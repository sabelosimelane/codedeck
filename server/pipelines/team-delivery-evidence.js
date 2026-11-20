import { redactReviewText } from '../cli-naming-client.js';
import { deliveryVerdict } from '../../shared/scoring/index.mjs';
import { isUuid } from '../../shared/pipeline-definitions.mjs';

const nonempty = (text, max) => typeof text === 'string' && text.trim().length > 0 && text.length <= max;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const verdicts = ['met', 'missed', 'unverified'];
const sourceId = (id) =>
  typeof id === 'string' && /^(request|(note|question|answer|review|owner):[1-9]\d*)$/.test(id);
function requireField(condition, field) {
  if (!condition)
    throw Object.assign(new Error('Invalid delivery evidence field ' + field), { status: 400, field });
}
function exact(object, fields) {
  return (
    object &&
    typeof object === 'object' &&
    !Array.isArray(object) &&
    Object.keys(object).length === fields.length &&
    fields.every((k) => Object.hasOwn(object, k))
  );
}
function checkSources(sources) {
  requireField(Array.isArray(sources) && sources.length > 0, 'sources');
  const ids = new Set();
  for (const item of sources) {
    requireField(exact(item, ['id', 'text']) && sourceId(item.id) && !ids.has(item.id), 'sources.id');
    requireField(typeof item.text === 'string', 'sources.text');
    ids.add(item.id);
  }
  requireField(ids.has('request'), 'sources.request');
  return sources;
}
function validateCriteria(criteria, sources) {
  requireField(Array.isArray(criteria) && criteria.length <= 65, 'criteria');
  const ids = new Set();
  for (const c of criteria) {
    requireField(exact(c, ['id', 'text', 'source', 'verdict', 'proof', 'evidenceRefs']), 'criterion');
    requireField(nonempty(c.id, 100) && !ids.has(c.id), 'criterion.id');
    ids.add(c.id);
    requireField(nonempty(c.text, 2000), 'criterion.text');
    requireField(
      sources.some((s) => s.id === c.source),
      'criterion.source',
    );
    requireField(verdicts.includes(c.verdict), 'criterion.verdict');
    requireField(
      Array.isArray(c.proof) && c.proof.length <= 8 && (c.verdict === 'unverified' || c.proof.length > 0),
      'criterion.proof',
    );
    for (const ref of c.proof) {
      const note = typeof ref?.source === 'string' && ref.source.startsWith('note:');
      requireField(
        exact(ref, note ? ['source', 'quote', 'check'] : ['source', 'quote']) &&
          sourceId(ref.source) &&
          ref.source !== 'request' &&
          !ref.source.startsWith('question:'),
        'proof.source',
      );
      if (note) {
        requireField(
          nonempty(ref.check, 2000) &&
            nonempty(ref.quote, 2000) &&
            !ref.check.includes(ref.quote) &&
            !ref.quote.includes(ref.check) &&
            sources.some((s) => s.id === ref.source && s.text.includes(ref.check)),
          'proof.check',
        );
      }
      if (ref.source.startsWith('review:')) requireField(c.verdict === 'missed', 'proof.review');
      requireField(
        nonempty(ref.quote, 2000) && sources.some((s) => s.id === ref.source && s.text.includes(ref.quote)),
        'proof.quote',
      );
    }
    requireField(
      Array.isArray(c.evidenceRefs) &&
        JSON.stringify(c.evidenceRefs) === JSON.stringify([...new Set(c.proof.map((r) => r.source))]),
      'criterion.evidenceRefs',
    );
  }
  return criteria;
}
const conflict = () =>
  Object.assign(new Error('The delivery evidence changed. Reopen the run evidence.'), { status: 409 });
const outstanding = {
  id: 'coverage',
  text: 'Verify the remaining acceptance criteria',
  source: 'request',
  verdict: 'unverified',
  proof: [],
  evidenceRefs: [],
};

export function createDeliveryEvidence({ db, now = () => new Date().toISOString() }) {
  requireField(typeof db?.transaction === 'function' && typeof now === 'function', 'store');
  db.exec(`CREATE TABLE IF NOT EXISTS team_delivery_reviews (
    run TEXT NOT NULL, signature TEXT NOT NULL, revision INTEGER NOT NULL, author TEXT NOT NULL,
    at TEXT NOT NULL, sources TEXT NOT NULL, criteria TEXT NOT NULL, PRIMARY KEY(run,revision))`);
  // Earlier reviews used the delivery identity directly as their signature.
  if (!db.pragma('table_info(team_delivery_reviews)').some((c) => c.name === 'delivery')) {
    db.transaction(() => {
      db.exec(`ALTER TABLE team_delivery_reviews ADD COLUMN delivery TEXT;
        ALTER TABLE team_delivery_reviews ADD COLUMN source_ids TEXT;
        UPDATE team_delivery_reviews SET delivery=signature,
          source_ids=(SELECT json_group_array(json_extract(value,'$.id')) FROM json_each(sources));`);
    }).immediate();
  }
  db.exec('CREATE INDEX IF NOT EXISTS team_delivery_latest ON team_delivery_reviews(run,delivery,revision)');
  function hydrate(row) {
    if (!row) return null;
    requireField(
      isUuid(row.run) && positive(row.revision) && nonempty(row.signature, 128),
      'review.identity',
    );
    requireField(['owner', 'reviewer'].includes(row.author), 'review.author');
    requireField(Number.isFinite(Date.parse(row.at)), 'review.at');
    const sources = checkSources(JSON.parse(row.sources));
    return {
      runId: row.run,
      signature: row.signature,
      revision: row.revision,
      author: row.author,
      at: row.at,
      sources,
      criteria: validateCriteria(JSON.parse(row.criteria), sources),
    };
  }
  const current = (id, signature) => {
    requireField(isUuid(id) && nonempty(signature, 128), 'run identity');
    return hydrate(
      db
        .prepare(
          'SELECT * FROM team_delivery_reviews WHERE run=? AND signature=? ORDER BY revision DESC LIMIT 1',
        )
        .get(id, signature),
    );
  };
  const byDelivery = db.prepare(
    'SELECT * FROM team_delivery_reviews WHERE run=? AND delivery=? ORDER BY revision DESC LIMIT 1',
  );
  const byDeliverySummary = db.prepare(
    'SELECT signature,revision,criteria,source_ids FROM team_delivery_reviews WHERE run=? AND delivery=? ORDER BY revision DESC LIMIT 1',
  );
  const reviewed = db.prepare(
    "SELECT 1 FROM team_delivery_reviews WHERE run=? AND signature=? AND author='reviewer' LIMIT 1",
  );
  const ownerCriterion = (c) => c.proof.some((p) => p.source.startsWith('owner:'));
  function provisional(criteria) {
    return criteria.map((c) =>
      ownerCriterion(c) ? c : { ...c, verdict: 'unverified', proof: [], evidenceRefs: [] },
    );
  }
  function mergeSources(live, earlier, criteria) {
    const merged = new Map(live.map((s) => [s.id, s]));
    const needed = new Set(criteria.flatMap((c) => [c.source, ...c.evidenceRefs]));
    for (const s of earlier) if (needed.has(s.id) && !merged.has(s.id)) merged.set(s.id, s);
    return [...merged.values()];
  }
  function state(id, signature, delivery, sources) {
    const previous = hydrate(byDelivery.get(id, delivery));
    if (!previous || previous.signature === signature) return previous;
    const criteria = provisional(previous.criteria);
    return { ...previous, signature, sources: mergeSources(sources, previous.sources, criteria), criteria };
  }
  function summary(id, signature, delivery) {
    const row = byDeliverySummary.get(id, delivery);
    if (!row) return { revision: 0, criteria: [], evidenceRefs: [], assessed: false };
    requireField(positive(row.revision) && nonempty(row.signature, 128), 'review.identity');
    const evidenceRefs = JSON.parse(row.source_ids),
      original = JSON.parse(row.criteria);
    deliveryVerdict(original, evidenceRefs);
    const criteria = row.signature === signature ? original : provisional(original);
    return { revision: row.revision, criteria, evidenceRefs, assessed: !!reviewed.get(id, signature) };
  }
  function save(id, signature, revision, author, sources, criteria, delivery) {
    checkSources(sources);
    validateCriteria(criteria, sources);
    db.prepare(
      'INSERT INTO team_delivery_reviews (run,signature,revision,author,at,sources,criteria,delivery,source_ids) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      signature,
      revision,
      author,
      now(),
      JSON.stringify(sources),
      JSON.stringify(criteria),
      delivery,
      JSON.stringify(sources.map((s) => s.id)),
    );
    return current(id, signature);
  }
  const nextRevision = (id) =>
    db.prepare('SELECT COALESCE(MAX(revision),0)+1 n FROM team_delivery_reviews WHERE run=?').get(id).n;
  return {
    current,
    state,
    summary,
    history(id) {
      requireField(isUuid(id), 'run identity');
      return db
        .prepare('SELECT * FROM team_delivery_reviews WHERE run=? ORDER BY revision')
        .all(id)
        .map(hydrate);
    },
    record: db.transaction((id, signature, sources, response, delivery = signature) => {
      if (reviewed.get(id, signature)) throw conflict();
      checkSources(sources);
      requireField(typeof response?.complete === 'boolean', 'complete');
      requireField(Array.isArray(response.criteria) && response.criteria.length <= 64, 'criteria');
      const texts = new Set();
      const criteria = response.criteria.map((c, i) => {
        requireField(exact(c, ['text', 'source', 'verdict', 'proof']) && Array.isArray(c.proof), 'criterion');
        requireField(nonempty(c.text, 2000) && !texts.has(c.text), 'criterion.text');
        texts.add(c.text);
        requireField(
          sources.some((s) => s.id === c.source && s.text.includes(c.text)),
          'criterion.source',
        );
        return {
          ...c,
          id: 'criterion-' + (i + 1),
          evidenceRefs: [...new Set(c.proof.map((r) => r?.source))],
        };
      });
      if (!response.complete || !criteria.length) criteria.push(outstanding);
      validateCriteria(criteria, sources);
      const previous = hydrate(byDelivery.get(id, delivery));
      for (const corrected of previous?.criteria.filter(ownerCriterion) ?? []) {
        const index = criteria.findIndex((c) => c.text === corrected.text);
        if (index < 0) criteria.push(corrected);
        else criteria[index] = corrected;
      }
      return save(
        id,
        signature,
        nextRevision(id),
        'reviewer',
        mergeSources(sources, previous?.sources ?? [], criteria),
        criteria,
        delivery,
      );
    }).immediate,
    correct: db.transaction((id, signature, sources, body, delivery = signature) => {
      requireField(exact(body, ['revision', 'text', 'verdict', 'reason']), 'correction');
      requireField(Number.isSafeInteger(body.revision) && body.revision >= 0, 'revision');
      requireField(nonempty(body.text, 2000), 'criterion.text');
      requireField(verdicts.includes(body.verdict), 'verdict');
      requireField(nonempty(body.reason, 1500), 'reason');
      const latest = state(id, signature, delivery, sources);
      if (body.revision !== (latest?.revision ?? 0)) throw conflict();
      const reason = redactReviewText(body.reason.trim());
      const text = redactReviewText(body.text.trim());
      const revision = nextRevision(id);
      const ref = 'owner:' + revision;
      const evidence = [...(latest?.sources ?? checkSources(sources)), { id: ref, text: reason }];
      const criteria = [...(latest?.criteria ?? [])];
      const i = criteria.findIndex((c) => c.text === text);
      const c = {
        id: 'owner-criterion-' + revision,
        text,
        source: i < 0 ? ref : criteria[i].source,
        verdict: body.verdict,
        proof: [{ source: ref, quote: reason }],
        evidenceRefs: [ref],
      };
      if (i < 0) criteria.push(c);
      else criteria[i] = c;
      if (!latest && text !== sources.find((s) => s.id === 'request').text) criteria.push(outstanding);
      return save(id, signature, revision, 'owner', evidence, criteria, delivery);
    }).immediate,
  };
}
