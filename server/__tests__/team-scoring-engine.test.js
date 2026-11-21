import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  scoreTeam,
  compareTeamTrial,
  scoreEnvelope,
  teamPolicy,
  createMetricRegistry,
  deliveryVerdict,
  compareWorkflow,
  TEAM_POLICY_VERSION,
} from '../../shared/scoring/index.mjs';
import { compareOutcomes } from '../../shared/workflow-improvements.mjs';

const criterion = (verdict = 'met') => ({
  id: 'button',
  text: 'Approve saves the change',
  verdict,
  evidenceRefs: verdict === 'unverified' ? [] : ['check'],
});
const row = (id, fields = {}) => ({
  id,
  status: 'complete',
  activeMs: 10,
  elapsedMs: 90,
  mixed: false,
  criteria: [criterion()],
  evidenceRefs: ['check'],
  steps: [
    { role: 'Fix', activeMs: 3 },
    { role: 'Fix', activeMs: 7 },
  ],
  ...fields,
});
const before = Array.from({ length: 3 }, (_, i) => row('before' + i));
const after = Array.from({ length: 3 }, (_, i) => row('after' + i, { activeMs: 6 }));
const score = (...extra) => scoreTeam([...before, ...extra]);
const compare = (trial, goal, version) => compareTeamTrial(before, trial, goal, version);

it('measures delivered time, accuracy, coverage and separate terminal states', () => {
  const card = score(
    row('unknown', { activeMs: null, criteria: [] }),
    row('miss', { criteria: [criterion('missed')] }),
    row('fail', { status: 'error' }),
    row('busy', { status: 'running' }),
    row('stop', { status: 'stopped' }),
    row('interrupted', { status: 'interrupted' }),
    row('manual', { mixed: true }),
  );
  expect(card).toMatchObject({
    policyVersion: 1,
    total: 10,
    mixed: 1,
    delivered: 5,
    failed: 1,
    stopped: 1,
    unfinished: 1,
    interrupted: 1,
    met: 3,
    missed: 1,
    unverified: 1,
    timed: 4,
  });
  expect(card.metrics.activeMs).toMatchObject({
    value: 10,
    unit: 'ms',
    direction: 'lower',
    eligible: 4,
    excluded: 6,
  });
  expect(card.metrics.elapsedMs.value).toBe(90);
  expect(card.metrics.accuracy).toMatchObject({
    value: 3 / 4,
    eligible: 4,
    excluded: 6,
    evidenceIds: [...before.map((r) => r.id), 'miss'],
  });
  expect(card.metrics.deliveryRate.value).toBe(5 / 9);
  expect(card.metrics.verificationCoverage.value).toBe(4 / 5);
  expect(card.roles[0].activeMs).toBe(10);
  expect(card.roles[0].runIds).toContain('manual'); // Attributable attempts remain visible for mixed runs.
  expect(scoreTeam([]).metrics.accuracy.value).toBeNull();
});

it('requires cited evidence for each acceptance criterion and never assumes success', () => {
  expect(deliveryVerdict([], [])).toBe('unverified');
  expect(deliveryVerdict([criterion(), { ...criterion('unverified'), id: 'other' }], ['check'])).toBe(
    'unverified',
  );
  expect(deliveryVerdict([criterion('missed'), { ...criterion('unverified'), id: 'other' }], ['check'])).toBe(
    'missed',
  );
  expect(() => deliveryVerdict([criterion()], ['unknown'])).toThrow(/evidence/i);
  expect(() => deliveryVerdict([{ ...criterion(), evidenceRefs: [] }], [])).toThrow(/evidence/i);
  expect(() => deliveryVerdict([criterion(), criterion()], ['check'])).toThrow(/id/);
});

it.each([
  ...Object.keys(row('r')).map((key) => ['observation.' + key, { ...row('r'), [key]: undefined }]),
  ...Object.keys(criterion()).map((key) => [
    'criterion.' + key,
    row('r', { criteria: [{ ...criterion(), [key]: undefined }] }),
  ]),
  ['empty evidence ID', row('r', { evidenceRefs: [''] })],
  ['empty role time', row('r', { steps: [{ role: 'Fix' }] })],
  ['invalid role', row('r', { steps: [{ role: null, activeMs: 0 }] })],
  ['negative time', row('r', { activeMs: -1 })],
])('rejects a malformed %s', (_, value) => {
  expect(() => scoreTeam([value])).toThrow();
});
it('rejects duplicate observation IDs', () => {
  expect(() => scoreTeam([before[0], before[0]])).toThrow(/id/i);
});

it('compares five independent assignments under one policy, protecting accuracy, completion and coverage', () => {
  expect(compare(after).verdict).toBe('helped');
  expect(compare(after.slice(1)).verdict).toBe('inconclusive');
  expect(compare([...after.slice(1), row('mixed', { mixed: true })]).verdict).toBe('inconclusive');
  expect(compare([...after.slice(1), row('live', { status: 'running' })]).verdict).toBe('inconclusive');
  expect(compare([...after.slice(1), row('miss', { criteria: [criterion('missed')] })]).verdict).toBe(
    'regressed',
  );
  expect(compare([...after.slice(1), row('unknown', { criteria: [] })]).verdict).toBe('regressed');
  expect(compare([...after.slice(1), row('broken', { status: 'error' })]).verdict).toBe('regressed');
  expect(compare(after.map((r) => ({ ...r, activeMs: null }))).verdict).toBe('inconclusive');
  expect(compare(after.map((r) => ({ ...r, criteria: [] }))).verdict).not.toBe('helped');
  expect(
    compareTeamTrial(
      before.map((r) => ({ ...r, criteria: [criterion('missed')] })),
      after.map((r) => ({ ...r, activeMs: 20 })),
      'accuracy',
    ).verdict,
  ).toBe('helped');
  expect(() => compare(after, 'effort')).toThrow(/goal/);
  expect(() => compare(after, 'speed', 2)).toThrow(/version/i);
  expect(() => compare(before)).toThrow(/overlap/i);
});

it('replays a versioned JSON envelope standalone and registers a metric without changing existing aggregators', () => {
  const input = {
    version: 1,
    subject: { type: 'team', id: 'frontend' },
    configuration: { id: 'usual', revision: 2 },
    policyVersion: TEAM_POLICY_VERSION,
    observations: before,
  };
  expect(scoreEnvelope(input, teamPolicy).metrics).toEqual(scoreTeam(before).metrics);
  const registry = createMetricRegistry([
    ...teamPolicy.registry.definitions,
    {
      id: 'deliveries',
      version: 1,
      unit: 'runs',
      direction: 'higher',
      eligible: (r) => !r.mixed && r.status === 'complete',
      aggregate: (rows) => rows.length,
    },
  ]);
  const extended = { ...teamPolicy, version: 2, registry };
  expect(scoreEnvelope({ ...input, policyVersion: 2 }, extended).metrics.deliveries).toMatchObject({
    value: 3,
    version: 1,
    eligible: 3,
  });
  for (const key of Object.keys(input))
    expect(() => scoreEnvelope({ ...input, [key]: undefined }, teamPolicy)).toThrow();
  const modulePath = new URL('../../shared/scoring/index.mjs', import.meta.url).href;
  const replay = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {scoreEnvelope,teamPolicy} from ${JSON.stringify(modulePath)}; import {readFileSync} from 'node:fs'; console.log(JSON.stringify(scoreEnvelope(JSON.parse(readFileSync(0,'utf8')),teamPolicy)))`,
    ],
    { input: JSON.stringify(input), encoding: 'utf8' },
  );
  expect(replay.status, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout)).toEqual(scoreEnvelope(input, teamPolicy));
});

it('retains workflow v1 null timing, workload, safeguard and median rules', () => {
  const legacy = before.map((r, i) => ({
    ...r,
    project: 'demo',
    workload: 'backend',
    flags: [],
    finalNote: true,
    launches: i,
    loops: i,
  }));
  const faster = legacy.map((r) => ({ ...r, activeMs: 5, id: 'post-' + r.id }));
  const result = (post, key = 'activeMs', guard = 'proofGaps') => compareWorkflow(legacy, post, key, guard);
  expect(result(faster)).toEqual({
    verdict: 'helped',
    before: 10,
    after: 5,
    guardBefore: 0,
    guardAfter: 0,
    beforeIds: before.map((r) => r.id),
    afterIds: faster.map((r) => r.id),
  });
  expect(result([...faster.slice(1), { ...faster[0], activeMs: null }]).verdict).toBe('inconclusive');
  expect(result(faster.map((r) => ({ ...r, workload: null }))).verdict).toBe('helped');
  expect(
    result(
      faster.map((r) => ({ ...r, finalNote: false })),
      'activeMs',
      'missingFinalNotes',
    ).verdict,
  ).toBe('regressed');
  expect(result(faster, 'loops').before).toBe(1);
  expect(compareOutcomes(legacy, faster, 'activeMs', 'proofGaps')).toEqual(result(faster));
});

it('withholds a positive result while either five-run cohort has unverified deliveries', () => {
  const partial = (rows) => rows.map((r, i) => (i === 0 ? { ...r, criteria: [] } : r));
  expect(compareTeamTrial(partial(before), partial(after), 'speed').verdict).toBe('inconclusive');
  expect(
    compareTeamTrial(
      partial(before.map((r) => ({ ...r, criteria: [criterion('missed')] }))),
      partial(after),
      'accuracy',
    ).verdict,
  ).toBe('inconclusive');
});
