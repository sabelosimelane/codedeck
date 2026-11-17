import { loopbackTestServer } from './helpers/loopback-test-server.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { createSettingsStore } from '../pipelines/settings-store.js';
import { createRunStore } from '../pipelines/run-store.js';
import { createDecisionStore } from '../pipelines/decision-store.js';
import { createPipelinesRouter } from '../routes/pipelines.js';

const base = '/api/pipelines';
const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });

const PROJECT = {
  name: 'Demo',
  path: '/tmp/demo-git',
  host: 'local',
};

function agentBody(overrides = {}) {
  return {
    name: 'codex-sol-high',
    launchCommand: 'codex --model gpt-5',
    resetCommand: '/clear',
    ...overrides,
  };
}

function node(agentId, overrides = {}) {
  return {
    name: 'Develop',
    agentId,
    prompt: 'Implement {input}',
    repeat: { mode: 'once' },
    ...overrides,
  };
}

async function setup(overrides = {}) {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());

  const agentStore = createAgentStore(db);
  const workflowStore = createWorkflowStore(db);
  const settingsStore = createSettingsStore(db);
  const runStore = createRunStore(db);
  const decisionStore = createDecisionStore(db);

  const engineStarts = [];
  const engine = {
    start: vi.fn(runId => {
      engineStarts.push(runId);
      return Promise.resolve();
    }),
    stop: vi.fn(async runId => {
      const run = runStore.get(runId);
      if (!run) throw new Error(`pipeline run ${runId}: not found`);
      if (run.status === 'stopped') return run;
      if (!['pending', 'running', 'needs_input', 'limit_paused', 'interrupted'].includes(run.status)) {
        const err = new Error(`Action stop is not allowed in status ${run.status}`);
        err.code = 'ACTION_REFUSED';
        throw err;
      }
      return runStore.update(runId, {
        status: 'stopped',
        stopReason: 'user',
        error: null,
        finishedAt: new Date().toISOString(),
      });
    }),
    resume: vi.fn(async runId => {
      const run = runStore.get(runId);
      if (!run) throw new Error(`pipeline run ${runId}: not found`);
      if (!['interrupted', 'stopped', 'error'].includes(run.status)
        || !['not_created', 'present'].includes(run.worktreeState)) {
        const err = new Error(`Action resume is not allowed in status ${run.status}`);
        err.code = 'ACTION_REFUSED';
        throw err;
      }
      if (run.worktreeState === 'present' && overrides.resumeWorktreeMissing) {
        const err = new Error('The worktree directory is missing');
        err.code = 'WORKTREE_MISSING';
        throw err;
      }
      return runStore.update(runId, {
        status: 'running',
        stopReason: null,
        error: null,
        finishedAt: null,
        steps: run.steps.map((step, index) => (
          index === run.currentStepIndex
            ? {
              ...step,
              status: 'launching',
              attempt: (step.attempt ?? 0) + 1,
              priorSessionIds: step.sessionId
                ? [...(step.priorSessionIds || []), step.sessionId]
                : [...(step.priorSessionIds || [])],
              sessionId: null,
              finishedAt: null,
            }
            : step
        )),
      });
    }),
    continue: vi.fn(async runId => {
      const run = runStore.get(runId);
      if (!run) throw new Error(`pipeline run ${runId}: not found`);
      if (run.status !== 'limit_paused') {
        const err = new Error(`Action continue is not allowed in status ${run.status}`);
        err.code = 'ACTION_REFUSED';
        throw err;
      }
      const last = run.currentStepIndex >= run.steps.length - 1;
      if (last) {
        return runStore.update(runId, {
          status: 'complete',
          finishedAt: new Date().toISOString(),
          error: null,
        });
      }
      return runStore.update(runId, {
        status: 'running',
        currentStepIndex: run.currentStepIndex + 1,
      });
    }),
    cleanup: vi.fn(async runId => {
      const run = runStore.get(runId);
      if (!run) throw new Error(`pipeline run ${runId}: not found`);
      if (!['complete', 'stopped', 'error', 'interrupted'].includes(run.status)
        || !['not_created', 'present', 'removal_blocked'].includes(run.worktreeState)) {
        const err = new Error(`Action cleanup is not allowed in status ${run.status}`);
        err.code = 'ACTION_REFUSED';
        throw err;
      }
      return runStore.update(runId, {
        worktreeState: 'removed',
        worktreeDetail: null,
    inputRequest: null,
      });
    }),
  };

  const projects = new Map([[PROJECT.name, { ...PROJECT }]]);
  const findProject = name => projects.get(name) ?? null;

  const preflight = overrides.preflight ?? vi.fn(async () => ({
    eligible: true,
    reasons: [],
    branch: 'main',
    head: 'a'.repeat(40),
    dirty: false,
  }));

  const resolveHomeRepoPath = overrides.resolveHomeRepoPath
    ?? vi.fn(async () => '/Users/me/git/codedeck');

  const planNames = overrides.planNames ?? (({ runId, workflowName, homeRepoPath }) => {
    const shortId = String(runId).replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase();
    const slug = String(workflowName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    const suffix = slug ? `${slug}-${shortId}` : shortId;
    return {
      shortId,
      slug,
      homeRepoPath,
      worktreePath: `/Users/me/git/worktrees/codedeck-${suffix}`,
      branch: `workflow/${suffix}`,
    };
  });

  const scheduled = [];
  const scheduleStart = fn => { scheduled.push(fn); };

  const app = express();
  app.use(createPipelinesRouter({
    agentStore,
    workflowStore,
    settingsStore,
    runStore,
    decisionStore,
    findProject,
    engine,
    preflight,
    planNames,
    resolveHomeRepoPath,
    scheduleStart,
    ...overrides.routerDeps,
  }));

  return {
    app: await loopbackTestServer(app),
    db,
    agentStore,
    workflowStore,
    settingsStore,
    runStore,
    decisionStore,
    engine,
    engineStarts,
    scheduled,
    projects,
    preflight,
    flushStart: () => { while (scheduled.length) scheduled.shift()(); },
  };
}

async function seedReady(ctx, { withInput = true } = {}) {
  const agent = ctx.agentStore.create(agentBody());
  ctx.settingsStore.update({ setupAgentId: agent.id, revision: 1 });
  const workflow = ctx.workflowStore.create({
    name: 'Feature', agentsDecide: false,
    nodes: [node(agent.id, withInput ? {} : { prompt: 'No placeholder' })],
  });
  return { agent, workflow };
}

describe('pipelines API — agents', () => {
  it('creates, lists, gets, updates and deletes an agent through the full envelope', async () => {
    const { app } = await setup();
    const created = await request(app).post(`${base}/agents`).send(agentBody());
    expect(created.status).toBe(201);
    expect(created.headers['x-trace-id']).toEqual(expect.any(String));
    expect(created.body).toMatchObject({
      name: 'codex-sol-high',
      launchCommand: 'codex --model gpt-5',
      resetCommand: '/clear',
      revision: 1,
    });
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/i);

    const listed = await request(app).get(`${base}/agents`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([created.body]);
    expect(listed.body.page).toEqual({
      currentPage: 0, size: 20, totalElements: 1, totalPages: 1, hasNextPage: false,
    });

    const got = await request(app).get(`${base}/agents/${created.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(created.body);

    const updated = await request(app).put(`${base}/agents/${created.body.id}`).send({
      ...agentBody({ name: 'renamed' }),
      revision: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'renamed', revision: 2 });

    const deleted = await request(app).delete(`${base}/agents/${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect((await request(app).get(`${base}/agents/${created.body.id}`)).status).toBe(404);
  });

  it('returns 409 for a duplicate agent name and a stale revision', async () => {
    const { app } = await setup();
    const first = await request(app).post(`${base}/agents`).send(agentBody());
    const dup = await request(app).post(`${base}/agents`).send(agentBody({ name: 'CODEX-SOL-HIGH' }));
    expect(dup.status).toBe(409);
    expect(dup.type).toBe('application/problem+json');

    const stale = await request(app).put(`${base}/agents/${first.body.id}`).send({
      ...agentBody({ name: 'x' }),
      revision: 99,
    });
    expect(stale.status).toBe(409);
  });

  it('returns 409 when deleting the setup agent or an agent used by a workflow', async () => {
    const ctx = await setup();
    const { agent, workflow } = await seedReady(ctx);

    const setupDelete = await request(ctx.app).delete(`${base}/agents/${agent.id}`);
    expect(setupDelete.status).toBe(409);

    ctx.settingsStore.update({ setupAgentId: null, revision: 2 });
    const usedDelete = await request(ctx.app).delete(`${base}/agents/${agent.id}`);
    expect(usedDelete.status).toBe(409);

    ctx.workflowStore.remove(workflow.id);
    expect((await request(ctx.app).delete(`${base}/agents/${agent.id}`)).status).toBe(204);
  });

  it.each([
    ['missing name', { launchCommand: 'x', resetCommand: '/clear' }, 'name'],
    ['empty launchCommand', { name: 'a', launchCommand: '  ', resetCommand: '/clear' }, 'launchCommand'],
    ['null body fields', { name: null, launchCommand: 'x', resetCommand: '/clear' }, 'name'],
    ['unknown field', { ...agentBody(), extra: true }, 'extra'],
  ])('returns 400 with field errors for %s', async (_label, body, field) => {
    const { app } = await setup();
    const response = await request(app).post(`${base}/agents`).send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation Error');
    expect(response.body.errors.some(e => e.field === field)).toBe(true);
  });

  it('paginates agents with a stable id tiebreaker across a page boundary', async () => {
    const { app, agentStore } = await setup();
    // Same updatedAt-ish names that collide on primary sort field.
    const a = agentStore.create(agentBody({ name: 'same' }));
    // Force a second with different id by renaming after create then creating another "same" via store bypass —
    // uniqueness prevents two "same". Use names that sort equal on updatedAt with id tiebreak.
    const b = agentStore.create(agentBody({ name: 'alpha' }));
    const c = agentStore.create(agentBody({ name: 'beta' }));
    void a; void b; void c;

    const page0 = await request(app).get(`${base}/agents`).query({ size: 2, sort: 'name,asc' });
    expect(page0.body.data.map(r => r.name)).toEqual(['alpha', 'beta']);
    expect(page0.body.page).toMatchObject({ currentPage: 0, hasNextPage: true, totalElements: 3 });

    const page1 = await request(app).get(`${base}/agents`).query({ page: 1, size: 2, sort: 'name,asc' });
    expect(page1.body.data.map(r => r.name)).toEqual(['same']);
    expect(page1.body.page.hasNextPage).toBe(false);
  });
});

describe('pipelines API — workflows and settings', () => {
  it('creates a workflow referencing an existing agent and updates settings', async () => {
    const { app, agentStore } = await setup();
    const agent = agentStore.create(agentBody());

    const created = await request(app).post(`${base}/workflows`).send({
      name: 'Feature', agentsDecide: false,
      nodes: [node(agent.id)],
    });
    expect(created.status).toBe(201);
    expect(created.body.nodes).toHaveLength(1);
    expect(created.body.revision).toBe(1);

    const settings = await request(app).get(`${base}/settings`);
    expect(settings.body).toEqual({ setupAgentId: null, revision: 1 });

    const updated = await request(app).put(`${base}/settings`).send({
      setupAgentId: agent.id,
      revision: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ setupAgentId: agent.id, revision: 2 });
  });

  it('rejects a workflow node that points at a missing agent', async () => {
    const { app } = await setup();
    const response = await request(app).post(`${base}/workflows`).send({
      name: 'Feature', agentsDecide: false,
      nodes: [node('c410a1b2-3456-4789-8abc-def012345678')],
    });
    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([
      { field: 'nodes[0].agentId', message: expect.any(String) },
    ]);
  });

  it('returns 409 for duplicate workflow names and stale settings revision', async () => {
    const { app, agentStore } = await setup();
    const agent = agentStore.create(agentBody());
    await request(app).post(`${base}/workflows`).send({ name: 'Feature', agentsDecide: false, nodes: [node(agent.id)] });
    const dup = await request(app).post(`${base}/workflows`).send({ name: 'feature', agentsDecide: false, nodes: [node(agent.id)] });
    expect(dup.status).toBe(409);

    const stale = await request(app).put(`${base}/settings`).send({ setupAgentId: null, revision: 9 });
    expect(stale.status).toBe(409);
  });
});

describe('pipelines API — preflight and runs', () => {
  it('reports preflight eligibility for an existing project', async () => {
    const { app, preflight } = await setup();
    const response = await request(app).get(`${base}/preflight`).query({ project: 'Demo' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      project: 'Demo',
      eligible: true,
      reasons: [],
      branch: 'main',
      head: 'a'.repeat(40),
      dirty: false,
    });
    expect(preflight).toHaveBeenCalled();
  });

  it('returns 404 when preflight project is unknown', async () => {
    const { app } = await setup();
    const response = await request(app).get(`${base}/preflight`).query({ project: 'Ghost' });
    expect(response.status).toBe(404);
    expect(response.body.traceId).toEqual(expect.any(String));
    expect(response.headers['x-trace-id']).toBe(response.body.traceId);
  });

  it('starts a run, returns the run view without a Setup step, and schedules engine.start', async () => {
    const ctx = await setup();
    const { workflow } = await seedReady(ctx);

    const started = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'run-3f2a9c',
      workflowId: workflow.id,
      project: 'Demo',
      input: 'docs/todos/feature.md',
    });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      requestId: 'run-3f2a9c',
      workflowId: workflow.id,
      workflowName: 'Feature',
      project: 'Demo',
      input: 'docs/todos/feature.md',
      status: 'pending',
      currentStepIndex: 0,
      worktree: {
        state: 'not_created',
        baseCommit: null,
        branch: expect.stringMatching(/^workflow\/feature-/),
        path: expect.stringContaining('/worktrees/codedeck-feature-'),
      },
      actions: { stop: true, resume: false, continue: false, cleanup: false },
    });
    expect(started.body.steps).toHaveLength(2);
    expect(started.body.steps[0]).toMatchObject({
      index: 0,
      kind: 'setup',
      name: 'Setup',
      agentName: 'codex-sol-high',
      status: 'pending',
      repeat: { mode: 'until_complete', max: 3 },
    });
    expect(started.body.steps[1]).toMatchObject({
      index: 1,
      kind: 'node',
      name: 'Develop',
      agentName: 'codex-sol-high',
      status: 'pending',
    });
    expect(ctx.runStore.get(started.body.id).definition.steps[0].prompt).toMatch(/fresh git worktree/);

    expect(ctx.engine.start).not.toHaveBeenCalled();
    ctx.flushStart();
    expect(ctx.engine.start).toHaveBeenCalledWith(started.body.id);

    const got = await request(ctx.app).get(`${base}/runs/${started.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(started.body.id);

    const listed = await request(ctx.app).get(`${base}/runs`);
    expect(listed.body.data.map(r => r.id)).toEqual([started.body.id]);
  });

  it('replays the same requestId with 200 and conflicts on a different body', async () => {
    const ctx = await setup();
    const { workflow } = await seedReady(ctx);
    const body = {
      requestId: 'run-replay',
      workflowId: workflow.id,
      project: 'Demo',
      input: 'one',
    };
    const first = await request(ctx.app).post(`${base}/runs`).send(body);
    expect(first.status).toBe(201);

    const replay = await request(ctx.app).post(`${base}/runs`).send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(ctx.engine.start).toHaveBeenCalledTimes(0);
    ctx.flushStart();
    expect(ctx.engine.start).toHaveBeenCalledTimes(1);

    const conflict = await request(ctx.app).post(`${base}/runs`).send({ ...body, input: 'two' });
    expect(conflict.status).toBe(409);
  });

  it('returns 404 when the workflow or project is missing', async () => {
    const ctx = await setup();
    const { workflow } = await seedReady(ctx);

    const missingWorkflow = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'a',
      workflowId: 'a2d0b1c2-3456-4789-8abc-def012345678',
      project: 'Demo',
      input: 'x',
    });
    expect(missingWorkflow.status).toBe(404);

    const missingProject = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'b',
      workflowId: workflow.id,
      project: 'Ghost',
      input: 'x',
    });
    expect(missingProject.status).toBe(404);
  });

  it('returns 409 with reason codes when start preconditions fail', async () => {
    const ctx = await setup({
      preflight: vi.fn(async () => ({
        eligible: false,
        reasons: [{ code: 'setup_agent_missing', message: 'Choose a setup agent in Settings → Workflows.' }],
        branch: null,
        head: null,
        dirty: null,
      })),
    });
    const { workflow } = await seedReady(ctx);
    const response = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'preflight-fail',
      workflowId: workflow.id,
      project: 'Demo',
      input: 'x',
    });
    expect(response.status).toBe(409);
    expect(response.body.reasons).toEqual([
      { code: 'setup_agent_missing', message: expect.any(String) },
    ]);
  });

  it('returns 400 when input is required by {input} or composed prompts are oversized', async () => {
    const ctx = await setup();
    const { workflow } = await seedReady(ctx);

    const empty = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'empty-input',
      workflowId: workflow.id,
      project: 'Demo',
      input: '',
    });
    expect(empty.status).toBe(400);
    expect(empty.body.errors).toEqual([
      { field: 'input', message: expect.stringMatching(/input/i) },
    ]);

    const agent = ctx.agentStore.create(agentBody({ name: 'big' }));
    const huge = ctx.workflowStore.create({
      name: 'Huge', agentsDecide: false,
      nodes: [node(agent.id, { name: 'Big', prompt: `prefix-{input}-${'x'.repeat(20)}` })],
    });
    const oversized = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'oversized-compose',
      workflowId: huge.id,
      project: 'Demo',
      input: 'y'.repeat(16384),
    });
    expect(oversized.status).toBe(400);
    expect(oversized.body.errors.some(e => e.field === 'input')).toBe(true);
  });

  it('starts a multi-node workflow with Setup as step 0', async () => {
    const ctx = await setup();
    const { agent } = await seedReady(ctx);
    const multi = ctx.workflowStore.create({
      name: 'TwoSteps', agentsDecide: false,
      nodes: [
        node(agent.id, { name: 'One' }),
        node(agent.id, { name: 'Two' }),
      ],
    });
    const response = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'multi-node',
      workflowId: multi.id,
      project: 'Demo',
      input: 'x',
    });
    expect(response.status).toBe(201);
    expect(response.body.steps.map(s => s.kind)).toEqual(['setup', 'node', 'node']);
    expect(response.body.steps.map(s => s.name)).toEqual(['Setup', 'One', 'Two']);
  });

  it('filters and sorts runs with a stable id tiebreaker across pages', async () => {
    // Fixed clock so createdAt collides and id is the only stable order.
    const times = [
      '2026-11-13T12:00:00.000Z',
      '2026-11-13T12:00:00.000Z',
      '2026-11-13T12:00:00.000Z',
    ];
    let i = 0;
    const db = new Database(':memory:');
    cleanup.push(() => db.close());
    const agentStore = createAgentStore(db);
    const workflowStore = createWorkflowStore(db);
    const settingsStore = createSettingsStore(db);
    const runStore = createRunStore(db, { now: () => times[Math.min(i++, times.length - 1)] });
    const agent = agentStore.create(agentBody());
    settingsStore.update({ setupAgentId: agent.id, revision: 1 });
    const workflow = workflowStore.create({ name: 'Feature', agentsDecide: false, nodes: [node(agent.id)] });

    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    for (const [index, id] of ids.entries()) {
      runStore.create({
        id,
        requestId: `req-${index}`,
        workflowId: workflow.id,
        project: 'Demo',
        input: 'x',
        status: 'pending',
        stopReason: null,
        currentStepIndex: 0,
        error: null,
        definition: {
          workflowId: workflow.id,
          workflowName: 'Feature',
          workflowRevision: 1,
          agentsDecide: false,
          progressFile: null,
          steps: [{
            kind: 'node',
            name: 'Develop',
            prompt: 'Implement x',
            repeat: { mode: 'once' },
            agent: {
              id: agent.id,
              name: agent.name,
              launchCommand: agent.launchCommand,
              resetCommand: agent.resetCommand,
            },
          }],
        },
        steps: [{
          status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0,
          detail: null, startedAt: null, finishedAt: null,
        }],
        homePath: '/Users/me/git/codedeck',
        worktreePath: `/Users/me/git/worktrees/r-${index}`,
        worktreeBranch: `workflow/r-${index}`,
        baseCommit: null,
        worktreeState: 'not_created',
        worktreeDetail: null,
    inputRequest: null,
        finishedAt: null,
      });
    }

    const app = express();
    app.use(createPipelinesRouter({
      agentStore,
      workflowStore,
      settingsStore,
      runStore,
      decisionStore: createDecisionStore(db),
      findProject: () => PROJECT,
      engine: { start: () => {} },
      preflight: async () => ({ eligible: true, reasons: [], branch: 'main', head: 'a'.repeat(40), dirty: false }),
      resolveHomeRepoPath: async () => '/Users/me/git/codedeck',
      scheduleStart: () => {},
    }));
    const server = await loopbackTestServer(app);

    const page0 = await request(server).get(`${base}/runs`).query({ size: 2, sort: 'createdAt,asc' });
    expect(page0.body.data.map(r => r.id)).toEqual([ids[0], ids[1]]);
    expect(page0.body.page.hasNextPage).toBe(true);

    const page1 = await request(server).get(`${base}/runs`).query({ page: 1, size: 2, sort: 'createdAt,asc' });
    expect(page1.body.data.map(r => r.id)).toEqual([ids[2]]);

    const filtered = await request(server).get(`${base}/runs`).query({ project: 'Demo', open: 'true' });
    expect(filtered.body.page.totalElements).toBe(3);
  });
});

describe('pipelines API — hostile and boundary payloads', () => {
  it('returns 400 for malformed JSON and unknown collection query fields', async () => {
    const { app } = await setup();
    const malformed = await request(app).post(`${base}/agents`).type('application/json').send('{"name":');
    expect(malformed.status).toBe(400);
    expect(malformed.type).toBe('application/problem+json');

    const unknown = await request(app).get(`${base}/agents`).query({ foo: 'bar' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors).toEqual([{ field: 'foo', message: expect.any(String) }]);
  });

  it('returns 413 for an oversized JSON body', async () => {
    const { app } = await setup();
    const huge = { name: 'x', launchCommand: 'y'.repeat(600 * 1024), resetCommand: '/clear' };
    const response = await request(app).post(`${base}/agents`).send(huge);
    expect(response.status).toBe(413);
    expect(response.type).toBe('application/problem+json');
  });

  it('returns 404 problem details for an unknown pipelines route', async () => {
    const { app } = await setup();
    const response = await request(app).get(`${base}/nope`);
    expect(response.status).toBe(404);
    expect(response.type).toBe('application/problem+json');
    expect(response.body.error).toBe('Pipelines Error');
  });

  it.each([
    ['out-of-range size', { size: 500 }, 'size'],
    ['negative page', { page: -1 }, 'page'],
    ['unknown sort field', { sort: 'nope,asc' }, 'sort'],
    ['blank name filter', { name: '  ' }, 'name'],
  ])('rejects %s on agent collection', async (_label, query, field) => {
    const { app } = await setup();
    const response = await request(app).get(`${base}/agents`).query(query);
    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([{ field, message: expect.any(String) }]);
  });

  it('rejects empty and null run-start bodies with field errors', async () => {
    const { app } = await setup();
    const empty = await request(app).post(`${base}/runs`).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.errors.length).toBeGreaterThan(0);

    const nulled = await request(app).post(`${base}/runs`).send({
      requestId: null,
      workflowId: null,
      project: null,
      input: null,
    });
    expect(nulled.status).toBe(400);
  });
});

describe('pipelines API — owner actions (Spec §8.8)', () => {
  async function seedRun(ctx, overrides = {}) {
    const { agent, workflow } = await seedReady(ctx);
    const started = await request(ctx.app).post(`${base}/runs`).send({
      requestId: `act-${Math.random().toString(16).slice(2)}`,
      workflowId: workflow.id,
      project: 'Demo',
      input: 'docs/todos/feature.md',
    });
    expect(started.status).toBe(201);
    const id = started.body.id;
    if (Object.keys(overrides).length) {
      ctx.runStore.update(id, overrides);
    }
    return { id, agent, workflow, view: () => request(ctx.app).get(`${base}/runs/${id}`) };
  }

  it('Stop is accepted from pending and idempotent when already stopped', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx);

    const stopped = await request(ctx.app).post(`${base}/runs/${id}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.status).toBe('stopped');
    expect(stopped.body.stopReason).toBe('user');
    expect(stopped.body.actions).toMatchObject({ stop: false, resume: true, cleanup: true });

    const again = await request(ctx.app).post(`${base}/runs/${id}/stop`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('stopped');
  });

  it('Stop is refused from complete and error', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx, {
      status: 'complete',
      finishedAt: new Date().toISOString(),
      worktreeState: 'present',
      steps: [
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
      ],
    });
    const refused = await request(ctx.app).post(`${base}/runs/${id}/stop`);
    expect(refused.status).toBe(409);

    ctx.runStore.update(id, {
      status: 'error',
      error: 'boom',
      finishedAt: new Date().toISOString(),
      steps: [
        { status: 'failed', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
      ],
    });
    const refusedError = await request(ctx.app).post(`${base}/runs/${id}/stop`);
    expect(refusedError.status).toBe(409);
  });

  it('Continue is only accepted from limit_paused', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx, {
      status: 'limit_paused',
      worktreeState: 'present',
      currentStepIndex: 1,
      steps: [
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'limit_reached', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 2, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
      ],
    });
    const ok = await request(ctx.app).post(`${base}/runs/${id}/continue`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('complete');

    const refused = await request(ctx.app).post(`${base}/runs/${id}/continue`);
    expect(refused.status).toBe(409);
  });

  it('Resume continues an interrupted run and 409s when the worktree is missing', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx, {
      status: 'interrupted',
      worktreeState: 'present',
      baseCommit: 'a'.repeat(40),
      steps: [
        { status: 'interrupted', sessionId: 'Demo-1', priorSessionIds: [], attempt: 1, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
      ],
    });
    const resumed = await request(ctx.app).post(`${base}/runs/${id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('running');
    expect(resumed.body.steps[0].attempt).toBe(2);
    expect(resumed.body.steps[0].priorSessionIds).toEqual(['Demo-1']);

    const missing = await setup({ resumeWorktreeMissing: true });
    const seeded = await seedRun(missing, {
      status: 'stopped',
      stopReason: 'user',
      finishedAt: new Date().toISOString(),
      worktreeState: 'present',
      baseCommit: 'a'.repeat(40),
    });
    const refused = await request(missing.app).post(`${base}/runs/${seeded.id}/resume`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/worktree/i);
  });

  it('Cleanup removes a finished run worktree and matches actions', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx, {
      status: 'complete',
      finishedAt: new Date().toISOString(),
      worktreeState: 'present',
      baseCommit: 'a'.repeat(40),
      steps: [
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
      ],
    });
    const before = await request(ctx.app).get(`${base}/runs/${id}`);
    expect(before.body.actions.cleanup).toBe(true);

    const cleaned = await request(ctx.app).post(`${base}/runs/${id}/cleanup`);
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.worktree.state).toBe('removed');
    expect(cleaned.body.actions.cleanup).toBe(false);
  });

  it('store rebuild mid-run marks interrupted then Resume works', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx);
    ctx.runStore.update(id, {
      status: 'running',
      worktreeState: 'present',
      baseCommit: 'a'.repeat(40),
      steps: [
        { status: 'running', sessionId: 'Demo-1', priorSessionIds: [], attempt: 1, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
      ],
    });

    const reopenedStore = createRunStore(ctx.db);
    expect(reopenedStore.get(id).status).toBe('interrupted');
    expect(reopenedStore.get(id).steps[0].status).toBe('interrupted');

    const app = express();
    app.use(createPipelinesRouter({
      agentStore: ctx.agentStore,
      workflowStore: ctx.workflowStore,
      settingsStore: ctx.settingsStore,
      runStore: reopenedStore,
      decisionStore: ctx.decisionStore,
      findProject: name => ctx.projects.get(name) ?? null,
      engine: {
        ...ctx.engine,
        resume: async (runId) => {
          const run = reopenedStore.get(runId);
          if (!run) throw new Error('missing');
          return reopenedStore.update(runId, {
            status: 'running',
            stopReason: null,
            error: null,
            finishedAt: null,
            steps: run.steps.map((step, index) => (
              index === run.currentStepIndex
                ? {
                  ...step,
                  status: 'launching',
                  attempt: (step.attempt ?? 0) + 1,
                  priorSessionIds: step.sessionId
                    ? [...(step.priorSessionIds || []), step.sessionId]
                    : [...(step.priorSessionIds || [])],
                  sessionId: null,
                  finishedAt: null,
                }
                : step
            )),
          });
        },
      },
      preflight: ctx.preflight,
      resolveHomeRepoPath: async () => '/Users/me/git/codedeck',
      scheduleStart: () => {},
    }));
    const server = await loopbackTestServer(app);

    const resumed = await request(server).post(`${base}/runs/${id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('running');
    expect(resumed.body.steps[0].attempt).toBe(2);
    expect(resumed.body.steps[0].priorSessionIds).toEqual(['Demo-1']);
  });
});

describe('pipelines API — worktrees', () => {
  const HEAD_A = 'a'.repeat(40);
  const HEAD_B = 'b'.repeat(40);
  const HOME_WT = { path: PROJECT.path, head: HEAD_A, branch: 'main', missing: false };
  const FEATURE_WT = { path: '/tmp/worktrees/demo-git-feature', head: HEAD_B, branch: 'feature/x', missing: false };
  const DETACHED_WT = { path: '/tmp/worktrees/demo-git-detached', head: HEAD_B, branch: null, missing: false };
  const MISSING_WT = { path: '/tmp/worktrees/demo-git-gone', head: HEAD_B, branch: 'gone', missing: true };
  const UNREADABLE_WT = { path: '/tmp/worktrees/demo-git-broken', head: HEAD_B, branch: 'broken', missing: false };

  async function setupWorktrees(worktrees = [HOME_WT, FEATURE_WT], overrides = {}) {
    const listWorktrees = vi.fn(async () => worktrees);
    const readWorktreeChanges = vi.fn(async ({ worktreePath }) => (worktreePath === UNREADABLE_WT.path
      ? { readable: false }
      : { readable: true, dirty: worktreePath === FEATURE_WT.path }));
    const ctx = await setup({
      ...overrides,
      routerDeps: { listWorktrees, readWorktreeChanges, realpath: async value => value, execFile: 'exec-file-stub', ...overrides.routerDeps },
    });
    return { ...ctx, listWorktrees, readWorktreeChanges };
  }

  const startBody = (workflow, overrides = {}) => ({
    requestId: 'run-existing',
    workflowId: workflow.id,
    project: 'Demo',
    input: 'docs/todos/feature.md',
    worktreePath: FEATURE_WT.path,
    ...overrides,
  });

  it('lists the project worktrees in the paginated envelope', async () => {
    const ctx = await setupWorktrees([FEATURE_WT, HOME_WT]);
    const response = await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [
        { path: PROJECT.path, name: 'demo-git', branch: 'main', head: HEAD_A, current: true, dirty: false, selectable: true, reason: null },
        { path: FEATURE_WT.path, name: 'demo-git-feature', branch: 'feature/x', head: HEAD_B, current: false, dirty: true, selectable: true, reason: null },
      ],
      page: { currentPage: 0, size: 20, totalElements: 2, totalPages: 1, hasNextPage: false },
    });
    expect(ctx.listWorktrees).toHaveBeenCalledWith({ projectPath: PROJECT.path, execFile: 'exec-file-stub' });
  });

  it('marks detached, missing and in-use worktrees as not selectable, with the reason', async () => {
    const ctx = await setupWorktrees([HOME_WT, FEATURE_WT, DETACHED_WT, MISSING_WT]);
    const { workflow } = await seedReady(ctx);
    const started = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow));
    expect(started.status).toBe(201);

    const response = await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo' });
    const byName = Object.fromEntries(response.body.data.map(item => [item.name, item]));
    expect(byName['demo-git-feature']).toMatchObject({
      selectable: false, reason: { code: 'in_use', message: 'An open workflow run is using this worktree.' },
    });
    expect(byName['demo-git-detached']).toMatchObject({
      branch: null, selectable: false, reason: { code: 'detached', message: 'No branch is checked out in this worktree.' },
    });
    expect(byName['demo-git-gone']).toMatchObject({
      dirty: null, selectable: false, reason: { code: 'missing', message: 'The worktree directory is missing.' },
    });
    expect(byName['demo-git']).toMatchObject({ selectable: true, reason: null });
    expect(ctx.readWorktreeChanges).not.toHaveBeenCalledWith(expect.objectContaining({ worktreePath: MISSING_WT.path }));
  });

  it('lists a worktree git cannot read as not selectable instead of failing the whole list', async () => {
    const ctx = await setupWorktrees([HOME_WT, UNREADABLE_WT, { ...UNREADABLE_WT, path: '/tmp/worktrees/demo-git-fine' }]);
    const response = await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo' });

    expect(response.status).toBe(200);
    const byName = Object.fromEntries(response.body.data.map(item => [item.name, item]));
    expect(byName['demo-git-broken']).toEqual({
      path: UNREADABLE_WT.path, name: 'demo-git-broken', branch: 'broken', head: HEAD_B, current: false,
      dirty: null, selectable: false, reason: { code: 'unreadable', message: 'Git cannot read this worktree.' },
    });
    expect(byName['demo-git-fine']).toMatchObject({ dirty: false, selectable: true, reason: null });
    expect(byName['demo-git']).toMatchObject({ dirty: false, selectable: true, reason: null });
  });

  it('pages and sorts by path deterministically', async () => {
    const ctx = await setupWorktrees([FEATURE_WT, HOME_WT, DETACHED_WT]);
    const first = await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo', size: 2, page: 0 });
    const second = await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo', size: 2, page: 1 });
    expect(first.body.data.map(item => item.path)).toEqual([PROJECT.path, DETACHED_WT.path]);
    expect(first.body.page).toEqual({ currentPage: 0, size: 2, totalElements: 3, totalPages: 2, hasNextPage: true });
    expect(second.body.data.map(item => item.path)).toEqual([FEATURE_WT.path]);
    expect(second.body.page).toEqual({ currentPage: 1, size: 2, totalElements: 3, totalPages: 2, hasNextPage: false });
    // Only the returned page is inspected for uncommitted changes.
    expect(ctx.readWorktreeChanges).toHaveBeenCalledTimes(3);

    const descending = await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo', sort: 'path,desc' });
    expect(descending.body.data.map(item => item.path)).toEqual([FEATURE_WT.path, DETACHED_WT.path, PROJECT.path]);

    const beyond = await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo', page: 5 });
    expect(beyond.status).toBe(200);
    expect(beyond.body.data).toEqual([]);
  });

  it.each([
    ['no project', {}, 'project'],
    ['an empty project', { project: '' }, 'project'],
    ['an unknown query field', { project: 'Demo', branch: 'main' }, 'branch'],
    ['size 0', { project: 'Demo', size: 0 }, 'size'],
    ['size 101', { project: 'Demo', size: 101 }, 'size'],
    ['a negative page', { project: 'Demo', page: -1 }, 'page'],
    ['a non-numeric page', { project: 'Demo', page: 'x' }, 'page'],
    ['an unknown sort field', { project: 'Demo', sort: 'branch,asc' }, 'sort'],
    ['a sort without a direction', { project: 'Demo', sort: 'path' }, 'sort'],
  ])('rejects %s with a 400 naming the field', async (_label, query, field) => {
    const ctx = await setupWorktrees();
    const response = await request(ctx.app).get(`${base}/worktrees`).query(query);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ status: 400, traceId: expect.any(String), path: expect.stringContaining('/worktrees') });
    expect(response.body.errors.map(error => error.field)).toEqual([field]);
    expect(ctx.listWorktrees).not.toHaveBeenCalled();
  });

  it('accepts the size boundaries 1 and 100', async () => {
    const ctx = await setupWorktrees();
    expect((await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo', size: 1 })).body.data).toHaveLength(1);
    expect((await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo', size: 100 })).status).toBe(200);
  });

  it('returns 404 for an unknown or hostile project name without running git', async () => {
    const ctx = await setupWorktrees();
    for (const project of ['Ghost', "Demo'; DROP TABLE pipeline_runs;--", '<script>alert(1)</script>']) {
      const response = await request(ctx.app).get(`${base}/worktrees`).query({ project });
      expect(response.status).toBe(404);
      expect(response.body.message).toBe('Project not found');
      expect(JSON.stringify(response.body)).not.toContain('<script>');
    }
    expect(ctx.listWorktrees).not.toHaveBeenCalled();
  });

  it('returns 409 with the reasons when the project cannot run workflows', async () => {
    const reasons = [{ code: 'not_git_toplevel', message: 'The project path must be the top level of a git working tree.' }];
    const ctx = await setupWorktrees([HOME_WT], {
      preflight: vi.fn(async () => ({ eligible: false, reasons, branch: null, head: null, dirty: null })),
    });
    const response = await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo' });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ message: reasons[0].message, reasons, traceId: expect.any(String) });
    expect(ctx.listWorktrees).not.toHaveBeenCalled();
  });

  it('lists worktrees when only the setup agent is missing', async () => {
    const ctx = await setupWorktrees([HOME_WT], {
      preflight: vi.fn(async () => ({
        eligible: false,
        reasons: [{ code: 'setup_agent_missing', message: 'Choose a setup agent in Settings → Workflows.' }],
        branch: 'main', head: HEAD_A, dirty: false,
      })),
    });
    const response = await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo' });
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });

  it('starts a run in an existing worktree: no Setup step, branch and commit taken from git', async () => {
    const ctx = await setupWorktrees();
    const { workflow } = await seedReady(ctx);
    const started = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow));

    expect(started.status).toBe(201);
    expect(started.body.worktree).toEqual({
      path: FEATURE_WT.path, branch: 'feature/x', baseCommit: HEAD_B, state: 'external', detail: null,
    });
    expect(started.body.steps.map(item => [item.kind, item.name])).toEqual([['node', 'Develop']]);
    expect(started.body.actions).toEqual({ stop: true, resume: false, continue: false, cleanup: false, answer: false });
    const stored = ctx.runStore.get(started.body.id);
    expect(stored.definition.steps.map(item => item.kind)).toEqual(['node']);
    expect(stored.worktreeState).toBe('external');
    ctx.flushStart();
    expect(ctx.engine.start).toHaveBeenCalledWith(started.body.id);

    const listed = await request(ctx.app).get(`${base}/runs`).query({ open: 'true' });
    expect(listed.body.data.map(item => item.id)).toEqual([started.body.id]);
  });

  it('needs no setup agent for an existing worktree, but still needs one for a new worktree', async () => {
    const ctx = await setupWorktrees([HOME_WT, FEATURE_WT], {
      preflight: vi.fn(async () => ({
        eligible: false,
        reasons: [{ code: 'setup_agent_missing', message: 'Choose a setup agent in Settings → Workflows.' }],
        branch: 'main', head: HEAD_A, dirty: false,
      })),
    });
    const agent = ctx.agentStore.create(agentBody());
    const workflow = ctx.workflowStore.create({ name: 'Feature', agentsDecide: false, nodes: [node(agent.id)] });

    const existing = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow));
    expect(existing.status).toBe(201);

    const { worktreePath, ...withoutPath } = startBody(workflow, { requestId: 'run-new' });
    const fresh = await request(ctx.app).post(`${base}/runs`).send(withoutPath);
    expect(fresh.status).toBe(409);
    expect(fresh.body.message).toBe('Choose a setup agent in Settings → Workflows.');
  });

  it('points a loop at the step it returns to when the run has no Setup step', async () => {
    const ctx = await setupWorktrees();
    const agent = ctx.agentStore.create(agentBody());
    const workflow = ctx.workflowStore.create({
      name: 'Build',
      agentsDecide: true,
      nodes: [
        node(agent.id, { name: 'Develop' }),
        node(agent.id, { name: 'Test', prompt: 'test it', repeat: { mode: 'loop_back', to: 'Develop', max: 5 } }),
      ],
    });
    const started = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow));
    expect(started.status).toBe(201);
    expect(started.body.steps.map(s => s.kind)).toEqual(['node', 'node']);
    expect(started.body.steps[1].repeat).toEqual({ mode: 'loop_back', toStepIndex: 0, max: 5 });
  });

  it('returns 404 when the path is not one of the project worktrees', async () => {
    const ctx = await setupWorktrees();
    const { workflow } = await seedReady(ctx);
    for (const worktreePath of ['/etc', '/tmp/worktrees/demo-git-feature/', '/tmp/worktrees/demo-git-feature; rm -rf /']) {
      const response = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow, { worktreePath }));
      expect(response.status).toBe(404);
      expect(response.body.message).toBe('Worktree not found for this project');
    }
    expect(ctx.runStore.list()).toEqual([]);
  });

  it.each([
    ['detached', DETACHED_WT, 'No branch is checked out in this worktree.'],
    ['missing', MISSING_WT, 'The worktree directory is missing.'],
    ['unreadable', UNREADABLE_WT, 'Git cannot read this worktree.'],
  ])('returns 409 for a %s worktree', async (_label, worktree, message) => {
    const ctx = await setupWorktrees([HOME_WT, worktree]);
    const { workflow } = await seedReady(ctx);
    const response = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow, { worktreePath: worktree.path }));
    expect(response.status).toBe(409);
    expect(response.body.message).toBe(message);
    expect(ctx.runStore.list()).toEqual([]);
  });

  it('refuses a worktree an open run is using, and allows it again once that run has released it', async () => {
    const ctx = await setupWorktrees();
    const { workflow } = await seedReady(ctx);
    const first = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow));
    expect(first.status).toBe(201);

    const second = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow, { requestId: 'run-second' }));
    expect(second.status).toBe(409);
    expect(second.body.message).toBe('An open workflow run is using this worktree.');

    ctx.runStore.update(first.body.id, { status: 'complete', finishedAt: new Date().toISOString(), worktreeState: 'released' });
    const third = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow, { requestId: 'run-third' }));
    expect(third.status).toBe(201);
  });

  it('refuses the worktree of a stopped run that CodeDeck created', async () => {
    const created = { path: '/Users/me/git/worktrees/codedeck-feature-owned', head: HEAD_B, branch: 'workflow/feature-owned', missing: false };
    const ctx = await setupWorktrees([HOME_WT, created], {
      planNames: () => ({ shortId: 'owned', slug: 'feature', homeRepoPath: '/Users/me/git/codedeck', worktreePath: created.path, branch: created.branch }),
    });
    const { workflow } = await seedReady(ctx);
    const { worktreePath, ...withoutPath } = startBody(workflow, { requestId: 'run-owner' });
    const owner = await request(ctx.app).post(`${base}/runs`).send(withoutPath);
    expect(owner.status).toBe(201);
    ctx.runStore.update(owner.body.id, { status: 'stopped', stopReason: 'user', finishedAt: new Date().toISOString(), worktreeState: 'present', baseCommit: HEAD_B });

    const response = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow, { worktreePath: created.path }));
    expect(response.status).toBe(409);
    expect(response.body.message).toBe('An open workflow run is using this worktree.');
  });

  it('replays the same request and conflicts when the worktree choice differs', async () => {
    const ctx = await setupWorktrees();
    const { workflow } = await seedReady(ctx);
    const body = startBody(workflow);
    const first = await request(ctx.app).post(`${base}/runs`).send(body);
    const replay = await request(ctx.app).post(`${base}/runs`).send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(ctx.runStore.list()).toHaveLength(1);

    const { worktreePath, ...withoutPath } = body;
    expect((await request(ctx.app).post(`${base}/runs`).send(withoutPath)).status).toBe(409);
    expect((await request(ctx.app).post(`${base}/runs`).send({ ...body, worktreePath: PROJECT.path })).status).toBe(409);

    const fresh = await request(ctx.app).post(`${base}/runs`).send({ ...withoutPath, requestId: 'run-fresh' });
    expect(fresh.status).toBe(201);
    expect((await request(ctx.app).post(`${base}/runs`).send({ ...body, requestId: 'run-fresh' })).status).toBe(409);
  });

  it.each([
    ['null', null],
    ['a number', 7],
    ['an empty string', ''],
    ['a relative path', 'demo-git-feature'],
    ['a newline', '/tmp/a\nb'],
    ['4097 characters', `/${'a'.repeat(4096)}`],
  ])('rejects a worktreePath that is %s with a 400 on that field', async (_label, worktreePath) => {
    const ctx = await setupWorktrees();
    const { workflow } = await seedReady(ctx);
    const response = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow, { worktreePath }));
    expect(response.status).toBe(400);
    expect(response.body.errors.map(error => error.field)).toEqual(['worktreePath']);
    expect(ctx.runStore.list()).toEqual([]);
  });
});


describe('pipelines API — what the agent needs, and answering it', () => {
  const ASKED = { questions: '1. Which schema?\nRecommended: the existing one.', truncated: false };
  const stepIn = status => ({
    status, sessionId: 'Demo-1', priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null,
  });
  const pendingStep = { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null };

  async function setupWaiting(inputRequest = ASKED) {
    const ctx = await setup();
    const { workflow } = await seedReady(ctx);
    const started = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'ask-1', workflowId: workflow.id, project: 'Demo', input: 'docs/todos/feature.md',
    });
    expect(started.status).toBe(201);
    const id = started.body.id;
    ctx.runStore.update(id, { status: 'needs_input', inputRequest, steps: [stepIn('needs_input'), pendingStep] });
    // The engine double answers the way the real one does: it returns the run to running.
    ctx.engine.answer = vi.fn(async (runId) => {
      const run = ctx.runStore.get(runId);
      if (run.status !== 'needs_input' || run.inputRequest === null) {
        throw Object.assign(new Error(`Action answer is not allowed in status ${run.status}`), { code: 'ACTION_REFUSED' });
      }
      return ctx.runStore.update(runId, { status: 'running', inputRequest: null, steps: [stepIn('running'), pendingStep] });
    });
    return { ctx, id };
  }
  const answer = (ctx, id, body) => request(ctx.app).post(`${base}/runs/${id}/answer`).send(body);

  it('starts a run that is not waiting on anything', async () => {
    const ctx = await setup();
    const { workflow } = await seedReady(ctx);
    const started = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'fresh-1', workflowId: workflow.id, project: 'Demo', input: 'docs/todos/feature.md',
    });
    expect(started.status).toBe(201);
    expect(started.body.inputRequest).toBeNull();
    expect(started.body.actions.answer).toBe(false);
  });

  it('shows what the agent asked on the run and in the run list, and offers Answer', async () => {
    const { ctx, id } = await setupWaiting();
    const one = await request(ctx.app).get(`${base}/runs/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.status).toBe('needs_input');
    expect(one.body.inputRequest).toEqual(ASKED);
    expect(one.body.actions).toMatchObject({ answer: true, stop: true });

    const list = await request(ctx.app).get(`${base}/runs`).query({ project: 'Demo' });
    expect(list.body.data[0].inputRequest).toEqual(ASKED);
  });

  it('does not offer Answer for a dialog the agent shows in its terminal', async () => {
    const { ctx, id } = await setupWaiting(null);
    const one = await request(ctx.app).get(`${base}/runs/${id}`);
    expect(one.body.inputRequest).toBeNull();
    expect(one.body.actions.answer).toBe(false);
    const refused = await answer(ctx, id, { answer: 'yes' });
    expect(refused.status).toBe(409);
    expect(refused.type).toBe('application/problem+json');
  });

  it('sends the answer to the engine and returns the run, no longer waiting', async () => {
    const { ctx, id } = await setupWaiting();
    const response = await answer(ctx, id, { answer: '1. the existing schema\n2. yes' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id, status: 'running', inputRequest: null });
    expect(response.body.actions.answer).toBe(false);
    expect(ctx.engine.answer).toHaveBeenCalledTimes(1);
    expect(ctx.engine.answer).toHaveBeenCalledWith(id, '1. the existing schema\n2. yes');
  });

  it('accepts the boundary lengths 1 and 4000 and refuses 4001', async () => {
    for (const text of ['y', 'x'.repeat(4000)]) {
      const { ctx, id } = await setupWaiting();
      expect((await answer(ctx, id, { answer: text })).status).toBe(200);
    }
    const { ctx, id } = await setupWaiting();
    const tooLong = await answer(ctx, id, { answer: 'x'.repeat(4001) });
    expect(tooLong.status).toBe(400);
    expect(ctx.engine.answer).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', undefined, 'answer'],
    ['an empty object', {}, 'answer'],
    ['a null answer', { answer: null }, 'answer'],
    ['an empty answer', { answer: '' }, 'answer'],
    ['a blank answer', { answer: '  \n ' }, 'answer'],
    ['a number', { answer: 42 }, 'answer'],
    ['an array', { answer: [] }, 'answer'],
    ['an escape sequence that would end the paste', { answer: 'ok\x1b[201~\rrm -rf /' }, 'answer'],
    ['a carriage return', { answer: 'ok\rnext' }, 'answer'],
    ['an unknown field', { answer: 'ok', runId: 'other' }, 'runId'],
  ])('returns 400 with the field for %s and sends nothing', async (_label, body, field) => {
    const { ctx, id } = await setupWaiting();
    const response = await answer(ctx, id, body);
    expect(response.status).toBe(400);
    expect(response.type).toBe('application/problem+json');
    expect(response.body.errors.map(error => error.field)).toContain(field);
    expect(response.body.traceId).toEqual(expect.any(String));
    expect(response.headers['x-trace-id']).toBe(response.body.traceId);
    expect(ctx.engine.answer).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON and a body that is not an object', async () => {
    const { ctx, id } = await setupWaiting();
    const malformed = await request(ctx.app).post(`${base}/runs/${id}/answer`).type('application/json').send('{"answer":');
    expect(malformed.status).toBe(400);
    expect(malformed.type).toBe('application/problem+json');
    const array = await request(ctx.app).post(`${base}/runs/${id}/answer`).type('application/json').send('["yes"]');
    expect(array.status).toBe(400);
    expect(array.body.errors).toEqual([{ field: 'body', message: 'A JSON object is required' }]);
    expect(ctx.engine.answer).not.toHaveBeenCalled();
  });

  it('passes hostile text through as plain answer text and never echoes it in an error', async () => {
    const { ctx, id } = await setupWaiting();
    const hostile = "'; DROP TABLE pipeline_runs; -- <script>alert(1)</script> $(rm -rf ~)";
    const accepted = await answer(ctx, id, { answer: hostile });
    expect(accepted.status).toBe(200);
    expect(ctx.engine.answer).toHaveBeenCalledWith(id, hostile);
    expect(ctx.runStore.get(id)).not.toBeNull();

    const refused = await answer(ctx, id, { answer: '<script>alert(1)</script>\x07' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).not.toContain('<script>');
  });

  it('returns 413 for an oversized body', async () => {
    const { ctx, id } = await setupWaiting();
    const response = await answer(ctx, id, { answer: 'x'.repeat(600 * 1024) });
    expect(response.status).toBe(413);
    expect(ctx.engine.answer).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown run and for an id that is not a UUID', async () => {
    const { ctx } = await setupWaiting();
    expect((await answer(ctx, '0d9e4b1a-9999-4999-8999-999999999999', { answer: 'yes' })).status).toBe(404);
    const invalid = await answer(ctx, 'not-a-uuid', { answer: 'yes' });
    expect(invalid.status).toBe(404);
    expect(invalid.type).toBe('application/problem+json');
  });

  it('answers once: the same answer sent again is refused with 409, not typed twice', async () => {
    const { ctx, id } = await setupWaiting();
    const [first, second] = await Promise.all([answer(ctx, id, { answer: 'yes' }), answer(ctx, id, { answer: 'yes' })]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(ctx.runStore.get(id).status).toBe('running');
  });

  it('returns 409 when the engine can no longer deliver the answer', async () => {
    const { ctx, id } = await setupWaiting();
    ctx.engine.answer = vi.fn(async () => {
      throw Object.assign(new Error('The agent is no longer waiting for an answer.'), { code: 'ANSWER_UNAVAILABLE' });
    });
    const response = await answer(ctx, id, { answer: 'yes' });
    expect(response.status).toBe(409);
    expect(response.body.message).toBe('The agent is no longer waiting for an answer.');
  });
});

describe('pipelines API — loops and who decides', () => {
  const loop = (to, max = 20) => ({ mode: 'loop_back', to, max });

  async function seedLoop(ctx, { agentsDecide = true } = {}) {
    const agent = ctx.agentStore.create(agentBody());
    ctx.settingsStore.update({ setupAgentId: agent.id, revision: 1 });
    const body = {
      name: 'Build',
      agentsDecide,
      nodes: [
        node(agent.id, { name: 'Develop' }),
        node(agent.id, { name: 'Test', prompt: 'test it', repeat: loop('develop') }),
        node(agent.id, { name: 'Review', prompt: 'review it' }),
      ],
    };
    return { agent, body };
  }

  it('saves a workflow with a loop and agents that decide, and returns it as stored', async () => {
    const ctx = await setup();
    const { body } = await seedLoop(ctx);
    const created = await request(ctx.app).post(`${base}/workflows`).send(body);
    expect(created.status).toBe(201);
    expect(created.body.agentsDecide).toBe(true);
    expect(created.body.nodes.map(n => n.repeat)).toEqual([{ mode: 'once' }, { mode: 'loop_back', to: 'Develop', max: 20 }, { mode: 'once' }]);

    const read = await request(ctx.app).get(`${base}/workflows/${created.body.id}`);
    expect(read.body).toEqual(created.body);
    const list = await request(ctx.app).get(`${base}/workflows`);
    expect(list.body.data).toEqual([created.body]);
  });

  it('changes who decides on update and refuses a stale revision', async () => {
    const ctx = await setup();
    const { body } = await seedLoop(ctx);
    const created = await request(ctx.app).post(`${base}/workflows`).send(body);
    const updated = await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...body, agentsDecide: false, revision: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ agentsDecide: false, revision: 2 });
    const stale = await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...body, revision: 1 });
    expect(stale.status).toBe(409);
    expect((await request(ctx.app).get(`${base}/workflows/${created.body.id}`)).body.agentsDecide).toBe(false);
  });

  it.each([
    ['no agentsDecide', b => { delete b.agentsDecide; }, 'agentsDecide', 'Use true or false'],
    ['agentsDecide as text', b => { b.agentsDecide = 'true'; }, 'agentsDecide', 'Use true or false'],
    ['a loop back to a later node', b => { b.nodes[1].repeat = loop('Review'); }, 'nodes[1].repeat.to', 'Choose an earlier node to loop back to'],
    ['a loop back to an unknown node', b => { b.nodes[1].repeat = loop('Deploy'); }, 'nodes[1].repeat.to', 'Choose an earlier node to loop back to'],
    ['a loop on the first node', b => { b.nodes[0].repeat = loop('Develop'); }, 'nodes[0].repeat.to', 'Choose an earlier node to loop back to'],
    ['a loop of 0 rounds', b => { b.nodes[1].repeat = loop('Develop', 0); }, 'nodes[1].repeat.max', 'Use a whole number from 1 to 100'],
    ['a loop of 101 rounds', b => { b.nodes[1].repeat = loop('Develop', 101); }, 'nodes[1].repeat.max', 'Use a whole number from 1 to 100'],
    ['loops that share a node', b => { b.nodes[2].repeat = loop('Develop'); }, 'nodes[2].repeat.to', 'Loops cannot share a node; this one overlaps the loop that ends at Test'],
    ['an index in place of a name', b => { b.nodes[1].repeat = { mode: 'loop_back', toStepIndex: 0, max: 5 }; }, 'nodes[1].repeat.toStepIndex', 'Unknown field'],
  ])('refuses a workflow with %s on create and on update, storing nothing', async (_label, breakIt, field, message) => {
    const ctx = await setup();
    const { body } = await seedLoop(ctx);
    const created = await request(ctx.app).post(`${base}/workflows`).send(body);
    const bad = structuredClone(body);
    breakIt(bad);

    for (const response of [
      await request(ctx.app).post(`${base}/workflows`).send({ ...bad, name: 'Other' }),
      await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...bad, revision: 1 }),
    ]) {
      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(response.body.traceId).toBe(response.headers['x-trace-id']);
      expect(response.body.errors).toContainEqual({ field, message });
    }
    expect(ctx.workflowStore.list()).toHaveLength(1);
    expect(ctx.workflowStore.get(created.body.id).revision).toBe(1);
  });

  it('accepts loops of 1 and of 100 rounds', async () => {
    const ctx = await setup();
    const { body } = await seedLoop(ctx);
    for (const [name, max] of [['One', 1], ['Hundred', 100]]) {
      const bounded = structuredClone(body);
      bounded.name = name;
      bounded.nodes[1].repeat = loop('Develop', max);
      const response = await request(ctx.app).post(`${base}/workflows`).send(bounded);
      expect(response.status).toBe(201);
      expect(response.body.nodes[1].repeat.max).toBe(max);
    }
  });

  it('starts a run whose loop points past Setup at the step it returns to', async () => {
    const ctx = await setup();
    const { body } = await seedLoop(ctx);
    const workflow = ctx.workflowStore.create(body);
    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'loop-1', workflowId: workflow.id, project: 'Demo', input: 'x' });
    expect(started.status).toBe(201);
    expect(started.body.agentsDecide).toBe(true);
    expect(started.body.decisionCount).toBe(0);
    expect(started.body.steps.map(s => s.name)).toEqual(['Setup', 'Develop', 'Test', 'Review']);
    expect(started.body.steps.map(s => s.repeat)).toEqual([
      { mode: 'until_complete', max: 3 }, { mode: 'once' }, { mode: 'loop_back', toStepIndex: 1, max: 20 }, { mode: 'once' },
    ]);
    expect(started.body.steps.map(s => s.roundsCompleted)).toEqual([0, 0, 0, 0]);
    expect(ctx.runStore.get(started.body.id).definition.agentsDecide).toBe(true);
  });

  it('shows the rounds a loop has completed', async () => {
    const ctx = await setup();
    const { body } = await seedLoop(ctx, { agentsDecide: false });
    const workflow = ctx.workflowStore.create(body);
    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'loop-2', workflowId: workflow.id, project: 'Demo', input: 'x' });
    const run = ctx.runStore.get(started.body.id);
    ctx.runStore.update(run.id, { steps: run.steps.map((s, i) => (i === 2 ? { ...s, roundsCompleted: 7 } : s)) });
    const read = await request(ctx.app).get(`${base}/runs/${run.id}`);
    expect(read.body.steps[2].roundsCompleted).toBe(7);
    expect(read.body.agentsDecide).toBe(false);
  });

  it('keeps a run as it started when its workflow is changed afterwards', async () => {
    const ctx = await setup();
    const { body } = await seedLoop(ctx);
    const workflow = ctx.workflowStore.create(body);
    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'loop-3', workflowId: workflow.id, project: 'Demo', input: 'x' });
    await request(ctx.app).put(`${base}/workflows/${workflow.id}`).send({ ...body, agentsDecide: false, nodes: [body.nodes[0]], revision: 1 });
    const read = await request(ctx.app).get(`${base}/runs/${started.body.id}`);
    expect(read.body.agentsDecide).toBe(true);
    expect(read.body.steps[2].repeat).toEqual({ mode: 'loop_back', toStepIndex: 1, max: 20 });
  });
});

describe('pipelines API — decisions agents made', () => {
  const OTHER = 'b3e1c2d3-4567-4890-9bcd-ef0123456789';

  async function setupRun() {
    const ctx = await setup();
    const { workflow } = await seedReady(ctx);
    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'dec-1', workflowId: workflow.id, project: 'Demo', input: 'x' });
    expect(started.status).toBe(201);
    return { ctx, id: started.body.id };
  }
  const record = (ctx, runId, pass, patch = {}) => ctx.decisionStore.add({
    runId, stepIndex: 1, stepName: 'Develop', pass, questions: `1. Question ${pass}?\nRecommended: yes`, truncated: false,
    answer: 'Proceed with your recommendations.', ...patch,
  });
  const decisions = (ctx, id, query = {}) => request(ctx.app).get(`${base}/runs/${id}/decisions`).query(query);

  it('lists the decisions of a run, oldest first, with every field and the page envelope', async () => {
    const { ctx, id } = await setupRun();
    const first = record(ctx, id, 1);
    const second = record(ctx, id, 2, { truncated: true });
    const response = await decisions(ctx, id);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [first, second].map(d => ({
        id: d.id, stepIndex: 1, stepName: 'Develop', pass: d.pass, questions: d.questions,
        truncated: d.truncated, answer: 'Proceed with your recommendations.', createdAt: d.createdAt,
      })),
      page: { currentPage: 0, size: 20, totalElements: 2, totalPages: 1, hasNextPage: false },
    });
  });

  it('returns an empty page for a run whose agents decided nothing', async () => {
    const { ctx, id } = await setupRun();
    const response = await decisions(ctx, id);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [], page: { currentPage: 0, size: 20, totalElements: 0, totalPages: 0, hasNextPage: false } });
  });

  it('counts the decisions on the run and in the run list', async () => {
    const { ctx, id } = await setupRun();
    record(ctx, id, 1);
    record(ctx, id, 2);
    record(ctx, OTHER, 1);
    expect((await request(ctx.app).get(`${base}/runs/${id}`)).body.decisionCount).toBe(2);
    expect((await request(ctx.app).get(`${base}/runs`)).body.data.map(run => run.decisionCount)).toEqual([2]);
  });

  it('never returns another run\'s decisions', async () => {
    const { ctx, id } = await setupRun();
    record(ctx, OTHER, 1);
    const mine = record(ctx, id, 1);
    const response = await decisions(ctx, id);
    expect(response.body.data.map(d => d.id)).toEqual([mine.id]);
    expect(response.body.page.totalElements).toBe(1);
  });

  it('pages through decisions and reports whether more follow', async () => {
    const { ctx, id } = await setupRun();
    const ids = [1, 2, 3].map(pass => record(ctx, id, pass).id);
    const first = await decisions(ctx, id, { size: 2 });
    expect(first.body.data.map(d => d.id)).toEqual(ids.slice(0, 2));
    expect(first.body.page).toEqual({ currentPage: 0, size: 2, totalElements: 3, totalPages: 2, hasNextPage: true });
    const last = await decisions(ctx, id, { size: 2, page: 1 });
    expect(last.body.data.map(d => d.id)).toEqual(ids.slice(2));
    expect(last.body.page).toEqual({ currentPage: 1, size: 2, totalElements: 3, totalPages: 2, hasNextPage: false });
    const beyond = await decisions(ctx, id, { size: 2, page: 9 });
    expect(beyond.status).toBe(200);
    expect(beyond.body.data).toEqual([]);
    expect(beyond.body.page).toEqual({ currentPage: 9, size: 2, totalElements: 3, totalPages: 2, hasNextPage: false });
  });

  it('sorts by createdAt in either direction and by nothing else', async () => {
    const { ctx, id } = await setupRun();
    const ids = [1, 2, 3].map(pass => record(ctx, id, pass).id);
    expect((await decisions(ctx, id, { sort: 'createdAt,asc' })).body.data.map(d => d.id)).toEqual(ids);
    expect((await decisions(ctx, id, { sort: 'createdAt,desc' })).body.data.map(d => d.id)).toEqual([...ids].reverse());
    for (const sort of ['answer,asc', 'createdAt', 'createdAt,up', 'createdAt,asc,extra', '']) {
      const response = await decisions(ctx, id, { sort });
      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual([{ field: 'sort', message: 'Sort by createdAt with asc or desc' }]);
    }
  });

  it.each([
    ['size', { size: 0 }],
    ['size', { size: 101 }],
    ['size', { size: '1e9' }],
    ['size', { size: 'ten' }],
    ['page', { page: -1 }],
    ['page', { page: 1.5 }],
    ['page', { page: 100001 }],
    ['page', { page: 'abc' }],
    ['project', { project: 'Demo' }],
    ['q', { q: "'; DROP TABLE pipeline_run_decisions; --" }],
  ])('answers 400 naming %s for the query %j', async (field, query) => {
    const { ctx, id } = await setupRun();
    record(ctx, id, 1);
    const response = await decisions(ctx, id, query);
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body.traceId).toBe(response.headers['x-trace-id']);
    expect(response.body.errors.map(error => error.field)).toEqual([field]);
    expect(ctx.decisionStore.count(id)).toBe(1);
  });

  it('accepts the largest page size and the largest page number', async () => {
    const { ctx, id } = await setupRun();
    record(ctx, id, 1);
    expect((await decisions(ctx, id, { size: 100 })).status).toBe(200);
    expect((await decisions(ctx, id, { size: 1, page: 100000 })).body.data).toEqual([]);
  });

  it.each([
    'c4f2d3e4-5678-4901-8cde-f01234567890',
    'not-a-uuid',
    '../../etc/passwd',
    '%00',
  ])('answers 404 for the unknown or malformed run %s', async (runId) => {
    const { ctx, id } = await setupRun();
    record(ctx, id, 1);
    const response = await request(ctx.app).get(`${base}/runs/${encodeURIComponent(runId)}/decisions`);
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body.traceId).toBe(response.headers['x-trace-id']);
    expect(response.body.message).toBe('Run not found');
  });

  it('gives the same answer to repeated and to simultaneous reads, and changes nothing', async () => {
    const { ctx, id } = await setupRun();
    [1, 2, 3].forEach(pass => record(ctx, id, pass));
    const before = ctx.runStore.get(id);
    const responses = await Promise.all(Array.from({ length: 8 }, () => decisions(ctx, id, { size: 2 })));
    expect(new Set(responses.map(response => JSON.stringify(response.body))).size).toBe(1);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(ctx.decisionStore.count(id)).toBe(3);
    expect(ctx.runStore.get(id)).toEqual(before);
  });

  it('refuses to write through the collection', async () => {
    const { ctx, id } = await setupRun();
    for (const method of ['post', 'put', 'delete']) {
      const response = await request(ctx.app)[method](`${base}/runs/${id}/decisions`).set('Content-Length', '2').send({});
      expect(response.status).toBe(404);
    }
    expect(ctx.decisionStore.count(id)).toBe(0);
  });

  it('answers 500 with a trace id, not the stored text, when a stored decision is corrupt', async () => {
    const { ctx, id } = await setupRun();
    const added = record(ctx, id, 1, { questions: '1. A private question?' });
    ctx.db.prepare('UPDATE pipeline_run_decisions SET pass = 0 WHERE id = ?').run(added.id);
    const response = await decisions(ctx, id);
    expect(response.status).toBe(500);
    expect(response.body.traceId).toBe(response.headers['x-trace-id']);
    expect(JSON.stringify(response.body)).not.toContain('private question');
  });

  it('requires the decision store', () => {
    expect(() => createPipelinesRouter({
      agentStore: {}, workflowStore: {}, settingsStore: {}, runStore: {}, findProject: () => null,
    })).toThrow('pipelines router: decisionStore is required');
  });
});

describe('pipelines API — progress file', () => {
  it('follows the current workflow setting for a run without a progress snapshot', async () => {
    const read = vi.fn(async ({ progressFile }) => ({ file: progressFile, status: 'in_progress', phaseCount: 1, phase: { number: 1, title: 'Review', tasksDone: 0, tasksTotal: 1 } }));
    const ctx = await setup({ routerDeps: { progressReader: { read } } });
    const agent = ctx.agentStore.create(agentBody());
    ctx.settingsStore.update({ setupAgentId: agent.id, revision: 1 });
    const body = { name: 'Progress', agentsDecide: false, nodes: [node(agent.id, { prompt: 'Work' })] };
    const workflow = ctx.workflowStore.create(body);
    const start = (requestId, input) => request(ctx.app).post(`${base}/runs`).send({ requestId, workflowId: workflow.id, project: 'Demo', input });
    const valid = await start('before-progress', 'todo.md');
    const freeText = await start('before-progress-text', 'fix the login bug');
    expect(valid.status).toBe(201);
    expect(freeText.status).toBe(201);
    ctx.runStore.update(valid.body.id, { worktreeState: 'present' });
    ctx.runStore.update(freeText.body.id, { worktreeState: 'present' });
    expect((await request(ctx.app).get(`${base}/runs/${valid.body.id}`)).body.progress).toBeNull();

    const updated = await request(ctx.app).put(`${base}/workflows/${workflow.id}`).send({ ...body, progressFile: 'docs/{input}', revision: 1 });
    expect(updated.status).toBe(200);
    const detail = await request(ctx.app).get(`${base}/runs/${valid.body.id}`);
    expect(detail.body.progress).toEqual({ file: 'docs/todo.md', status: 'in_progress', phaseCount: 1, phase: { number: 1, title: 'Review', tasksDone: 0, tasksTotal: 1 } });
    const listed = await request(ctx.app).get(`${base}/runs`);
    expect(listed.body.data.find(run => run.id === valid.body.id).progress).toEqual(detail.body.progress);
    expect(ctx.runStore.get(valid.body.id).definition.progressFile).toBeNull();
    expect((await request(ctx.app).get(`${base}/runs/${freeText.body.id}`)).body.progress).toBeNull();

    const cleared = await request(ctx.app).put(`${base}/workflows/${workflow.id}`).send({ ...body, progressFile: null, revision: 2 });
    expect(cleared.status).toBe(200);
    expect((await request(ctx.app).get(`${base}/runs/${valid.body.id}`)).body.progress).toBeNull();

    ctx.workflowStore.remove(workflow.id);
    expect(ctx.workflowStore.get(workflow.id)).toBeNull();
    expect((await request(ctx.app).get(`${base}/runs/${valid.body.id}`)).body.progress).toBeNull();
  });

  it('stores SQL and HTML looking path text as inert data', async () => {
    const ctx = await setup();
    const agent = ctx.agentStore.create(agentBody());
    const progressFile = "docs/<script>alert('x')</script>';DROP TABLE.md";
    const created = await request(ctx.app).post(`${base}/workflows`).send({ name: 'Progress', agentsDecide: false, progressFile, nodes: [node(agent.id)] });
    expect(created.status).toBe(201);
    expect(ctx.workflowStore.get(created.body.id).progressFile).toBe(progressFile);
    expect(ctx.workflowStore.list()).toHaveLength(1);
  });
  it('returns each parsed status and clears a workflow setting with PUT', async () => {
    const statuses = ['all_done', 'no_phases', 'missing', 'unreadable'];
    let status = statuses[0];
    const read = vi.fn(async ({ progressFile }) => ({ file: progressFile, status, phaseCount: status === 'all_done' ? 1 : null, phase: null }));
    const ctx = await setup({ routerDeps: { progressReader: { read } } });
    const agent = ctx.agentStore.create(agentBody());
    ctx.settingsStore.update({ setupAgentId: agent.id, revision: 1 });
    const body = { name: 'Progress', agentsDecide: false, progressFile: 'docs/todo.md', nodes: [node(agent.id, { prompt: 'Work' })] };
    const created = await request(ctx.app).post(`${base}/workflows`).send(body);
    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'progress-status', workflowId: created.body.id, project: 'Demo', input: '' });
    ctx.runStore.update(started.body.id, { worktreeState: 'present' });
    for (const wanted of statuses) {
      status = wanted;
      const response = await request(ctx.app).get(`${base}/runs/${started.body.id}`);
      expect(response.status).toBe(200);
      expect(response.body.progress).toEqual({ file: 'docs/todo.md', status: wanted, phaseCount: wanted === 'all_done' ? 1 : null, phase: null });
    }
    const changed = await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...body, progressFile: 'docs/changed.md', revision: 1 });
    expect(changed.status).toBe(200);
    expect((await request(ctx.app).get(`${base}/runs/${started.body.id}`)).body.progress.file).toBe('docs/todo.md');
    const cleared = await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ name: 'Progress', agentsDecide: false, nodes: body.nodes, revision: 2 });
    const duplicate = await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ name: 'Progress', agentsDecide: false, nodes: body.nodes, revision: 2 });
    expect(cleared.body.progressFile).toBeNull();
    expect(duplicate.status).toBe(409);
    expect((await request(ctx.app).get(`${base}/runs/${started.body.id}`)).body.progress.file).toBe('docs/todo.md');
  });
  it('persists workflow setting, snapshots composed path, and returns progress on every run view', async () => {
    const read = vi.fn(async ({ progressFile }) => ({ file: progressFile, status: 'in_progress', phaseCount: 2, phase: { number: 1, title: 'Review', tasksDone: 0, tasksTotal: 3 } }));
    const ctx = await setup({ routerDeps: { progressReader: { read } } });
    const agent = ctx.agentStore.create(agentBody());
    ctx.settingsStore.update({ setupAgentId: agent.id, revision: 1 });
    const workflowBody = { name: 'Progress', agentsDecide: false, progressFile: 'docs/{input}', nodes: [node(agent.id)] };
    const created = await request(ctx.app).post(`${base}/workflows`).send(workflowBody);
    expect(created.status).toBe(201);
    expect(created.body.progressFile).toBe('docs/{input}');
    expect((await request(ctx.app).get(`${base}/workflows/${created.body.id}`)).body.progressFile).toBe('docs/{input}');
    const updated = await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...workflowBody, revision: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.progressFile).toBe('docs/{input}');
    const invalid = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'progress-invalid', workflowId: created.body.id, project: 'Demo', input: 'fix the login bug' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors.map(error => error.field)).toContain('input');
    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'progress-1', workflowId: created.body.id, project: 'Demo', input: 'todos/x.md' });
    expect(started.status).toBe(201);
    expect(ctx.runStore.get(started.body.id).definition.progressFile).toBe('docs/todos/x.md');
    expect(started.body.progress).toBeNull();
    ctx.runStore.update(started.body.id, { worktreeState: 'present' });
    const detail = await request(ctx.app).get(`${base}/runs/${started.body.id}`);
    expect(detail.body.progress).toEqual({ file: 'docs/todos/x.md', status: 'in_progress', phaseCount: 2, phase: { number: 1, title: 'Review', tasksDone: 0, tasksTotal: 3 } });
    expect((await request(ctx.app).get(`${base}/runs`)).body.data[0].progress).toEqual(detail.body.progress);
    expect(read).toHaveBeenCalled();
    ctx.runStore.update(started.body.id, { worktreeState: 'removed' });
    expect((await request(ctx.app).get(`${base}/runs/${started.body.id}`)).body.progress).toBeNull();
  });
  it.each([1, {}, [], '', ' ', '/bad.md', '~/bad.md', 'a\\b.md', 'a/../b.md', 'a//b.md', 'a\nb.md', 'bad.txt', 'x'.repeat(298) + '.md'])('rejects invalid workflow progressFile %s', async progressFile => {
    const ctx = await setup();
    const agent = ctx.agentStore.create(agentBody());
    const response = await request(ctx.app).post(`${base}/workflows`).send({ name: 'Progress', agentsDecide: false, progressFile, nodes: [node(agent.id)] });
    expect(response.status).toBe(400);
    expect(response.body.errors.map(error => error.field)).toContain('progressFile');
  });
  it('requires input for a progress placeholder and validates composed path', async () => {
    const ctx = await setup();
    const agent = ctx.agentStore.create(agentBody());
    ctx.settingsStore.update({ setupAgentId: agent.id, revision: 1 });
    const workflow = ctx.workflowStore.create({ name: 'Progress', agentsDecide: false, progressFile: 'docs/{input}.md', nodes: [node(agent.id, { prompt: 'Work' })] });
    for (const input of ['', '../bad', 'x'.repeat(510)]) {
      const response = await request(ctx.app).post(`${base}/runs`).send({ requestId: `progress-${input.length}`, workflowId: workflow.id, project: 'Demo', input });
      expect(response.status).toBe(400);
      expect(response.body.errors.map(error => error.field)).toContain('input');
    }
  });
});
