import { buildTemplateDraft } from '../../shared/workflow-templates.mjs';
import { loopbackTestServer } from './helpers/loopback-test-server.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import supertest from 'supertest';
import { existsSync, mkdtempSync, mkdirSync, promises as fsPromises, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { createSettingsStore } from '../pipelines/settings-store.js';
import { createRunStore } from '../pipelines/run-store.js';
import { createRequestStore } from '../pipelines/request-store.js';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskService, TaskError } from '../tasks/task-service.js';
import { createReviewStore } from '../pipelines/review-store.js';
import { createAnswerStore } from '../pipelines/answer-store.js';
import { createRoleStore, createTeamStore, createTemplateStore, createStepPresetStore } from '../pipelines/library-store.js';
import { BUILT_IN_ROLES } from '../../shared/workflow-templates.mjs';
import { createDecisionStore } from '../pipelines/decision-store.js';
import { createNoteStore } from '../pipelines/note-store.js';
import { createTeamObservations } from '../pipelines/team-observations.js';
import { createTeamTrials } from '../pipelines/team-trials.js';
import { createImprovements } from '../pipelines/improvements.js';
import { createPipelinesRouter } from '../routes/pipelines.js';
import { setTaskState, OWN_REPOSITORY } from './helpers/task-state.js';
import { create as createRunWorktree, planNames as realPlanNames } from '../pipelines/run-worktree.js';
import { AttachmentPublishError, publishAttachmentBatch } from '../pipelines/attachment-publisher.js';
import { reconcileAttachmentStarts } from '../pipelines/attachment-reconcile.js';

const base = '/api/pipelines';
const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });
const fixtureTeams = new WeakMap();

function request(app) {
  const api = supertest(app);
  const post = api.post.bind(api);
  api.post = url => {
    const req = post(url);
    if (url !== `${base}/runs`) return req;
    const send = req.send.bind(req);
    req.send = body => {
      const teamId = fixtureTeams.get(app);
      return teamId && body && !Array.isArray(body) && typeof body === 'object' && !Object.hasOwn(body, 'teamId')
        ? send({ teamId, ...body }) : send(body);
    };
    const field = req.field.bind(req);
    req.field = (name, value) => {
      const teamId = fixtureTeams.get(app);
      if (name === 'run' && teamId && typeof value === 'string') {
        const body = JSON.parse(value);
        if (!Object.hasOwn(body, 'teamId')) value = JSON.stringify({ teamId, ...body });
      }
      return field(name, value);
    };
    return req;
  };
  return api;
}

const PROJECT = {
  name: 'Demo',
  path: '/tmp/demo-git',
  host: 'local',
  repositories: [],
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
    role: 'Developer',
    prompt: 'Implement {input}',
    repeat: { mode: 'once' },
    ...overrides,
  };
}

async function setup(overrides = {}) {
  if (overrides.routerDeps?.progressReader) {
    const originalRead = overrides.routerDeps.progressReader.read;
    overrides = { ...overrides, routerDeps: { ...overrides.routerDeps, progressReader: {
      worktreeExists: async () => true,
      read: async args => {
        const progress = await originalRead(args);
        return { ...progress, tasksDone: progress.phase?.tasksDone ?? null, tasksTotal: progress.phase?.tasksTotal ?? null };
      },
    } } };
  }
  const db = new Database(overrides.databasePath ?? ':memory:');
  cleanup.push(() => db.close());

  const agentStore = createAgentStore(db);
  const workflowStore = createWorkflowStore(db);
  const settingsStore = createSettingsStore(db);
  const runStore = createRunStore(db, { now: overrides.runClock });
  const decisionStore = createDecisionStore(db);
  const noteStore = createNoteStore(db);
  const reviewStore = createReviewStore(db);
  const answerStore = createAnswerStore(db);
  const templateStore = createTemplateStore(db);
  const stepPresetStore = createStepPresetStore(db);

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

  const projects = new Map([[PROJECT.name, { ...PROJECT, path: overrides.repo ?? PROJECT.path }]]);
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
  let fixtureTeamId = null;

  // Tasks: the real store; planning and creating a worktree are replaced, as Git is elsewhere here.
  const taskStore = createTaskStore(db);
  let plannedTasks = 0;
  const taskService = overrides.repo
    ? createTaskService({ taskStore, findProject, execFile, pathExists: async target => existsSync(target), startSession: vi.fn(), isRunWorking: () => false,
      listRuns: () => runStore.list(), reservedWorktreePaths: () => new Set() })
    : overrides.taskService ?? {
    plan: vi.fn(async ({ project, title, titleSource }) => {
      plannedTasks += 1;
      const id = `7a00000${plannedTasks}-0000-4000-8000-000000000000`;
      const worktreePath = `/Users/me/git/worktrees/codedeck-task-${plannedTasks}`;
      const branch = `task/t-${plannedTasks}`;
      // A plan as the task service makes it: the task's worktrees, the one it starts in first.
      return { id, project, projectPath: PROJECT.path, title: title.trim(), titleSource, folder: null, homePath: '/Users/me/git/codedeck', worktreePath, branch, baseBranch: 'main',
        worktrees: [{ repository: 'codedeck', repositoryPath: null, checkoutPath: PROJECT.path, homePath: '/Users/me/git/codedeck', worktreePath, branch, baseBranch: 'main' }] };
    }),
    createPlanned: vi.fn(async planned => taskStore.create({ ...OWN_REPOSITORY, id: planned.id, project: planned.project, title: planned.title,
      titleSource: planned.titleSource, worktreePath: planned.worktreePath, branch: planned.branch, baseBranch: planned.baseBranch, baseCommit: 'c'.repeat(40) })),
  };

  // Closing a run's terminals is the terminal layer's work; here it reports that none was open.
  const closeRunTerminals = overrides.closeRunTerminals ?? vi.fn(async () => ({ closed: [], notClosed: [] }));

  const openApp = async () => {
    const app = express();
    if (overrides.onRequest) app.use(express.json(), overrides.onRequest);
    const roleStore = createRoleStore(db);
    for (const role of BUILT_IN_ROLES) roleStore.ensureRole(role.name, role.description);
    app.use(createPipelinesRouter({
      db,
      agentStore,
      roleStore,
      workflowStore,
      settingsStore,
      runStore,
      requestStore: createRequestStore(db),
      decisionStore,
      noteStore,
      reviewStore,
      answerStore,
      teamStore: createTeamStore(db),
      templateStore,
      stepPresetStore,
      taskStore,
      taskService,
      findProject,
      engine,
      closeRunTerminals,
      preflight: overrides.repo ? undefined : preflight,
      planNames,
      resolveHomeRepoPath: overrides.repo ? undefined : resolveHomeRepoPath,
      scheduleStart,
      ...overrides.routerDeps,
    }));
    const server = await loopbackTestServer(app);
    if (fixtureTeamId) fixtureTeams.set(server, fixtureTeamId);
    return server;
  };

  const server = await openApp();
  return {
    app: server,
    openApp,
    db,
    agentStore,
    workflowStore,
    settingsStore,
    runStore,
    decisionStore,
    noteStore,
    reviewStore,
    answerStore,
    taskStore,
    taskService,
    engine,
    closeRunTerminals,
    engineStarts,
    scheduled,
    projects,
    preflight,
    flushStart: () => { while (scheduled.length) scheduled.shift()(); },
    setFixtureTeam: teamId => { fixtureTeamId = teamId; fixtureTeams.set(server, teamId); },
  };
}

function staff(ctx, agent) {
  const team = createTeamStore(ctx.db).create({ name: 'Feature team', members: BUILT_IN_ROLES.map(role => ({ role: role.name, agentId: agent.id })) });
  ctx.setFixtureTeam(team.id);
  return team;
}

async function seedReady(ctx, { withInput = true } = {}) {
  const agent = ctx.agentStore.create(agentBody());
  ctx.settingsStore.update({ setupAgentId: agent.id, defaultBaseBranch: null, revision: 1 });
  const workflow = ctx.workflowStore.create({
    name: 'Feature', agentsDecide: false,
    nodes: [node(agent.id, withInput ? {} : { prompt: 'No placeholder' })],
  });
  const team = staff(ctx, agent);
  return { agent, workflow, team };
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

  it('blocks deletion while an agent is staffed on a team, then permits it while the workflow keeps its role', async () => {
    const ctx = await setup();
    const { agent, workflow, team } = await seedReady(ctx);

    const setupDelete = await request(ctx.app).delete(`${base}/agents/${agent.id}`);
    expect(setupDelete.status).toBe(409);

    ctx.settingsStore.update({ setupAgentId: null, defaultBaseBranch: null, revision: 2 });
    const usedDelete = await request(ctx.app).delete(`${base}/agents/${agent.id}`);
    expect(usedDelete.status).toBe(409);

    createTeamStore(ctx.db).remove(team.id);
    expect((await request(ctx.app).delete(`${base}/agents/${agent.id}`)).status).toBe(204);
    expect(ctx.workflowStore.get(workflow.id).nodes[0].role).toBe('Developer');
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

describe('pipelines API — run notes', () => {
  it.each([
    ['bug-fix', null], ['troubleshoot', null], ['feature-build', null], ['feature-from-requirements', null],
    ['bug-fix', 'Also write release notes.'],
  ])('does not mark Commit as inspectCleanCommit so release notes and changelog are always written (%s, %s)', async (id, extra) => {
    const ctx = await setup();
    await seedReady(ctx);
    const draft = buildTemplateDraft(id);
    if (extra) draft.nodes.at(-1).prompt += ' ' + extra;
    const workflow = ctx.workflowStore.create(draft);
    const response = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'snapshot', workflowId: workflow.id, project: 'Demo', input: 'Watch' });
    expect(response.status).toBe(201);
    const commit = ctx.runStore.get(response.body.id).definition.steps.at(-1);
    expect(commit.inspectCleanCommit).toBeUndefined();
  });

  it('creates a notes directory and exposes a paged notes list and latest step note', async () => {
    const ctx = await setup();
    const { workflow } = await seedReady(ctx);
    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'notes-1', workflowId: workflow.id, project: 'Demo', input: 'x' });
    expect(started.status).toBe(201);
    expect(started.body.notesDir).toBe(`.codedeck/runs/${started.body.id.slice(0, 8)}`);
    expect(started.body.steps[0].notePath).toBeNull();
    expect(started.body.steps[1].notePath).toMatch(/01-develop\.md$/);
    ctx.noteStore.add({ runId: started.body.id, stepIndex: 1, stepName: 'Develop', attempt: 1, pass: 1, status: 'written', summary: 'Done', content: '# Done' });
    const page = await request(ctx.app).get(`${base}/runs/${started.body.id}/notes`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ data: [{ status: 'written', summary: 'Done', content: '# Done' }], page: { currentPage: 0, size: 20, totalElements: 1, totalPages: 1, hasNextPage: false } });
    expect((await request(ctx.app).get(`${base}/runs/${started.body.id}`)).body.steps[1].note.summary).toBe('Done');
    expect((await request(ctx.app).get(`${base}/runs/${started.body.id}/notes`).query({ sort: 'bad' })).status).toBe(400);
  });
  it('pages, filters, sorts, rejects bad queries, and returns 404 for an unknown run', async () => {
    const ctx = await setup();
    const { workflow } = await seedReady(ctx);
    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'notes-query', workflowId: workflow.id, project: 'Demo', input: 'x' });
    const id = started.body.id;
    for (let pass = 1; pass <= 3; pass++) ctx.noteStore.add({ runId: id, stepIndex: 1, stepName: 'Develop', attempt: 1, pass, status: 'written', summary: `Pass ${pass}`, content: `# Pass ${pass}` });
    const get = query => request(ctx.app).get(`${base}/runs/${id}/notes`).query(query);
    expect((await get({ page: 1, size: 1, sort: 'createdAt,desc', stepIndex: 1 })).body).toMatchObject({ data: [{ pass: 2 }], page: { currentPage: 1, size: 1, totalElements: 3, totalPages: 3, hasNextPage: true } });
    expect((await get({ sort: 'createdAt,asc' })).body.data.map(row => row.pass)).toEqual([1, 2, 3]);
    expect((await get({ stepIndex: 0 })).body.data).toEqual([]);
    for (const query of [{ page: -1 }, { size: 0 }, { sort: 'name,asc' }, { stepIndex: -1 }, { other: 'x' }]) {
      const response = await get(query);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ status: 400, errors: [expect.objectContaining({ field: expect.any(String) })], traceId: expect.any(String) });
    }
    expect((await request(ctx.app).get(`${base}/runs/11111111-1111-4111-8111-111111111111/notes`)).status).toBe(404);
  });
  it('refuses a worktree path that makes guidance too long before writing a run', async () => {
    const ctx = await setup({ planNames: () => ({ worktreePath: `/${'a'.repeat(3950)}`, branch: 'workflow/long' }) });
    const { workflow } = await seedReady(ctx);
    const result = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'long-notes', workflowId: workflow.id, project: 'Demo', input: 'x' });
    expect(result.status).toBe(400);
    expect(result.body.errors).toEqual([{ field: 'project', message: expect.any(String) }]);
    expect(ctx.runStore.list()).toEqual([]);
    expect(ctx.engine.start).not.toHaveBeenCalled();
  });
});

describe('pipelines API — progress file start boundary', () => {
  async function ready(overrides = {}) {
    const ctx = await setup(overrides);
    const agent = ctx.agentStore.create(agentBody());
    staff(ctx, agent);
    ctx.settingsStore.update({ setupAgentId: agent.id, defaultBaseBranch: null, revision: 1 });
    const workflow = ctx.workflowStore.create({ name: 'Progress', agentsDecide: false, progressFile: 'docs/todo.md', nodes: [node(agent.id, { prompt: 'Work' })] });
    const body = { requestId: 'progress-boundary', workflowId: workflow.id, project: 'Demo', input: 'feature' };
    return { ctx, workflow, body };
  }

  it('starts in an adopted task whose progress file is only untracked', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cd-adopt-run-')));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'backend');
    const tree = path.join(root, 'worktrees', 'backend-spec');
    mkdirSync(home);
    const git = (...args) => execFileSync('git', ['-C', home, ...args], { encoding: 'utf8' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.test');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(home, 'README.md'), 'base');
    git('add', 'README.md');
    git('commit', '-m', 'base');
    mkdirSync(path.dirname(tree));
    git('worktree', 'add', '-b', 'feature/spec', tree);
    mkdirSync(path.join(tree, 'docs'));
    writeFileSync(path.join(tree, 'docs/todo.md'), '# untracked');
    const { ctx, body } = await ready({ repo: home });
    const task = await ctx.taskService.adoptWorktree({ project: 'Demo', worktreePath: tree });
    const response = await request(ctx.app).post(`${base}/runs`).send({ ...body, taskId: task.id });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ taskId: task.id });
    expect(ctx.runStore.get(response.body.id).worktreePath).toBe(tree);
    expect(readFileSync(path.join(tree, 'docs/todo.md'), 'utf8')).toBe('# untracked');
  });

  it.each([
    ['/Users/me/git/demo/docs/todos/plan.md', 'docs//Users/me/git/demo/docs/todos/plan.md'],
    ['../outside.md', 'docs/../outside.md'],
    ['todos/plan', 'docs/todos/plan'],
    [`todos/${'x'.repeat(600)}.md`, `docs/todos/${'x'.repeat(109)}…`],
  ])('says what the progress file would be when the input %j does not complete its path', async (input, shown) => {
    const { ctx, body } = await ready();
    const workflow = ctx.workflowStore.create({ name: 'Templated', agentsDecide: false, progressFile: 'docs/{input}', nodes: [node(ctx.agentStore.list()[0].id, { prompt: 'Work on {input}' })] });
    const result = await request(ctx.app).post(`${base}/runs`).send({ ...body, workflowId: workflow.id, input });
    expect(result.status).toBe(400);
    expect(result.body.errors).toEqual([{
      field: 'input',
      message: `This workflow reads its progress from docs/{input}. With this input that is "${shown}", which is not the path of a .md file inside the project. Type only the part that replaces {input}.`,
    }]);
    expect(ctx.runStore.list()).toEqual([]);
  });

  it.each([
    ['blob', 201], ['missing', 400], ['untracked', 400], ['tree', 400],
  ])('checks the linked project commit for a %s path before storing a new run', async (kind, status) => {
    const execFile = vi.fn((_command, args, _options, callback) => {
      expect(args).toEqual(['-C', PROJECT.path, 'ls-tree', '-z', 'HEAD', '--', 'docs/todo.md']);
      callback(null, kind === 'blob' ? '100644 blob abc\tdocs/todo.md\0' : kind === 'tree' ? '040000 tree abc\tdocs/todo.md\0' : '', '');
    });
    const { ctx, body } = await ready({ routerDeps: { execFile } });
    const result = await request(ctx.app).post(`${base}/runs`).send(body);
    expect(result.status).toBe(status);
    expect(execFile).toHaveBeenCalledTimes(1);
    if (status === 400) {
      expect(result.body.errors).toContainEqual({ field: 'input', message: 'docs/todo.md is not in this repository at its current commit. Commit it, or start the run from the project that contains it.' });
      expect(ctx.runStore.list()).toHaveLength(0);
      expect(ctx.scheduled).toHaveLength(0);
    }
  });

  describe('an input typed as the whole path of the progress file', () => {
    const committed = files => vi.fn((_command, args, _options, callback) => {
      const file = args.at(-1);
      callback(null, files.includes(file) ? `100644 blob abc\t${file}\0` : '', '');
    });
    const templated = (ctx, progressFile = 'docs/{input}') => ctx.workflowStore.create({ name: 'Templated', agentsDecide: false, progressFile,
      nodes: [node(ctx.agentStore.list()[0].id, { prompt: 'Work through docs/{input} now' })] });
    const looked = execFile => execFile.mock.calls.map(([, args]) => args.at(-1));

    it('starts the run with the part that replaces {input}, in its prompts and its progress file', async () => {
      const execFile = committed(['docs/todos/tag-pings.md']);
      const { ctx, body } = await ready({ routerDeps: { execFile } });
      const result = await request(ctx.app).post(`${base}/runs`).send({ ...body, workflowId: templated(ctx).id, input: 'docs/todos/tag-pings.md' });
      expect(result.status).toBe(201);
      // As typed first, then the whole-path reading.
      expect(looked(execFile)).toEqual(['docs/docs/todos/tag-pings.md', 'docs/todos/tag-pings.md']);
      const run = ctx.runStore.get(result.body.id);
      expect(run.input).toBe('todos/tag-pings.md');
      expect(result.body.input).toBe('todos/tag-pings.md');
      expect(run.definition.progressFile).toBe('docs/todos/tag-pings.md');
      expect(run.definition.steps.at(-1).prompt).toContain('Work through docs/todos/tag-pings.md now');
    });

    it('reads the input as typed when that file is there, even if the whole-path reading is there too', async () => {
      const execFile = committed(['docs/docs/todos/tag-pings.md', 'docs/todos/tag-pings.md']);
      const { ctx, body } = await ready({ routerDeps: { execFile } });
      const result = await request(ctx.app).post(`${base}/runs`).send({ ...body, workflowId: templated(ctx).id, input: 'docs/todos/tag-pings.md' });
      expect(result.status).toBe(201);
      expect(looked(execFile)).toEqual(['docs/docs/todos/tag-pings.md']);
      expect(ctx.runStore.get(result.body.id)).toMatchObject({ input: 'docs/todos/tag-pings.md', definition: { progressFile: 'docs/docs/todos/tag-pings.md' } });
    });

    it('refuses with both places it looked when neither file is there', async () => {
      const execFile = committed([]);
      const { ctx, body } = await ready({ routerDeps: { execFile } });
      const result = await request(ctx.app).post(`${base}/runs`).send({ ...body, workflowId: templated(ctx).id, input: 'docs/todos/tag-pings.md' });
      expect(result.status).toBe(400);
      expect(result.body.errors).toEqual([{ field: 'input', message: 'Neither docs/docs/todos/tag-pings.md nor docs/todos/tag-pings.md is in this repository at its current commit. Commit it, or start the run from the project that contains it.' }]);
      expect(ctx.runStore.list()).toEqual([]);
    });

    it('takes the part from a template that also ends the path', async () => {
      const execFile = committed(['docs/todos/feature.md']);
      const { ctx, body } = await ready({ routerDeps: { execFile } });
      const result = await request(ctx.app).post(`${base}/runs`).send({ ...body, workflowId: templated(ctx, 'docs/todos/{input}.md').id, input: 'docs/todos/feature.md' });
      expect(result.status).toBe(201);
      expect(ctx.runStore.get(result.body.id)).toMatchObject({ input: 'feature', definition: { progressFile: 'docs/todos/feature.md' } });
    });

    it('keeps the one place in the refusal when the input cannot be a whole path', async () => {
      const execFile = committed([]);
      const { ctx, body } = await ready({ routerDeps: { execFile } });
      const result = await request(ctx.app).post(`${base}/runs`).send({ ...body, workflowId: templated(ctx).id, input: 'todos/tag-pings.md' });
      expect(result.status).toBe(400);
      expect(result.body.errors).toEqual([{ field: 'input', message: 'docs/todos/tag-pings.md is not in this repository at its current commit. Commit it, or start the run from the project that contains it.' }]);
      expect(looked(execFile)).toEqual(['docs/todos/tag-pings.md']);
    });

    it('answers a replay of the same request with the same run', async () => {
      const execFile = committed(['docs/todos/tag-pings.md']);
      const { ctx, body } = await ready({ routerDeps: { execFile } });
      const start = { ...body, workflowId: templated(ctx).id, input: 'docs/todos/tag-pings.md' };
      const first = await request(ctx.app).post(`${base}/runs`).send(start);
      const replay = await request(ctx.app).post(`${base}/runs`).send(start);
      expect([first.status, replay.status]).toEqual([201, 200]);
      expect(replay.body.id).toBe(first.body.id);
      // The request is known by what was typed: the part alone under the same id is another request.
      expect((await request(ctx.app).post(`${base}/runs`).send({ ...start, input: 'todos/tag-pings.md' })).status).toBe(409);
    });

    it('finds the whole path in a chosen worktree too', async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'cd-progress-whole-'));
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const worktreePath = path.join(root, 'worktree');
      mkdirSync(path.join(worktreePath, 'docs/todos'), { recursive: true });
      writeFileSync(path.join(worktreePath, 'docs/todos/tag-pings.md'), '# todo');
      const listWorktrees = vi.fn(async () => [{ path: worktreePath, head: 'a'.repeat(40), branch: 'feature/x', missing: false }]);
      const { ctx, body } = await ready({ routerDeps: { listWorktrees, readWorktreeChanges: async () => ({ readable: true, dirty: false }) } });
      const start = { ...body, workflowId: templated(ctx).id, worktreePath };
      const absent = await request(ctx.app).post(`${base}/runs`).send({ ...start, requestId: 'whole-absent', input: 'docs/todos/other.md' });
      expect(absent.status).toBe(400);
      expect(absent.body.errors).toEqual([{ field: 'input', message: 'Neither docs/docs/todos/other.md nor docs/todos/other.md is in the chosen worktree. Add it there, or choose the worktree that contains it.' }]);
      const found = await request(ctx.app).post(`${base}/runs`).send({ ...start, input: 'docs/todos/tag-pings.md' });
      expect(found.status).toBe(201);
      expect(ctx.runStore.get(found.body.id)).toMatchObject({ input: 'todos/tag-pings.md', definition: { progressFile: 'docs/todos/tag-pings.md' } });
    });
  });

  it('does not check progress on an idempotent replay after the file disappears', async () => {
    const execFile = vi.fn((_command, _args, _options, callback) => callback(null, '100644 blob abc\tdocs/todo.md\0', ''));
    const { ctx, body } = await ready({ routerDeps: { execFile } });
    const first = await request(ctx.app).post(`${base}/runs`).send(body);
    expect(first.status).toBe(201);
    execFile.mockClear();
    const replay = await request(ctx.app).post(`${base}/runs`).send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('surfaces an unexpected git failure as a server error', async () => {
    const execFile = vi.fn((_command, _args, _options, callback) => callback(new Error('git crashed'), '', 'fatal: git crashed'));
    const { ctx, body } = await ready({ routerDeps: { execFile } });
    const result = await request(ctx.app).post(`${base}/runs`).send(body);
    expect(result.status).toBe(500);
    expect(ctx.runStore.list()).toHaveLength(0);
  });

  it('does not consult the guard for a workflow without progressFile', async () => {
    const execFile = vi.fn();
    const ctx = await setup({ routerDeps: { execFile } });
    const { workflow } = await seedReady(ctx);
    const result = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'no-progress', workflowId: workflow.id, project: 'Demo', input: 'feature' });
    expect(result.status).toBe(201);
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(['present', 'absent', 'outside'])('checks a chosen worktree for a %s file', async kind => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cd-progress-boundary-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const worktreePath = path.join(root, 'worktree');
    mkdirSync(path.join(worktreePath, 'docs'), { recursive: true });
    if (kind === 'present') writeFileSync(path.join(worktreePath, 'docs/todo.md'), '# todo');
    if (kind === 'outside') {
      writeFileSync(path.join(root, 'outside.md'), '# outside');
      symlinkSync(path.join(root, 'outside.md'), path.join(worktreePath, 'docs/todo.md'));
    }
    const listWorktrees = vi.fn(async () => [{ path: worktreePath, head: 'a'.repeat(40), branch: 'feature/x', missing: false }]);
    const { ctx, body } = await ready({ routerDeps: { listWorktrees, readWorktreeChanges: async () => ({ readable: true, dirty: false }) } });
    const result = await request(ctx.app).post(`${base}/runs`).send({ ...body, worktreePath });
    expect(result.status).toBe(kind === 'present' ? 201 : 400);
    if (kind !== 'present') {
      expect(result.body.errors).toContainEqual({ field: 'input', message: 'docs/todo.md is not in the chosen worktree. Add it there, or choose the worktree that contains it.' });
      expect(ctx.runStore.list()).toHaveLength(0);
    }
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
    expect(settings.body).toEqual({ setupAgentId: null, defaultBaseBranch: null, revision: 1 });

    const updated = await request(app).put(`${base}/settings`).send({
      setupAgentId: agent.id,
      defaultBaseBranch: 'develop',
      revision: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ setupAgentId: agent.id, defaultBaseBranch: 'develop', revision: 2 });

    const unnamed = await request(app).put(`${base}/settings`).send({ setupAgentId: agent.id, revision: 2 });
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.errors.map(error => error.field)).toEqual(['defaultBaseBranch']);
  });

  it('rejects a workflow node whose role is absent from the catalog', async () => {
    const { app } = await setup();
    const response = await request(app).post(`${base}/workflows`).send({
      name: 'Feature', agentsDecide: false,
      nodes: [node(null, { role: 'Unlisted role' })],
    });
    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([
      { field: 'nodes[0].role', message: 'Choose an existing role' },
    ]);
  });

  it('returns 409 for duplicate workflow names and stale settings revision', async () => {
    const { app, agentStore } = await setup();
    const agent = agentStore.create(agentBody());
    await request(app).post(`${base}/workflows`).send({ name: 'Feature', agentsDecide: false, nodes: [node(agent.id)] });
    const dup = await request(app).post(`${base}/workflows`).send({ name: 'feature', agentsDecide: false, nodes: [node(agent.id)] });
    expect(dup.status).toBe(409);

    const stale = await request(app).put(`${base}/settings`).send({ setupAgentId: null, defaultBaseBranch: null, revision: 9 });
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
      host: 'local',
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
      attachments: [],
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
      kind: 'setup', role: '', askOwner: false, readOnly: false, approval: false,
      name: 'Setup',
      agentName: 'codex-sol-high',
      status: 'pending',
      repeat: { mode: 'until_complete', max: 3 },
    });
    expect(started.body.steps[1]).toMatchObject({
      index: 1,
      kind: 'node', role: 'Developer', askOwner: false, readOnly: false, approval: false,
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
      nodes: [node(agent.id, { name: 'Big', prompt: '{input}'.repeat(4) })],
    });
    const boundaryInput = `first\n\n${'y'.repeat(4089)}`;
    const atLimit = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'exact-compose-limit', workflowId: huge.id, project: 'Demo', input: boundaryInput,
    });
    expect(atLimit.status).toBe(201);
    expect(ctx.runStore.get(atLimit.body.id).definition.steps.at(-1).prompt).toBe(boundaryInput.repeat(4));

    const oneOver = ctx.workflowStore.create({
      name: 'OverLimit', agentsDecide: false,
      nodes: [node(agent.id, { name: 'Big', prompt: `${'{input}'.repeat(4)}x` })],
    });
    const oversized = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'oversized-compose',
      workflowId: oneOver.id,
      project: 'Demo',
      input: boundaryInput,
    });
    expect(oversized.status).toBe(400);
    expect(oversized.body.errors).toEqual([{ field: 'input', message: 'Composed prompt must be at most 16384 characters' }]);
  });

  it('accepts descriptive multiline input, normalizes line endings, and keeps path Progress input single-line', async () => {
    const ctx = await setup();
    const { agent, workflow } = await seedReady(ctx);
    const paragraphs = 'First paragraph.\r\n\rSecond paragraph with trailing spaces.  \n';
    const started = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'multiline-descriptive',
      workflowId: workflow.id,
      project: 'Demo',
      input: paragraphs,
    });
    expect(started.status).toBe(201);
    const stored = ctx.runStore.get(started.body.id);
    expect(stored.input).toBe('First paragraph.\n\nSecond paragraph with trailing spaces.  \n');
    expect(stored.definition.inputMode).toBe('descriptive');
    expect(stored.definition.steps.at(-1).prompt).toContain('First paragraph.\n\nSecond paragraph');
    expect(started.body.input).toBe(stored.input);
    const replayed = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'multiline-descriptive', workflowId: workflow.id, project: 'Demo', input: stored.input,
    });
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ id: started.body.id, input: stored.input });

    const whitespace = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'whitespace-only',
      workflowId: workflow.id,
      project: 'Demo',
      input: '  \n\n  ',
    });
    expect(whitespace.status).toBe(400);
    expect(whitespace.body.errors).toEqual([{ field: 'input', message: expect.stringMatching(/input/i) }]);

    const optional = ctx.workflowStore.create({
      name: 'Optional', agentsDecide: false,
      nodes: [node(agent.id, { prompt: 'No placeholder' })],
    });
    const emptyOk = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'empty-ok',
      workflowId: optional.id,
      project: 'Demo',
      input: '',
    });
    expect(emptyOk.status).toBe(201);
    expect(ctx.runStore.get(emptyOk.body.id).input).toBe('');

    const execFile = vi.fn((_command, args, _options, callback) => {
      callback(null, args.at(-1) === 'docs/todo.md' ? '100644 blob abc\tdocs/todo.md\0' : '', '');
    });
    const fixedCtx = await setup({ routerDeps: { execFile } });
    staff(fixedCtx, fixedCtx.agentStore.create(agentBody()));
    fixedCtx.settingsStore.update({ setupAgentId: fixedCtx.agentStore.list()[0].id, defaultBaseBranch: null, revision: 1 });
    const fixedWorkflow = fixedCtx.workflowStore.create({
      name: 'FixedProgress', agentsDecide: false, progressFile: 'docs/todo.md',
      nodes: [node(fixedCtx.agentStore.list()[0].id, { prompt: 'Work' })],
    });
    const fixedStart = await request(fixedCtx.app).post(`${base}/runs`).send({
      requestId: 'fixed-multiline',
      workflowId: fixedWorkflow.id,
      project: 'Demo',
      input: 'Notes about the work\nwith a second line',
    });
    expect(fixedStart.status).toBe(201);
    expect(fixedCtx.runStore.get(fixedStart.body.id).input).toBe('Notes about the work\nwith a second line');

    const pathWorkflow = ctx.workflowStore.create({
      name: 'PathProgress', agentsDecide: false, progressFile: 'docs/{input}',
      nodes: [node(agent.id, { prompt: 'Work on {input}' })],
    });
    const pathReject = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'path-multiline',
      workflowId: pathWorkflow.id,
      project: 'Demo',
      input: 'todos/x.md\nmore',
    });
    expect(pathReject.status).toBe(400);
    expect(pathReject.body.errors).toEqual([{
      field: 'input',
      message: 'Use 0–4096 characters on one line without control characters',
    }]);
    expect(ctx.runStore.getByRequestId('path-multiline')).toBeNull();

    const withLiteral = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'literal-input-token',
      workflowId: workflow.id,
      project: 'Demo',
      input: 'contains {input} literally\nand another line',
      newTask: {},
    });
    expect(withLiteral.status).toBe(201);
    const literalRun = ctx.runStore.get(withLiteral.body.id);
    expect(literalRun.definition.steps.at(-1).prompt).toBe('Implement contains {input} literally\nand another line');
    expect(literalRun.definition.inputMode).toBe('descriptive');
    expect(withLiteral.body.taskId).toEqual(expect.any(String));
    expect(ctx.taskStore.get(withLiteral.body.taskId).title).toBe('contains {input} literally and another line');
  });

  it('requires a title or nonblank input for a new task even if the workflow input is optional', async () => {
    const ctx = await setup();
    const { agent } = await seedReady(ctx);
    const optional = ctx.workflowStore.create({
      name: 'Optional', agentsDecide: false,
      nodes: [node(agent.id, { prompt: 'No placeholder' })],
    });
    const start = { requestId: 'untitled-empty', workflowId: optional.id, project: 'Demo', input: ' \n\n ', newTask: {} };
    const rejected = await request(ctx.app).post(`${base}/runs`).send(start);
    expect(rejected.status).toBe(400);
    expect(rejected.body.errors).toContainEqual({ field: 'input', message: expect.stringMatching(/title/i) });
    expect(ctx.taskService.plan).not.toHaveBeenCalled();

    const started = await request(ctx.app).post(`${base}/runs`).send({ ...start, newTask: { title: 'Explicit title' } });
    expect(started.status).toBe(201);
    expect(ctx.taskStore.get(started.body.taskId).title).toBe('Explicit title');
    expect(ctx.runStore.get(started.body.id).input).toBe(start.input);
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
    settingsStore.update({ setupAgentId: agent.id, defaultBaseBranch: null, revision: 1 });
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
          notesDir: null,
          steps: [{
            kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
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
          detail: null, startedAt: null, finishedAt: null, elapsedMs: 0,
        }],
        homePath: '/Users/me/git/codedeck',
        worktreePath: `/Users/me/git/worktrees/r-${index}`,
        worktreeBranch: `workflow/r-${index}`,
        baseCommit: null,
        worktreeState: 'not_created',
        worktreeDetail: null,
    inputRequest: null,
    taskId: null,
        finishedAt: null,
      });
    }

    const app = express();
    const roleStore = createRoleStore(db);
    for (const role of BUILT_IN_ROLES) roleStore.ensureRole(role.name, role.description);
    app.use(createPipelinesRouter({
      db,
      agentStore,
      roleStore,
      workflowStore,
      settingsStore,
      runStore,
      requestStore: createRequestStore(db),
      decisionStore: createDecisionStore(db),
      noteStore: createNoteStore(db),
      reviewStore: createReviewStore(db),
      answerStore: createAnswerStore(db),
      teamStore: createTeamStore(db),
      templateStore: createTemplateStore(db),
      stepPresetStore: createStepPresetStore(db),
      taskStore: createTaskStore(db),
      taskService: { plan: async () => { throw new Error('unused'); }, createPlanned: async () => { throw new Error('unused'); } },
      findProject: () => PROJECT,
      engine: { start: () => {} },
      closeRunTerminals: async () => ({ closed: [], notClosed: [] }),
      preflight: async () => ({ eligible: true, reasons: [], branch: 'main', head: 'a'.repeat(40), dirty: false }),
      resolveHomeRepoPath: async () => '/Users/me/git/codedeck',
      scheduleStart: () => {},
    }));
    const server = await loopbackTestServer(app);

    const page0 = await request(server).get(`${base}/runs`).query({ size: 2, sort: 'createdAt,asc' });
    expect(page0.body.data.map(r => r.id)).toEqual([ids[0], ids[1]]);
    expect(page0.body.data.every(r => Array.isArray(r.attachments) && r.attachments.length === 0)).toBe(true);
    expect(page0.body.page.hasNextPage).toBe(true);

    const page1 = await request(server).get(`${base}/runs`).query({ page: 1, size: 2, sort: 'createdAt,asc' });
    expect(page1.body.data.map(r => r.id)).toEqual([ids[2]]);
    expect(page1.body.data[0].attachments).toEqual([]);

    const filtered = await request(server).get(`${base}/runs`).query({ project: 'Demo', open: 'true' });
    expect(filtered.body.page.totalElements).toBe(3);
  });

  it('projects ordered attachment name, path and size on detail and list without digests', async () => {
    const ctx = await setup();
    const { workflow } = await seedReady(ctx);
    const started = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'attach-view',
      workflowId: workflow.id,
      project: 'Demo',
      input: 'x',
    });
    expect(started.status).toBe(201);
    const notesDir = ctx.runStore.get(started.body.id).definition.notesDir;
    const digest = 'cd'.repeat(32);
    const attachments = [
      { name: 'a.txt', path: `${notesDir}/attachments/01-a.txt`, sizeBytes: 1, digest },
      { name: 'b.txt', path: `${notesDir}/attachments/02-b.txt`, sizeBytes: 2, digest: 'ef'.repeat(32) },
    ];
    ctx.runStore.update(started.body.id, { attachments });

    const detail = await request(ctx.app).get(`${base}/runs/${started.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.attachments).toEqual([
      { name: 'a.txt', path: `${notesDir}/attachments/01-a.txt`, sizeBytes: 1 },
      { name: 'b.txt', path: `${notesDir}/attachments/02-b.txt`, sizeBytes: 2 },
    ]);
    expect(JSON.stringify(detail.body)).not.toMatch(/digest/);
    expect(JSON.stringify(detail.body)).not.toContain(digest);

    const listed = await request(ctx.app).get(`${base}/runs`).query({ size: 1 });
    expect(listed.body.data[0].attachments).toEqual(detail.body.attachments);

    const missing = await request(ctx.app).get(`${base}/runs/11111111-1111-4111-8111-111111111111`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ status: 404, traceId: expect.any(String) });
  });
});

describe('pipelines API — multipart run start', () => {
  // Accepted starts publish for real, so they work in a real repository with real run checkouts.
  async function stagingSetup() {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cd-pipe-attach-')));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    git('init', '-b', 'main');
    git('-c', 'user.name=API Test', '-c', 'user.email=api@test.local', 'commit', '--allow-empty', '-m', 'init');
    const stagingRoot = path.join(dir, 'staging');
    const ctx = await setup({ repo, routerDeps: { attachmentStagingRoot: stagingRoot, planNames: realPlanNames } });
    const { workflow } = await seedReady(ctx);
    return { ctx, workflow, stagingRoot };
  }

  function runFields(workflowId, requestId = 'mp-run') {
    return JSON.stringify({ requestId, workflowId, project: 'Demo', input: 'brief' });
  }

  it('accepts multipart with ordered files and returns public attachments without digests', async () => {
    const { ctx, workflow } = await stagingSetup();
    const response = await request(ctx.app)
      .post(`${base}/runs`)
      .field('run', runFields(workflow.id, 'mp-ok'))
      .attach('files', Buffer.from('alpha'), 'a.txt')
      .attach('files', Buffer.from('beta'), 'b.txt');
    expect(response.status).toBe(201);
    expect(response.body.attachments).toEqual([
      expect.objectContaining({ name: 'a.txt', sizeBytes: 5, path: expect.stringMatching(/\.codedeck\/runs\/[0-9a-f]{8}\/attachments\//) }),
      expect.objectContaining({ name: 'b.txt', sizeBytes: 4 }),
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/digest/);
    expect(response.headers['x-trace-id']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('returns 400 with indexed files[n] errors for an unsafe filename', async () => {
    const { ctx, workflow } = await stagingSetup();
    // Superagent basenames path separators; overlong names still reach the server.
    const response = await request(ctx.app)
      .post(`${base}/runs`)
      .field('run', runFields(workflow.id, 'mp-bad-name'))
      .attach('files', Buffer.from('x'), `${'a'.repeat(256)}.txt`);
    expect(response.status).toBe(400);
    expect(response.type).toBe('application/problem+json');
    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'files[0]' })]);
    expect(response.body.traceId).toBe(response.headers['x-trace-id']);
  });

  it('returns 413 when more than 20 files are attached', async () => {
    const { ctx, workflow } = await stagingSetup();
    let req = request(ctx.app).post(`${base}/runs`).field('run', runFields(workflow.id, 'mp-too-many'));
    for (let i = 0; i < 21; i++) req = req.attach('files', Buffer.from(String(i)), `f${i}.txt`);
    const response = await req;
    expect(response.status).toBe(413);
    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'files' })]);
    expect(response.body.traceId).toBe(response.headers['x-trace-id']);
  });

  it('keeps hostile unexpected part names and content out of the problem and correlated warning', async () => {
    const { ctx, workflow } = await stagingSetup();
    const partName = 'hostile-<img src=x>';
    const partContent = 'private-part-marker';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await request(ctx.app)
        .post(`${base}/runs`)
        .field('run', runFields(workflow.id, 'mp-hostile'))
        .field(partName, partContent)
        .attach('files', Buffer.from('x'), 'a.txt');
      expect(response.status).toBe(400);
      expect(response.body.traceId).toBe(response.headers['x-trace-id']);
      expect(response.body.errors).toEqual([expect.objectContaining({ field: 'field' })]);
      const correlatedWarning = warning.mock.calls.find(([line]) => line.includes(`traceId=${response.body.traceId}`));
      expect(correlatedWarning).toBeDefined();
      expect(JSON.stringify(correlatedWarning)).toMatch(/\bfield\b/);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(partContent);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(partName);
      expect(response.text).not.toContain(partContent);
      expect(response.text).not.toContain(partName);
    } finally {
      warning.mockRestore();
    }
  });

  it('returns 409 when a multipart start reuses a requestId with different launch fields', async () => {
    const { ctx, workflow } = await stagingSetup();
    const first = await request(ctx.app)
      .post(`${base}/runs`)
      .field('run', runFields(workflow.id, 'mp-conflict'))
      .attach('files', Buffer.from('a'), 'a.txt');
    expect(first.status).toBe(201);
    const conflict = await request(ctx.app)
      .post(`${base}/runs`)
      .field('run', JSON.stringify({ requestId: 'mp-conflict', workflowId: workflow.id, project: 'Demo', input: 'changed' }))
      .attach('files', Buffer.from('a'), 'a.txt');
    expect(conflict.status).toBe(409);
  });

  it('returns 409 when attachment order or same-size bytes change under the same requestId', async () => {
    const { ctx, workflow } = await stagingSetup();
    const first = await request(ctx.app)
      .post(`${base}/runs`)
      .field('run', runFields(workflow.id, 'mp-bytes'))
      .attach('files', Buffer.from('alpha'), 'a.txt')
      .attach('files', Buffer.from('beta'), 'b.txt');
    expect(first.status).toBe(201);
    const reordered = await request(ctx.app)
      .post(`${base}/runs`)
      .field('run', runFields(workflow.id, 'mp-bytes'))
      .attach('files', Buffer.from('beta'), 'b.txt')
      .attach('files', Buffer.from('alpha'), 'a.txt');
    expect(reordered.status).toBe(409);
    const sameSize = await request(ctx.app)
      .post(`${base}/runs`)
      .field('run', runFields(workflow.id, 'mp-bytes'))
      .attach('files', Buffer.from('ALPHA'), 'a.txt')
      .attach('files', Buffer.from('beta'), 'b.txt');
    expect(sameSize.status).toBe(409);
    const matching = await request(ctx.app)
      .post(`${base}/runs`)
      .field('run', runFields(workflow.id, 'mp-bytes'))
      .attach('files', Buffer.from('alpha'), 'a.txt')
      .attach('files', Buffer.from('beta'), 'b.txt');
    expect(matching.status).toBe(200);
    expect(matching.body.id).toBe(first.body.id);
  });

  it('returns 500 when attachment staging cannot be created', async () => {
    const blocker = path.join(mkdtempSync(path.join(os.tmpdir(), 'cd-pipe-block-')), 'file');
    writeFileSync(blocker, 'x');
    cleanup.push(() => rmSync(path.dirname(blocker), { recursive: true, force: true }));
    const ctx = await setup({ routerDeps: { attachmentStagingRoot: blocker } });
    const { workflow } = await seedReady(ctx);
    const response = await request(ctx.app)
      .post(`${base}/runs`)
      .field('run', runFields(workflow.id, 'mp-storage'))
      .attach('files', Buffer.from('x'), 'a.txt');
    expect(response.status).toBe(500);
    expect(response.body.traceId).toBe(response.headers['x-trace-id']);
  });

  it('removes the staged files when the run JSON fails validation after parsing', async () => {
    const { ctx, stagingRoot } = await stagingSetup();
    const response = await request(ctx.app)
      .post(`${base}/runs`)
      .field('run', JSON.stringify({ requestId: 'mp-invalid', workflowId: 'not-a-uuid', project: 'Demo', input: 'brief' }))
      .attach('files', Buffer.from('alpha'), 'a.txt');
    expect(response.status).toBe(400);
    const attempts = path.join(stagingRoot, 'attempts');
    expect(existsSync(attempts) ? readdirSync(attempts) : []).toEqual([]);
  });

  it('keeps JSON attachment-free starts working alongside multipart', async () => {
    const { ctx, workflow } = await stagingSetup();
    const json = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'json-still',
      workflowId: workflow.id,
      project: 'Demo',
      input: 'plain',
    });
    expect(json.status).toBe(201);
    expect(json.body.attachments).toEqual([]);
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
  it.each(['approve', 'send-back'])('returns a problem 404 for unknown and malformed run ids on %s', async action => {
    const ctx = await setup();
    for (const id of ['c4f2d3e4-5678-4901-8cde-f01234567890', 'not-a-uuid']) {
      const response = await request(ctx.app).post(`${base}/runs/${id}/${action}`).send(action === 'approve' ? {} : { comment: 'Revise' });
      expect(response.status).toBe(404);
      expect(response.type).toBe('application/problem+json');
      expect(response.body.traceId).toBe(response.headers['x-trace-id']);
    }
  });
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

  it('exposes ordered attempt evidence and refuses invalid audit filters', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx);
    const page = await request(ctx.app).get(`${base}/runs/${id}/audit?size=1&stepIndex=0`);
    expect(page.status).toBe(200);
    expect(page.body.data[0]).toMatchObject({kind:'created', host:'local', attempt:0, stepIndex:0});
    expect(page.body.page.size).toBe(1);
    const invalid = await request(ctx.app).get(`${base}/runs/${id}/audit?stepIndex=-1`);
    expect(invalid.status).toBe(400);
    expect(invalid.body.traceId).toBeTruthy();
  });

  it('validates approval bodies and returns a conflict after an approval advances', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx);
    const original = ctx.runStore.get(id);
    ctx.runStore.update(id, { status: 'awaiting_approval', steps: original.steps.map((step, index) => index === 0 ? { ...step, status: 'awaiting_approval', attempt: 1 } : step) });
    ctx.engine.approve = vi.fn(async runId => {
      const run = ctx.runStore.get(runId);
      if (run.status !== 'awaiting_approval') throw Object.assign(new Error('Approval already handled'), { code: 'ACTION_REFUSED' });
      return ctx.runStore.update(runId, { status: 'complete', finishedAt: new Date().toISOString(), steps: run.steps.map((step, index) => index === run.currentStepIndex ? { ...step, status: 'complete' } : step) });
    });
    expect((await request(ctx.app).post(`${base}/runs/${id}/approve`).send({ unexpected: true })).body.errors[0].field).toBe('unexpected');
    const approved = await request(ctx.app).post(`${base}/runs/${id}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.approvalRequest).toBeNull();
    expect((await request(ctx.app).post(`${base}/runs/${id}/approve`).send({})).status).toBe(409);
    expect((await request(ctx.app).post(`${base}/runs/${id}/send-back`).send({ comment: '' })).status).toBe(400);
    expect((await request(ctx.app).post(`${base}/runs/not-a-uuid/approve`).send({})).status).toBe(404);
  });
  it('validates send-back comments and exposes the waiting approval request', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx);
    const original = ctx.runStore.get(id);
    ctx.runStore.update(id, { status: 'awaiting_approval', steps: original.steps.map((step, index) => index === 0 ? { ...step, status: 'awaiting_approval', attempt: 1 } : step) });
    const waiting = await request(ctx.app).get(`${base}/runs/${id}`);
    expect(waiting.body.approvalRequest).toMatchObject({ stepIndex: 0, stepName: 'Setup', note: null });
    expect(waiting.body.actions).toMatchObject({ approve: true, sendBack: true });
    for (const body of [{}, { comment: '' }, { comment: 'x'.repeat(4001) }, { comment: 'bad\u0000text' }, { comment: 3 }, { comment: 'ok', extra: true }]) {
      expect((await request(ctx.app).post(`${base}/runs/${id}/send-back`).send(body)).status).toBe(400);
    }
    expect((await request(ctx.app).post(`${base}/runs/${id}/send-back`).set('Content-Type', 'application/json').send('{bad')).status).toBe(400);
    ctx.engine.sendBack = vi.fn(async (runId, comment) => {
      const run = ctx.runStore.get(runId);
      if (run.status !== 'awaiting_approval') throw Object.assign(new Error('Approval already handled'), { code: 'ACTION_REFUSED' });
      expect(comment).toBe('Please revise\nwith evidence');
      return ctx.runStore.update(runId, { status: 'running', steps: run.steps.map((step, index) => index === run.currentStepIndex ? { ...step, status: 'running' } : step) });
    });
    const sent = await request(ctx.app).post(`${base}/runs/${id}/send-back`).send({ comment: 'Please revise\nwith evidence' });
    expect(sent.status).toBe(200);
    expect(ctx.engine.sendBack).toHaveBeenCalledOnce();
    expect((await request(ctx.app).post(`${base}/runs/${id}/send-back`).send({ comment: 'Again' })).status).toBe(409);
    expect((await request(ctx.app).post(`${base}/runs/not-a-uuid/send-back`).send({ comment: 'Again' })).status).toBe(404);
  });
  it('accepts a 4000-character send-back comment and rejects 4001', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx);
    const original = ctx.runStore.get(id);
    ctx.runStore.update(id, { status: 'awaiting_approval', steps: original.steps.map((step, index) => index === 0 ? { ...step, status: 'awaiting_approval', attempt: 1 } : step) });
    const tooLong = await request(ctx.app).post(`${base}/runs/${id}/send-back`).send({ comment: 'x'.repeat(4001) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.errors[0].field).toBe('comment');
    ctx.engine.sendBack = vi.fn(async () => ctx.runStore.get(id));
    const boundary = await request(ctx.app).post(`${base}/runs/${id}/send-back`).send({ comment: 'x'.repeat(4000) });
    expect(boundary.status).toBe(200);
    expect(ctx.engine.sendBack).toHaveBeenCalledWith(id, 'x'.repeat(4000));
  });

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
  it('returns a no-progress stop with Resume and Clean up actions', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx);
    ctx.runStore.update(id, { status: 'stopped', stopReason: 'no_progress', finishedAt: new Date().toISOString() });
    const response = await request(ctx.app).get(`${base}/runs/${id}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'stopped', stopReason: 'no_progress', actions: { resume: true, cleanup: true } });
  });

  it('Stop is refused from complete and error', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx, {
      status: 'complete',
      finishedAt: new Date().toISOString(),
      worktreeState: 'present',
      steps: [
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
      ],
    });
    const refused = await request(ctx.app).post(`${base}/runs/${id}/stop`);
    expect(refused.status).toBe(409);

    ctx.runStore.update(id, {
      status: 'error',
      error: 'boom',
      finishedAt: new Date().toISOString(),
      steps: [
        { status: 'failed', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
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
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
        { status: 'limit_reached', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 2, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
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
        { status: 'interrupted', sessionId: 'Demo-1', priorSessionIds: [], attempt: 1, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
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
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
        { status: 'complete', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
      ],
    });
    const before = await request(ctx.app).get(`${base}/runs/${id}`);
    expect(before.body.actions.cleanup).toBe(true);

    const cleaned = await request(ctx.app).post(`${base}/runs/${id}/cleanup`);
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.worktree.state).toBe('removed');
    expect(cleaned.body.actions.cleanup).toBe(false);
  });

  describe('Close run closes the terminals the run used', () => {
    const usedSteps = [
      { status: 'complete', sessionId: 'Demo-3', priorSessionIds: ['Demo-2'], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
      { status: 'complete', sessionId: 'Demo-4', priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
    ];
    // The engine as it closes a run in a task or in Main: the run lets go of the place it worked in.
    const releasing = ctx => {
      ctx.engine.cleanup = vi.fn(async runId => {
        if (ctx.runStore.get(runId).worktreeState !== 'external') throw Object.assign(new Error('Action cleanup is not allowed'), { code: 'ACTION_REFUSED' });
        return ctx.runStore.update(runId, { worktreeState: 'released', worktreeDetail: null });
      });
    };
    async function seedClosable(ctx, status = 'complete') {
      const seeded = await seedRun(ctx, { status, stopReason: status === 'stopped' ? 'user' : null, error: status === 'error' ? 'The launch command exited.' : null,
        finishedAt: status === 'interrupted' ? null : new Date().toISOString(), worktreeState: 'external', baseCommit: 'a'.repeat(40), steps: usedSteps });
      return seeded.id;
    }

    it('closes them after the run is closed, and answers with the ones closed', async () => {
      const closeRunTerminals = vi.fn(async () => ({ closed: ['Demo-3', 'Demo-4'], notClosed: [] }));
      const ctx = await setup({ closeRunTerminals });
      releasing(ctx);
      const id = await seedClosable(ctx);

      const closed = await request(ctx.app).post(`${base}/runs/${id}/cleanup`);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ id, worktree: { state: 'released' }, terminalsClosed: ['Demo-3', 'Demo-4'], terminalsNotClosed: [] });
      expect(closeRunTerminals).toHaveBeenCalledTimes(1);
      const [run, others] = closeRunTerminals.mock.calls[0];
      expect(run).toMatchObject({ id, worktreeState: 'released', steps: [{ sessionId: 'Demo-3', priorSessionIds: ['Demo-2'] }, { sessionId: 'Demo-4' }] });
      expect(others).toEqual([]);

      // A second Close run is refused and closes nothing more.
      const again = await request(ctx.app).post(`${base}/runs/${id}/cleanup`);
      expect(again.status).toBe(409);
      expect(closeRunTerminals).toHaveBeenCalledTimes(1);
    });

    it.each(['stopped', 'error', 'interrupted'])('closes them for a run that is %s when it is closed', async status => {
      const closeRunTerminals = vi.fn(async () => ({ closed: ['Demo-4'], notClosed: [] }));
      const ctx = await setup({ closeRunTerminals });
      releasing(ctx);
      const id = await seedClosable(ctx, status);
      const closed = await request(ctx.app).post(`${base}/runs/${id}/cleanup`);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ status, terminalsClosed: ['Demo-4'], terminalsNotClosed: [] });
      expect(closeRunTerminals).toHaveBeenCalledTimes(1);
    });

    it('still closes the run when a terminal could not be closed, and says which', async () => {
      const ctx = await setup({ closeRunTerminals: vi.fn(async () => ({ closed: ['Demo-3'], notClosed: ['Demo-4'] })) });
      releasing(ctx);
      const id = await seedClosable(ctx);
      const closed = await request(ctx.app).post(`${base}/runs/${id}/cleanup`);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ worktree: { state: 'released' }, terminalsClosed: ['Demo-3'], terminalsNotClosed: ['Demo-4'] });
      expect((await request(ctx.app).get(`${base}/runs?open=true`)).body.data).toEqual([]);
    });

    it('names the other runs still on screen, whose terminals are theirs to keep', async () => {
      const closeRunTerminals = vi.fn(async () => ({ closed: [], notClosed: [] }));
      const ctx = await setup({ closeRunTerminals });
      releasing(ctx);
      const seeded = await seedRun(ctx, { status: 'complete', finishedAt: new Date().toISOString(), worktreeState: 'external', baseCommit: 'a'.repeat(40), steps: usedSteps });
      const another = async overrides => {
        const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: `other-${overrides.worktreeState}`, workflowId: seeded.workflow.id, project: 'Demo', input: 'docs/todos/feature.md' });
        expect(started.status).toBe(201);
        ctx.runStore.update(started.body.id, { baseCommit: 'a'.repeat(40), ...overrides });
        return started.body.id;
      };
      const working = await another({ status: 'running', worktreeState: 'present' });
      // A run that was already closed is not on screen any more.
      await another({ status: 'complete', finishedAt: new Date().toISOString(), worktreeState: 'released' });

      expect((await request(ctx.app).post(`${base}/runs/${seeded.id}/cleanup`)).status).toBe(200);
      const [, others] = closeRunTerminals.mock.calls[0];
      expect(others.map(run => run.id)).toEqual([working]);
    });

    it('leaves the terminals of a run whose worktree could not be removed: that run is still on screen', async () => {
      const ctx = await setup();
      ctx.engine.cleanup = vi.fn(async runId => ctx.runStore.update(runId, { worktreeState: 'removal_blocked', worktreeDetail: 'worktree contains modified or untracked files' }));
      const { id } = await seedRun(ctx, { status: 'complete', finishedAt: new Date().toISOString(), worktreeState: 'present', baseCommit: 'a'.repeat(40), steps: usedSteps });
      const blocked = await request(ctx.app).post(`${base}/runs/${id}/cleanup`);
      expect(blocked.status).toBe(200);
      expect(blocked.body).toMatchObject({ worktree: { state: 'removal_blocked' }, terminalsClosed: [], terminalsNotClosed: [] });
      expect(ctx.closeRunTerminals).not.toHaveBeenCalled();
    });

    it('closes no terminal when Close run is refused', async () => {
      const ctx = await setup();
      const { id } = await seedRun(ctx, { status: 'running', worktreeState: 'present', baseCommit: 'a'.repeat(40), steps: usedSteps });
      expect((await request(ctx.app).post(`${base}/runs/${id}/cleanup`)).status).toBe(409);
      expect(ctx.closeRunTerminals).not.toHaveBeenCalled();
    });

    it.each([
      ['no answer', undefined],
      ['closed that is not a list', { closed: 'Demo-3', notClosed: [] }],
      ['an empty session id', { closed: [''], notClosed: [] }],
      ['notClosed missing', { closed: [] }],
    ])('fails loudly on %s from the terminal layer', async (_label, answer) => {
      const ctx = await setup({ closeRunTerminals: vi.fn(async () => answer) });
      releasing(ctx);
      const id = await seedClosable(ctx);
      const failed = await request(ctx.app).post(`${base}/runs/${id}/cleanup`);
      expect(failed.status).toBe(500);
      expect(failed.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(failed.body.traceId).toBe(failed.headers['x-trace-id']);
    });

    it('leaves the terminals alone on every other owner action', async () => {
      const ctx = await setup();
      const { id } = await seedRun(ctx, { status: 'running', worktreeState: 'present', baseCommit: 'a'.repeat(40), steps: usedSteps });
      const stopped = await request(ctx.app).post(`${base}/runs/${id}/stop`);
      expect(stopped.status).toBe(200);
      expect(stopped.body).not.toHaveProperty('terminalsClosed');
      expect((await request(ctx.app).post(`${base}/runs/${id}/resume`)).status).toBe(200);
      expect(ctx.closeRunTerminals).not.toHaveBeenCalled();
    });
  });

  it('store rebuild mid-run marks interrupted then Resume works', async () => {
    const ctx = await setup();
    const { id } = await seedRun(ctx);
    ctx.runStore.update(id, {
      status: 'running',
      worktreeState: 'present',
      baseCommit: 'a'.repeat(40),
      steps: [
        { status: 'running', sessionId: 'Demo-1', priorSessionIds: [], attempt: 1, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 },
      ],
    });

    const reopenedStore = createRunStore(ctx.db);
    expect(reopenedStore.get(id).status).toBe('interrupted');
    expect(reopenedStore.get(id).steps[0].status).toBe('interrupted');

    const app = express();
    app.use(createPipelinesRouter({
      db: ctx.db,
      agentStore: ctx.agentStore,
      roleStore: createRoleStore(ctx.db),
      workflowStore: ctx.workflowStore,
      settingsStore: ctx.settingsStore,
      runStore: reopenedStore,
      requestStore: createRequestStore(ctx.db),
      decisionStore: ctx.decisionStore,
      noteStore: ctx.noteStore,
      reviewStore: ctx.reviewStore,
      answerStore: ctx.answerStore,
      teamStore: createTeamStore(ctx.db),
      templateStore: createTemplateStore(ctx.db),
      stepPresetStore: createStepPresetStore(ctx.db),
      taskStore: ctx.taskStore,
      taskService: ctx.taskService,
      findProject: name => ctx.projects.get(name) ?? null,
      closeRunTerminals: ctx.closeRunTerminals,
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

  it('uses the selected host git runner for the existing checkout and its changes', async () => {
    const remoteGit = vi.fn();
    const ctx = await setupWorktrees(undefined, {routerDeps:{resolveHostTools: () => ({execFile:remoteGit,fs:fsPromises})}});
    const {workflow} = await seedReady(ctx);
    const response = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow, {skipSync:true}));
    expect(response.status).toBe(201);
    expect(ctx.listWorktrees).toHaveBeenCalledWith(expect.objectContaining({execFile:remoteGit}));
    expect(ctx.readWorktreeChanges).toHaveBeenCalledWith(expect.objectContaining({execFile:remoteGit}));
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
      selectable: false, reason: { code: 'in_use', message: 'An open workflow run is already using it.' },
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
    expect(started.body.actions).toEqual({ stop: true, resume: false, continue: false, cleanup: false, answer: false, approve: false, sendBack: false });
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
    staff(ctx, agent);
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
    staff(ctx, agent);
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
    expect(second.body.message).toBe('An open workflow run is already using it.');

    // A finished run stays open where it worked, but no longer holds the place.
    ctx.runStore.update(first.body.id, { status: 'complete', finishedAt: new Date().toISOString() });
    expect(ctx.runStore.get(first.body.id).worktreeState).toBe('external');
    const open = await request(ctx.app).get(`${base}/runs?open=true`);
    expect(open.body.data.map(run => run.id)).toEqual([first.body.id]);
    const third = await request(ctx.app).post(`${base}/runs`).send(startBody(workflow, { requestId: 'run-third' }));
    expect(third.status).toBe(201);
    // The new run takes its place: the finished one is closed.
    expect(ctx.runStore.get(first.body.id).worktreeState).toBe('released');
    // Its terminals stay: the new run goes on in the ones its agents already have there.
    expect(ctx.closeRunTerminals).not.toHaveBeenCalled();
    const after = await request(ctx.app).get(`${base}/runs?open=true`);
    expect(after.body.data.map(run => run.id)).toEqual([third.body.id]);
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
    expect(response.body.message).toBe('An open workflow run is already using it.');
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
    status, sessionId: 'Demo-1', priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0,
  });
  const pendingStep = { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 };

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
    staff(ctx, agent);
    ctx.settingsStore.update({ setupAgentId: agent.id, defaultBaseBranch: null, revision: 1 });
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
  it('round trips absent, true and false node flags through POST and PUT, including repeated PUT', async () => {
    const ctx = await setup();
    const { body } = await seedLoop(ctx);
    const created = await request(ctx.app).post(`${base}/workflows`).send(body);
    expect(created.status).toBe(201);
    expect(created.body.nodes[0]).toMatchObject({ readOnly: false, approval: false });
    const flags = { ...body, nodes: body.nodes.map((entry, index) => index === 0 ? { ...entry, readOnly: true, approval: true } : { ...entry, readOnly: false, approval: false }) };
    const updated = await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...flags, revision: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.nodes[0]).toMatchObject({ readOnly: true, approval: true });
    expect(updated.body.nodes[1]).toMatchObject({ readOnly: false, approval: false });
    const repeated = await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...flags, revision: 2 });
    expect(repeated.status).toBe(200);
    expect(repeated.body.nodes[0]).toMatchObject({ readOnly: true, approval: true });
  });
  it.each(['readOnly', 'approval'])('rejects each wrong %s type in POST and PUT with the node field', async flag => {
    const ctx = await setup();
    const { body } = await seedLoop(ctx);
    const created = await request(ctx.app).post(`${base}/workflows`).send(body);
    for (const bad of [null, 0, 'true', [], {}]) {
      const invalid = { ...body, nodes: body.nodes.map((entry, index) => index === 0 ? { ...entry, [flag]: bad } : entry) };
      for (const response of [
        await request(ctx.app).post(`${base}/workflows`).send({ ...invalid, name: 'Invalid' }),
        await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...invalid, revision: 1 }),
      ]) {
        expect(response.status).toBe(400);
        expect(response.body.errors.map(error => error.field)).toContain(`nodes[0].${flag}`);
      }
    }
  });
  it('rejects approval on a loop-closing node in POST and PUT', async () => {
    const ctx = await setup();
    const { body } = await seedLoop(ctx);
    const created = await request(ctx.app).post(`${base}/workflows`).send(body);
    const invalid = { ...body, nodes: body.nodes.map((entry, index) => index === 1 ? { ...entry, approval: true } : entry) };
    for (const response of [
      await request(ctx.app).post(`${base}/workflows`).send({ ...invalid, name: 'Invalid' }),
      await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...invalid, revision: 1 }),
    ]) {
      expect(response.status).toBe(400);
      expect(response.body.errors.map(error => error.field)).toContain('nodes[1].approval');
    }
  });

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

  it('narrows decisions to one step', async () => {
    const { ctx, id } = await setupRun();
    record(ctx, id, 1);
    record(ctx, id, 1, { stepIndex: 0, stepName: 'Setup' });
    const response = await decisions(ctx, id, { stepIndex: 0 });
    expect(response.body.data.map(d => d.stepName)).toEqual(['Setup']);
    expect(response.body.page.totalElements).toBe(1);
    expect((await decisions(ctx, id, { stepIndex: 5 })).body.data).toEqual([]);
    for (const stepIndex of ['-1', 'x', '33', '']) {
      const bad = await decisions(ctx, id, { stepIndex });
      expect(bad.status).toBe(400);
      expect(bad.body.errors.map(error => error.field)).toEqual(['stepIndex']);
    }
  });

  it('lists the owner reviews of a run with the page envelope, and narrows them to a step', async () => {
    const { ctx, id } = await setupRun();
    const reviews = (query = {}) => request(ctx.app).get(`${base}/runs/${id}/reviews`).query(query);
    expect((await reviews()).body).toEqual({ data: [], page: { currentPage: 0, size: 20, totalElements: 0, totalPages: 0, hasNextPage: false } });
    const sentBack = ctx.reviewStore.add({ runId: id, stepIndex: 1, stepName: 'Develop', attempt: 1, verdict: 'sent_back', comment: 'Cover the empty case <b>too</b>' });
    const approved = ctx.reviewStore.add({ runId: id, stepIndex: 1, stepName: 'Develop', attempt: 2, verdict: 'approved', comment: null });
    ctx.reviewStore.add({ runId: id, stepIndex: 0, stepName: 'Setup', attempt: 1, verdict: 'approved', comment: null });
    ctx.reviewStore.add({ runId: OTHER, stepIndex: 1, stepName: 'Develop', attempt: 1, verdict: 'approved', comment: null });

    const all = await reviews();
    expect(all.status).toBe(200);
    expect(all.body.page).toEqual({ currentPage: 0, size: 20, totalElements: 3, totalPages: 1, hasNextPage: false });
    expect(all.body.data[0]).toEqual({ id: sentBack.id, stepIndex: 1, stepName: 'Develop', attempt: 1, verdict: 'sent_back', comment: 'Cover the empty case <b>too</b>', createdAt: sentBack.createdAt });
    expect((await reviews({ stepIndex: 1 })).body.data.map(review => review.id)).toEqual([sentBack.id, approved.id]);
    expect((await reviews({ stepIndex: 1, sort: 'createdAt,desc', size: 1 })).body).toMatchObject({ data: [{ id: approved.id }], page: { totalElements: 2, totalPages: 2, hasNextPage: true } });
    expect((await reviews({ stepIndex: 1, sort: 'createdAt,desc', size: 1, page: 1 })).body.data.map(review => review.id)).toEqual([sentBack.id]);

    for (const [query, field] of [[{ stepIndex: 'x' }, 'stepIndex'], [{ size: 0 }, 'size'], [{ size: 101 }, 'size'], [{ sort: 'verdict,asc' }, 'sort'], [{ verdict: 'approved' }, 'verdict']]) {
      const bad = await reviews(query);
      expect(bad.status).toBe(400);
      expect(bad.body.errors.map(error => error.field)).toEqual([field]);
    }
    const missing = await request(ctx.app).get(`${base}/runs/${OTHER}/reviews`);
    expect(missing.status).toBe(404);
    expect(missing.type).toBe('application/problem+json');
    expect((await request(ctx.app).get(`${base}/runs/not-a-uuid/reviews`)).status).toBe(404);
  });

  it('lists what the owner answered, with the page envelope, and narrows it to a step', async () => {
    const { ctx, id } = await setupRun();
    const answers = (query = {}) => request(ctx.app).get(`${base}/runs/${id}/answers`).query(query);
    expect((await answers()).body).toEqual({ data: [], page: { currentPage: 0, size: 20, totalElements: 0, totalPages: 0, hasNextPage: false } });
    const first = ctx.answerStore.add({ runId: id, stepIndex: 1, stepName: 'Develop', pass: 1, questions: '1. Which page?', answer: 'The <b>login</b> page' });
    const second = ctx.answerStore.add({ runId: id, stepIndex: 1, stepName: 'Develop', pass: 2, questions: null, answer: 'Yes' });
    ctx.answerStore.add({ runId: id, stepIndex: 0, stepName: 'Setup', pass: 1, questions: null, answer: 'Go on' });
    ctx.answerStore.add({ runId: OTHER, stepIndex: 1, stepName: 'Develop', pass: 1, questions: null, answer: 'Elsewhere' });

    const all = await answers();
    expect(all.status).toBe(200);
    expect(all.body.page.totalElements).toBe(3);
    expect(all.body.data[0]).toEqual({ id: first.id, stepIndex: 1, stepName: 'Develop', pass: 1, questions: '1. Which page?', answer: 'The <b>login</b> page', createdAt: first.createdAt });
    expect((await answers({ stepIndex: 1 })).body.data.map(item => item.id)).toEqual([first.id, second.id]);
    expect((await answers({ stepIndex: 1, sort: 'createdAt,desc', size: 1 })).body).toMatchObject({ data: [{ id: second.id }], page: { totalElements: 2, totalPages: 2, hasNextPage: true } });
    for (const [query, field] of [[{ stepIndex: 'x' }, 'stepIndex'], [{ size: 0 }, 'size'], [{ size: 101 }, 'size'], [{ sort: 'answer,asc' }, 'sort'], [{ by: 'owner' }, 'by']]) {
      const bad = await answers(query);
      expect(bad.status).toBe(400);
      expect(bad.body.errors.map(error => error.field)).toEqual([field]);
    }
    expect((await request(ctx.app).get(`${base}/runs/${OTHER}/answers`)).status).toBe(404);
    expect((await request(ctx.app).get(`${base}/runs/nope/answers`)).status).toBe(404);
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

  it('requires the task store and service', () => {
    const base = { agentStore: {}, workflowStore: {}, settingsStore: {}, runStore: {}, decisionStore: {}, noteStore: {}, findProject: () => null };
    expect(() => createPipelinesRouter(base)).toThrow('pipelines router: reviewStore is required');
    expect(() => createPipelinesRouter({ ...base, reviewStore: { list() {} } })).toThrow('pipelines router: answerStore is required');
    const withAnswers = { ...base, reviewStore: { list() {} }, answerStore: { list() {} } };
    expect(() => createPipelinesRouter(withAnswers)).toThrow('pipelines router: templateStore is required');
    expect(() => createPipelinesRouter({ ...withAnswers, templateStore: { list() {} } })).toThrow('pipelines router: stepPresetStore is required');
    const stores = { ...withAnswers, teamStore: { list() {} }, roleStore: { list() {} }, templateStore: { list() {} }, stepPresetStore: { list() {} } };
    expect(() => createPipelinesRouter({ ...withAnswers, teamStore: { list() {} }, templateStore: { list() {} }, stepPresetStore: { list() {} } })).toThrow('pipelines router: roleStore is required');
    expect(() => createPipelinesRouter(stores)).toThrow('pipelines router: taskStore is required');
    expect(() => createPipelinesRouter({ ...stores, taskStore: { get() {} } })).toThrow('pipelines router: taskService is required');
    const withTasks = { ...stores, taskStore: { get() {} }, taskService: { plan() {}, createPlanned() {} } };
    expect(() => createPipelinesRouter(withTasks)).toThrow('pipelines router: requestStore is required');
    expect(() => createPipelinesRouter({
      ...withTasks,
      requestStore: {
        get() {}, reserve() {}, setTaskId() {}, release() {},
        assertMatchingParams() {}, assignRunId() {}, setPlacement() {}, transition() {},
      },
    })).toThrow('pipelines router: requestStore is required');
    expect(() => createPipelinesRouter({
      ...withTasks,
      requestStore: {
        get() {}, reserve() {}, setTaskId() {}, release() {},
        assertMatchingParams() {}, assignRunId() {}, setPlacement() {}, transition() {}, getByRunId() {}, listUnpublished() {},
      },
    })).toThrow('pipelines router: closeRunTerminals must be a function');
  });

  it('requires the decision store', () => {
    expect(() => createPipelinesRouter({
      agentStore: {}, workflowStore: {}, settingsStore: {}, runStore: {}, findProject: () => null,
    })).toThrow('pipelines router: decisionStore is required');
  });
});

describe('pipelines API — progress file', () => {
  async function startOptionalPlanRun(read) {
    const ctx = await setup({ routerDeps: { progressReader: { read } } });
    const { workflow } = await seedReady(ctx);
    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'run-notes-plan', workflowId: workflow.id, project: 'Demo', input: 'build it' });
    expect(started.status).toBe(201);
    ctx.runStore.update(started.body.id, { worktreeState: 'present' });
    return { ctx, started, view: () => request(ctx.app).get(`${base}/runs/${started.body.id}`) };
  }

  it('hides a missing optional run notes plan', async () => {
    const read = vi.fn(async ({ progressFile }) => ({ file: progressFile, status: 'missing', phaseCount: null, phase: null }));
    const { ctx, started, view } = await startOptionalPlanRun(read);
    expect((await view()).body.progress).toBeNull();
    expect(read).toHaveBeenLastCalledWith({ worktreePath: ctx.runStore.get(started.body.id).worktreePath, progressFile: `${started.body.notesDir}/plan.md` });
  });

  it('shows the current phase from an optional run notes plan', async () => {
    const read = vi.fn(async ({ progressFile }) => ({ file: progressFile, status: 'in_progress', phaseCount: 1, phase: { number: 1, title: 'Build', tasksDone: 0, tasksTotal: 2 } }));
    const { started, view } = await startOptionalPlanRun(read);
    expect((await view()).body.progress).toEqual({ file: `${started.body.notesDir}/plan.md`, status: 'in_progress', phaseCount: 1, phase: { number: 1, title: 'Build', tasksDone: 0, tasksTotal: 2 }, tasksDone: 0, tasksTotal: 2 });
  });

  it('hides an optional run notes plan without phase sections', async () => {
    const read = vi.fn(async ({ progressFile }) => ({ file: progressFile, status: 'no_phases', phaseCount: null, phase: null }));
    const { view } = await startOptionalPlanRun(read);
    expect((await view()).body.progress).toBeNull();
  });

  it('reports an unreadable optional run notes plan', async () => {
    const read = vi.fn(async ({ progressFile }) => ({ file: progressFile, status: 'unreadable', phaseCount: null, phase: null }));
    const { view } = await startOptionalPlanRun(read);
    expect((await view()).body.progress).toMatchObject({ status: 'unreadable' });
  });

  it('reports a missing configured Progress file', async () => {
    const read = vi.fn(async ({ progressFile }) => ({ file: progressFile, status: 'missing', phaseCount: null, phase: null }));
    const { ctx, started, view } = await startOptionalPlanRun(read);
    const old = ctx.runStore.get(started.body.id);
    ctx.db.prepare('UPDATE pipeline_runs SET definition = ? WHERE id = ?').run(JSON.stringify({ ...old.definition, progressFile: 'docs/progress.md' }), old.id);
    expect((await view()).body.progress).toMatchObject({ file: 'docs/progress.md', status: 'missing' });
  });

  it('does not read progress for an old run without notes or a Progress file', async () => {
    const read = vi.fn();
    const { ctx, started, view } = await startOptionalPlanRun(read);
    const old = ctx.runStore.get(started.body.id);
    ctx.db.prepare('UPDATE pipeline_runs SET definition = ? WHERE id = ?').run(JSON.stringify({ ...old.definition, notesDir: null }), old.id);
    expect((await view()).body.progress).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it('follows the current workflow setting for a run without a progress snapshot', async () => {
    const read = vi.fn(async ({ progressFile }) => progressFile.endsWith('/plan.md')
      ? { file: progressFile, status: 'missing', phaseCount: null, phase: null }
      : { file: progressFile, status: 'in_progress', phaseCount: 1, phase: { number: 1, title: 'Review', tasksDone: 0, tasksTotal: 1 } });
    const ctx = await setup({ routerDeps: { progressReader: { read } } });
    const agent = ctx.agentStore.create(agentBody());
    staff(ctx, agent);
    ctx.settingsStore.update({ setupAgentId: agent.id, defaultBaseBranch: null, revision: 1 });
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
    expect(detail.body.progress).toEqual({ file: 'docs/todo.md', status: 'in_progress', phaseCount: 1, phase: { number: 1, title: 'Review', tasksDone: 0, tasksTotal: 1 }, tasksDone: 0, tasksTotal: 1 });
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
    const execFile = vi.fn((_command, _args, _options, callback) => callback(null, '100644 blob abc\tdocs/todo.md\0', ''));
    const ctx = await setup({ routerDeps: { progressReader: { read }, execFile } });
    const agent = ctx.agentStore.create(agentBody());
    staff(ctx, agent);
    ctx.settingsStore.update({ setupAgentId: agent.id, defaultBaseBranch: null, revision: 1 });
    const body = { name: 'Progress', agentsDecide: false, progressFile: 'docs/todo.md', nodes: [node(agent.id, { prompt: 'Work' })] };
    const created = await request(ctx.app).post(`${base}/workflows`).send(body);
    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'progress-status', workflowId: created.body.id, project: 'Demo', input: '' });
    ctx.runStore.update(started.body.id, { worktreeState: 'present' });
    for (const wanted of statuses) {
      status = wanted;
      const response = await request(ctx.app).get(`${base}/runs/${started.body.id}`);
      expect(response.status).toBe(200);
      expect(response.body.progress).toEqual({ file: 'docs/todo.md', status: wanted, phaseCount: wanted === 'all_done' ? 1 : null, phase: null, tasksDone: null, tasksTotal: null });
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
    const execFile = vi.fn((_command, _args, _options, callback) => callback(null, '100644 blob abc\tdocs/todos/x.md\0', ''));
    const ctx = await setup({ routerDeps: { progressReader: { read }, execFile } });
    const agent = ctx.agentStore.create(agentBody());
    staff(ctx, agent);
    ctx.settingsStore.update({ setupAgentId: agent.id, defaultBaseBranch: null, revision: 1 });
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
    expect(detail.body.progress).toEqual({ file: 'docs/todos/x.md', status: 'in_progress', phaseCount: 2, phase: { number: 1, title: 'Review', tasksDone: 0, tasksTotal: 3 }, tasksDone: 0, tasksTotal: 3 });
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
    staff(ctx, agent);
    ctx.settingsStore.update({ setupAgentId: agent.id, defaultBaseBranch: null, revision: 1 });
    const workflow = ctx.workflowStore.create({ name: 'Progress', agentsDecide: false, progressFile: 'docs/{input}.md', nodes: [node(agent.id, { prompt: 'Work' })] });
    for (const input of ['', '../bad', 'x'.repeat(510)]) {
      const response = await request(ctx.app).post(`${base}/runs`).send({ requestId: `progress-${input.length}`, workflowId: workflow.id, project: 'Demo', input });
      expect(response.status).toBe(400);
      expect(response.body.errors.map(error => error.field)).toContain('input');
    }
  });
});

describe('pipelines API — runs in tasks', () => {
  const HEAD_A = 'a'.repeat(40);
  const HEAD_T = 'd'.repeat(40);
  const TASK_ID = '7b000000-0000-4000-8000-000000000001';
  const TASK_WT = { path: '/tmp/worktrees/demo-git-task', head: HEAD_T, branch: 'task/replies-7b000000', missing: false };
  const HOME_WT = { path: PROJECT.path, head: HEAD_A, branch: 'main', missing: false };

  async function setupTasks(worktrees = [HOME_WT, TASK_WT], overrides = {}) {
    const listWorktrees = vi.fn(async () => worktrees);
    const readWorktreeChanges = vi.fn(async () => ({ readable: true, dirty: false }));
    const ctx = await setup({ ...overrides, routerDeps: { listWorktrees, readWorktreeChanges, realpath: async value => value, execFile: 'exec-file-stub', ...overrides.routerDeps } });
    const { workflow } = await seedReady(ctx);
    const seedTask = (fields = {}) => ctx.taskStore.create({ ...OWN_REPOSITORY, id: TASK_ID, project: 'Demo', title: 'Replies', worktreePath: TASK_WT.path,
      branch: TASK_WT.branch, baseBranch: 'main', baseCommit: HEAD_A, titleSource: 'owner', ...fields });
    const body = (extra = {}) => ({ requestId: 'run-task', workflowId: workflow.id, project: 'Demo', input: 'docs/todos/feature.md', ...extra });
    return { ...ctx, workflow, seedTask, body, listWorktrees };
  }

  async function setupRealTasks(options) {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codedeck-api-tasks-')));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'API Test');
    git('config', 'user.email', 'api@test.local');
    git('commit', '--allow-empty', '-m', 'Initial commit');
    const ctx = await setup({ ...options, repo });
    const { workflow } = await seedReady(ctx);
    const body = { requestId: 'real-task', workflowId: workflow.id, project: 'Demo', input: 'Fix login', newTask: { title: 'Login' } };
    const post = (extra = {}, app = ctx.app) => request(app).post(`${base}/runs`).send({ ...body, ...extra });
    const expectOneWorktree = () => {
      const [task] = ctx.taskStore.list();
      expect(ctx.taskStore.list()).toHaveLength(1);
      expect(git('branch', '--format=%(refname:short)', '--list', 'task/*')).toBe(task.branch);
      expect(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))).toEqual([
        `worktree ${repo}`, `worktree ${task.worktreePath}`,
      ]);
    };
    return { ...ctx, body, post, git, expectOneWorktree };
  }

  it('provisions exactly one task for overlapping identical requests', async () => {
    const ctx = await setupRealTasks();
    const responses = await Promise.all([ctx.post(), ctx.post()]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    expect(responses[0].body.id).toBe(responses[1].body.id);
    ctx.expectOneWorktree();
    expect(ctx.runStore.list()).toHaveLength(1);
    ctx.flushStart();
    expect(ctx.engineStarts).toEqual([responses[0].body.id]);
  });

  it('refuses a conflicting request while the first is provisioning', async () => {
    const ctx = await setupRealTasks();
    const entered = Promise.withResolvers();
    const proceed = Promise.withResolvers();
    const create = ctx.taskService.createPlanned;
    vi.spyOn(ctx.taskService, 'createPlanned').mockImplementationOnce(async plan => {
      entered.resolve();
      await proceed.promise;
      return create(plan);
    });
    const first = ctx.post().then(response => response);
    await entered.promise;
    const conflict = await ctx.post({ input: 'Other' }).then(response => response).finally(proceed.resolve);
    const started = await first;
    expect([started.status, conflict.status]).toEqual([201, 409]);
    expect(conflict.body).toMatchObject({ message: 'This requestId was already used with a different body', traceId: conflict.headers['x-trace-id'] });
    ctx.expectOneWorktree();
    expect(ctx.runStore.list()).toHaveLength(1);
  });

  it('shares the first provisioning error with an overlapping replay, then allows a fresh attempt', async () => {
    const entered = Promise.withResolvers();
    const proceed = Promise.withResolvers();
    const ctx = await setupRealTasks({ onRequest(req, _res, next) {
      next();
      if (req.get('X-Test-Replay')) setImmediate(proceed.resolve);
    } });
    vi.spyOn(ctx.taskService, 'createPlanned').mockImplementationOnce(async () => {
      entered.resolve();
      await proceed.promise;
      throw Object.assign(new Error('Provisioning failed'), { status: 409 });
    });
    const first = ctx.post().then(response => response);
    await entered.promise;
    const replay = ctx.post().set('X-Test-Replay', 'true');
    const responses = await Promise.all([first, replay]);
    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ message: 'Provisioning failed', traceId: response.headers['x-trace-id'] });
    }
    expect(ctx.taskStore.list()).toEqual([]);
    expect(ctx.runStore.list()).toEqual([]);
    expect((await ctx.post({ input: 'Retry with different input' })).status).toBe(201);
    ctx.expectOneWorktree();
  });

  it.each([{ title: ' Original ' }, {}])('replays the original request after a rename (%j)', async newTask => {
    const ctx = await setupTasks();
    const post = place => request(ctx.app).post(`${base}/runs`).send(ctx.body(place));
    const first = await post({ newTask });
    expect(first.status).toBe(201);
    ctx.taskStore.rename(first.body.taskId, { title: 'Renamed', revision: 1 });

    const replay = await post({ newTask: newTask.title ? { title: 'Original' } : {} });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect((await post({ newTask: { title: 'Renamed' } })).status).toBe(409);
    expect(ctx.taskStore.list()).toHaveLength(1);
    expect(ctx.runStore.list()).toHaveLength(1);
  });

  it('rejects a replay that switches from a new task to its id', async () => {
    const ctx = await setupTasks();
    const first = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: {} }));
    const replay = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ taskId: first.body.taskId }));
    expect([first.status, replay.status]).toEqual([201, 409]);
    expect(ctx.taskStore.list()).toHaveLength(1);
    expect(ctx.runStore.list()).toHaveLength(1);
  });

  it('rejects a replay of a legacy run without stored start parameters', async () => {
    const ctx = await setupTasks();
    const first = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: {} }));
    expect(first.status).toBe(201);
    ctx.runStore.create({ ...ctx.runStore.get(first.body.id), id: randomUUID(), requestId: 'legacy' });
    const replay = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ requestId: 'legacy', newTask: {} }));
    expect(replay.status).toBe(409);
    expect(ctx.taskStore.list()).toHaveLength(1);
    expect(ctx.runStore.list()).toHaveLength(2);
  });

  it.each([
    ['open', 201, null],
    ['missing', 409, "This task's files are no longer on disk."],
    ['locked and missing', 409, "This task's files are no longer on disk."],
    ['finished', 409, 'This task is finished.'],
  ])('replays a start interrupted before run insertion with a %s task', async (state, status, message) => {
    const ctx = await setupRealTasks();
    const plan = vi.spyOn(ctx.taskService, 'plan');
    const createPlanned = vi.spyOn(ctx.taskService, 'createPlanned');
    vi.spyOn(ctx.runStore, 'create').mockImplementationOnce(() => { throw new Error('Run insert failed'); });
    expect((await ctx.post()).status).toBe(500);
    expect(ctx.runStore.list()).toEqual([]);
    ctx.expectOneWorktree();
    const [task] = ctx.taskStore.list();
    const ownerFile = path.join(task.worktreePath, 'owner.txt');
    if (state === 'open') {
      ctx.git('-C', task.worktreePath, 'commit', '--allow-empty', '-m', 'Owner commit');
      writeFileSync(ownerFile, 'Keep this');
    }
    if (state === 'missing') ctx.git('worktree', 'remove', task.worktreePath);
    if (state === 'locked and missing') {
      ctx.git('worktree', 'lock', task.worktreePath);
      rmSync(task.worktreePath, { recursive: true });
    }
    if (state === 'finished') setTaskState(ctx.taskStore, task.id, { state: 'closed' });

    const restarted = await ctx.openApp();
    const replay = await ctx.post({}, restarted);
    expect(replay.status).toBe(status);
    expect(ctx.taskStore.list()).toHaveLength(1);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(createPlanned).toHaveBeenCalledTimes(1);
    if (state === 'open') {
      ctx.expectOneWorktree();
      expect(ctx.runStore.list()).toHaveLength(1);
      expect(replay.body.taskId).toBe(task.id);
      expect(replay.body.steps.map(step => step.kind)).toEqual(['setup', 'node']);
      expect(replay.body.worktree).toMatchObject({ path: task.worktreePath, baseCommit: task.baseCommit, state: 'external' });
      expect(readFileSync(ownerFile, 'utf8')).toBe('Keep this');
    } else {
      expect(replay.body.message).toBe(message);
      expect(ctx.runStore.list()).toEqual([]);
      expect((await ctx.post({ input: 'Different' }, restarted)).status).toBe(409);
    }
  });

  it('validates a start before reserving an id and stores hostile-looking input as text', async () => {
    const ctx = await setupTasks();
    const post = () => request(ctx.app).post(`${base}/runs`);
    const malformed = await post().type('application/json').send('{"requestId":');
    expect(malformed.status).toBe(400);
    expect(malformed.type).toBe('application/problem+json');
    expect(malformed.body.errors).toEqual([expect.objectContaining({ field: 'body' })]);
    const invalid = await post().send(ctx.body({ requestId: '', workflowId: undefined, input: null }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.traceId).toBe(invalid.headers['x-trace-id']);
    expect(invalid.body.errors.map(error => error.field)).toEqual(['requestId', 'workflowId', 'input']);
    const tooLong = await post().send(ctx.body({ requestId: 'a'.repeat(129), input: 'x'.repeat(4097) }));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.errors.map(error => error.field)).toEqual(['requestId', 'input']);
    const oversized = await post().send(ctx.body({ input: 'x'.repeat(513 * 1024) }));
    expect(oversized.status).toBe(413);
    expect(ctx.db.prepare('SELECT request_id FROM pipeline_run_requests').all()).toEqual([]);
    expect(ctx.runStore.list()).toEqual([]);

    const input = "'; DROP TABLE pipeline_run_requests; -- <script>".padEnd(4096, 'x');
    const body = ctx.body({ requestId: 'a'.repeat(128), input });
    const started = await post().send(body);
    expect(started.status).toBe(201);
    expect(started.body.input).toBe(input);
    const replay = await post().send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(started.body.id);
  });

  it('starts a run in an existing task: no Setup, the task keeps its worktree', async () => {
    const ctx = await setupTasks();
    ctx.seedTask();
    const started = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ taskId: TASK_ID }));

    expect(started.status).toBe(201);
    expect(started.body.taskId).toBe(TASK_ID);
    expect(started.body.worktree).toEqual({ path: TASK_WT.path, branch: TASK_WT.branch, baseCommit: HEAD_T, state: 'external', detail: null });
    expect(started.body.steps.map(item => item.kind)).toEqual(['node']);
    expect(ctx.runStore.get(started.body.id).taskId).toBe(TASK_ID);
    expect(ctx.taskService.plan).not.toHaveBeenCalled();
  });

  it('creates a task for a run, prepares it with Setup, and never lets the run remove it', async () => {
    const ctx = await setupTasks();
    const started = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: '  WhatsApp replies ' } }));

    expect(started.status).toBe(201);
    const task = ctx.taskStore.get(started.body.taskId);
    expect(task).toMatchObject({ title: 'WhatsApp replies', titleSource: 'owner', project: 'Demo', state: 'active' });
    expect(started.body.worktree).toEqual({ path: task.worktreePath, branch: task.branch, baseCommit: task.baseCommit, state: 'external', detail: null });
    expect(started.body.steps.map(item => item.kind)).toEqual(['setup', 'node']);
    expect(ctx.runStore.get(started.body.id).definition.steps[0].prompt).toContain(task.worktreePath);
    ctx.flushStart();
    expect(ctx.engine.start).toHaveBeenCalledWith(started.body.id);
  });

  it('calls a task after the input of its run when no title was typed, and marks it as one to name', async () => {
    const ctx = await setupTasks();
    const started = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ input: '"/tmp/drops/screenshot.png"', newTask: {} }));

    expect(started.status).toBe(201);
    expect(ctx.taskStore.get(started.body.taskId)).toMatchObject({ title: '"/tmp/drops/screenshot.png"', titleSource: 'input', project: 'Demo', state: 'active' });
    expect(ctx.taskService.plan).toHaveBeenCalledWith({ project: 'Demo', host: 'local', title: '"/tmp/drops/screenshot.png"', titleSource: 'input' });
  });

  it('cuts a new task from the default base branch of the settings when the run names none', async () => {
    const ctx = await setupTasks();
    ctx.settingsStore.update({ setupAgentId: ctx.settingsStore.get().setupAgentId, defaultBaseBranch: 'develop', revision: ctx.settingsStore.get().revision });
    const started = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'From default' } }));
    expect(started.status).toBe(201);
    expect(ctx.taskService.plan).toHaveBeenCalledWith({ project: 'Demo', host: 'local', title: 'From default', titleSource: 'owner', baseBranch: 'develop' });
  });

  it('cuts a new task from the branch the run names, over the default', async () => {
    const ctx = await setupTasks();
    ctx.settingsStore.update({ setupAgentId: ctx.settingsStore.get().setupAgentId, defaultBaseBranch: 'develop', revision: ctx.settingsStore.get().revision });
    const started = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Hotfix', baseBranch: 'release/2.1' } }));
    expect(started.status).toBe(201);
    expect(ctx.taskService.plan).toHaveBeenCalledWith({ project: 'Demo', host: 'local', title: 'Hotfix', titleSource: 'owner', baseBranch: 'release/2.1' });
  });

  it('names no base branch when neither the run nor the settings do', async () => {
    const ctx = await setupTasks();
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Plain' } }))).status).toBe(201);
    expect(ctx.taskService.plan).toHaveBeenCalledWith({ project: 'Demo', host: 'local', title: 'Plain', titleSource: 'owner' });
  });

  it('reports a base branch the repository lacks as a refusal of the start, with nothing created', async () => {
    const ctx = await setupTasks();
    ctx.taskService.plan.mockImplementationOnce(async () => { throw new TaskError('codedeck has no branch nope to start the task from.', 409); });
    const refused = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Nope', baseBranch: 'nope' } }));
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('codedeck has no branch nope to start the task from.');
    expect(ctx.taskStore.list()).toEqual([]);
    expect(ctx.runStore.list()).toEqual([]);
  });

  it('takes a request naming another base branch for a different request', async () => {
    const ctx = await setupTasks();
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Once', baseBranch: 'develop' } }))).status).toBe(201);
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Once', baseBranch: 'develop' } }))).status).toBe(200);
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Once' } }))).status).toBe(409);
  });

  it('replays an untitled request without creating a second task, also once the task is named', async () => {
    const ctx = await setupTasks();
    const body = ctx.body({ newTask: {} });
    const first = await request(ctx.app).post(`${base}/runs`).send(body);
    ctx.taskStore.applyGeneratedTitle(first.body.taskId, 'Named from the work');
    const second = await request(ctx.app).post(`${base}/runs`).send(body);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.id).toBe(first.body.id);
    expect(ctx.taskStore.list()).toHaveLength(1);
    // The same request id asking for a titled task is a different request.
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Typed' } }))).status).toBe(409);
  });

  it('does not take an untitled request for the replay of a titled one', async () => {
    const ctx = await setupTasks();
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Typed' } }))).status).toBe(201);
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: {} }))).status).toBe(409);
    expect(ctx.taskStore.list()).toHaveLength(1);
  });

  it('replays the same request without creating a second task', async () => {
    const ctx = await setupTasks();
    const body = ctx.body({ newTask: { title: 'Once' } });
    const first = await request(ctx.app).post(`${base}/runs`).send(body);
    const second = await request(ctx.app).post(`${base}/runs`).send(body);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.id).toBe(first.body.id);
    expect(ctx.taskStore.list()).toHaveLength(1);
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Other' } }))).status).toBe(409);
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body())).status).toBe(409);
  });

  it('creates no task when the run is refused', async () => {
    const ctx = await setupTasks();
    const noInput = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ input: '', newTask: { title: 'Refused' } }));
    expect(noInput.status).toBe(400);
    expect(noInput.body.errors.map(error => error.field)).toEqual(['input']);
    const unknownWorkflow = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ workflowId: '7c000000-0000-4000-8000-000000000009', newTask: { title: 'Refused' } }));
    expect(unknownWorkflow.status).toBe(404);
    expect(ctx.taskService.createPlanned).not.toHaveBeenCalled();
    expect(ctx.taskStore.list()).toEqual([]);
  });

  it('needs a setup agent for a new task but not for an existing one', async () => {
    const ctx = await setupTasks([HOME_WT, TASK_WT], {
      preflight: vi.fn(async () => ({ eligible: false, reasons: [{ code: 'setup_agent_missing', message: 'Choose a setup agent in Settings → Workflows.' }], branch: 'main', head: HEAD_A, dirty: false })),
    });
    ctx.seedTask();
    const fresh = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Needs setup' } }));
    expect(fresh.status).toBe(409);
    expect(ctx.taskStore.list()).toHaveLength(1);
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ requestId: 'run-existing-task', taskId: TASK_ID }))).status).toBe(201);
  });

  it('reports what the task service refuses', async () => {
    const refuse = (status, errors) => Object.assign(new Error(status === 400 ? 'One or more fields failed validation.' : 'Tasks are only available for local projects.'), { status, errors });
    const invalid = await setupTasks([HOME_WT], { taskService: { plan: vi.fn(async () => { throw refuse(400, [{ field: 'title', message: 'Use 1–80 characters on one line' }]); }), createPlanned: vi.fn() } });
    const bad = await request(invalid.app).post(`${base}/runs`).send(invalid.body({ newTask: { title: 'x' } }));
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toEqual([{ field: 'newTask.title', message: 'Use 1–80 characters on one line' }]);

    const remote = await setupTasks([HOME_WT], { taskService: { plan: vi.fn(async () => { throw refuse(409); }), createPlanned: vi.fn() } });
    const refused = await request(remote.app).post(`${base}/runs`).send(remote.body({ newTask: { title: 'x' } }));
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('Tasks are only available for local projects.');

    const collided = await setupTasks([HOME_WT], { taskService: {
      plan: vi.fn(async () => ({ id: TASK_ID, worktreePath: '/tmp/worktrees/x', branch: 'task/x', homePath: '/tmp/demo-git',
        worktrees: [{ repository: 'demo-git', repositoryPath: null, checkoutPath: '/tmp/demo-git', homePath: '/tmp/demo-git', worktreePath: '/tmp/worktrees/x', branch: 'task/x', baseBranch: 'main' }] })),
      createPlanned: vi.fn(async () => { throw Object.assign(new Error('A folder for this task already exists. Try again.'), { status: 409 }); }),
    } });
    const collision = await request(collided.app).post(`${base}/runs`).send(collided.body({ newTask: { title: 'x' } }));
    expect(collision.status).toBe(409);
    expect(collided.runStore.list()).toEqual([]);
  });

  it('refuses an unknown, foreign, finished, vanished or busy task', async () => {
    const ctx = await setupTasks();
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ taskId: TASK_ID }))).status).toBe(404);

    ctx.seedTask({ project: 'Elsewhere' });
    const foreign = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ taskId: TASK_ID }));
    expect(foreign.status).toBe(400);
    expect(foreign.body.errors.map(error => error.field)).toEqual(['taskId']);

    const gone = await setupTasks([HOME_WT]);
    gone.seedTask();
    const vanished = await request(gone.app).post(`${base}/runs`).send(gone.body({ taskId: TASK_ID }));
    expect(vanished.status).toBe(409);
    expect(vanished.body.message).toBe("This task's files are no longer on disk.");

    const busy = await setupTasks();
    busy.seedTask();
    expect((await request(busy.app).post(`${base}/runs`).send(busy.body({ taskId: TASK_ID }))).status).toBe(201);
    const second = await request(busy.app).post(`${base}/runs`).send(busy.body({ requestId: 'run-second', taskId: TASK_ID }));
    expect(second.status).toBe(409);
    expect(second.body.reasons).toEqual([{ code: 'in_use', message: 'An open workflow run is already using it.' }]);

    setTaskState(busy.taskStore, TASK_ID, { state: 'closed' });
    const finished = await request(busy.app).post(`${base}/runs`).send(busy.body({ requestId: 'run-third', taskId: TASK_ID }));
    expect(finished.status).toBe(409);
    expect(finished.body.message).toBe('This task is finished.');
  });

  it.each([
    [{ taskId: 'nope' }, ['taskId']],
    [{ taskId: null }, ['taskId']],
    [{ newTask: { title: '' } }, ['newTask.title']],
    [{ newTask: { title: null } }, ['newTask.title']],
    [{ newTask: { title: '   ' } }, ['newTask.title']],
    [{ newTask: { title: 'x'.repeat(81) } }, ['newTask.title']],
    [{ newTask: [] }, ['newTask']],
    [{ newTask: { title: 'x', branch: 'main' } }, ['newTask.branch']],
    [{ taskId: '7b000000-0000-4000-8000-000000000001', newTask: { title: 'x' } }, ['newTask']],
  ])('refuses a run start with %j', async (extra, fields) => {
    const ctx = await setupTasks();
    const response = await request(ctx.app).post(`${base}/runs`).send(ctx.body(extra));
    expect(response.status).toBe(400);
    expect(response.body.errors.map(error => error.field)).toEqual(fields);
    expect(ctx.runStore.list()).toEqual([]);
  });

  it('lists the runs of a task, closed ones included', async () => {
    const ctx = await setupTasks();
    ctx.seedTask();
    const inTask = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ taskId: TASK_ID }));
    await request(ctx.app).post(`${base}/runs`).send(ctx.body({ requestId: 'run-main', worktreePath: PROJECT.path }));
    ctx.runStore.update(inTask.body.id, { status: 'complete', worktreeState: 'released', finishedAt: new Date().toISOString(),
      steps: ctx.runStore.get(inTask.body.id).steps.map(item => ({ ...item, status: 'complete' })) });

    const listed = await request(ctx.app).get(`${base}/runs`).query({ taskId: TASK_ID });
    expect(listed.status).toBe(200);
    expect(listed.body.data.map(run => [run.id, run.taskId, run.status])).toEqual([[inTask.body.id, TASK_ID, 'complete']]);
    expect((await request(ctx.app).get(`${base}/runs`).query({ taskId: TASK_ID, open: 'true' })).body.data).toEqual([]);
    const bad = await request(ctx.app).get(`${base}/runs`).query({ taskId: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map(error => error.field)).toEqual(['taskId']);
  });

  it('reports no task for a run outside one', async () => {
    const ctx = await setupTasks();
    const started = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ worktreePath: PROJECT.path }));
    expect(started.status).toBe(201);
    expect(started.body.taskId).toBeNull();
  });
});

describe('pipelines API — kind, description and step roles', () => {
  it('saves and returns them on a workflow, and shows the role on a run step', async () => {
    const ctx = await setup();
    const agent = ctx.agentStore.create(agentBody());
    staff(ctx, agent);
    ctx.settingsStore.update({ setupAgentId: agent.id, defaultBaseBranch: null, revision: 1 });
    const created = await request(ctx.app).post(`${base}/workflows`).send({
      name: 'Hunt', kind: 'troubleshoot', description: ' Find the cause ', agentsDecide: false, nodes: [node(agent.id, { role: ' Investigator ' })],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'troubleshoot', description: 'Find the cause' });
    expect(created.body.nodes[0].role).toBe('Investigator');

    const plain = await request(ctx.app).post(`${base}/workflows`).send({ name: 'Plain', agentsDecide: false, nodes: [node(agent.id)] });
    expect(plain.body).toMatchObject({ kind: 'other', description: '' });
    expect(plain.body.nodes[0].role).toBe('Developer');

    const started = await request(ctx.app).post(`${base}/runs`).send({ requestId: 'role-run', workflowId: created.body.id, project: 'Demo', input: 'x' });
    expect(started.status).toBe(201);
    expect(started.body.steps.map(step => [step.kind, step.role])).toEqual([['setup', ''], ['node', 'Investigator']]);

    for (const [extra, field] of [[{ kind: 'deploy' }, 'kind'], [{ description: 'x'.repeat(281) }, 'description'], [{ nodes: [node(agent.id, { role: 'x'.repeat(33) })] }, 'nodes[0].role']]) {
      const bad = await request(ctx.app).post(`${base}/workflows`).send({ name: 'Bad', agentsDecide: false, nodes: [node(agent.id)], ...extra });
      expect(bad.status).toBe(400);
      expect(bad.body.errors.map(error => error.field)).toEqual([field]);
    }
  });
});

describe.each([
  ['templates', 'Template', () => ({ name: 'My build', kind: 'build', description: 'Plan then build', agentsDecide: false, nodes: [{ name: 'Plan', role: 'Planner', prompt: 'Plan {input}', repeat: { mode: 'once' }, readOnly: true, approval: true }] }), { nodes: [] }, 'nodes'],
  ['step-presets', 'Saved step', () => ({ name: 'Review', role: 'Reviewer', prompt: 'Review the changes', repeat: { mode: 'once' }, readOnly: true }), { prompt: '' }, 'prompt'],
])('pipelines API — saved %s', (segment, entity, body, invalid, invalidField) => {
  const url = `${base}/${segment}`;

  it('creates, reads, lists in the page envelope, updates and removes', async () => {
    const ctx = await setup();
    const created = await request(ctx.app).post(url).send(body());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...body(), revision: 1, id: expect.any(String), createdAt: expect.any(String) });
    expect((await request(ctx.app).get(`${url}/${created.body.id}`)).body).toEqual(created.body);

    await request(ctx.app).post(url).send({ ...body(), name: 'Another' });
    const listed = await request(ctx.app).get(url).query({ size: 1 });
    expect(listed.status).toBe(200);
    expect(listed.body.data.map(item => item.name)).toEqual(['Another']);
    expect(listed.body.page).toEqual({ currentPage: 0, size: 1, totalElements: 2, totalPages: 2, hasNextPage: true });
    expect((await request(ctx.app).get(url).query({ size: 1, page: 1, sort: 'name,asc' })).body.data.map(item => item.name)).toEqual([body().name]);

    const updated = await request(ctx.app).put(`${url}/${created.body.id}`).send({ ...body(), name: 'Renamed', revision: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Renamed', revision: 2 });
    expect((await request(ctx.app).put(`${url}/${created.body.id}`).send({ ...body(), name: 'Late', revision: 1 })).status).toBe(409);

    expect((await request(ctx.app).delete(`${url}/${created.body.id}`)).status).toBe(204);
    expect((await request(ctx.app).get(`${url}/${created.body.id}`)).status).toBe(404);
    expect((await request(ctx.app).delete(`${url}/${created.body.id}`)).status).toBe(404);
  });

  it('refuses invalid, duplicate, unknown and hostile requests with problem details', async () => {
    const ctx = await setup();
    const bad = await request(ctx.app).post(url).send({ ...body(), ...invalid });
    expect(bad.status).toBe(400);
    expect(bad.type).toBe('application/problem+json');
    expect(bad.body.errors.map(error => error.field)).toEqual([invalidField]);
    expect(bad.body.traceId).toBe(bad.headers['x-trace-id']);
    for (const payload of [{}, [], { ...body(), agentId: 'x' }, { ...body(), name: '' }, { ...body(), name: null }]) {
      expect((await request(ctx.app).post(url).send(payload)).status).toBe(400);
    }
    expect((await request(ctx.app).post(url).set('Content-Type', 'application/json').send('{"name":')).status).toBe(400);

    const first = await request(ctx.app).post(url).send(body());
    const again = await request(ctx.app).post(url).send(body());
    expect([first.status, again.status]).toEqual([201, 409]);
    expect(again.body.message).toBe(`A ${entity.toLowerCase()} with this name already exists`);

    const hostile = await request(ctx.app).post(url).send({ ...body(), name: "<script>'; DROP TABLE x;--" });
    expect(hostile.status).toBe(201);
    expect(hostile.type).toBe('application/json');

    expect((await request(ctx.app).put(`${url}/${first.body.id}`).send(body())).body.errors.map(error => error.field)).toEqual(['revision']);
    expect((await request(ctx.app).get(`${url}/not-a-uuid`)).status).toBe(404);
    expect((await request(ctx.app).put(`${url}/7c000000-0000-4000-8000-000000000009`).send({ ...body(), revision: 1 })).status).toBe(404);
    for (const query of [{ size: 0 }, { size: 101 }, { page: -1 }, { sort: 'body,asc' }, { name: 'x' }]) {
      expect((await request(ctx.app).get(url).query(query)).status).toBe(400);
    }
  });
});

describe('pipelines API — what a step\'s agent is sent', () => {
  const url = `${base}/prompt-previews`;
  const workflow = (extra = {}) => ({
    name: 'Draft', agentsDecide: false,
    nodes: [
      { name: 'Plan', role: 'Planner', prompt: '/feature-spec {input}', repeat: { mode: 'once' }, readOnly: true, approval: true },
      { name: 'Develop', role: 'Developer', prompt: 'Build what the plan says', repeat: { mode: 'once' } },
      { name: 'Test', role: 'Tester', prompt: 'Test it', repeat: { mode: 'loop_back', to: 'Develop', max: 3 } },
    ],
    ...extra,
  });

  it('composes the prompt of an unsaved workflow with the real instruction and guidance', async () => {
    const ctx = await setup();
    const response = await request(ctx.app).post(url).send({ workflow: workflow(), nodeIndex: 0, input: 'docs/todos/replies.md' });
    expect(response.status).toBe(200);
    expect(response.body.stepName).toBe('Plan');
    expect(response.body.placeholders).toEqual({ worktreePath: '/path/to/the/task', notesDir: '.codedeck/runs/00000000', identifier: '<pass identifier>' });
    expect(response.body.skillRewrite).toBe(true);
    const { prompt } = response.body;
    expect(prompt.startsWith('/feature-spec docs/todos/replies.md\n\nCodeDeck workflow instruction: perform one pass')).toBe(true);
    expect(prompt).toContain("Work only inside this run's worktree, /path/to/the/task");
    expect(prompt).toContain('This step is read-only: change nothing in the worktree except files in the run notes folder, .codedeck/runs/00000000.');
    expect(prompt).toContain('write your note to .codedeck/runs/00000000/00-plan.md');
    expect(prompt).toContain('Iteration identifier: <pass identifier>');
    expect(prompt).not.toContain('The owner is not available');
    expect(ctx.workflowStore.list()).toEqual([]);
  });

  it('explains the loop to the step that closes it, and who decides when agents decide', async () => {
    const ctx = await setup();
    const response = await request(ctx.app).post(url).send({ workflow: workflow({ agentsDecide: true }), nodeIndex: 2, input: '' });
    expect(response.status).toBe(200);
    expect(response.body.prompt).toContain('This step closes a loop: CodeDeck repeats the steps from "Develop" to "Test" in order');
    expect(response.body.prompt).toContain('The owner is not available during this run.');
    expect(response.body.skillRewrite).toBe(false);
    const first = await request(ctx.app).post(url).send({ workflow: workflow(), nodeIndex: 0, input: '' });
    expect(first.body.prompt.startsWith('/feature-spec {input}\n')).toBe(true);
  });

  it.each([
    [{ nodeIndex: 3 }, ['nodeIndex']], [{ nodeIndex: -1 }, ['nodeIndex']], [{ nodeIndex: '0' }, ['nodeIndex']], [{ nodeIndex: 1.5 }, ['nodeIndex']],
    [{ input: null }, ['input']], [{ input: 'x'.repeat(4097) }, ['input']], [{ input: 'a\nb' }, ['input']],
    [{ workflow: null }, ['workflow.body']], [{ extra: 1 }, ['extra']],
  ])('refuses %j', async (patch, fields) => {
    const ctx = await setup();
    const response = await request(ctx.app).post(url).send({ workflow: workflow(), nodeIndex: 0, input: 'x', ...patch });
    expect(response.status).toBe(400);
    expect(response.type).toBe('application/problem+json');
    expect(response.body.errors.map(error => error.field)).toEqual(fields);
  });

  it('names the invalid field of the draft, refuses agents in it, and accepts the limits', async () => {
    const ctx = await setup();
    const bad = await request(ctx.app).post(url).send({ workflow: workflow({ nodes: [{ name: 'Plan', role: 'Planner', prompt: '', repeat: { mode: 'once' } }] }), nodeIndex: 0, input: 'x' });
    expect(bad.body.errors.map(error => error.field)).toEqual(['workflow.nodes[0].prompt']);
    const withAgent = await request(ctx.app).post(url).send({ workflow: workflow({ nodes: [{ name: 'Plan', role: 'Planner', agentId: '7c000000-0000-4000-8000-000000000009', prompt: 'p', repeat: { mode: 'once' } }] }), nodeIndex: 0, input: 'x' });
    expect(withAgent.body.errors.map(error => error.field)).toEqual(['workflow.nodes[0].agentId']);
    expect((await request(ctx.app).post(url).send({ workflow: workflow(), nodeIndex: 2, input: 'x'.repeat(4096) })).status).toBe(200);
    const tooLong = await request(ctx.app).post(url).send({ workflow: workflow({ nodes: [{ name: 'Plan', role: 'Planner', prompt: `${'p'.repeat(8000)} {input} {input} {input}`, repeat: { mode: 'once' } }] }), nodeIndex: 0, input: 'x'.repeat(4096) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.errors.map(error => error.field)).toEqual(['input']);
    expect((await request(ctx.app).post(url).send([])).status).toBe(400);
    expect((await request(ctx.app).post(url).set('Content-Type', 'application/json').send('{"workflow":')).status).toBe(400);
  });

  it('returns hostile text as text and gives the same answer twice', async () => {
    const ctx = await setup();
    const body = { workflow: workflow(), nodeIndex: 1, input: "<script>alert(1)</script>'; DROP TABLE x;--" };
    const [first, second] = await Promise.all([request(ctx.app).post(url).send(body), request(ctx.app).post(url).send(body)]);
    expect(first.status).toBe(200);
    expect(first.type).toBe('application/json');
    expect(first.body).toEqual(second.body);
  });
});

// Audit b2bd312, item B03: two starts for one worktree must not both be admitted.
describe('POST /api/pipelines/runs — one worktree, two starts at once', () => {
  it('Exactly one concurrent start acquires the worktree', async () => {
    const wt = mkdtempSync(path.join(os.tmpdir(), 'codedeck-occupancy-'));
    cleanup.push(() => rmSync(wt, { recursive: true, force: true }));
    mkdirSync(path.join(wt, 'docs'));
    writeFileSync(path.join(wt, 'docs/todo.md'), '# Progress\n');
    // Both requests are held at the read that precedes the occupancy check, so each finds the
    // checkout free before the other has inserted its run; the progress-file check then runs.
    let held = 0;
    let release;
    const bothArrived = new Promise(resolve => { release = resolve; });
    const readWorktreeChanges = async () => {
      if (++held === 2) release();
      if (held <= 2) await bothArrived;
      return { readable: true, dirty: false };
    };
    const ctx = await setup({ routerDeps: {
      listWorktrees: async () => [{ path: wt, branch: 'task/x', head: 'a'.repeat(40), missing: false }], readWorktreeChanges,
    } });
    const agent = ctx.agentStore.create(agentBody());
    staff(ctx, agent);
    ctx.settingsStore.update({ setupAgentId: agent.id, defaultBaseBranch: null, revision: 1 });
    const workflow = ctx.workflowStore.create({ name: 'Occupancy', agentsDecide: false, progressFile: 'docs/todo.md', nodes: [node(agent.id, { prompt: 'Work' })] });
    const post = id => request(ctx.app).post(`${base}/runs`).send({ requestId: `start-${id}`, workflowId: workflow.id, project: 'Demo', input: 'feature', worktreePath: wt });
    const occupying = () => ctx.db.prepare("SELECT request_id FROM pipeline_runs WHERE worktree_path = ? AND worktree_state != 'released'").all(wt).length;

    const responses = await Promise.all([post(1), post(2)]);
    expect(held).toBe(2);
    ctx.flushStart();

    expect({
      statuses: responses.map(response => response.status).sort(), occupyingRows: occupying(), engineStarts: ctx.engine.start.mock.calls.length,
    }).toEqual({ statuses: [201, 409], occupyingRows: 1, engineStarts: 1 });
    const loser = responses.find(response => response.status === 409);
    expect(loser.type).toBe('application/problem+json');
    expect(loser.body.reasons).toEqual([{ code: 'in_use', message: 'An open workflow run is already using it.' }]);

    // The existing reuse rule: once the winner is finished, the worktree can be used again.
    const winner = responses.find(response => response.status === 201);
    ctx.runStore.update(winner.body.id, { status: 'complete', finishedAt: new Date().toISOString() });
    expect((await post(3)).status).toBe(201);
    expect(occupying()).toBe(1);
  });
});

describe('pipelines API — runs across the repositories of a project', () => {
  const HEAD_A = 'a'.repeat(40);
  const HEAD_M = 'e'.repeat(40);
  const TASK_ID = '7b000000-0000-4000-8000-000000000001';
  const MOBILE = '/tmp/group/mobile-app';
  const FOLDER = '/tmp/worktrees/replies-7b000000';
  const HOME_WT = { path: PROJECT.path, head: HEAD_A, branch: 'main', missing: false };
  const OWN_TASK_WT = { path: `${FOLDER}/codedeck`, head: HEAD_A, branch: 'task/replies-7b000000', missing: false };
  const MOBILE_HOME_WT = { path: MOBILE, head: HEAD_M, branch: 'main', missing: false };
  const MOBILE_TASK_WT = { path: `${FOLDER}/mobile-app`, head: HEAD_M, branch: 'task/replies-7b000000', missing: false };

  /** A project whose own repository is known as `codedeck` and that lists `mobile-app`. */
  async function setupRepositories(overrides = {}) {
    const listWorktrees = vi.fn(async ({ projectPath }) => (projectPath === MOBILE ? [MOBILE_HOME_WT, MOBILE_TASK_WT] : [HOME_WT, OWN_TASK_WT]));
    const readWorktreeChanges = vi.fn(async () => ({ readable: true, dirty: false }));
    const ctx = await setup({ ...overrides, routerDeps: { listWorktrees, readWorktreeChanges, realpath: async value => value, execFile: 'exec-file-stub', ...overrides.routerDeps } });
    ctx.projects.set('Demo', { ...PROJECT, repositories: [{ name: 'mobile-app', path: MOBILE }] });
    const { workflow } = await seedReady(ctx);
    const seedTask = () => {
      ctx.taskStore.create({ id: TASK_ID, project: 'Demo', title: 'Replies', titleSource: 'owner', folder: FOLDER, repository: 'codedeck', repositoryPath: null,
        worktreePath: OWN_TASK_WT.path, branch: OWN_TASK_WT.branch, baseBranch: 'main', baseCommit: HEAD_A });
      return ctx.taskStore.addWorktree(TASK_ID, { repository: 'mobile-app', repositoryPath: MOBILE, worktreePath: MOBILE_TASK_WT.path, branch: MOBILE_TASK_WT.branch, baseBranch: 'main', baseCommit: HEAD_M });
    };
    const body = (extra = {}) => ({ requestId: 'run-repos', workflowId: workflow.id, project: 'Demo', input: 'docs/todos/feature.md', ...extra });
    return { ...ctx, workflow, seedTask, body, listWorktrees };
  }

  /** A task service that plans the worktrees asked for, the first one first, and records them as the real one does. */
  function planning(ctx) {
    const checkout = name => (name === 'codedeck' ? PROJECT.path : MOBILE);
    return {
      plan: vi.fn(async ({ project, title, titleSource, repositories = ['codedeck'] }) => {
        if (repositories.includes('nope')) throw Object.assign(new Error('One or more fields failed validation.'), { status: 400, errors: [{ field: 'repositories', message: 'nope is not a repository of this project' }] });
        const worktrees = repositories.map(repository => ({ repository, repositoryPath: repository === 'codedeck' ? null : MOBILE, checkoutPath: checkout(repository), homePath: checkout(repository),
          worktreePath: `${FOLDER}/${repository}`, branch: 'task/replies-7b000000', baseBranch: 'main' }));
        return { id: TASK_ID, project, projectPath: PROJECT.path, title: title.trim(), titleSource, folder: FOLDER, homePath: worktrees[0].homePath, worktreePath: worktrees[0].worktreePath, branch: worktrees[0].branch, baseBranch: 'main', worktrees };
      }),
      createPlanned: vi.fn(async (planned) => {
        const row = entry => ({ repository: entry.repository, repositoryPath: entry.repositoryPath, worktreePath: entry.worktreePath, branch: entry.branch, baseBranch: entry.baseBranch, baseCommit: HEAD_A });
        const [first, ...rest] = planned.worktrees;
        let task = ctx().taskStore.create({ id: planned.id, project: planned.project, title: planned.title, titleSource: planned.titleSource, folder: planned.folder, ...row(first) });
        for (const entry of rest) task = ctx().taskStore.addWorktree(planned.id, row(entry));
        return task;
      }),
    };
  }

  describe('POST /api/pipelines/run-plans', () => {
    const url = `${base}/run-plans`;
    const HEADER = '# Tag pings\n\n**Repositories**: codedeck (this todo), mobile-app (docs/todos/tag-phone.md), frontend (minor)\n**Status**: Not started\n\n## Phase 1: Models\n- [ ] One\n';
    /** Git as the plan needs it: which files each checkout holds at HEAD, and their text. */
    const committed = files => vi.fn((_command, args, _options, callback) => {
      const held = files[args[1]] ?? {};
      if (args[2] === 'ls-tree') {
        const file = args.at(-1);
        return callback(null, Object.hasOwn(held, file) ? `100644 blob abc\t${file}\0` : '', '');
      }
      if (args[2] === 'cat-file') {
        const file = args.at(-1).slice('HEAD:'.length);
        return Object.hasOwn(held, file) ? callback(null, held[file], '') : callback(new Error(`fatal: path '${file}' does not exist in 'HEAD'`));
      }
      return callback(new Error(`unexpected git ${args.join(' ')}`));
    });
    async function setupPlan(files, progressFile = 'docs/{input}') {
      const execFile = committed(files);
      const ctx = await setupRepositories({ routerDeps: { execFile } });
      const workflow = ctx.workflowStore.create({ name: 'Templated', agentsDecide: false, progressFile, nodes: [node(ctx.agentStore.list()[0].id, { prompt: 'Work on {input}' })] });
      const plan = (input, extra = {}) => request(ctx.app).post(url).send({ workflowId: workflow.id, project: 'Demo', input, ...extra });
      return { ...ctx, execFile, workflow, plan };
    }
    const FILES = { [PROJECT.path]: { 'docs/todos/tag.md': HEADER }, [MOBILE]: { 'docs/todos/tag-phone.md': '# Phone\n' } };

    it('says where the todo is and what its Repositories line asks for', async () => {
      const ctx = await setupPlan(FILES);
      const response = await ctx.plan('todos/tag.md');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        progressFile: 'docs/todos/tag.md',
        input: 'todos/tag.md',
        foundIn: 'codedeck',
        problem: null,
        repositories: [
          { repository: 'codedeck', role: 'this', todo: null, input: null, listed: true, present: null },
          { repository: 'mobile-app', role: 'todo', todo: 'docs/todos/tag-phone.md', input: 'todos/tag-phone.md', listed: true, present: true },
          { repository: 'frontend', role: 'minor', todo: null, input: null, listed: false, present: null },
        ],
      });
      // The same question twice gives the same answer and stores nothing.
      expect((await ctx.plan('todos/tag.md')).body).toEqual(response.body);
      expect(ctx.runStore.list()).toEqual([]);
      expect(ctx.taskStore.list()).toEqual([]);
    });

    it('finds a todo that is in another repository of the project, and one typed as its whole path', async () => {
      const ctx = await setupPlan({ [MOBILE]: { 'docs/todos/tag-phone.md': '# Phone\n\n**Repositories**: mobile-app (this todo)\n' } });
      const elsewhere = await ctx.plan('todos/tag-phone.md');
      expect(elsewhere.body).toMatchObject({ progressFile: 'docs/todos/tag-phone.md', input: 'todos/tag-phone.md', foundIn: 'mobile-app', problem: null,
        repositories: [{ repository: 'mobile-app', role: 'this', todo: null, input: null, listed: true, present: null }] });
      const whole = await ctx.plan('docs/todos/tag-phone.md');
      expect(whole.body).toMatchObject({ progressFile: 'docs/todos/tag-phone.md', input: 'todos/tag-phone.md', foundIn: 'mobile-app' });
    });

    it('plans repositories from a fixed Progress file while preserving descriptive paragraphs', async () => {
      const ctx = await setupPlan(FILES, 'docs/todos/tag.md');
      const response = await ctx.plan('First paragraph.\r\n\rSecond paragraph.  ');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        progressFile: 'docs/todos/tag.md',
        input: 'First paragraph.\n\nSecond paragraph.  ',
        foundIn: 'codedeck',
        problem: null,
        repositories: [
          { repository: 'codedeck', role: 'this', todo: null, input: null, listed: true, present: null },
          { repository: 'mobile-app', role: 'todo', todo: 'docs/todos/tag-phone.md', input: null, listed: true, present: true },
          { repository: 'frontend', role: 'minor', todo: null, input: null, listed: false, present: null },
        ],
      });
      // Empty input is refused without claiming that descriptive input must be one line.
      const empty = await ctx.plan('');
      expect(empty.status).toBe(400);
      expect(empty.body.errors).toEqual([{ field: 'input', message: 'Use 1–4096 characters' }]);
      // Other controls are still refused for descriptive input.
      const tab = await ctx.plan('First\tsecond');
      expect(tab.status).toBe(400);
      expect(tab.body.errors.map(error => error.field)).toEqual(['input']);
    });

    it('answers with nothing to read when there is no such file, no line, or no Progress file', async () => {
      const ctx = await setupPlan({ [PROJECT.path]: { 'docs/todos/plain.md': '# Plain\n\n## Phase 1\n- [ ] One\n' } });
      expect((await ctx.plan('todos/absent.md')).body).toEqual({ progressFile: 'docs/todos/absent.md', input: 'todos/absent.md', foundIn: null, problem: null, repositories: null });
      expect((await ctx.plan('todos/plain.md')).body).toEqual({ progressFile: 'docs/todos/plain.md', input: 'todos/plain.md', foundIn: 'codedeck', problem: null, repositories: null });
      // An input that does not complete the path of a .md file names no file to look for, and Git is not asked.
      ctx.execFile.mockClear();
      for (const input of ['fix the login', '../outside.md', '/Users/me/todo.md', 'todos/tag']) {
        expect((await ctx.plan(input)).body).toEqual({ progressFile: null, input, foundIn: null, problem: null, repositories: null });
      }
      expect(ctx.execFile).not.toHaveBeenCalled();

      const none = await setupPlan(FILES, null);
      expect((await none.plan('todos/tag.md')).body).toEqual({ progressFile: null, input: 'todos/tag.md', foundIn: null, problem: null, repositories: null });
      expect(none.execFile).not.toHaveBeenCalled();
    });

    it('reports a line it cannot read, and one that puts the todo in another repository, without guessing', async () => {
      const ctx = await setupPlan({ [PROJECT.path]: {
        'docs/todos/bad.md': '# Bad\n\n**Repositories**: codedeck (major)\n',
        'docs/todos/moved.md': '# Moved\n\n**Repositories**: mobile-app (this todo), codedeck (minor)\n',
      } });
      expect((await ctx.plan('todos/bad.md')).body).toEqual({ progressFile: 'docs/todos/bad.md', input: 'todos/bad.md', foundIn: 'codedeck', repositories: null,
        problem: 'codedeck (major): use this todo, minor, or the path of a .md file inside that repository' });
      expect((await ctx.plan('todos/moved.md')).body).toMatchObject({ foundIn: 'codedeck', repositories: null,
        problem: 'The Repositories line says this todo belongs to mobile-app, but it is in codedeck.' });
    });

    it('says when another repository\'s todo is not committed there, or does not fit the workflow\'s Progress file', async () => {
      const text = '# Tag\n\n**Repositories**: codedeck (this todo), mobile-app (docs/todos/missing.md)\n';
      const ctx = await setupPlan({ [PROJECT.path]: { 'docs/todos/tag.md': text } });
      expect((await ctx.plan('todos/tag.md')).body.repositories[1]).toEqual({ repository: 'mobile-app', role: 'todo', todo: 'docs/todos/missing.md', input: 'todos/missing.md', listed: true, present: false });

      const elsewhere = await setupPlan({ [PROJECT.path]: { 'docs/todos/tag.md': '# Tag\n\n**Repositories**: codedeck (this todo), mobile-app (plans/phone.md)\n' }, [MOBILE]: { 'plans/phone.md': '# Phone\n' } });
      expect((await elsewhere.plan('todos/tag.md')).body.repositories[1]).toEqual({ repository: 'mobile-app', role: 'todo', todo: 'plans/phone.md', input: null, listed: true, present: true });

      const whole = await setupPlan({ [PROJECT.path]: { 'docs/todos/tag.md': text } }, '{input}');
      expect((await whole.plan('docs/todos/tag.md')).body.repositories[1]).toMatchObject({ todo: 'docs/todos/missing.md', input: 'docs/todos/missing.md' });
    });

    it('refuses a body that is not what it takes, naming each field', async () => {
      const ctx = await setupPlan(FILES);
      const fields = response => { expect(response.status).toBe(400); expect(response.body.traceId).toBe(response.headers['x-trace-id']); return response.body.errors.map(error => error.field).sort(); };
      expect(fields(await request(ctx.app).post(url).send({}))).toEqual(['input', 'project', 'workflowId']);
      expect(fields(await request(ctx.app).post(url).send([]))).toEqual(['body']);
      expect(fields(await ctx.plan('todos/tag.md', { extra: 1 }))).toEqual(['extra']);
      expect(fields(await request(ctx.app).post(url).send({ workflowId: 'nope', project: 7, input: null }))).toEqual(['input', 'project', 'workflowId']);
      expect(fields(await request(ctx.app).post(url).send({ workflowId: ctx.workflow.id, project: '', input: '' }))).toEqual(['input', 'project']);
      // Boundaries of the input: 1 and 4096 characters are taken, 4097 and a control character are not.
      expect((await ctx.plan('x')).status).toBe(200);
      expect((await ctx.plan('x'.repeat(4096))).status).toBe(200);
      expect(fields(await ctx.plan('x'.repeat(4097)))).toEqual(['input']);
      expect(fields(await ctx.plan('todos/tag.md\n--upload-pack=x'))).toEqual(['input']);
      const malformed = await request(ctx.app).post(url).set('Content-Type', 'application/json').send('{"workflowId":');
      expect(malformed.status).toBe(400);
      expect(ctx.execFile).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['--upload-pack=x']), expect.anything(), expect.anything());
    });

    it('neutralises input that tries to reach outside the repository or run something', async () => {
      const ctx = await setupPlan(FILES);
      for (const input of ["todos/x.md'; DROP TABLE tasks; --", '<script>alert(1)</script>.md', 'todos/$(touch x).md', '-rf.md']) {
        const response = await ctx.plan(input);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ foundIn: null, repositories: null });
        expect(response.headers['content-type']).toMatch(/application\/json/);
      }
      // Whatever was asked, Git was only ever given a path after `--` or after `HEAD:`.
      for (const [, args] of ctx.execFile.mock.calls) expect(args.slice(0, 3)).toEqual(['-C', expect.stringMatching(/^\//), expect.stringMatching(/^(ls-tree|cat-file)$/)]);
      expect((await request(ctx.app).post(url).send({ workflowId: ctx.workflow.id, project: 'Demo', input: 'x'.repeat(600 * 1024) })).status).toBe(413);
    });

    it('answers 404 for a workflow or project it does not know', async () => {
      const ctx = await setupPlan(FILES);
      const unknownWorkflow = await request(ctx.app).post(url).send({ workflowId: '11111111-1111-4111-8111-111111111111', project: 'Demo', input: 'todos/tag.md' });
      expect(unknownWorkflow.status).toBe(404);
      expect(unknownWorkflow.body).toMatchObject({ status: 404, message: 'Workflow not found', traceId: unknownWorkflow.headers['x-trace-id'] });
      const unknownProject = await ctx.plan('todos/tag.md', { project: 'Nope' });
      expect(unknownProject.status).toBe(404);
      expect(unknownProject.body.message).toBe('Project not found');
    });
  });

  it('starts a run in the repository of an open task that is named, and in the one the task started in when none is', async () => {
    const ctx = await setupRepositories();
    ctx.seedTask();
    const started = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ taskId: TASK_ID, startIn: 'mobile-app' }));
    expect(started.status).toBe(201);
    expect(started.body.worktree).toEqual({ path: MOBILE_TASK_WT.path, branch: MOBILE_TASK_WT.branch, baseCommit: HEAD_M, state: 'external', detail: null });
    expect(started.body.steps.map(item => item.kind)).toEqual(['node']);
    // The worktree is looked up in the repository it belongs to, and the run records that repository's home.
    expect(ctx.listWorktrees).toHaveBeenLastCalledWith({ projectPath: MOBILE, execFile: 'exec-file-stub' });
    expect(ctx.runStore.get(started.body.id)).toMatchObject({ taskId: TASK_ID, worktreePath: MOBILE_TASK_WT.path });

    const other = await setupRepositories();
    other.seedTask();
    const unnamed = await request(other.app).post(`${base}/runs`).send(other.body({ taskId: TASK_ID }));
    expect(unnamed.body.worktree.path).toBe(OWN_TASK_WT.path);
    expect(other.listWorktrees).toHaveBeenLastCalledWith({ projectPath: PROJECT.path, execFile: 'exec-file-stub' });
  });

  it('refuses a repository the task does not have open', async () => {
    const ctx = await setupRepositories();
    const task = ctx.seedTask();
    const unknown = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ taskId: TASK_ID, startIn: 'frontend' }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors).toEqual([{ field: 'startIn', message: 'Use the name of a repository of this task that is still open' }]);
    ctx.taskStore.setWorktreeState(TASK_ID, task.worktrees[1].id, { state: 'closed' });
    const closed = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ taskId: TASK_ID, startIn: 'mobile-app' }));
    expect(closed.status).toBe(400);
    expect(ctx.runStore.list()).toEqual([]);
  });

  it('lets a task have one unfinished run, whichever repository it starts in', async () => {
    const ctx = await setupRepositories();
    ctx.seedTask();
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body({ taskId: TASK_ID, startIn: 'mobile-app' }))).status).toBe(201);
    const second = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ requestId: 'run-second', taskId: TASK_ID }));
    expect(second.status).toBe(409);
    expect(second.body.reasons).toEqual([{ code: 'task_in_use', message: 'An open workflow run is working in another repository of this task. Stop it or let it finish first.' }]);
    expect(ctx.runStore.list()).toHaveLength(1);
  });

  it('creates a task for a run in the repositories asked for, starting where the run starts, and prepares each with Setup', async () => {
    let ctx;
    const taskService = planning(() => ctx);
    ctx = await setupRepositories({ taskService });
    const started = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { title: 'Replies', repositories: ['codedeck', 'mobile-app'] }, startIn: 'mobile-app' }));
    expect(started.status).toBe(201);
    expect(taskService.plan).toHaveBeenCalledWith({ project: 'Demo', host: 'local', title: 'Replies', titleSource: 'owner', repositories: ['mobile-app', 'codedeck'] });
    expect(started.body.worktree.path).toBe(`${FOLDER}/mobile-app`);
    expect(started.body.steps.map(item => item.kind)).toEqual(['setup', 'node']);
    const run = ctx.runStore.get(started.body.id);
    expect(run.homePath).toBe(MOBILE);
    const setup = run.definition.steps[0].prompt;
    expect(setup).toContain('You are preparing 2 fresh git worktrees of one task');
    expect(setup).toContain(`- mobile-app: home checkout ${MOBILE}, worktree ${FOLDER}/mobile-app (your current directory)`);
    expect(setup).toContain(`- codedeck: home checkout ${PROJECT.path}, worktree ${FOLDER}/codedeck`);
    expect(ctx.taskStore.get(TASK_ID).worktrees.map(worktree => [worktree.repository, worktree.first])).toEqual([['mobile-app', true], ['codedeck', false]]);
  });

  it('finishes an interrupted start in the task it recorded, in the same repository and with Setup for each one', async () => {
    let ctx;
    const taskService = planning(() => ctx);
    // Each checkout in this suite is its repository's home.
    ctx = await setupRepositories({ taskService, resolveHomeRepoPath: vi.fn(async ({ projectPath }) => projectPath) });
    const start = { newTask: { title: 'Replies', repositories: ['codedeck', 'mobile-app'] }, startIn: 'mobile-app' };
    vi.spyOn(ctx.runStore, 'create').mockImplementationOnce(() => { throw new Error('Run insert failed'); });
    expect((await request(ctx.app).post(`${base}/runs`).send(ctx.body(start))).status).toBe(500);
    expect(ctx.runStore.list()).toEqual([]);
    expect(ctx.taskStore.list()).toHaveLength(1);

    // The same request id with another starting repository, or other repositories, is another request.
    for (const changed of [{ ...start, startIn: 'codedeck' }, { ...start, newTask: { title: 'Replies', repositories: ['mobile-app'] } }, { newTask: { title: 'Replies' } }]) {
      const conflict = await request(ctx.app).post(`${base}/runs`).send(ctx.body(changed));
      expect(conflict.status).toBe(409);
      expect(conflict.body.message).toBe('This requestId was already used with a different body');
    }

    // The copies in this suite are names only; the start checks that the task's folder is on disk.
    const stat = vi.spyOn(fsPromises, 'stat').mockImplementation(async target => {
      if (target !== `${FOLDER}/mobile-app`) throw new Error(`unexpected stat of ${target}`);
      return { isDirectory: () => true };
    });
    cleanup.push(() => stat.mockRestore());
    const replay = await request(ctx.app).post(`${base}/runs`).send(ctx.body(start));
    expect(replay.status).toBe(201);
    expect(taskService.plan).toHaveBeenCalledTimes(1);
    expect(taskService.createPlanned).toHaveBeenCalledTimes(1);
    expect(ctx.taskStore.list()).toHaveLength(1);
    expect(replay.body.taskId).toBe(TASK_ID);
    expect(replay.body.worktree.path).toBe(`${FOLDER}/mobile-app`);
    expect(replay.body.steps.map(item => item.kind)).toEqual(['setup', 'node']);
    const run = ctx.runStore.get(replay.body.id);
    expect(run.homePath).toBe(MOBILE);
    const setup = run.definition.steps[0].prompt;
    expect(setup).toContain('You are preparing 2 fresh git worktrees of one task');
    expect(setup).toContain(`- mobile-app: home checkout ${MOBILE}, worktree ${FOLDER}/mobile-app (your current directory)`);
    expect(setup).toContain(`- codedeck: home checkout ${PROJECT.path}, worktree ${FOLDER}/codedeck`);
  });

  it('starts a new task in the one repository named when no list is given, and in the project\'s own when nothing is', async () => {
    let ctx;
    const taskService = planning(() => ctx);
    ctx = await setupRepositories({ taskService });
    await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: {}, startIn: 'mobile-app' }));
    expect(taskService.plan).toHaveBeenLastCalledWith(expect.objectContaining({ repositories: ['mobile-app'] }));
    let other;
    const plain = planning(() => other);
    other = await setupRepositories({ taskService: plain });
    await request(other.app).post(`${base}/runs`).send(other.body({ newTask: { title: 'Alone' } }));
    expect(plain.plan).toHaveBeenLastCalledWith({ project: 'Demo', host: 'local', title: 'Alone', titleSource: 'owner' });
  });

  it('names the field to fix when a repository of the new task is not one of the project\'s', async () => {
    let ctx;
    ctx = await setupRepositories({ taskService: planning(() => ctx) });
    const listed = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ newTask: { repositories: ['nope'] } }));
    expect(listed.status).toBe(400);
    expect(listed.body.errors).toEqual([{ field: 'newTask.repositories', message: 'nope is not a repository of this project' }]);
    const started = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ requestId: 'run-start-in', newTask: {}, startIn: 'nope' }));
    expect(started.body.errors).toEqual([{ field: 'startIn', message: 'nope is not a repository of this project' }]);
    expect(ctx.runStore.list()).toEqual([]);
  });

  it('starts a run in Main of another repository of the project, in that repository\'s own checkout', async () => {
    const ctx = await setupRepositories();
    const started = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ worktreePath: MOBILE }));
    expect(started.status).toBe(201);
    expect(started.body.worktree).toEqual({ path: MOBILE, branch: 'main', baseCommit: HEAD_M, state: 'external', detail: null });
    expect(started.body.taskId).toBeNull();
    expect(started.body.steps.map(item => item.kind)).toEqual(['node']);
    expect(ctx.listWorktrees).toHaveBeenLastCalledWith({ projectPath: MOBILE, execFile: 'exec-file-stub' });
    // A path that is neither a worktree of the project's own repository nor one of its repositories is not found.
    const elsewhere = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ requestId: 'run-elsewhere', worktreePath: '/tmp/group/unrelated' }));
    expect(elsewhere.status).toBe(404);
  });

  it('looks for the progress file of a new task in the repository the run starts in, and names that repository when it is missing', async () => {
    let ctx;
    const execFile = vi.fn((_command, args, _options, callback) => {
      expect(args).toEqual(['-C', MOBILE, 'ls-tree', '-z', 'HEAD', '--', 'docs/todo.md']);
      callback(null, '', '');
    });
    ctx = await setupRepositories({ taskService: planning(() => ctx), routerDeps: { execFile } });
    const agent = ctx.agentStore.list()[0];
    const workflow = ctx.workflowStore.create({ name: 'Progress', agentsDecide: false, progressFile: 'docs/todo.md', nodes: [node(agent.id, { prompt: 'Work' })] });
    const refused = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ workflowId: workflow.id, newTask: {}, startIn: 'mobile-app' }));
    expect(refused.status).toBe(400);
    expect(refused.body.errors).toEqual([{ field: 'input', message: 'docs/todo.md is not in mobile-app at its current commit. Commit it there, or start the run in the repository that contains it.' }]);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(ctx.taskStore.list()).toEqual([]);
  });

  it('says which repository to start in when the input is the full path of a file in one of the project\'s repositories', async () => {
    const ctx = await setupRepositories();
    const agent = ctx.agentStore.list()[0];
    const workflow = ctx.workflowStore.create({ name: 'Todo', agentsDecide: false, progressFile: '{input}', nodes: [node(agent.id, { prompt: 'Work on {input}' })] });
    const refused = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ workflowId: workflow.id, input: `${MOBILE}/docs/todos/replies.md`, newTask: {} }));
    expect(refused.status).toBe(400);
    expect(refused.body.errors).toEqual([{ field: 'input', message: `"${MOBILE}/docs/todos/replies.md" is a file in mobile-app. Start the run in mobile-app and type its path inside that repository: docs/todos/replies.md` }]);
    // A full path that is in none of the project's repositories is answered as before.
    const outside = await request(ctx.app).post(`${base}/runs`).send(ctx.body({ requestId: 'run-outside', workflowId: workflow.id, input: '/tmp/elsewhere/todo.md', newTask: {} }));
    expect(outside.body.errors[0].message).toContain('which is not the path of a .md file inside the project');
  });
});

describe('workflow improvement endpoints', () => {
  it('pages and filters dashboard outcomes and rejects invalid query parameters', async () => {
    const id=randomUUID(), at='2026-11-19T12:00:00.000Z';
    const {app}=await setup({routerDeps:{improvements:{outcomes:()=>[{id,at,workflowId:id,revision:2}]}}});
    const url=base+'/improvements/outcomes';
    const ok=await request(app).get(url).query({workflowId:id,revision:2,from:'2026-11-19',size:1});
    expect(ok.status).toBe(200); expect(ok.body.page).toMatchObject({totalElements:1,hasNextPage:false}); expect(ok.body.data[0].id).toBe(id);
    for (const invalid of [{revision:'x'},{workflowId:'drop table'},{from:'2026-02-31'},{size:101},{sort:'constructor,desc'},{unknown:'x'}]) {
      const res=await request(app).get(url).query(invalid);
      expect(res.status).toBe(400); expect(res.body).toMatchObject({traceId:expect.any(String),errors:expect.any(Array)});
    }
    expect((await request(app).get(url).query({revision:3})).body.data).toEqual([]);
  });
});
it('uses structured errors, validates decision edges and forwards valid owner actions',async()=>{
 const id=randomUUID(), configure=vi.fn(v=>v),decide=vi.fn(()=>({id})),label=vi.fn(),evaluate=vi.fn(()=>({passed:true})),packet=vi.fn(()=>({id}));
 const {app}=await setup({routerDeps:{improvements:{configure,decide,label,evaluate,packet,status:()=>({configured:false}),calls:()=>[],proposals:()=>[]}}});
 const api=base+'/improvements';
 for (const key of ['calls','proposals'])expect((await request(app).get(api+'/'+key).query({page:0,size:100})).body.page.totalElements).toBe(0);
 expect((await request(app).get(api+'/status')).body.configured).toBe(false);
 expect((await request(app).get(api+'/outcomes/'+id)).body.id).toBe(id);
 for(const body of [null,{},[],{action:'foo'},{action:'approve',extra:1},{action:'dismiss',reason:''},{action:'dismiss',reason:'x'.repeat(1501)}]){
   const r=await request(app).post(api+'/proposals/'+id+'/decision').send(body);
   expect(r.status).toBe(400);expect(r.type).toBe('application/problem+json');expect(r.body.errors.length).toBeGreaterThan(0);
 }
 const malformed=await request(app).post(api+'/proposals/'+id+'/decision').type('json').send('{');
 expect(malformed.status).toBe(400);expect(malformed.body.traceId).toBeTruthy();
 for(const action of ['approve','activate']) expect((await request(app).post(api+'/proposals/'+id+'/decision').send({action})).body.id).toBe(id);
 expect((await request(app).post(api+'/proposals/'+id+'/decision').send({action:'dismiss',reason:'x'.repeat(1500)})).status).toBe(200);
 expect((await request(app).post(api+'/outcomes/'+id+'/label').send({label:'ordinary'})).body.label).toBe('ordinary');
 expect((await request(app).post(api+'/outcomes/'+id+'/label').send({label:'arbitrary'})).status).toBe(400);
 expect((await request(app).post(api+'/proposals/'+id+'/evaluation').send({})).body.passed).toBe(true);
 expect((await request(app).post(api+'/proposals/'+id+'/evaluation').send({key:'guess'})).status).toBe(400);
 expect((await request(app).put(api+'/model').send({model:'m',provider:'codex',revision:0,effort:null})).status).toBe(200);
 expect((await request(app).put(api+'/model').send({model:'m',provider:'codex',revision:-1,effort:null})).status).toBe(400);
});

describe('workflow teams', () => {
  it('pins role fallback snapshots on start and stopped team reassignment', async () => {
    let team;
    const teamStore = { get: id => id === team.id ? team : null, list: () => [team] };
    const directory = mkdtempSync(path.join(os.tmpdir(), 'codedeck-team-snapshot-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = path.join(directory, 'runs.sqlite');
    const ctx = await setup({ databasePath, routerDeps: { teamStore } });
    const { agent } = await seedReady(ctx);
    const first = ctx.agentStore.create(agentBody({ name: 'Developer backup' }));
    const second = ctx.agentStore.create(agentBody({ name: 'Reviewer backup' }));
    team = { id: randomUUID(), revision: 3, name: 'Team snapshot', members: [
      { role: 'Developer', agentId: agent.id, fallbackAgentId: first.id },
      { role: 'Reviewer', agentId: agent.id, fallbackAgentId: second.id },
    ] };
    const originalTeam = team;
    const workflow = ctx.workflowStore.create({ name: 'Snapshot', agentsDecide: false, nodes: [
      node(null, { name: 'Implement', role: 'developer' }),
      node(null, { name: 'Review', role: 'reviewer' }),
      node(null, { name: 'Override', role: 'Reviewer' }),
      node(agent.id, { name: 'Report' }),
    ] });
    const started = (await request(ctx.app).post(base + '/runs').send({
      workflowId: workflow.id, requestId: 'role-snapshots', project: 'Demo', input: 'Change', teamId: team.id,
      stepOverrides: { Override: agent.id },
    }).expect(201)).body;
    const projectedFallback = item => ({ id: item.id, name: item.name, agentRevision: item.revision });
    expect(started.steps.map(step => [step.agentSource, step.fallbackAgent])).toEqual([
      ['setup', undefined], ['team', projectedFallback(first)], ['team', projectedFallback(second)],
      ['override', undefined], ['team', projectedFallback(first)],
    ]);
    const snapshotted = item => ({
      id: item.id, name: item.name, launchCommand: item.launchCommand, resetCommand: item.resetCommand,
      assignment: { source: 'fallback', agentRevision: item.revision, teamId: team.id, teamRevision: originalTeam.revision },
    });
    const read = () => {
      const db = new Database(databasePath);
      try {
        const store = createRunStore(db, { interruptOnStart: false });
        return [store.get(started.id), store.attribution(started.id)];
      } finally { db.close(); }
    };
    const [saved, attribution] = read();
    expect(saved.definition.steps.map(step => step.agent.fallbackAgent)).toEqual([
      undefined, snapshotted(first), snapshotted(second), undefined, snapshotted(first),
    ]);
    expect(attribution.configuration[2]).toMatchObject({
      role: 'reviewer', source: 'team', teamRevision: 3, fallbackAgent: projectedFallback(second),
    });
    expect(attribution.configuration[2].fallbackAgent).toEqual(projectedFallback(second));
    team = { ...team, revision: 4, members: team.members.map(member => ({ ...member, fallbackAgentId: second.id })) };
    const revised = ctx.agentStore.update(second.id, { ...agentBody({
      name: 'Revised backup', launchCommand: 'agy', resetCommand: '/reset',
    }), revision: second.revision });
    await request(ctx.app).delete(base + '/agents/' + first.id).expect(204);
    expect(read()[0].definition.steps[1].agent.fallbackAgent).toEqual(snapshotted(first));
    expect(read()[0].definition.steps[2].agent.fallbackAgent).toEqual(snapshotted(second));

    // An old, assignment-free run must acquire current fallback configuration only from an explicit team edit.
    const stopped = ctx.runStore.update(started.id, {
      status: 'stopped', stopReason: 'user', finishedAt: new Date().toISOString(), currentStepIndex: 1,
      steps: saved.steps.map((step, index) => index === 0 ? { ...step, status: 'complete' }
        : index === 1 ? { ...step, status: 'stopped' } : step),
      definition: { ...saved.definition, steps: saved.definition.steps.map(({ agent: { assignment, fallbackAgent, ...legacy }, ...step }) => ({
        ...step, agent: legacy,
      })) },
    });
    expect(read()[0].definition.steps[1].agent).not.toHaveProperty('fallbackAgent');
    await request(ctx.app).put(base + '/runs/' + started.id + '/team').send({
      expectedUpdatedAt: stopped.updatedAt, teamId: team.id, stepOverrides: { Override: agent.id },
    }).expect(200);
    const [reassigned, originalAttribution] = read();
    expect(reassigned.definition.steps.map(step => step.agent.fallbackAgent?.name)).toEqual([
      undefined, revised.name, revised.name, undefined, revised.name,
    ]);
    expect(reassigned.definition.steps[1].agent.fallbackAgent).toEqual({
      id: revised.id, name: revised.name, launchCommand: revised.launchCommand, resetCommand: revised.resetCommand,
      assignment: { source: 'fallback', agentRevision: revised.revision, teamId: team.id, teamRevision: 4 },
    });
    expect(originalAttribution).toEqual({ ...attribution, mixed: true });
  });

  it('validates, persists and releases team role fallback references', async () => {
    const ctx = await setup();
    const primary = ctx.agentStore.create(agentBody({ name: 'Primary' }));
    const backup = ctx.agentStore.create(agentBody({ name: 'Backup' }));
    const successor = ctx.agentStore.create(agentBody({ name: 'Successor' }));
    const api = request(ctx.app);
    const member = { role: 'Developer', agentId: primary.id };
    const team = { name: 'Fallback fleet', members: [member] };
    const created = await api.post(base + '/teams').send(team).expect(201);
    const path = base + '/teams/' + created.body.id;
    expect(created.body.members).toEqual([member]);
    const save = (revision, members) => api.put(path).send({ ...team, members, revision });

    const selected = { ...member, fallbackAgentId: backup.id };
    const settled = await Promise.all([save(1, [selected]), save(1, [selected])]);
    expect(settled.map(response => response.status).sort()).toEqual([200, 409]);
    expect(settled.find(response => response.status === 409).body.traceId).toBeTruthy();
    await api.delete(base + '/agents/' + backup.id).expect(409).expect('Content-Type', /application\/problem\+json/);

    const legacy = await save(2, [{ ...member, role: ' developer ' }]).expect(200);
    expect(legacy.body.members).toEqual([{ ...selected, role: 'Developer' }]);
    const implicitSelf = await save(3, [{ ...member, agentId: backup.id }]).expect(400);
    expect(implicitSelf.body.errors[0].field).toBe('members[0].fallbackAgentId');
    createRoleStore(ctx.db).ensureRole('Review');
    const changed = await save(3, [{ ...member, fallbackAgentId: successor.id }, { ...selected, role: 'Review' }]).expect(200);
    expect(changed.body.members.map(item => item.fallbackAgentId)).toEqual([successor.id, backup.id]);
    const cleared = await save(4, [{ ...member, fallbackAgentId: null }]).expect(200);
    expect(cleared.body.members).toEqual([member]);
    await api.delete(base + '/agents/' + backup.id).expect(204);
    await api.delete(base + '/agents/' + successor.id).expect(204);
    expect((await api.get(path).expect(200)).body.members).toEqual([member]);
    await api.post(base + '/teams').send(team).expect(409);
    await api.put(base + '/teams/' + randomUUID()).send({ ...team, revision: 1 }).expect(404);
  });

  it('returns safe field errors for malformed or unknown team role fallbacks', async () => {
    const ctx = await setup();
    const primary = ctx.agentStore.create(agentBody({ name: 'Primary' }));
    const api = request(ctx.app);
    const path = base + '/teams';
    for (const fallbackAgentId of [randomUUID(), '', [], {}, 1, primary.id, '<script>secret</script>', 'x'.repeat(2048)]) {
      const result = await api.post(path).send({ name: 'Daily', members: [{ role: 'Developer', agentId: primary.id, fallbackAgentId }] }).expect(400);
      expect(result.type).toBe('application/problem+json');
      expect(result.body.traceId).toBeTruthy();
      expect(result.body.errors.map(error => error.field)).toEqual(['members[0].fallbackAgentId']);
      expect(result.text).not.toContain('<script>secret');
    }
    const hostile = await api.post(path).send({ name: 'Daily', members: [{ role: 'Developer', agentId: primary.id, '<script>secret</script>': true }] }).expect(400);
    expect(hostile.body.errors.map(error => error.field)).toEqual(['members[0]']);
    expect(hostile.text).not.toContain('<script>secret');
    const malformed = await api.post(path).type('json').send('{').expect(400);
    expect(malformed.body.traceId).toBeTruthy();
    expect(malformed.body.errors.length).toBeGreaterThan(0);
  });

  it('saves reusable role assignments and snapshots a run-only step override', async () => {
    const ctx = await setup();
    const { agent } = await seedReady(ctx);
    const reviewer = ctx.agentStore.create(agentBody({ name: 'Reviewer' }));
    const team = { name: 'Daily', members: [{ role: 'Reviewer', agentId: reviewer.id }] };
    const created = await request(ctx.app).post(base + '/teams').send(team).expect(201);
    const path = base + '/teams/' + created.body.id;
    await request(ctx.app).get(path).expect(200);
    const listed = await request(ctx.app).get(base + '/teams?name=Daily&sort=name,asc').expect(200);
    expect(listed.body).toMatchObject({ data: [created.body], page: { totalElements: 1, hasNextPage: false } });
    await request(ctx.app).post(base + '/teams').send(team).expect(409);
    await request(ctx.app).delete(base + '/agents/' + reviewer.id).expect(409);
    const workflow = await request(ctx.app).post(base + '/workflows').send({
      name: 'Review work', agentsDecide: false,
      nodes: ['Check', 'Report'].map(name => node(null, { name, role: 'reviewer' })),
    }).expect(201);
    const start = { workflowId: workflow.body.id, requestId: 'team-run', project: 'Demo', input: 'Change' };
    await request(ctx.app).post(base + '/runs').send({ ...start, teamId: null }).expect(400);
    const assigned = { ...start, teamId: created.body.id, stepOverrides: { Report: agent.id } };
    const run = await request(ctx.app).post(base + '/runs').send(assigned).expect(201);
    await request(ctx.app).post(base + '/runs').send({ ...assigned, stepOverrides: {} }).expect(409);
    await request(ctx.app).post(base + '/runs').send({ ...assigned, requestId: 'bad-step', stepOverrides: { Typo: agent.id } }).expect(400);
    await request(ctx.app).put(path).send({ ...team, revision: 1, members: [{ role: 'Reviewer', agentId: agent.id }] }).expect(200);
    await request(ctx.app).put(path).send({ ...team, revision: 1 }).expect(409);
    await request(ctx.app).delete(path).expect(204);
    expect(ctx.runStore.get(run.body.id).definition.steps.map(step => step.agent.id)).toEqual([agent.id, reviewer.id, agent.id]);
    // The run names the team it started with, also after that team is edited or deleted.
    expect(run.body.team).toEqual({ name: 'Daily', changed: false });
    expect(ctx.runStore.get(run.body.id).definition.team).toEqual({ name: 'Daily', changed: false });
    expect(ctx.runStore.attribution(run.body.id)).toMatchObject({
      teamId: created.body.id, teamRevision: 1, teamName: 'Daily', mixed: true, trialId: null,
      configuration: [
        { source: 'setup', agentRevision: agent.revision, teamId: null },
        { source: 'team', role: 'Reviewer', agentId: reviewer.id, provider: null, teamId: created.body.id },
        { source: 'override', agentId: agent.id },
      ],
      attempts: [],
    });
    expect(ctx.workflowStore.get(start.workflowId).nodes.map(step => step.role)).toEqual(['Reviewer', 'Reviewer']);
    expect(ctx.workflowStore.get(start.workflowId).nodes.every(step => !Object.hasOwn(step, 'agentId'))).toBe(true);
  });

  it.each([{}, { members: [] }, { members: [null] }, { members: [{ role: '', agentId: 'x' }] },
    { members: [{ role: 'Dev', agentId: randomUUID() }] }, { members: [{ role: 'Dev', agentId: randomUUID() }, { role: 'dev', agentId: randomUUID() }] },
    { name: 'x'.repeat(65) }])('rejects incomplete or invalid team members and names', async patch => {
    const ctx = await setup();
    const result = await request(ctx.app).post(base + '/teams').send({ name: 'Daily', ...patch }).expect(400);
    expect(result.body.traceId).toBeTruthy();
    expect(result.body.errors.length).toBeGreaterThan(0);
  });
});

it('starts with overrides alone and replays independent of override key order', async () => {
  const ctx = await setup();
  const { agent } = await seedReady(ctx);
  const trial = ctx.agentStore.create(agentBody({ name: 'Trial' }));
  const workflow = ctx.workflowStore.create({ name: 'Trial work', agentsDecide: false,
    nodes: [node(agent.id), node(null, { name: 'Report', role: 'Reviewer' })] });
  const body = { requestId: 'trial', workflowId: workflow.id, project: 'Demo', input: 'change' };
  const start = stepOverrides => request(ctx.app).post(base + '/runs').send({ ...body, stepOverrides });
  const first = await start({ Develop: trial.id, Report: agent.id }).expect(201);
  const replay = await start({ Report: agent.id, Develop: trial.id }).expect(200);
  expect(replay.body.id).toBe(first.body.id);
  expect(first.body.steps.map(step => step.agentName)).toEqual([agent.name, trial.name, agent.name]);
});

it('checks team field boundaries and rejects unsupported run selections before creating a task', async () => {
  const ctx = await setup();
  const { agent, workflow } = await seedReady(ctx);
  const members = Array.from({ length: 32 }, (_, index) => ({ role: String(index).padStart(32, 'x'), agentId: agent.id }));
  for (const member of members) createRoleStore(ctx.db).ensureRole(member.role);
  const teams = request(ctx.app);
  await teams.post(base + '/teams').send({ name: 'x'.repeat(64), members }).expect(201);
  for (const patch of [{ name: 'x'.repeat(65) }, { members: [...members, members[0]] },
    { members: [{ role: 'x'.repeat(33), agentId: agent.id }] }, { members: [{ role: 'X' }] },
    { members: [{ role: 'X', agentId: 'bad' }] }, { members: [members[0], members[0]] }, { name: null }]) {
    await teams.post(base + '/teams').send({ name: 'Y', members, ...patch }).expect(400);
  }
  for (const patch of [{ teamId: null }, { teamId: randomUUID() }, { stepOverrides: null }, { stepOverrides: [] },
    { stepOverrides: { Develop: 'bad' } }, { stepOverrides: { Develop: randomUUID() } }]) {
    await teams.post(base + '/runs').send({ requestId: 'refused', input: 'change', project: 'Demo', workflowId: workflow.id, newTask: {}, ...patch }).expect(400);
  }
  expect(ctx.taskService.createPlanned).not.toHaveBeenCalled();
});

describe('changing a running workflow’s team', () => {
  it.each([
    ['pending', 0, 'pending', 'Report', false],
    ['running', 1, 'pending', 'Verify', false],
    ['running', 1, 'launching', 'Verify', true],
    ['running', 1, 'running', 'Verify', true],
    ['needs_input', 1, 'needs_input', 'Verify', true],
    ['awaiting_approval', 1, 'awaiting_approval', 'Verify', true],
    ['limit_paused', 1, 'limit_reached', 'Verify', true],
  ])('assigns one node in %s (%s, %s)', async (status, currentStepIndex, stepStatus, name, queued) => {
    const ctx = await setup();
    const { agent } = await seedReady(ctx);
    const replacement = ctx.agentStore.create(agentBody({ name: 'Replacement' }));
    const workflow = ctx.workflowStore.create({ name: 'Live edit', agentsDecide: false,
      nodes: ['Verify', 'Report'].map(name => node(agent.id, { name })) });
    const started = (await request(ctx.app).post(base + '/runs').send({ project: 'Demo', input: 'fix', workflowId: workflow.id, requestId: 'live-edit' }).expect(201)).body;
    const run = ctx.runStore.get(started.id);
    const current = ctx.runStore.update(run.id, { status, currentStepIndex, steps: run.steps.map((step, index) =>
      index === currentStepIndex ? { ...step, status: stepStatus, sessionId: queued ? 'Demo-1' : null } : step) });
    const url = base + '/runs/' + run.id + '/team';
    const change = { expectedUpdatedAt: current.updatedAt, stepOverrides: { [name]: replacement.id } };
    const updated = (await request(ctx.app).put(url).send(change).expect(200)).body;
    const step = updated.steps.find(step => step.name === name);
    expect(step.agentName).toBe(queued ? agent.name : replacement.name);
    expect(step.nextAgentName).toBe(queued ? replacement.name : undefined);
    expect(step.sessionId).toBe(queued ? 'Demo-1' : null);
    expect(updated.status).toBe(status);
  });

  it('rejects invalid live edits and separates invalid fields from state conflicts', async () => {
    const ctx = await setup();
    const { agent } = await seedReady(ctx);
    const workflow = ctx.workflowStore.create({ name: 'Live edit', agentsDecide: false,
      nodes: ['Verify', 'Report'].map(name => node(agent.id, { name })) });
    const run = (await request(ctx.app).post(base + '/runs').send({ project: 'Demo', input: 'fix', workflowId: workflow.id, requestId: 'invalid-edit' }).expect(201)).body;
    const url = base + '/runs/' + run.id + '/team';
    const payload = { expectedUpdatedAt: run.updatedAt, stepOverrides: { Verify: agent.id } };
    const put = body => request(ctx.app).put(url).set('Content-Type', 'application/json').send(body);
    for (const body of [
      '{', 'null', { ...payload, stepOverrides: [] }, { ...payload, stepOverrides: {} },
      { ...payload, stepOverrides: Object.fromEntries(Array.from({length:33}, (_, i) => ['step-' + i, agent.id])) },
      { ...payload, stepOverrides: { ['x'.repeat(65)]: agent.id } },
      { ...payload, stepOverrides: { Verify: '<script>' } },
      { ...payload, stepOverrides: { Setup: agent.id } },
      { ...payload, stepOverrides: { Verify: randomUUID() } },
      JSON.stringify({ ...payload, stepOverrides: { ['__proto__']: agent.id } }),
      { ...payload, unexpected: 'value' },
      { ...payload, '<script>': 'value' },
    ]) {
      const bad = await put(body).expect(400).expect('Content-Type', /problem\+json/);
      expect(bad.body).toMatchObject({ status:400, timestamp:expect.any(String), message:expect.any(String), path:url,
        traceId:bad.headers['x-trace-id'], errors:expect.arrayContaining([expect.objectContaining({field:expect.any(String)})]) });
      expect(bad.text).not.toContain('<script>');
    }
    await put({ ...payload, stepOverrides: { Verify: agent.id, Report: agent.id } }).expect(409);
    await put({ ...payload, teamId: agent.id }).expect(409);
    await put({ ...payload, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }).expect(409);
    await request(ctx.app).put(base + '/runs/' + randomUUID() + '/team').send(payload).expect(404);
    const finished = ctx.runStore.update(run.id, { status: 'complete', finishedAt: new Date().toISOString() });
    await put({ ...payload, expectedUpdatedAt: finished.updatedAt }).expect(409);
  });

  it('replaces and cancels a next-round choice without changing the completed assignment', async () => {
    const ctx = await setup();
    const { agent } = await seedReady(ctx);
    const first = ctx.agentStore.create(agentBody({ name: 'First' }));
    const second = ctx.agentStore.create(agentBody({ name: 'Second' }));
    const workflow = ctx.workflowStore.create({ name: 'Live edit', agentsDecide: false,
      nodes: [node(agent.id, { name: 'Verify' }), node(agent.id, { name: 'Report', repeat: { mode: 'loop_back', max: 2, to: 'Verify' } })] });
    const started = (await request(ctx.app).post(base + '/runs').send({
      project: 'Demo', input: 'fix', workflowId: workflow.id, requestId: 'edit-next-round',
    }).expect(201)).body;
    const original = ctx.runStore.get(started.id);
    const running = ctx.runStore.update(started.id, { status: 'running', currentStepIndex: 2,
      steps: original.steps.map((step, i) => i === 1 ? { ...step, status: 'complete', sessionId: 'Demo-1', attempt: 1 } : step),
    });
    const url = base + '/runs/' + started.id + '/team';
    const change = async (run, id, status = 200) => (await request(ctx.app).put(url)
      .send({ expectedUpdatedAt: run.updatedAt, stepOverrides: { Verify: id } }).expect(status)).body;
    const queued = await change(running, first.id);
    const replaced = await change(queued, second.id);
    expect(replaced.steps[1]).toMatchObject({ agentId: agent.id, nextAgentId: second.id, sessionId: 'Demo-1' });
    const cancelled = await change(replaced, agent.id);
    expect(cancelled.steps[1].nextAgentName).toBeUndefined();
    expect(ctx.runStore.get(started.id).definition.steps[1].agent).toEqual(original.definition.steps[1].agent);
    const current = ctx.runStore.get(started.id);
    const lastRound = ctx.runStore.update(current.id, { steps: current.steps.map((step, i) =>
      i === 2 ? { ...step, roundsCompleted: 1 } : step) });
    await change(lastRound, first.id, 400);
  });

  it('persists exactly one competing override even within one clock tick, without editing the catalog or a sibling run', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'codedeck-override-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = path.join(directory, 'run.db');
    const ctx = await setup({ databasePath, runClock: () => '2026-01-01T00:00:00.000Z' });
    const { agent } = await seedReady(ctx);
    const first = ctx.agentStore.create(agentBody({ name: 'First' }));
    const second = ctx.agentStore.create(agentBody({ name: 'Second' }));
    const team = (await request(ctx.app).post(base + '/teams').send({ name: 'Builders', members: [{ role: 'Tester', agentId: agent.id }] }).expect(201)).body;
    const workflow = ctx.workflowStore.create({ name: 'Live edit', agentsDecide: false,
      nodes: [node(agent.id, { name: 'Verify', role: 'Tester' })] });
    const start = async requestId => (await request(ctx.app).post(base + '/runs').send({
      project: 'Demo', input: 'fix', workflowId: workflow.id, teamId: team.id, requestId,
    }).expect(201)).body;
    const run = await start('winner');
    const sibling = await start('sibling');
    const before = ctx.runStore.get(sibling.id);
    const url = base + '/runs/' + run.id + '/team';
    const results = await Promise.all([first, second].map(replacement => request(ctx.app).put(url)
      .send({ expectedUpdatedAt: run.updatedAt, stepOverrides: { Verify: replacement.id } })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = results.find(result => result.status === 200).body;
    const reconnected = new Database(databasePath);
    cleanup.push(() => reconnected.close());
    const reopened = createRunStore(reconnected, { interruptOnStart: false });
    expect(reopened.get(run.id).definition.steps[1].agent.name).toBe(winner.steps[1].agentName);
    expect(reopened.attribution(run.id).mixed).toBe(true);
    expect(winner.team).toEqual({ name: 'Builders', changed: true });
    expect(reopened.get(sibling.id)).toEqual(before);
    expect(ctx.workflowStore.get(workflow.id)).toEqual(workflow);
    expect((await request(ctx.app).get(base + '/teams/' + team.id).expect(200)).body).toEqual(team);
  });

  it('reassigns the failed and later steps atomically, retaining previous terminals and completed work', async () => {
    const ctx = await setup();
    const { agent, team: originalTeam } = await seedReady(ctx);
    const trial = ctx.agentStore.create(agentBody({ name: 'Replacement' }));
    const team = (await request(ctx.app).post(base + '/teams').send({ name: 'Trial team', members: [{ role: 'Tester', agentId: trial.id }] }).expect(201)).body;
    const workflow = ctx.workflowStore.create({ name: 'Verification', agentsDecide: false, nodes:
      ['Investigate', 'Verify', 'Report'].map(name => node(agent.id, { name, role: 'Tester' })) });
    const started = (await request(ctx.app).post(base + '/runs').send({ project: 'Demo', input: 'fix', workflowId: workflow.id, requestId: 'reteam' }).expect(201)).body;
    expect(started.team).toEqual({ name: 'Feature team', changed: false });
    const url = base + '/runs/' + started.id + '/team';
    const payload = { expectedUpdatedAt: started.updatedAt, teamId: team.id, stepOverrides: { Report: agent.id } };
    await request(ctx.app).put(url).send(payload).expect(409);
    const run = ctx.runStore.get(started.id);
    const stopped = ctx.runStore.update(run.id, { currentStepIndex: 2, status: 'error', error: 'Not ready', finishedAt: new Date().toISOString(), steps: run.steps.map((step, index) =>
      index <= 2 ? { ...step, status: index === 2 ? 'failed' : 'complete', sessionId: 'Demo-' + (index + 1), attempt: 1 } : step) });
    const change = { ...payload, expectedUpdatedAt: stopped.updatedAt };
    for (const patch of [{ expectedUpdatedAt: null }, { stepOverrides: { Investigate: trial.id } }, { teamId: randomUUID() }, { stepOverrides: { Report: 'bad' } }, { teamId: null }, { unknown: true }]) {
      await request(ctx.app).put(url).send({ ...change, ...patch }).expect(400);
    }
    await request(ctx.app).put(url).send({ ...change, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }).expect(409);
    const updated = (await request(ctx.app).put(url).send(change).expect(200)).body;
    expect(updated.steps.map(step => step.agentName)).toEqual([agent.name, agent.name, trial.name, agent.name]);
    expect(updated.steps[2]).toMatchObject({ priorSessionIds: ['Demo-3'], sessionId: null, attempt: 1 });
    expect(updated.status).toBe('error');
    // Reassignment replaces the starting team's name in the run snapshot.
    expect(updated.team).toEqual({ name: 'Trial team', changed: true });
    expect(ctx.runStore.get(run.id).definition.team).toEqual({ name: 'Trial team', changed: true });
    expect(ctx.runStore.get(run.id).definition.steps[2].agent.id).toBe(trial.id);
    expect(ctx.runStore.attribution(run.id)).toMatchObject({ teamId: originalTeam.id, mixed: true,
      configuration: [{source:'setup'}, {source:'team'}, {source:'team'}, {source:'team'}],
    });
    expect(ctx.workflowStore.get(workflow.id).nodes[1]).toMatchObject({ role: 'Tester' });
    expect(ctx.workflowStore.get(workflow.id).nodes[1]).not.toHaveProperty('agentId');
    // If Verify loops back, the earlier Investigator keeps its original attribution until re-entry.
    const latest = ctx.runStore.get(run.id);
    const loop = ctx.runStore.update(run.id, { definition: { ...latest.definition, steps: latest.definition.steps.map((item, index) =>
      index === 2 ? { ...item, repeat: { mode: 'loop_back', toStepIndex: 1, max: 3 } } : item) } });
    const queued = await request(ctx.app).put(url).send({ ...change, expectedUpdatedAt: loop.updatedAt }).expect(200);
    expect(queued.body.steps[1]).toMatchObject({ agentName: agent.name, nextAgentName: trial.name, sessionId: 'Demo-2' });
    // Overriding one step keeps the team's name and marks the lineup as changed.
    const overridden = await request(ctx.app).put(url).send({ expectedUpdatedAt: queued.body.updatedAt, stepOverrides: { Report: trial.id } }).expect(200);
    expect(overridden.body.team).toEqual({ name: 'Trial team', changed: true });
  });
});

describe('pipelines API — attached starts reserve, publish and close', () => {
  const IN_USE = [{ code: 'in_use', message: 'An open workflow run is already using it.' }];

  async function attachedSetup({ routerDeps = {}, repositories = false, ...options } = {}) {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codedeck-api-attach-')));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const initRepo = name => {
      const repo = path.join(dir, name);
      mkdirSync(repo);
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.name', 'API Test');
      git(repo, 'config', 'user.email', 'api@test.local');
      writeFileSync(path.join(repo, 'README.md'), '# repo\n');
      git(repo, 'add', 'README.md');
      git(repo, 'commit', '-m', 'init');
      return repo;
    };
    const repo = initRepo('repo');
    const stagingRoot = path.join(dir, 'staging');
    const ctx = await setup({ ...options, repo, routerDeps: { attachmentStagingRoot: stagingRoot, planNames: realPlanNames, ...routerDeps } });
    const backend = repositories ? initRepo('backend') : null;
    if (backend) ctx.projects.get('Demo').repositories = [{ name: 'backend', path: backend }];
    const { workflow } = await seedReady(ctx);
    const post = (fields = {}, files = [['a.txt', 'alpha'], ['a.txt', 'second a']], app = ctx.app) => {
      let req = request(app).post(`${base}/runs`)
        .field('run', JSON.stringify({ requestId: 'attached', workflowId: workflow.id, project: 'Demo', input: 'brief', ...fields }));
      for (const [name, body] of files) req = req.attach('files', Buffer.from(body), name);
      return req;
    };
    const postJson = fields => request(ctx.app).post(`${base}/runs`).send({ workflowId: workflow.id, project: 'Demo', input: 'plain', ...fields });
    const attempts = () => (existsSync(path.join(stagingRoot, 'attempts')) ? readdirSync(path.join(stagingRoot, 'attempts')) : []);
    const read = (checkout, attachment) => readFileSync(path.join(checkout, attachment.path), 'utf8');
    const clean = checkout => git(checkout, 'status', '--porcelain', '--untracked-files=all');
    return { ...ctx, repo, backend, git, workflow, requestStore: createRequestStore(ctx.db), post, postJson, attempts, read, clean, stagingRoot };
  }

  /** A publisher that waits at `entered` until `release` is resolved, then publishes for real. */
  function pausedPublisher() {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let calls = 0;
    const publishAttachments = async options => {
      calls += 1;
      entered.resolve();
      await release.promise;
      return publishAttachmentBatch(options);
    };
    return { publishAttachments, entered: entered.promise, release: release.resolve, calls: () => calls };
  }

  function failingOnce(field = 'files[1]') {
    let failed = false;
    return async options => {
      if (!failed) {
        failed = true;
        throw new AttachmentPublishError(`Attachment ${field} could not be copied: EIO`, { status: 500, code: 'copy_failed', field });
      }
      return publishAttachmentBatch(options);
    };
  }

  it('publishes a new task\'s attachments in its starting worktree before answering 201', async () => {
    const ctx = await attachedSetup();
    const response = await ctx.post({ newTask: { title: 'Login' } });
    expect(response.status).toBe(201);
    const [task] = ctx.taskStore.list();
    const run = ctx.runStore.get(response.body.id);
    expect(run.worktreePath).toBe(task.worktreePath);
    expect(response.body.attachments.map(entry => entry.name)).toEqual(['a.txt', 'a.txt']);
    expect(response.body.attachments.map(entry => ctx.read(task.worktreePath, entry))).toEqual(['alpha', 'second a']);
    expect(ctx.clean(task.worktreePath)).toBe('');
    expect(ctx.requestStore.get('attached')).toMatchObject({
      runId: run.id, taskId: task.id, provisioningState: 'published', placement: { worktreePath: task.worktreePath, startRepository: 'repo' },
    });
    expect(ctx.attempts()).toEqual([]);
    expect(ctx.engineStarts).toEqual([]);
    ctx.flushStart();
    expect(ctx.engineStarts).toEqual([run.id]);
  });

  it('creates the selector-free checkout itself and publishes into it', async () => {
    const ctx = await attachedSetup();
    const response = await ctx.post();
    expect(response.status).toBe(201);
    const run = ctx.runStore.get(response.body.id);
    expect(run).toMatchObject({ worktreeState: 'present', baseCommit: ctx.git(ctx.repo, 'rev-parse', 'HEAD').trim() });
    expect(ctx.git(ctx.repo, 'worktree', 'list', '--porcelain')).toContain(`worktree ${run.worktreePath}\n`);
    expect(response.body.attachments.map(entry => ctx.read(run.worktreePath, entry))).toEqual(['alpha', 'second a']);
    expect(ctx.clean(run.worktreePath)).toBe('');
    expect(ctx.clean(ctx.repo)).toBe('');
  });

  it('publishes in Main and in an open task\'s worktree', async () => {
    const ctx = await attachedSetup();
    const inMain = await ctx.post({ worktreePath: ctx.repo });
    expect(inMain.status).toBe(201);
    expect(ctx.runStore.get(inMain.body.id).worktreeState).toBe('external');
    expect(inMain.body.attachments.map(entry => ctx.read(ctx.repo, entry))).toEqual(['alpha', 'second a']);
    expect(ctx.clean(ctx.repo)).toBe('');

    const task = await ctx.taskService.createPlanned(await ctx.taskService.plan({ project: 'Demo', title: 'Open', titleSource: 'owner' }));
    const inTask = await ctx.post({ requestId: 'attached-task', taskId: task.id }, [['notes.md', '# notes']]);
    expect(inTask.status).toBe(201);
    expect(inTask.body.attachments.map(entry => ctx.read(task.worktreePath, entry))).toEqual(['# notes']);
    expect(ctx.clean(task.worktreePath)).toBe('');
  });

  it('publishes only in the selected secondary repository', async () => {
    const ctx = await attachedSetup({ repositories: true });
    const response = await ctx.post({ worktreePath: ctx.backend });
    expect(response.status).toBe(201);
    expect(response.body.attachments.map(entry => ctx.read(ctx.backend, entry))).toEqual(['alpha', 'second a']);
    expect(existsSync(path.join(ctx.repo, '.codedeck'))).toBe(false);
    expect(ctx.requestStore.get('attached').placement).toMatchObject({ worktreePath: ctx.backend, startRepository: 'backend' });
  });

  it('answers a concurrent identical start with the same run while the copy is paused, enqueuing once', async () => {
    const paused = pausedPublisher();
    const ctx = await attachedSetup({ routerDeps: { publishAttachments: paused.publishAttachments } });
    let answered = false;
    const first = ctx.post().then(response => { answered = true; return response; });
    await paused.entered;
    const second = ctx.post().then(response => response);
    await vi.waitFor(() => expect(ctx.attempts()).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(answered).toBe(false);
    expect(ctx.runStore.list()).toEqual([]);
    paused.release();
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    expect(responses[0].body.id).toBe(responses[1].body.id);
    expect(paused.calls()).toBe(1);
    ctx.flushStart();
    expect(ctx.engineStarts).toEqual([responses[0].body.id]);
    expect(ctx.attempts()).toEqual([]);
  });

  it('answers 201 without waiting for the agent to become ready', async () => {
    const ctx = await attachedSetup({ routerDeps: { scheduleStart: fn => fn() } });
    ctx.engine.start.mockImplementation(() => new Promise(() => {}));
    const response = await ctx.post();
    expect(response.status).toBe(201);
    expect(ctx.engine.start).toHaveBeenCalledTimes(1);
  });

  it('keeps a recoverable copy failure under the same reservation and retries without another task', async () => {
    const ctx = await attachedSetup({ routerDeps: { publishAttachments: failingOnce() } });
    const failed = await ctx.post({ newTask: { title: 'Login' } });
    expect(failed.status).toBe(500);
    expect(failed.type).toBe('application/problem+json');
    const reservation = ctx.requestStore.get('attached');
    expect(reservation).toMatchObject({ provisioningState: 'failed', runId: expect.any(String), taskId: expect.any(String) });
    expect(failed.body).toMatchObject({
      errors: [{ field: 'files[1]' }], traceId: failed.headers['x-trace-id'],
      reservation: { requestId: 'attached', runId: reservation.runId, taskId: reservation.taskId, provisioningState: 'failed' },
    });
    expect(ctx.runStore.list()).toEqual([]);
    expect(ctx.taskStore.list()).toHaveLength(1);
    expect(ctx.attempts()).toEqual([]);
    ctx.flushStart();
    expect(ctx.engineStarts).toEqual([]);

    const retried = await ctx.post({ newTask: { title: 'Login' } });
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({ id: reservation.runId, taskId: reservation.taskId });
    expect(ctx.taskStore.list()).toHaveLength(1);
    expect(ctx.requestStore.get('attached').provisioningState).toBe('published');
    ctx.flushStart();
    expect(ctx.engineStarts).toEqual([reservation.runId]);
  });

  it('refuses a competing start for the checkout while an attached start is publishing there', async () => {
    const paused = pausedPublisher();
    const ctx = await attachedSetup({ routerDeps: { publishAttachments: paused.publishAttachments } });
    const first = ctx.post({ worktreePath: ctx.repo }).then(response => response);
    await paused.entered;
    const competing = await ctx.postJson({ requestId: 'competing', worktreePath: ctx.repo });
    expect(competing.status).toBe(409);
    expect(competing.body.reasons).toEqual(IN_USE);
    const listed = await request(ctx.app).get(`${base}/worktrees`).query({ project: 'Demo' });
    expect(listed.body.data.find(entry => entry.path === ctx.repo)).toMatchObject({ selectable: false, reason: IN_USE[0] });
    paused.release();
    expect((await first).status).toBe(201);
    expect(ctx.runStore.list()).toHaveLength(1);
  });

  it('revalidates the checkout at publication and removes the unpublished batch', async () => {
    let ctx;
    let other;
    ctx = await attachedSetup({ routerDeps: { publishAttachments: async options => {
      const published = await publishAttachmentBatch(options);
      // Another run came to hold the checkout while the batch was being copied.
      ctx.runStore.update(other, { worktreePath: ctx.repo, worktreeState: 'external' });
      return published;
    } } });
    other = (await ctx.postJson({ requestId: 'elsewhere' })).body.id;
    const response = await ctx.post({ worktreePath: ctx.repo });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ reasons: IN_USE, reservation: { requestId: 'attached', provisioningState: 'failed' } });
    expect(ctx.runStore.list().map(run => run.id)).toEqual([other]);
    const notesDir = `.codedeck/runs/${response.body.reservation.runId.slice(0, 8)}`;
    expect(readdirSync(path.join(ctx.repo, notesDir))).toEqual([]);
  });

  it('refuses publication if the selected checkout becomes detached during the copy', async () => {
    const paused = pausedPublisher();
    const ctx = await attachedSetup({ routerDeps: { publishAttachments: paused.publishAttachments } });
    const starting = ctx.post({ worktreePath: ctx.repo }).then(response => response);
    await paused.entered;
    try {
      ctx.git(ctx.repo, 'checkout', '--detach');
    } finally {
      paused.release();
    }

    const response = await starting;
    expect(response.status).toBe(409);
    expect(response.body.reasons).toEqual([expect.objectContaining({ code: 'detached' })]);
    expect(ctx.runStore.list()).toEqual([]);
    const reservation = ctx.requestStore.get('attached');
    expect(reservation.provisioningState).toBe('failed');
    const notesDir = `.codedeck/runs/${reservation.runId.slice(0, 8)}`;
    expect(readdirSync(path.join(ctx.repo, notesDir))).toEqual([]);
    ctx.flushStart();
    expect(ctx.engineStarts).toEqual([]);
  });

  it('refuses publication if Git can no longer read the selected checkout after the copy', async () => {
    const ctx = await attachedSetup({ routerDeps: { publishAttachments: async options => {
      const published = await publishAttachmentBatch(options);
      writeFileSync(path.join(options.checkoutPath, '.git', 'index'), 'invalid checkout index');
      return published;
    } } });

    const response = await ctx.post({ worktreePath: ctx.repo });

    expect(response.status).toBe(409);
    expect(response.body.reasons).toEqual([expect.objectContaining({ code: 'unreadable' })]);
    const reservation = ctx.requestStore.get('attached');
    expect(reservation.provisioningState).toBe('failed');
    const notesDir = `.codedeck/runs/${reservation.runId.slice(0, 8)}`;
    expect(readdirSync(path.join(ctx.repo, notesDir))).toEqual([]);
    expect(ctx.runStore.list()).toEqual([]);
    ctx.flushStart();
    expect(ctx.engineStarts).toEqual([]);
  });

  it('releases a definitive rejection before provisioning so the same ID and body can retry', async () => {
    const ctx = await attachedSetup();
    const holder = await ctx.postJson({ requestId: 'holder', worktreePath: ctx.repo });
    expect(holder.status).toBe(201);
    const refused = await ctx.post({ worktreePath: ctx.repo });
    expect(refused.status).toBe(409);
    expect(refused.body.reasons).toEqual(IN_USE);
    expect(refused.body.reservation).toBeUndefined();
    expect(ctx.requestStore.get('attached')).toBeNull();
    expect(ctx.attempts()).toEqual([]);
    ctx.runStore.update(holder.body.id, { status: 'complete', finishedAt: new Date().toISOString() });
    expect((await ctx.post({ worktreePath: ctx.repo })).status).toBe(201);
  });

  it('replays a published start with 200 and never rewrites its files', async () => {
    const ctx = await attachedSetup();
    const first = await ctx.post();
    const run = ctx.runStore.get(first.body.id);
    const copy = path.join(run.worktreePath, first.body.attachments[0].path);
    const inode = (await fsPromises.stat(copy)).ino;
    const replay = await ctx.post();
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect((await fsPromises.stat(copy)).ino).toBe(inode);
    expect(ctx.attempts()).toEqual([]);
    ctx.flushStart();
    expect(ctx.engineStarts).toEqual([first.body.id]);
  });

  describe('a server stop part way through, then a retry with the same ID', () => {
    /** Holds a start at `at()` and never lets it carry on, as a server stop would. */
    function interruption() {
      const reached = Promise.withResolvers();
      const stopped = Promise.withResolvers();
      return { at: () => { reached.resolve(); return stopped.promise; }, reached: reached.promise, abandon: () => stopped.reject(new Error('server stopped')) };
    }

    /** Startup reconcile, then a new router over the same database, as after a restart. */
    async function restart(ctx) {
      await reconcileAttachmentStarts({ requestStore: createRequestStore(ctx.db), runStore: ctx.runStore, stagingRoot: ctx.stagingRoot });
      return ctx.openApp();
    }

    const worktrees = ctx => ctx.git(ctx.repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '));

    it('finishes a start stopped while its task was being created, with one task and one run', async () => {
      const ctx = await attachedSetup();
      const stop = interruption();
      vi.spyOn(ctx.taskService, 'createPlanned').mockImplementationOnce(() => stop.at());
      const abandoned = ctx.post({ newTask: { title: 'Login' } }).then(response => response);
      await stop.reached;
      expect(ctx.attempts()).toHaveLength(1);

      const app = await restart(ctx);
      expect(ctx.attempts()).toEqual([]);
      expect(ctx.requestStore.get('attached').provisioningState).toBe('failed');
      const retried = await ctx.post({ newTask: { title: 'Login' } }, undefined, app);
      expect(retried.status).toBe(201);
      const [task] = ctx.taskStore.list();
      expect(ctx.taskStore.list()).toHaveLength(1);
      expect(worktrees(ctx)).toEqual([`worktree ${ctx.repo}`, `worktree ${task.worktreePath}`]);
      expect(retried.body.attachments.map(entry => ctx.read(task.worktreePath, entry))).toEqual(['alpha', 'second a']);
      expect(ctx.runStore.list()).toHaveLength(1);
      ctx.flushStart();
      expect(ctx.engineStarts).toEqual([retried.body.id]);
      stop.abandon();
      await abandoned;
    });

    it('reuses the checkout a selector-free start created before it was stopped', async () => {
      const stop = interruption();
      let created = 0;
      const ctx = await attachedSetup({ routerDeps: { createWorktree: async options => {
        const result = await createRunWorktree(options);
        if (++created === 1) await stop.at();
        return result;
      } } });
      const abandoned = ctx.post().then(response => response);
      await stop.reached;
      const { worktreePath } = ctx.requestStore.get('attached').placement;

      const retried = await ctx.post(undefined, undefined, await restart(ctx));
      expect(retried.status).toBe(201);
      expect(created).toBe(1);
      expect(ctx.runStore.get(retried.body.id)).toMatchObject({ worktreePath, worktreeState: 'present' });
      expect(worktrees(ctx)).toEqual([`worktree ${ctx.repo}`, `worktree ${worktreePath}`]);
      expect(retried.body.attachments.map(entry => ctx.read(worktreePath, entry))).toEqual(['alpha', 'second a']);
      stop.abandon();
      await abandoned;
    });

    it('removes a batch promoted before its manifest was persisted, then publishes the same paths once', async () => {
      const stop = interruption();
      let published = null;
      const ctx = await attachedSetup({ routerDeps: { publishAttachments: async options => {
        const result = await publishAttachmentBatch(options);
        if (published === null) {
          published = { ...result, checkout: options.checkoutPath, notesDir: options.notesDir };
          await stop.at();
        }
        return result;
      } } });
      const abandoned = ctx.post({ worktreePath: ctx.repo }).then(response => response);
      await stop.reached;
      const inode = statSync(path.join(ctx.repo, published.attachments[0].path)).ino;

      const app = await restart(ctx);
      expect(readdirSync(path.join(ctx.repo, published.notesDir))).toEqual([]);
      const retried = await ctx.post({ worktreePath: ctx.repo }, undefined, app);
      expect(retried.status).toBe(201);
      expect(retried.body.attachments.map(entry => entry.path)).toEqual(published.attachments.map(entry => entry.path));
      expect(statSync(path.join(ctx.repo, published.attachments[0].path)).ino).not.toBe(inode);
      expect(retried.body.attachments.map(entry => ctx.read(ctx.repo, entry))).toEqual(['alpha', 'second a']);
      expect(ctx.runStore.list()).toHaveLength(1);
      ctx.flushStart();
      expect(ctx.engineStarts).toEqual([retried.body.id]);
      stop.abandon();
      await abandoned;
    });

    it('keeps a batch whose run was recorded before the stop and answers the lost response with 200', async () => {
      const ctx = await attachedSetup();
      const first = await ctx.post();
      ctx.flushStart();
      // Stopped after the run and its manifest were recorded, before the reservation was marked published.
      ctx.db.prepare("UPDATE pipeline_run_requests SET provisioning_state = 'reserved' WHERE request_id = 'attached'").run();
      const run = ctx.runStore.get(first.body.id);
      const inode = statSync(path.join(run.worktreePath, first.body.attachments[0].path)).ino;

      const replay = await ctx.post(undefined, undefined, await restart(ctx));
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(ctx.requestStore.get('attached').provisioningState).toBe('published');
      expect(statSync(path.join(run.worktreePath, first.body.attachments[0].path)).ino).toBe(inode);
      ctx.flushStart();
      expect(ctx.engineStarts).toEqual([first.body.id]);
    });
  });

  describe('Close run on an unpublished reservation', () => {
    it.each(['Close run', 'startup reconciliation'])('preserves a foreign attachment batch during %s', async action => {
      let foreignFile;
      const ctx = await attachedSetup({ routerDeps: { publishAttachments: async options => {
        const batch = path.join(options.checkoutPath, options.notesDir, 'attachments');
        mkdirSync(batch, { recursive: true });
        writeFileSync(path.join(options.checkoutPath, '.codedeck', '.gitignore'), '*\n');
        foreignFile = path.join(batch, 'keep.txt');
        writeFileSync(foreignFile, 'owner content');
        return publishAttachmentBatch(options);
      } } });
      const response = await ctx.post({ worktreePath: ctx.repo });
      expect(response.status).toBe(409);
      expect(response.body.reservation.provisioningState).toBe('failed');
      expect(readFileSync(foreignFile, 'utf8')).toBe('owner content');

      if (action === 'Close run') {
        await request(ctx.app).post(`${base}/runs/${response.body.reservation.runId}/cleanup`);
      } else {
        await reconcileAttachmentStarts({ requestStore: ctx.requestStore, runStore: ctx.runStore, stagingRoot: ctx.stagingRoot });
      }

      expect(existsSync(foreignFile)).toBe(true);
      expect(readFileSync(foreignFile, 'utf8')).toBe('owner content');
      expect(ctx.runStore.list()).toEqual([]);
    });

    it.each(['Close run', 'startup reconciliation'])('preserves a foreign temporary attachment directory during %s', async action => {
      let foreignFile;
      const ctx = await attachedSetup({ routerDeps: { publishAttachments: async options => {
        const batch = path.join(options.checkoutPath, options.notesDir, `.attachments-${options.attemptId}.tmp`);
        mkdirSync(batch, { recursive: true });
        writeFileSync(path.join(options.checkoutPath, '.codedeck', '.gitignore'), '*\n');
        foreignFile = path.join(batch, 'keep.txt');
        writeFileSync(foreignFile, 'owner content');
        return publishAttachmentBatch(options);
      } } });
      const response = await ctx.post({ worktreePath: ctx.repo });
      expect(response.body.reservation.provisioningState).toBe('failed');
      expect(readFileSync(foreignFile, 'utf8')).toBe('owner content');

      if (action === 'Close run') {
        const closed = await request(ctx.app).post(`${base}/runs/${response.body.reservation.runId}/cleanup`);
        expect(closed.status).toBe(200);
        expect(closed.body.provisioningState).toBe('closed');
      } else {
        const reconciled = await reconcileAttachmentStarts({ requestStore: ctx.requestStore, runStore: ctx.runStore, stagingRoot: ctx.stagingRoot });
        expect(reconciled.failed).toEqual(['attached']);
      }

      expect(existsSync(foreignFile)).toBe(true);
      expect(readFileSync(foreignFile, 'utf8')).toBe('owner content');
    });

    it('fences replay, removes its own checkout, and lets a fresh ID start the corrected draft', async () => {
      const ctx = await attachedSetup({ routerDeps: { publishAttachments: failingOnce() } });
      const failed = await ctx.post();
      expect(failed.status).toBe(500);
      const { runId } = failed.body.reservation;
      const { worktreePath } = ctx.requestStore.get('attached').placement;
      expect(existsSync(worktreePath)).toBe(true);

      const closed = await request(ctx.app).post(`${base}/runs/${runId}/cleanup`);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({
        requestId: 'attached', runId, provisioningState: 'closed',
        worktree: { path: worktreePath, state: 'removed' }, terminalsClosed: [], terminalsNotClosed: [],
      });
      expect(existsSync(worktreePath)).toBe(false);

      const replay = await ctx.post();
      expect(replay.status).toBe(409);
      expect(ctx.runStore.list()).toEqual([]);
      expect(existsSync(worktreePath)).toBe(false);
      expect((await request(ctx.app).post(`${base}/runs/${runId}/cleanup`)).status).toBe(404);

      const fresh = await ctx.post({ requestId: 'attached-2', input: 'corrected brief' });
      expect(fresh.status).toBe(201);
      expect(fresh.body.id).not.toBe(runId);
    });

    it('keeps an owned checkout with owner changes and still fences the reservation', async () => {
      const ctx = await attachedSetup({ routerDeps: { publishAttachments: failingOnce() } });
      const { runId } = (await ctx.post()).body.reservation;
      const { worktreePath } = ctx.requestStore.get('attached').placement;
      writeFileSync(path.join(worktreePath, 'README.md'), 'owner edit\n');
      const closed = await request(ctx.app).post(`${base}/runs/${runId}/cleanup`);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ provisioningState: 'closed', worktree: { path: worktreePath, state: 'removal_blocked' } });
      expect(readFileSync(path.join(worktreePath, 'README.md'), 'utf8')).toBe('owner edit\n');
      expect((await ctx.post()).status).toBe(409);
    });

    it('leaves a created task to its own lifecycle and clears only managed files', async () => {
      const ctx = await attachedSetup({ routerDeps: { publishAttachments: failingOnce() } });
      const { runId } = (await ctx.post({ newTask: { title: 'Login' } })).body.reservation;
      const [task] = ctx.taskStore.list();
      const notes = path.join(task.worktreePath, `.codedeck/runs/${runId.slice(0, 8)}`);
      mkdirSync(path.join(notes, 'attachments'), { recursive: true });
      writeFileSync(path.join(notes, 'keep.md'), 'not managed');
      const closed = await request(ctx.app).post(`${base}/runs/${runId}/cleanup`);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ taskId: task.id, worktree: { path: task.worktreePath, state: 'external' } });
      expect(ctx.taskStore.get(task.id)).not.toBeNull();
      expect(readdirSync(notes)).toEqual(['keep.md']);
    });

    it('refuses Close while the start is still provisioning', async () => {
      const paused = pausedPublisher();
      const ctx = await attachedSetup({ routerDeps: { publishAttachments: paused.publishAttachments } });
      const first = ctx.post().then(response => response);
      await paused.entered;
      const { runId } = ctx.requestStore.get('attached');
      const refused = await request(ctx.app).post(`${base}/runs/${runId}/cleanup`);
      expect(refused.status).toBe(409);
      paused.release();
      expect((await first).status).toBe(201);
      expect(ctx.requestStore.get('attached').provisioningState).toBe('published');
    });
  });
});

it('reserves a candidate in the run insert transaction and replays without another slot', async () => {
  let db, candidate, backup;
  const reserve = vi.fn(context => {
    expect(db.inTransaction).toBe(true);
    expect(context).toMatchObject({ roles: ['Reviewer'], mixed: false, project: 'Demo', workflowRevision: 1 });
    expect(context.configuration[1].fallbackAgent).toEqual({ id: backup.id, name: backup.name, agentRevision: 1 });
    return { trialId, role: 'Reviewer', agent: candidate };
  });
  const trialId = randomUUID();
  let team;
  const teamStore = { get: id => id === team.id ? team : null, list: () => [team] };
  const ctx = await setup({ routerDeps: { teamStore, teamScoring: { trials: { reserve } } } });
  db = ctx.db;
  const { agent } = await seedReady(ctx);
  candidate = { ...agent, launchCommand: 'command codex --model m -c model_reasoning_effort="medium"' };
  backup = ctx.agentStore.create(agentBody({ name: 'Review backup' }));
  team = { id: randomUUID(), name: 'Correctors', revision: 1, members: [
    { role: 'Reviewer', agentId: agent.id, fallbackAgentId: backup.id },
  ] };
  const workflow = ctx.workflowStore.create({ name: 'Validate', agentsDecide: false, nodes: [node(agent.id, {role: 'Reviewer'})] });
  const body = { project: 'Demo', requestId: 'reserve', workflowId: workflow.id, input: 'fix', teamId: team.id };
  const run = (await request(ctx.app).post(base + '/runs').send(body).expect(201)).body;
  expect(ctx.runStore.get(run.id).definition.steps.at(-1).agent.launchCommand).toBe(candidate.launchCommand);
  expect(ctx.runStore.get(run.id).definition.steps.at(-1).agent).not.toHaveProperty('fallbackAgent');
  expect(run.steps.at(-1)).toMatchObject({ agentSource: 'trial' });
  expect(run.steps.at(-1)).not.toHaveProperty('fallbackAgent');
  expect(ctx.runStore.attribution(run.id)).toMatchObject({ trialId, mixed: false, configuration: [
    {source: 'setup'}, {source: 'trial', model: 'm', effort: 'medium', agentRevision: agent.revision}
  ]});
  await request(ctx.app).post(base + '/runs').send(body).expect(200);
  expect(reserve).toHaveBeenCalledTimes(1);
});

it('measures five trial deliveries through the normal run launcher, then adopts only for the selected team', async () => {
  let time = Date.parse('2026-11-20T12:00:00.000Z');
  const now = () => new Date(time).toISOString();
  const teamScoring = {};
  const ctx = await setup({ runClock: now, routerDeps: { teamScoring } });
  const teams = createTeamStore(ctx.db);
  const stores = { db:ctx.db, runs:ctx.runStore, teams, notes:ctx.noteStore, answers:ctx.answerStore,
    reviews:ctx.reviewStore, now };
  const improvements = createImprovements({...stores, tasks:ctx.taskStore, decisions:ctx.decisionStore,
    workflows:ctx.workflowStore, settings:()=>null, generate:vi.fn()});
  Object.assign(teamScoring, createTeamObservations({...stores,improvements}));
  teamScoring.trials = createTeamTrials({db:ctx.db, teams, agents:ctx.agentStore, workflows:ctx.workflowStore,
    observations:teamScoring.observations, now});
  const {agent} = await seedReady(ctx);
  const high = 'command codex --model m -c model_reasoning_effort="high"';
  const medium = 'command codex --model m -c model_reasoning_effort="medium"';
  ctx.agentStore.update(agent.id, {...agentBody({launchCommand:high}), revision:agent.revision});
  const members = [{role:'Fix',agentId:agent.id}];
  const team = teams.create({name:'Trial team',members}), other = teams.create({name:'Other team',members});
  const workflow = ctx.workflowStore.create({name:'Repair', agentsDecide:false, nodes:[node(agent.id,{role:'Fix'})]});
  const start = async selected => {
    const response = await request(ctx.app).post(base+'/runs').send({requestId:randomUUID(),teamId:selected.id,
      workflowId:workflow.id,project:'Demo',input:'Fix rotation'}).expect(201);
    return ctx.runStore.get(response.body.id);
  };
  const dashboard = base+'/improvements/teams';
  async function deliver(run, ms) {
    for (const index of [0,1]) {
      const progress = ctx.runStore.get(run.id).steps.map((s,i) => i===index
        ? {...s,status:'running',attempt:1,sessionId:'Demo-'+(i+1)} : {...s,status:'complete'});
      ctx.runStore.recordAttempt(ctx.runStore.update(run.id,{currentStepIndex:index,status:'running',steps:progress}));
      time += index === 0 ? 100 : ms;
    }
    const latest = ctx.runStore.get(run.id);
    ctx.runStore.update(run.id,{status:'complete',finishedAt:now(),steps:latest.steps.map(s=>({...s,status:'complete'}))});
    await improvements.tick();
    const details = (await request(ctx.app).get(dashboard+'/runs/'+run.id).expect(200)).body;
    await request(ctx.app).post(dashboard+'/runs/'+run.id+'/corrections').send({revision:0,signature:details.signature,
      text:'Fix rotation',verdict:'met',reason:'Verified rotation on the device.'}).expect(200);
    time += 1000;
  }
  for (let i=0;i<3;i++) await deliver(await start(team), 900);
  teamScoring.trials.refresh();
  const pending = (await request(ctx.app).get(dashboard+'/trials').expect(200)).body.data[0];
  const decision = dashboard+'/trials/'+pending.id+'/decision';
  await request(ctx.app).post(decision).send({action:'start',revision:pending.revision}).expect(200);
  for (let i=0;i<3;i++) {
    const run = await start(team);
    expect(run.definition.steps[1].agent.launchCommand).toBe(medium);
    await deliver(run, 400);
  }
  expect((await start(team)).definition.steps[1].agent.launchCommand).toBe(high);
  const measured = (await request(ctx.app).get(dashboard+'/trials').expect(200)).body.data[0];
  expect(measured).toMatchObject({status:'measured', comparison:{verdict:'helped'}});
  await request(ctx.app).post(decision).send({action:'adopt',revision:measured.revision}).expect(200);
  const later = await start(team);
  expect(later.definition.steps[1].agent.launchCommand).toBe(medium);
  expect(ctx.runStore.attribution(later.id)).toMatchObject({trialId:null,teamRevision:2});
  expect((await start(other)).definition.steps[1].agent.launchCommand).toBe(high);
});

it('refuses a selected team when none of its roles staff the workflow', async () => {
  const ctx=await setup();
  const {agent,workflow}=await seedReady(ctx);
  const team=createTeamStore(ctx.db).create({name:'Unused',members:[{role:'Review',agentId:agent.id}]});
  const response=await request(ctx.app).post(base+'/runs').send({requestId:'no-team-roles',teamId:team.id,
    workflowId:workflow.id,project:'Demo',input:'Fix rotation'}).expect(400);
  expect(response.body.errors).toContainEqual({ field: 'teamId', message: expect.stringContaining('Developer') });
  expect(ctx.runStore.list()).toEqual([]);
});

it('returns traced problem details for invalid team score queries and missing trial evidence', async () => {
  const {app} = await setup({routerDeps:{teamScoring:{
    runs:()=>[], detail:()=>{throw Object.assign(new Error('Team run evidence not found'),{status:404})},
  }}});
  const url=base+'/improvements/teams/runs';
  for (const [path,status] of [[url+'?sort=command,desc',400],[url+'/'+randomUUID(),404]]) {
    const response=await request(app).get(path);
    expect(response.status).toBe(status);
    expect(response.type).toBe('application/problem+json');
    expect(response.body).toMatchObject({status,traceId:response.headers['x-trace-id']});
    if(status===400) expect(response.body.errors).toEqual([expect.objectContaining({field:'sort'})]);
  }
});

it('omits disabled workflow stages and per-run disabledSteps while keeping loop targets aligned', async () => {
  const ctx = await setup();
  const { agent } = await seedReady(ctx);
  const workflow = (await request(ctx.app).post(base + '/workflows').send({
    name: 'Flexible build',
    agentsDecide: false,
    nodes: [
      { ...node(agent.id, { name: 'Requirements', prompt: 'Ask {input}' }), enabled: false },
      node(agent.id, { name: 'Specify', prompt: 'Specify {input}' }),
      node(agent.id, { name: 'Develop', prompt: 'Build {input}' }),
      node(agent.id, { name: 'Review', prompt: 'Review {input}' }),
      node(agent.id, { name: 'Test', prompt: 'Test {input}', repeat: { mode: 'loop_back', to: 'Develop', max: 4 } }),
    ],
  }).expect(201)).body;

  expect(workflow.nodes[0].enabled).toBe(false);

  // Starting without disabledSteps skips nodes disabled on the workflow and adjusts loop toStepIndex.
  const defaultRun = (await request(ctx.app).post(base + '/runs').send({
    requestId: 'default-disabled',
    workflowId: workflow.id,
    project: 'Demo',
    input: 'feature',
  }).expect(201)).body;
  expect(defaultRun.steps.map(s => s.name)).toEqual(['Setup', 'Specify', 'Develop', 'Review', 'Test']);
  expect(defaultRun.steps[4].repeat).toEqual({ mode: 'loop_back', toStepIndex: 2, max: 4 });

  // Starting with per-run disabledSteps skips the named steps for that run.
  const customRun = (await request(ctx.app).post(base + '/runs').send({
    requestId: 'custom-disabled',
    workflowId: workflow.id,
    project: 'Demo',
    input: 'feature',
    disabledSteps: ['Requirements', 'Review'],
  }).expect(201)).body;
  expect(customRun.steps.map(s => s.name)).toEqual(['Setup', 'Specify', 'Develop', 'Test']);
  expect(customRun.steps[3].repeat).toEqual({ mode: 'loop_back', toStepIndex: 2, max: 4 });

  // Refuses disabling a loop target or unknown step name.
  await request(ctx.app).post(base + '/runs').send({
    requestId: 'bad-loop-disabled',
    workflowId: workflow.id,
    project: 'Demo',
    input: 'feature',
    disabledSteps: ['Develop'],
  }).expect(400);
  await request(ctx.app).post(base + '/runs').send({
    requestId: 'unknown-disabled',
    workflowId: workflow.id,
    project: 'Demo',
    input: 'feature',
    disabledSteps: ['Nonexistent'],
  }).expect(400);
});
