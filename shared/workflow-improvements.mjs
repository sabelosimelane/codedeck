import { isUuid } from './pipeline-definitions.mjs';

export const flags = ['proofGap', 'productiveLoop', 'cleanCommit'];
export const metrics = ['activeMs', 'launches', 'loops', 'proofGaps'];
export const safeguards = ['proofGaps', 'missingFinalNotes'];
export const classifications = [...flags, 'ordinary'];
export const statuses = ['complete', 'error', 'stopped', 'interrupted'];
export const metricNames = {
  activeMs: 'Active execution time',
  launches: 'Terminal launches',
  loops: 'Loop-backs',
  proofGaps: 'Flagged proof gaps per run',
  missingFinalNotes: 'Missing final notes per run',
};
export const flagNames = {
  proofGap: 'Possible proof gap',
  productiveLoop: 'Verification caught a failure',
  cleanCommit: 'Clean Commit launch',
  ordinary: 'No issue',
};
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const string = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const iso = (x) => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
export function check(condition, field) {
  if (!condition) throw new TypeError('Invalid workflow improvement field ' + field);
}
export function classifyEvidence(step, note) {
  const result = [];
  if (
    /commit/i.test(step) &&
    !/^\s*(?:#\s*)?committed\b/i.test(note) &&
    /already clean|nothing to commit|no new commit needed/i.test(note.split('\n')[0])
  )
    result.push('cleanCommit');
  if (/test|verify|proof|acceptance/i.test(step)) {
    if (
      /(?:phone|device|handset).{0,45}(?:still (?:sees nothing|fails|cannot)|does not (?:show|respond))|(?:device|phone|external|manual|acceptance|verification|evidence|proof|end.to.end).{0,70}(?:pending|unverified|not (?:tested|verified)|still required)|(?:not verified|unverified) on/i.test(
        note,
      )
    )
      result.push('proofGap');
    if (
      /symptom is not gone|(?:found|caught|reproduced) (?:a |the )?(?:regression|failure)|original symptom (?:persists|remains)/i.test(
        note,
      )
    )
      result.push('productiveLoop');
  }
  return result;
}
export function validateOutcome(r) {
  check(r && typeof r === 'object', 'outcome');
  for (const key of ['id', 'workflowId']) check(isUuid(r[key]), key);
  for (const key of ['name', 'project']) check(string(r[key], 512), key);
  for (const key of ['at', 'createdAt']) check(iso(r[key]), key);
  check(count(r.revision) && r.revision > 0, 'revision');
  check(
    r.workload === null || (typeof r.workload === 'string' && /^[a-f0-9]{64}$/.test(r.workload)),
    'workload',
  );
  check(statuses.includes(r.status), 'status');
  check(Array.isArray(r.flags) && r.flags.every((x) => flags.includes(x)), 'flags');
  check(typeof r.finalNote === 'boolean', 'finalNote');
  const times = (v, keys) => keys.forEach((k) => check(v[k] === null || count(v[k]), k));
  times(r, ['activeMs', 'waitMs']);
  check(Array.isArray(r.steps) && r.steps.length > 0 && r.steps.length <= 33, 'steps');
  for (const s of [r, ...r.steps]) {
    for (const k of ['elapsedMs', 'launches', 'loops']) check(count(s[k]), k);
    if (s !== r) {
      check(string(s.name, 64), 'step.name');
      times(s, ['activeMs']);
    }
  }
  return r;
}
export function runnerBrief(p) {
  return JSON.stringify({ task: p.title, change: p.change, regressionTest: p.test, sourceRuns: p.citations });
}
export function validateDraft(p, allowedIds) {
  check(p && typeof p === 'object' && !Array.isArray(p), 'proposal');
  const fields = [
    'kind',
    'title',
    'reason',
    'citations',
    'counterevidence',
    'change',
    'step',
    'test',
    'metric',
    'safeguard',
  ];
  check(
    Object.keys(p).every((k) => fields.includes(k)),
    'proposal.keys',
  );
  check(['workflow', 'runner', 'reviewer'].includes(p.kind), 'kind');
  for (const [key, max] of Object.entries({
    title: 140,
    reason: 1500,
    counterevidence: 1500,
    change: 8192,
    test: 1500,
  }))
    check(string(p[key], max), key);
  check(p.kind === 'workflow' ? string(p.step, 64) : p.step === null, 'step');
  check(
    Array.isArray(p.citations) &&
      p.citations.length >= 1 &&
      p.citations.length <= 5 &&
      new Set(p.citations).size === p.citations.length &&
      p.citations.every((id) => isUuid(id) && allowedIds.includes(id)),
    'citations',
  );
  check(metrics.includes(p.metric), 'metric');
  check(safeguards.includes(p.safeguard), 'safeguard');
  if (p.kind === 'runner') check(runnerBrief(p).length <= 4096, 'runner brief length');
  return p;
}
export function median(values) {
  if (!values.length || values.some((v) => v === null)) return null;
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(values.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function measure(rows, key) {
  if (!rows.length) return null;
  if (key === 'proofGaps' || key === 'missingFinalNotes')
    return (
      rows.filter((r) => (key === 'proofGaps' ? r.flags.includes('proofGap') : !r.finalNote)).length /
      rows.length
    );
  return median(rows.map((r) => r[key]));
}
export function compareOutcomes(before, after, metric, safeguard) {
  const a = measure(before, metric),
    b = measure(after, metric),
    guardBefore = measure(before, safeguard),
    guardAfter = measure(after, safeguard);
  const mix = (rows) =>
    rows
      .map((r) => JSON.stringify([r.project, r.workload, r.status]))
      .sort()
      .join(',');
  let verdict = 'inconclusive';
  if (
    before.length === 5 &&
    after.length === 5 &&
    [...before, ...after].every((r) => r.workload !== null) &&
    mix(before) === mix(after) &&
    a !== null &&
    b !== null
  ) {
    if (guardAfter > guardBefore || b > a) verdict = 'regressed';
    else if (b < a) verdict = 'helped';
  }
  return {
    verdict,
    before: a,
    after: b,
    guardBefore,
    guardAfter,
    beforeIds: before.map((r) => r.id),
    afterIds: after.map((r) => r.id),
  };
}

const finite = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const text = (x) => typeof x === 'string';
const nullableText = (x) => x === null || text(x);
function validateFinding(f) {
  check(f && classifications.includes(f.label), 'finding.label');
  check(string(f.quote, 500), 'finding.quote');
}
export function validateCall(v) {
  check(v && isUuid(v.id) && isUuid(v.workflowId), 'call identity');
  check(count(v.revision) && v.revision > 0, 'call revision');
  check(iso(v.at), 'call timestamp');
  check(string(v.model, 400), 'call model');
  check(['started', 'complete', 'failed', 'interrupted'].includes(v.status), 'call status');
  check(v.cost === null || finite(v.cost), 'call cost');
  return v;
}
export function validateReviewerStatus(v) {
  check(v && typeof v.configured === 'boolean', 'configured');
  for (const key of ['dailyBudget', 'reviewerRevision', 'queued', 'modelRevision']) check(count(v[key]), key);
  for (const key of ['provider', 'model', 'effort']) check(nullableText(v[key]), key);
  return v;
}
export function validateProposal(v) {
  check(v && isUuid(v.id) && isUuid(v.workflowId), 'proposal identity');
  for (const key of ['revision', 'reviewerRevision']) check(count(v[key]) && v[key] > 0, key);
  check(iso(v.at), 'proposal date');
  check(['pending', 'approved', 'dismissed', 'applied'].includes(v.status), 'proposal status');
  validateDraft(v.draft, v.draft?.citations ?? []);
  check(nullableText(v.reason), 'dismissal reason');
  check(v.effectiveAt === null || iso(v.effectiveAt), 'effectiveAt');
  check(
    v.effectiveRevision === null || (count(v.effectiveRevision) && v.effectiveRevision > 0),
    'effectiveRevision',
  );
  if (v.evaluation !== null) {
    check(v.evaluation && typeof v.evaluation.passed === 'boolean', 'evaluation passed');
    check(count(v.evaluation.count) && v.evaluation.count >= 2, 'evaluation size');
    check(typeof v.evaluation.key === 'string' && /^[0-9a-f]{64}$/.test(v.evaluation.key), 'evaluation key');
  }
  if (v.result !== null) {
    check(v.result && ['helped', 'regressed', 'inconclusive'].includes(v.result.verdict), 'verdict');
    for (const key of ['before', 'after', 'guardBefore', 'guardAfter'])
      check(v.result[key] === null || finite(v.result[key]), key);
    for (const key of ['beforeIds', 'afterIds'])
      check(Array.isArray(v.result[key]) && v.result[key].length <= 5 && v.result[key].every(isUuid), key);
  }
  return v;
}
export function validatePacket(v) {
  check(v && isUuid(v.id), 'packet identity');
  check(text(v.request), 'run request');
  check(Array.isArray(v.steps) && v.steps.length > 0, 'evidence steps');
  for (const s of v.steps) {
    check(string(s.name, 64) && text(s.prompt), 'evidence step');
    check(Array.isArray(s.notes), 'evidence notes');
    for (const n of s.notes) check(n && count(n.id) && text(n.summary) && text(n.excerpt), 'evidence note');
  }
  for (const key of ['ownerAnswers', 'ownerReviews', 'agentDecisions']) {
    check(Array.isArray(v[key]), key);
    for (const record of v[key]) {
      check(string(record.step, 64), 'decision step');
      if (key === 'ownerReviews')
        check(
          ['approved', 'sent_back'].includes(record.verdict) && nullableText(record.comment),
          'review verdict',
        );
      else check(text(record.answer), 'answer');
      if (key === 'ownerAnswers') check(nullableText(record.question), 'owner question');
    }
  }
  if (v.finding !== null) validateFinding(v.finding);
  return v;
}
