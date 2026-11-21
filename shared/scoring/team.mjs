import {
  count,
  createMetricRegistry,
  fraction,
  median,
  object,
  observationsFor,
  requireField,
  text,
} from './engine.mjs';

export const TEAM_POLICY_VERSION = 1;
export const TEAM_TRIAL_SIZE = 3;
const statuses = new Set([
  'pending',
  'running',
  'needs_input',
  'limit_paused',
  'awaiting_approval',
  'interrupted',
  'stopped',
  'error',
  'complete',
]);
const terminal = new Set(['interrupted', 'stopped', 'error', 'complete']);
const duration = (value) => value === null || count(value);
const uniqueRefs = (refs) => Array.isArray(refs) && refs.every(text) && new Set(refs).size === refs.length;

export function deliveryVerdict(criteria, evidenceRefs) {
  requireField(uniqueRefs(evidenceRefs), 'evidenceRefs');
  requireField(Array.isArray(criteria), 'criteria');
  const allowed = new Set(evidenceRefs);
  const ids = new Set();
  for (const item of criteria) {
    requireField(object(item) && text(item.id) && !ids.has(item.id), 'criterion.id');
    ids.add(item.id);
    requireField(text(item.text), 'criterion.text ' + item.id);
    requireField(['met', 'missed', 'unverified'].includes(item.verdict), 'criterion.verdict ' + item.id);
    requireField(
      uniqueRefs(item.evidenceRefs) && item.evidenceRefs.every((ref) => allowed.has(ref)),
      'criterion evidenceRefs ' + item.id,
    );
    requireField(
      item.verdict === 'unverified' || item.evidenceRefs.length > 0,
      'criterion evidence missing ' + item.id,
    );
  }
  if (criteria.some((item) => item.verdict === 'missed')) return 'missed';
  return criteria.length && criteria.every((item) => item.verdict === 'met') ? 'met' : 'unverified';
}

function prepare(row) {
  const path = 'observation ' + row.id + ' ';
  requireField(statuses.has(row.status), path + 'status');
  requireField(typeof row.mixed === 'boolean', path + 'mixed');
  requireField(duration(row.activeMs), path + 'activeMs');
  requireField(duration(row.elapsedMs), path + 'elapsedMs');
  requireField(Array.isArray(row.steps), path + 'steps');
  row.steps.forEach((step, index) => {
    requireField(object(step) && typeof step.role === 'string', path + 'steps[' + index + '].role');
    requireField(duration(step.activeMs), path + 'steps[' + index + '].activeMs');
  });
  return { ...row, verdict: deliveryVerdict(row.criteria, row.evidenceRefs) };
}

const delivered = (row) => !row.mixed && row.status === 'complete';
const verified = (row) => delivered(row) && row.verdict !== 'unverified';
const timeMetric = (key) => ({
  id: key,
  version: 1,
  unit: 'ms',
  direction: 'lower',
  eligible: (row) => delivered(row) && row[key] !== null,
  aggregate: (rows) => median(rows.map((row) => row[key])),
});
const ratioMetric = (id, eligible, matches) => ({
  id,
  version: 1,
  unit: 'fraction',
  direction: 'higher',
  eligible,
  aggregate: (rows) => fraction(rows, matches),
});
export const teamPolicy = Object.freeze({
  subjectType: 'team',
  version: TEAM_POLICY_VERSION,
  prepare,
  registry: createMetricRegistry([
    timeMetric('activeMs'),
    timeMetric('elapsedMs'),
    ratioMetric('accuracy', verified, (row) => row.verdict === 'met'),
    ratioMetric('deliveryRate', (row) => !row.mixed, delivered),
    ratioMetric('verificationCoverage', delivered, verified),
  ]),
});

function roleTimings(rows) {
  // Combine repeated attempts before taking the median, so a retry-heavy run only votes once.
  const groups = new Map();
  for (const row of rows) {
    const times = new Map();
    for (const { role, activeMs } of row.steps) {
      if (!role) continue; // Setup and workflow-owned steps can have no team role.
      const key = role.trim().toLowerCase();
      if (!groups.has(key)) groups.set(key, { role, samples: [], runIds: [] });
      const subtotal = times.get(key);
      times.set(key, activeMs === null || subtotal === null ? null : (subtotal ?? 0) + activeMs);
    }
    for (const [key, time] of times) {
      if (time === null) continue;
      groups.get(key).samples.push(time);
      groups.get(key).runIds.push(row.id);
    }
  }
  return [...groups.values()]
    .map(({ role, samples, runIds }) => ({ role, activeMs: median(samples), runIds }))
    .sort((a, b) => (b.activeMs ?? -1) - (a.activeMs ?? -1) || a.role.localeCompare(b.role));
}

export function scoreTeam(observations) {
  const rows = observationsFor(teamPolicy, observations);
  const metrics = teamPolicy.registry.score(rows);
  const assigned = rows.filter((row) => !row.mixed);
  const deliveries = assigned.filter(delivered);
  return {
    policyVersion: TEAM_POLICY_VERSION,
    total: rows.length,
    mixed: rows.length - assigned.length,
    delivered: deliveries.length,
    unfinished: assigned.filter((row) => !terminal.has(row.status)).length,
    failed: assigned.filter((row) => row.status === 'error').length,
    stopped: assigned.filter((row) => row.status === 'stopped').length,
    interrupted: assigned.filter((row) => row.status === 'interrupted').length,
    met: deliveries.filter((row) => row.verdict === 'met').length,
    missed: deliveries.filter((row) => row.verdict === 'missed').length,
    unverified: deliveries.length - metrics.accuracy.eligible,
    timed: metrics.activeMs.eligible,
    metrics,
    roles: roleTimings(rows),
    runIds: rows.map((row) => row.id),
  };
}

function trialVerdict(before, after, goal) {
  if ([before, after].some((card) => card.total !== TEAM_TRIAL_SIZE || card.mixed || card.unfinished))
    return 'inconclusive';
  const previous = before.metrics;
  const current = after.metrics;
  const safeguards = ['deliveryRate', 'verificationCoverage', 'accuracy'];
  for (const id of safeguards) {
    if (previous[id].value !== null && current[id].value !== null && current[id].value < previous[id].value)
      return 'regressed';
  }
  if (safeguards.some((id) => previous[id].value === null || current[id].value === null))
    return 'inconclusive';
  if (before.unverified || after.unverified) return 'inconclusive';
  if (goal === 'accuracy')
    return current.accuracy.value > previous.accuracy.value ? 'helped' : 'inconclusive';
  if ([before, after].some((card) => !card.timed || card.timed !== card.delivered)) return 'inconclusive';
  if (current.activeMs.value < previous.activeMs.value) return 'helped';
  if (current.activeMs.value > previous.activeMs.value) return 'regressed';
  return 'inconclusive';
}

export function compareTeamTrial(before, after, goal = 'speed', policyVersion = TEAM_POLICY_VERSION) {
  requireField(policyVersion === TEAM_POLICY_VERSION, 'trial.policyVersion');
  requireField(['accuracy', 'speed'].includes(goal), 'trial.goal');
  const baseline = scoreTeam(before);
  const trial = scoreTeam(after);
  requireField(!baseline.runIds.some((id) => trial.runIds.includes(id)), 'overlapping trial observation ids');
  return {
    policyVersion,
    goal,
    verdict: trialVerdict(baseline, trial, goal),
    before: baseline,
    after: trial,
  };
}
