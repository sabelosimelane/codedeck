import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createImprovements } from '../pipelines/improvements.js';
import { compareOutcomes, classifyEvidence } from '../../shared/workflow-improvements.mjs';
const workflowId = randomUUID();
const stamp = '2026-11-19T12:00:00.000Z';
const run = (extra = {}) => ({
  id: randomUUID(),
  workflowId,
  definition: {
    workflowRevision: 2,
    workflowName: 'Bug fix',
    steps: [{ name: 'Verify', kind: 'node', prompt: 'Check it' }],
  },
  project: 'Demo',
  input: 'Fix watch',
  taskId: null,
  homePath: '/demo',
  createdAt: stamp,
  updatedAt: stamp,
  finishedAt: stamp,
  status: 'complete',
  steps: [{ elapsedMs: 300, sessionId: 's1', priorSessionIds: [], roundsCompleted: 0 }],
  ...extra,
});
const proposed = (ids) => ({
  kind: 'workflow',
  title: 'Verify the phone',
  reason: 'A device check is missing',
  citations: ids,
  counterevidence: 'A server-only task can finish',
  change: 'Ask for phone evidence',
  step: 'Verify',
  test: 'Missing phone evidence pauses',
  metric: 'loops',
  safeguard: 'proofGaps',
});
function setup(runs, generate) {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE pipeline_runs(id TEXT PRIMARY KEY,status TEXT, updated_at TEXT,current_step_index INTEGER,
      steps TEXT DEFAULT '[{"attempt":1}]')`,
  );
  for (const r of runs)
    db.prepare('INSERT INTO pipeline_runs(id,status,updated_at,current_step_index) VALUES(?,?,?,0)').run(r.id, r.status, r.updatedAt);
  const workflow = {
    id: workflowId,
    name: 'Bug fix',
    description: '',
    kind: 'other',
    progressFile: null,
    agentsDecide: false,
    revision: 2,
    nodes: [{ name: 'Verify', prompt: 'Check it' }],
  };
  const deps = {
    db,
    runs: { get: (id) => runs.find((r) => r.id === id), list: () => runs },
    workflows: {
      get: () => workflow,
      update: (_, v) => Object.assign(workflow, { ...v, revision: v.revision + 1 }),
    },
    tasks: { get: () => null },
    notes: { list: () => [] },
    answers: { list: () => [] },
    decisions: { list: () => [] },
    reviews: { list: () => [] },
    settings: () => ({ provider: 'codex', model: 'test', effort: null }),
    generate,
    now: () => stamp,
  };
  return { db, deps, workflow, service: createImprovements(deps) };
}
describe('workflow reviewer', () => {
  it('batches five outcomes, persists its evidence across restart and fences duplicate approvals', async () => {
    const records = Array.from({ length: 5 }, () => run());
    const generate = vi.fn(async () => ({ proposal: proposed([records[0].id]), cost: null }));
    const { service, deps, workflow } = setup(records, generate);
    await service.tick();
    await createImprovements(deps).tick();
    expect(generate).toHaveBeenCalledTimes(1);
    const [p] = service.proposals();
    expect(service.outcomes()[0]).toMatchObject({ activeMs: null, waitMs: null, launches: 1 });
    service.decide(p.id, { action: 'approve' });
    expect(workflow.nodes[0].prompt).toBe('Ask for phone evidence');
    expect(service.proposals()[0].effectiveRevision).toBe(3);
    expect(() => service.decide(p.id, { action: 'approve' })).toThrow();
  });
  it('rejects unknown evidence and invalid fields before creating a proposal', async () => {
    const records = Array.from({ length: 5 }, () => run());
    for (const patch of [
      { citations: [randomUUID()] },
      ...Object.keys(proposed([])).map((key) => ({ [key]: null })),
    ]) {
      const { service } = setup(records, async () => ({
        proposal: { ...proposed([records[0].id]), ...patch },
        cost: null,
      }));
      await expect(service.tick()).rejects.toThrow();
      expect(service.proposals()).toEqual([]);
    }
  });
  it('refuses a changed workflow revision and records dismissal reasons', async () => {
    const records = Array.from({ length: 5 }, () => run());
    const { service, workflow } = setup(records, async () => ({
      proposal: proposed([records[0].id]),
      cost: null,
    }));
    await service.tick();
    const [p] = service.proposals();
    workflow.revision++;
    expect(() => service.decide(p.id, { action: 'approve' })).toThrow(/revision/i);
    service.decide(p.id, { action: 'dismiss', reason: 'Already covered' });
    expect(service.proposals()[0]).toMatchObject({ status: 'dismissed', reason: 'Already covered' });
  });
  it('detects an unfinished device check and credits a productive verify loop', () => {
    expect(classifyEvidence('Verify', 'On a real phone the owner still sees nothing')).toContain('proofGap');
    expect(classifyEvidence('Verify', 'The symptom is not gone')).toContain('productiveLoop');
    expect(classifyEvidence('Commit', 'Both worktrees already clean; no new commit needed')).toContain(
      'cleanCommit',
    );
    expect(
      classifyEvidence('Commit', 'Committed the fix; tree clean. Git now reports nothing to commit.'),
    ).toEqual([]);
  });
  it('requires comparable workloads, five cases and a preserved safeguard', () => {
    const row = {
      project: 'Demo',
      workload: 'backend',
      status: 'complete',
      loops: 2,
      flags: [],
      finalNote: true,
    };
    const before = Array(5).fill(row),
      after = Array(5).fill({ ...row, loops: 1 });
    const result = (a) => compareOutcomes(before, a, 'loops', 'proofGaps').verdict;
    expect(result(after)).toBe('helped');
    expect(result(after.map((r) => ({ ...r, workload: 'backend and mobile' })))).toBe('inconclusive');
    expect(result(after.slice(1))).toBe('inconclusive');
    expect(result(after.map((x) => ({ ...x, project: 'Different' })))).toBe('inconclusive');
    expect(result(after.map((x) => ({ ...x, flags: ['proofGap'] })))).toBe('regressed');
  });
});

it('blinds a reviewer benchmark, fences activation and uses the approved rubric next time', async () => {
  const records = Array.from({ length: 5 }, () => run()),
    candidate = {
      ...proposed([records[0].id]),
      kind: 'reviewer',
      step: null,
      change: 'Check device acceptance separately',
    };
  const generate = vi.fn(async (_config, input) => {
    if (input.cases)
      return {
        labels: input.cases.map((c) => (c.request === 'External device pending' ? 'proofGap' : 'ordinary')),
        cost: null,
      };
    return { proposal: candidate, cost: null };
  });
  const { service, db } = setup(records, generate);
  await service.tick();
  const [p] = service.proposals();
  expect(() => service.decide(p.id, { action: 'approve' })).toThrow(/benchmark/);
  for (const [request, label] of [
    ['External device pending', 'proofGap'],
    ['All checks passed', 'ordinary'],
  ]) {
    const r = run({ input: request });
    records.push(r);
    db.prepare('INSERT INTO pipeline_runs(id,status,updated_at,current_step_index) VALUES(?,?,?,0)').run(r.id, r.status, r.updatedAt);
    await service.tick();
    service.label(r.id, label);
  }
  expect(await service.evaluate(p.id)).toMatchObject({ passed: true, count: 2 });
  expect(generate.mock.calls.at(-1)[1].cases.every((c) => !('label' in c))).toBe(true);
  service.decide(p.id, { action: 'approve' });
  expect(service.status().reviewerRevision).toBe(2);
});

it('separates input and approval waiting from execution for newly observed runs', async () => {
  const records = [],
    { db, service } = setup(records, vi.fn());
  const r = run();
  records.push(r);
  const update = (status, seconds) =>
    db
      .prepare('UPDATE pipeline_runs SET status=?, updated_at=? WHERE id=?')
      .run(status, new Date(Date.parse(stamp) + seconds * 1000).toISOString(), r.id);
  db.prepare('INSERT INTO pipeline_runs(id,status,updated_at,current_step_index) VALUES(?,?,?,0)').run(r.id, 'pending', stamp);
  update('running', 1);
  update('needs_input', 3);
  update('running', 8);
  update('awaiting_approval', 10);
  update('complete', 14);
  await service.tick();
  expect(service.outcomes()[0]).toMatchObject({ activeMs: 4000, waitMs: 9000 });
});
it('records a model finding only when its quoted evidence is in the reviewed run', async () => {
  const records = Array.from({ length: 5 }, () => run({ input: 'Phone evidence is outstanding' }));
  const response = {
    proposal: null,
    cost: null,
    findings: [{ id: records[0].id, label: 'proofGap', quote: 'Phone evidence is outstanding' }],
  };
  const { service } = setup(records, async () => response);
  await service.tick();
  expect(service.outcomes().find((r) => r.id === records[0].id).flags).toContain('proofGap');
  const bad = setup(records, async () => ({
    ...response,
    findings: [{ ...response.findings[0], quote: 'invented evidence' }],
  }));
  await expect(bad.service.tick()).rejects.toThrow(/quote/);
});
it('retains a valid single-line handoff for runner implementation', async () => {
  const { runnerBrief } = await import('../../shared/workflow-improvements.mjs');
  const draft = {
    ...proposed([randomUUID()]),
    kind: 'runner',
    step: null,
    change: 'Edit the runner.\nKeep a trace.',
  };
  expect(runnerBrief(draft)).not.toMatch(/[\n\r]/);
  expect(runnerBrief(draft)).toContain('Keep a trace.');
});
it('reclaims an expired job without leaving a third abandoned attempt active', async () => {
  const records = Array.from({ length: 5 }, () => run());
  const { service, db } = setup(records, async () => ({ proposal: null, cost: null }));
  await service.tick();
  db.prepare("UPDATE improvement_jobs SET status='working',attempts=3,next_at=?").run(stamp);
  await service.tick();
  expect(service.status().queued).toBe(0);
});
it('sets a reviewer-only model and fences concurrent edits', async () => {
  const records = Array.from({ length: 5 }, () => run());
  const model = vi.fn(async () => ({ proposal: null, cost: null })),
    { service, deps } = setup(records, model);
  expect(service.status().model).toBe('test');
  service.configure({ revision: 0, provider: 'codex', model: 'gpt-selected', effort: 'low' });
  expect(() => service.configure({ revision: 0, provider: 'claude', model: 'sonnet', effort: null })).toThrow(
    /revision/,
  );
  expect(deps.settings().model).toBe('test');
  await service.tick();
  expect(model.mock.calls[0][0].model).toBe('gpt-selected');
});
it('keeps unresolved proof visible when an agent calls it ordinary', async () => {
  const r = run(),
    { deps } = setup([r], async () => ({
      proposal: null,
      cost: null,
      findings: [{ id: r.id, label: 'ordinary', quote: 'Phone check pending' }],
    }));
  deps.notes.list = () => [
    {
      id: 1,
      status: 'written',
      stepIndex: 0,
      summary: 'Phone check pending',
      content: 'Phone check pending',
    },
  ];
  const service = createImprovements(deps);
  await service.tick();
  expect(service.outcomes()[0].flags).toContain('proofGap');
});
it('enforces its daily call budget across processes', async () => {
  const records = Array.from({ length: 55 }, () => run()),
    generate = vi.fn(async () => ({ proposal: null, cost: null }));
  const { service, deps } = setup(records, generate);
  for (let i = 0; i < 10; i++) await service.tick();
  await createImprovements(deps).tick();
  expect(generate).toHaveBeenCalledTimes(10);
  expect(service.status().queued).toBe(1);
});
it('validates the public dashboard records on read for every field', async () => {
  const { validateProposal, validateCall, validateReviewerStatus, validatePacket, validateOutcome } =
    await import('../../shared/workflow-improvements.mjs');
  const records = Array.from({ length: 5 }, () => run());
  const { service } = setup(records, async () => ({ proposal: proposed([records[0].id]), cost: 0.01 }));
  await service.tick();
  for (const [guard, value] of [
    [validateProposal, service.proposals()[0]],
    [validateCall, service.calls()[0]],
    [validateReviewerStatus, service.status()],
    [validatePacket, service.packet(records[0].id)],
    [validateOutcome, service.outcomes()[0]],
  ]) {
    expect(guard(value)).toBe(value);
    for (const field of Object.keys(value)) {
      const broken = { ...value };
      delete broken[field];
      expect(() => guard(broken), field).toThrow();
    }
  }
});
it('invalidates a passed reviewer evaluation if the chosen model changes', async () => {
  const records = Array.from({ length: 5 }, () => run());
  const { service, db } = setup(records, async (_, input) =>
    input.cases
      ? { labels: input.cases.map((c) => (c.request === 'passed' ? 'ordinary' : 'proofGap')), cost: null }
      : { proposal: { ...proposed([records[0].id]), step: null, kind: 'reviewer' }, cost: null },
  );
  await service.tick();
  const [p] = service.proposals();
  for (const [input, label] of [
    ['passed', 'ordinary'],
    ['pending', 'proofGap'],
  ]) {
    const r = run({ input });
    records.push(r);
    db.prepare('INSERT INTO pipeline_runs(id,status,updated_at,current_step_index) VALUES(?,?,?,0)').run(r.id, r.status, r.updatedAt);
    await service.tick();
    service.label(r.id, label);
  }
  expect((await service.evaluate(p.id)).passed).toBe(true);
  service.configure({ revision: 0, provider: 'codex', model: 'another', effort: null });
  expect(() => service.decide(p.id, { action: 'approve' })).toThrow(/benchmark/);
});

it('requires a task lookup for workload matching at startup', () => {
  const { deps } = setup([], vi.fn());
  expect(() => createImprovements({ ...deps, tasks: {} })).toThrow(/tasks.get/);
});

it('reviews a new proof gap before an older routine batch waiting in the queue', async () => {
  const records = Array.from({ length: 5 }, () => run());
  const generate = vi.fn(async () => ({ proposal: null, cost: null }));
  const { deps, db } = setup(records, generate);
  deps.settings = () => null;
  const service = createImprovements(deps);
  await service.tick();
  db.prepare('UPDATE improvement_jobs SET next_at=?').run('2026-11-18T00:00:00.000Z');
  const gap = run();
  records.push(gap);
  db.prepare('INSERT INTO pipeline_runs(id,status,updated_at,current_step_index) VALUES(?,?,?,0)').run(gap.id, gap.status, gap.updatedAt);
  deps.notes.list = (id) =>
    id === gap.id
      ? [
          {
            id: 1,
            status: 'written',
            stepIndex: 0,
            summary: 'Phone check pending',
            content: 'Phone check pending',
          },
        ]
      : [];
  service.configure({ revision: 0, provider: 'claude', model: 'sonnet', effort: null });
  await service.tick();
  expect(generate.mock.calls[0][1].evidence.map((e) => e.outcome.id)).toEqual([gap.id]);
});

it('charges team assessments to the shared reviewer budget and records invalid responses as failed calls', async () => {
  const {service} = setup([],async () => ({criteria:[],complete:false,cost:null}));
  const packet = {instructions:'Assess criteria',rubric:'Cite evidence'};
  await expect(service.reviewDelivery(workflowId,2,packet,() => {throw new Error('bad citation')})).rejects.toThrow('bad citation');
  let saved = 0;
  for (let i=1;i<10;i++) expect(await service.reviewDelivery(workflowId,2,packet,() => saved++)).toBe(true);
  expect(await service.reviewDelivery(workflowId,2,packet,() => saved++)).toBe(false);
  expect(saved).toBe(9);
  expect(service.calls().filter(c=>c.status==='failed')).toHaveLength(1);
});
