// Validate each wire field before giving it to a dashboard component. Metric names are extensible.
import { isUuid } from './pipeline-definitions.mjs';

import { buildLaunchCommand } from './agent-presets.mjs';
import { TEAM_TRIAL_SIZE } from './scoring/team.mjs';

const string = (x) => typeof x === 'string';
const text = (x) => string(x) && x.trim().length > 0;
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const positive = (x) => count(x) && x > 0;
const finite = Number.isFinite;
const hash = (x) => string(x) && /^[a-f0-9]{64}$/.test(x);
const date = (x) =>
  string(x) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(x) &&
  Number.isFinite(Date.parse(x));
const bool = (x) => typeof x === 'boolean';
const choice =
  (...values) =>
  (x) =>
    values.includes(x);
const nullable = (rule) => (value, path) => value === null || rule(value, path);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const fields = (shape) => (value, path) => {
  if (!object(value)) return false;
  for (const [key, rule] of Object.entries(shape)) validate(rule, value[key], path + '.' + key);
  return true;
};
const list = (rule) => (items, path) => {
  if (!Array.isArray(items)) return false;
  items.forEach((item, i) => validate(rule, item, path + '[' + i + ']'));
  return true;
};
const all =
  (...rules) =>
  (value, path) =>
    rules.every((rule) => rule(value, path));
const ids = (min = 0, max = Infinity) =>
  all(
    list(isUuid),
    (items) => items.length >= min && items.length <= max && new Set(items).size === items.length,
  );
const duration = (value) => finite(value) && value >= 0;
function validate(rule, value, path) {
  if (!rule(value, path)) throw new TypeError('Invalid team scoring response at ' + path);
  return value;
}
const metric = fields({
  value: nullable(finite),
  unit: text,
  version: positive,
  direction: choice('lower', 'higher'),
  eligible: count,
  excluded: count,
  evidenceIds: ids(),
});
const metrics = (value, path) => {
  if (!object(value)) return false;
  for (const [key, item] of Object.entries(value)) validate(metric, item, path + '.' + key);
  for (const key of ['activeMs', 'elapsedMs', 'accuracy', 'deliveryRate', 'verificationCoverage']) {
    if (!Object.hasOwn(value, key)) throw new TypeError('Missing team metric ' + key);
    const n = value[key].value;
    const time = key === 'activeMs' || key === 'elapsedMs';
    validate(
      (value) => value === null || (value >= 0 && (time || value <= 1)),
      n,
      path + '.' + key + '.value',
    );
  }
  return true;
};
const score = fields({
  policyVersion: positive,
  total: count,
  mixed: count,
  delivered: count,
  unfinished: count,
  failed: count,
  stopped: count,
  interrupted: count,
  met: count,
  missed: count,
  unverified: count,
  timed: count,
  metrics,
  roles: list(fields({ role: text, activeMs: nullable(duration), runIds: ids() })),
  runIds: ids(),
});
const verdict = choice('met', 'missed', 'unverified');
const sources = list(fields({ id: text, text: string }));
const criteria = list(
  fields({
    id: text,
    text: text,
    source: text,
    verdict,
    proof: list(fields({ source: text, quote: text })),
    evidenceRefs: list(text),
  }),
);
const assignment = {
  stepIndex: (v) => count(v) && v <= 32,
  stepName: text,
  role: string,
  source: choice('team', 'override', 'setup', 'workflow', 'trial'),
  agentId: isUuid,
  agentRevision: positive,
  teamId: nullable(isUuid),
  teamRevision: nullable(positive),
  provider: nullable(text),
  model: nullable(string),
  effort: nullable(string),
};
function preset(profile, path) {
  const result = buildLaunchCommand({
    provider: profile.provider,
    model: profile.model,
    effort: profile.effort,
    skipPermissions: false,
  });
  for (const error of result.errors) validate(() => false, profile[error.field], path + '.' + error.field);
  return true;
}
const assignmentRelations = (a, path) => {
  const byTeam = a.source === 'team' || a.source === 'trial';
  validate(
    () =>
      byTeam ? isUuid(a.teamId) && positive(a.teamRevision) : a.teamId === null && a.teamRevision === null,
    a,
    path + '.teamId/teamRevision',
  );
  if (a.provider === null) return a.model === null && a.effort === null;
  return string(a.model) && string(a.effort) && preset(a, path);
};
const assignmentField = all(fields(assignment), assignmentRelations);
const reviewReferences = (review, path) => {
  const byId = new Map(review.sources.map((item) => [item.id, item.text]));
  validate(
    () => byId.size === review.sources.length && byId.has('request'),
    review.sources,
    path + '.sources',
  );
  const names = new Set();
  for (const c of review.criteria) {
    validate(() => !names.has(c.id) && byId.has(c.source), c, path + '.criteria.' + c.id + '.source');
    names.add(c.id);
    validate(
      () => c.verdict === 'unverified' || c.proof.length > 0,
      c,
      path + '.criteria.' + c.id + '.proof',
    );
    for (const ref of c.proof) {
      const source = byId.get(ref.source);
      validate(
        () => ref.source !== 'request' && source?.includes(ref.quote),
        ref,
        path + '.criteria.' + c.id + '.proof',
      );
      if (ref.source.startsWith('note:'))
        validate(
          () =>
            text(ref.check) &&
            source.includes(ref.check) &&
            !ref.check.includes(ref.quote) &&
            !ref.quote.includes(ref.check),
          ref,
          path + '.criteria.' + c.id + '.proof.check',
        );
    }
    validate(
      () => JSON.stringify([...new Set(c.proof.map((ref) => ref.source))]) === JSON.stringify(c.evidenceRefs),
      c,
      path + '.criteria.' + c.id + '.evidenceRefs',
    );
  }
  return true;
};
const card = fields({
  id: hash,
  teamId: isUuid,
  name: text,
  teamRevision: positive,
  trialId: nullable(isUuid),
  configuration: list(assignmentField),
  score,
});
const summary = {
  id: isUuid,
  cardId: hash,
  teamId: isUuid,
  teamName: text,
  teamRevision: positive,
  trialId: nullable(isUuid),
  at: date,
  project: text,
  workflowName: text,
  status: choice(
    'complete',
    'error',
    'stopped',
    'interrupted',
    'running',
    'pending',
    'needs_input',
    'limit_paused',
    'awaiting_approval',
  ),
  mixed: bool,
  verdict,
  activeMs: nullable(count),
  elapsedMs: nullable(count),
};
const detail = all(
  fields({
    ...summary,
    request: string,
    signature: hash,
    revision: count,
    criteria,
    sources,
    attempts: list(
      all(fields({ ...assignment, attempt: positive, activeMs: nullable(count) }), assignmentRelations),
    ),
    configuration: list(assignmentField),
  }),
  reviewReferences,
);
const profile = all(fields({ provider: text, model: string, effort: string }), preset);
const goal = choice('speed', 'accuracy');
const comparison = fields({
  exposedRuns: (v) => count(v) && v <= TEAM_TRIAL_SIZE,
  before: score,
  after: score,
  verdict: choice('helped', 'regressed', 'inconclusive'),
  goal,
  policyVersion: positive,
});
const trial = fields({
  id: isUuid,
  revision: positive,
  status: choice('pending', 'running', 'measured', 'adopted', 'stopped', 'dismissed'),
  at: date,
  teamName: text,
  teamId: isUuid,
  teamRevision: positive,
  role: text,
  goal,
  workflowId: isUuid,
  workflowRevision: positive,
  project: text,
  workload: hash,
  from: profile,
  to: profile,
  baselineIds: ids(TEAM_TRIAL_SIZE, TEAM_TRIAL_SIZE),
  assignmentIds: ids(0, TEAM_TRIAL_SIZE),
  policyVersion: positive,
  reason: text,
  counterevidence: text,
  success: text,
  stale: bool,
  staleReason: nullable(text),
  comparison: nullable(comparison),
  adoptedComparison: nullable(comparison),
});
const history = all(
  fields({
    id: text,
    runId: isUuid,
    signature: hash,
    at: date,
    author: choice('reviewer', 'owner'),
    revision: positive,
    criteria,
    sources,
  }),
  reviewReferences,
  (entry) => entry.id === String(entry.revision),
);
export const teamScoreResponse = {
  scorecards: (values) => validate(list(card), values, 'scorecards'),
  trials: (values) => validate(list(trial), values, 'trials'),
  runs: (values) => validate(list(fields(summary)), values, 'runs'),
  detail: (value) => validate(detail, value, 'delivery'),
  history: (values) => validate(list(history), values, 'history'),
  trial: (value) => validate(trial, value, 'trial'),
};
