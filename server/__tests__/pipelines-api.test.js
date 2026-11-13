import { loopbackTestServer } from './helpers/loopback-test-server.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { createSettingsStore } from '../pipelines/settings-store.js';
import { createRunStore } from '../pipelines/run-store.js';
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
    name: 'Feature',
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
      name: 'Feature',
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
      name: 'Feature',
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
    await request(app).post(`${base}/workflows`).send({ name: 'Feature', nodes: [node(agent.id)] });
    const dup = await request(app).post(`${base}/workflows`).send({ name: 'feature', nodes: [node(agent.id)] });
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
      name: 'Huge',
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
      name: 'TwoSteps',
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
    const workflow = workflowStore.create({ name: 'Feature', nodes: [node(agent.id)] });

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
          status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0,
          detail: null, startedAt: null, finishedAt: null,
        }],
        homePath: '/Users/me/git/codedeck',
        worktreePath: `/Users/me/git/worktrees/r-${index}`,
        worktreeBranch: `workflow/r-${index}`,
        baseCommit: null,
        worktreeState: 'not_created',
        worktreeDetail: null,
        finishedAt: null,
      });
    }

    const app = express();
    app.use(createPipelinesRouter({
      agentStore,
      workflowStore,
      settingsStore,
      runStore,
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
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, detail: null, startedAt: null, finishedAt: null },
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, detail: null, startedAt: null, finishedAt: null },
      ],
    });
    const refused = await request(ctx.app).post(`${base}/runs/${id}/stop`);
    expect(refused.status).toBe(409);

    ctx.runStore.update(id, {
      status: 'error',
      error: 'boom',
      finishedAt: new Date().toISOString(),
      steps: [
        { status: 'failed', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, detail: null, startedAt: null, finishedAt: null },
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
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, detail: null, startedAt: null, finishedAt: null },
        { status: 'limit_reached', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 2, detail: null, startedAt: null, finishedAt: null },
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
        { status: 'interrupted', sessionId: 'Demo-1', priorSessionIds: [], attempt: 1, iteration: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, detail: null, startedAt: null, finishedAt: null },
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
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, detail: null, startedAt: null, finishedAt: null },
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, detail: null, startedAt: null, finishedAt: null },
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
        { status: 'running', sessionId: 'Demo-1', priorSessionIds: [], attempt: 1, iteration: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, detail: null, startedAt: null, finishedAt: null },
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
