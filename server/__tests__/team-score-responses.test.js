import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { teamScoreResponse } from '../../shared/team-score-responses.mjs';
import { scoreTeam } from '../../shared/scoring/index.mjs';

const ids = Array.from({ length: 10 }, randomUUID),
  teamId = randomUUID(),
  agentId = randomUUID(),
  trialId = randomUUID();
const [runId] = ids;
const at = '2026-11-20T08:50:00.000Z',
  hash = 'a'.repeat(64);
const cfg = {
  stepIndex: 0,
  stepName: 'Build',
  role: 'Engineer',
  source: 'team',
  agentId,
  agentRevision: 1,
  teamId,
  teamRevision: 1,
  provider: 'codex',
  model: 'm1',
  effort: 'high',
};
const sources = [
  { id: 'request', text: 'Change the font' },
  { id: 'note:1', text: 'Changed font verified on device' },
];
const criteria = [
  {
    id: 'c1',
    source: 'request',
    text: 'Change the font',
    verdict: 'met',
    proof: [{ source: 'note:1', check: 'Changed font', quote: 'verified on device' }],
    evidenceRefs: ['note:1'],
  },
];
const scored = (id) => ({
  id,
  status: 'complete',
  mixed: false,
  activeMs: 3,
  elapsedMs: 11,
  steps: [{ role: 'Engineer', activeMs: 3 }],
  criteria,
  evidenceRefs: sources.map((s) => s.id),
});
const before = scoreTeam(ids.slice(0, 5).map(scored)),
  after = scoreTeam(ids.slice(5).map(scored));
const comparison = { goal: 'speed', policyVersion: 1, verdict: 'helped', exposedRuns: 5, before, after };
const card = {
  id: hash,
  teamId,
  name: 'Team',
  teamRevision: 1,
  trialId: null,
  configuration: [cfg],
  score: before,
};
const run = {
  id: runId,
  teamId,
  teamName: 'Team',
  teamRevision: 1,
  trialId: null,
  cardId: hash,
  at,
  project: 'App',
  workflowName: 'Fix',
  status: 'complete',
  mixed: false,
  verdict: 'met',
  activeMs: 3,
  elapsedMs: 11,
};
const detail = {
  ...run,
  request: 'Change the font',
  signature: hash,
  revision: 1,
  criteria,
  sources,
  configuration: [cfg],
  attempts: [{ ...cfg, attempt: 1, activeMs: 3 }],
};
const history = { id: '1', at, runId, signature: hash, author: 'owner', revision: 1, criteria, sources };
const trial = {
  id: trialId,
  revision: 1,
  status: 'adopted',
  at,
  teamName: 'Team',
  teamId,
  teamRevision: 1,
  role: 'Engineer',
  goal: 'speed',
  workflowId: randomUUID(),
  workflowRevision: 2,
  project: 'App',
  workload: hash,
  from: { provider: 'codex', model: 'm1', effort: 'high' },
  to: { provider: 'codex', model: 'm1', effort: 'medium' },
  baselineIds: ids.slice(0, 5),
  assignmentIds: ids.slice(5),
  policyVersion: 1,
  reason: 'Measure lower effort',
  counterevidence: 'Only five observations',
  success: 'Deliver faster',
  stale: false,
  staleReason: null,
  comparison,
  adoptedComparison: comparison,
};
const resourceSamples = {
  scorecards: [card],
  trials: [trial],
  trial,
  runs: [run],
  detail,
  history: [history],
};
function missingFields(item, drop) {
  if (Array.isArray(item)) {
    if (item.length) missingFields(item[0], drop);
    return;
  }
  if (!item || typeof item !== 'object') return;
  for (const key of Object.keys(item)) {
    const original = item[key];
    delete item[key];
    drop(key);
    item[key] = original;
    missingFields(original, drop);
  }
}
it.each(Object.entries(resourceSamples))(
  'validates every published %s field and identifies a malformed response',
  (key, sample) => {
    expect(teamScoreResponse[key](sample)).toBe(sample);
    const input = structuredClone(sample);
    missingFields(input, () => expect(() => teamScoreResponse[key](input)).toThrow(/Invalid|Missing/));
  },
);
it('preserves new metrics and empty scorecards', () => {
  const extra = { ...before.metrics.activeMs, unit: 'credits', direction: 'lower', value: 7.5 };
  const cards = [
    { ...card, configuration: [], score: scoreTeam([]) },
    { ...card, score: { ...before, metrics: { ...before.metrics, dcCredits: extra } } },
  ];
  expect(teamScoreResponse.scorecards(cards)).toBe(cards);
});
it.each([
  ['scorecards', () => [{ ...card, score: { ...before, roles: [{ ...before.roles[0], activeMs: -1 }] } }]],
  ['detail', () => ({ ...detail, attempts: [{ ...detail.attempts[0], stepIndex: 33 }] })],
  ['detail', () => ({ ...detail, configuration: [{ ...cfg, teamId: null }] })],
  ['detail', () => ({ ...detail, configuration: [{ ...cfg, provider: null }] })],
  ['detail', () => ({ ...detail, criteria: [{ ...criteria[0], source: 'note:3' }] })],
  [
    'detail',
    () => ({
      ...detail,
      criteria: [{ ...criteria[0], proof: [{ source: 'note:1', quote: 'no such quote' }] }],
    }),
  ],
  ['trial', () => ({ ...trial, baselineIds: ids.slice(0, 4) })],
  ['trial', () => ({ ...trial, assignmentIds: [...ids.slice(0, 1), ...ids.slice(5)] })],
  ['trial', () => ({ ...trial, from: { provider: 'codex', model: 'm1', effort: 'invalid' } })],
  ['trial', () => ({ ...trial, comparison: { ...comparison, exposedRuns: 6 } })],
  ['history', () => [{ ...history, id: 'different revision' }]],
])('%s rejects out-of-domain values', (key, sample) =>
  expect(() => teamScoreResponse[key](sample())).toThrow(/Invalid/),
);
