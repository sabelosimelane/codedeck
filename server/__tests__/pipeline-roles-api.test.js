import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { createSettingsStore } from '../pipelines/settings-store.js';
import { createRunStore } from '../pipelines/run-store.js';
import { createRequestStore } from '../pipelines/request-store.js';
import { createTaskStore } from '../tasks/task-store.js';
import { createReviewStore } from '../pipelines/review-store.js';
import { createAnswerStore } from '../pipelines/answer-store.js';
import { createRoleStore, createTeamStore, createTemplateStore, createStepPresetStore } from '../pipelines/library-store.js';
import { createDecisionStore } from '../pipelines/decision-store.js';
import { createNoteStore } from '../pipelines/note-store.js';
import { createPipelinesRouter } from '../routes/pipelines.js';
import { BUILT_IN_ROLES } from '../../shared/workflow-templates.mjs';
import { loopbackTestServer } from './helpers/loopback-test-server.js';

const base = '/api/pipelines';
const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });

const HEAD = 'a'.repeat(40);
const PROJECT = { name: 'demo', path: '/tmp/demo' };

async function setup() {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  const roleStore = createRoleStore(db);
  for (const role of BUILT_IN_ROLES) roleStore.ensureRole(role.name, role.description);
  const agentStore = createAgentStore(db);
  const workflowStore = createWorkflowStore(db);
  const teamStore = createTeamStore(db);
  const templateStore = createTemplateStore(db);
  const stepPresetStore = createStepPresetStore(db);
  const settingsStore = createSettingsStore(db);
  const runStore = createRunStore(db);
  const taskStore = createTaskStore(db);
  const app = express();
  app.use(createPipelinesRouter({
    db,
    agentStore,
    roleStore,
    workflowStore,
    teamStore,
    templateStore,
    stepPresetStore,
    settingsStore,
    runStore,
    requestStore: createRequestStore(db),
    decisionStore: createDecisionStore(db),
    noteStore: createNoteStore(db),
    reviewStore: createReviewStore(db),
    answerStore: createAnswerStore(db),
    taskStore,
    taskService: {
      plan: vi.fn(async () => ({
        id: '7a000000-0000-4000-8000-000000000001',
        project: 'demo',
        projectPath: '/tmp/demo',
        title: 'Task',
        titleSource: 'input',
        folder: null,
        homePath: '/tmp/demo',
        worktreePath: '/tmp/wt-1',
        branch: 'workflow/t1',
        baseBranch: 'main',
        worktrees: [{ repository: 'demo', repositoryPath: null, checkoutPath: '/tmp/demo', homePath: '/tmp/demo', worktreePath: '/tmp/wt-1', branch: 'workflow/t1', baseBranch: 'main' }],
      })),
      createPlanned: vi.fn(async planned => taskStore.create({
        id: planned.id,
        project: planned.project,
        title: planned.title,
        titleSource: planned.titleSource,
        worktreePath: planned.worktreePath,
        branch: planned.branch,
        baseBranch: planned.baseBranch,
        baseCommit: HEAD,
        ownRepository: 'demo',
        worktrees: [{ repository: 'demo', own: true, first: true, worktreePath: planned.worktreePath, branch: planned.branch, baseBranch: planned.baseBranch, baseCommit: HEAD, state: 'active', prUrl: null }],
      })),
    },
    findProject: name => (name === 'demo' ? PROJECT : null),
    engine: { start: vi.fn(async () => {}) },
    closeRunTerminals: vi.fn(async () => ({ closed: [], notClosed: [] })),
    preflight: vi.fn(async () => ({ eligible: true, reasons: [], branch: 'main', head: HEAD, dirty: false })),
    listWorktrees: vi.fn(async () => [{ path: '/tmp/demo', name: 'demo', branch: 'main', head: HEAD, current: true, dirty: false, missing: false }]),
    readWorktreeChanges: vi.fn(async () => ({ readable: true, dirty: false })),
    planNames: vi.fn(({ runId }) => ({ shortId: 'abc', slug: 'w', homeRepoPath: '/tmp/demo', worktreePath: `/tmp/wt-${runId}`, branch: 'b' })),
    resolveHomeRepoPath: vi.fn(async () => '/tmp/demo'),
    scheduleStart: () => {},
  }));
  return {
    app: await loopbackTestServer(app),
    db,
    roleStore,
    agentStore,
    workflowStore,
    teamStore,
    templateStore,
    stepPresetStore,
    settingsStore,
    runStore,
  };
}

describe('structured roles API, role-only workflows, and team compatibility', () => {
  it('supports Roles CRUD, cascades rename across all stores, and guards delete with 409', async () => {
    const ctx = await setup();
    const agent = ctx.agentStore.create({ name: 'Claude', launchCommand: 'claude', resetCommand: '/clear' });

    const created = await request(ctx.app).post(`${base}/roles`).send({ name: 'Architect', description: 'Designs systems' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Architect', description: 'Designs systems', revision: 1 });

    // Duplicate case-insensitively is 409
    const dup = await request(ctx.app).post(`${base}/roles`).send({ name: 'architect' });
    expect(dup.status).toBe(409);

    // Reference it in a workflow and a team (using different casing — normalized to canonical)
    const wf = await request(ctx.app).post(`${base}/workflows`).send({
      name: 'Design',
      agentsDecide: false,
      nodes: [{ name: 'Draft', role: 'architect', prompt: 'Design {input}', repeat: { mode: 'once' } }],
    });
    expect(wf.status).toBe(201);
    expect(wf.body.nodes[0].role).toBe('Architect');

    const team = await request(ctx.app).post(`${base}/teams`).send({
      name: 'Designers',
      members: [{ role: 'architect', agentId: agent.id }],
    });
    expect(team.status).toBe(201);
    expect(team.body.members[0].role).toBe('Architect');

    // Delete in use is 409
    const blocked = await request(ctx.app).delete(`${base}/roles/${created.body.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/1 workflow.*1 team/);

    // Rename cascades everywhere
    const renamed = await request(ctx.app).put(`${base}/roles/${created.body.id}`).send({
      name: 'Principal',
      description: 'Leads design',
      revision: 1,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Principal');
    expect(ctx.workflowStore.get(wf.body.id).nodes[0].role).toBe('Principal');
    expect(ctx.teamStore.get(team.body.id).members[0].role).toBe('Principal');

    // Once unused, delete succeeds
    ctx.workflowStore.remove(wf.body.id);
    ctx.teamStore.remove(team.body.id);
    const removed = await request(ctx.app).delete(`${base}/roles/${created.body.id}`);
    expect(removed.status).toBe(204);
  });

  it('rejects node.agentId and unknown roles on workflows and teams', async () => {
    const ctx = await setup();
    const agent = ctx.agentStore.create({ name: 'Claude', launchCommand: 'claude', resetCommand: '/clear' });

    const withAgent = await request(ctx.app).post(`${base}/workflows`).send({
      name: 'Legacy',
      agentsDecide: false,
      nodes: [{ name: 'Do', role: 'Developer', agentId: agent.id, prompt: 'Do it', repeat: { mode: 'once' } }],
    });
    expect(withAgent.status).toBe(400);
    expect(withAgent.body.errors.map(e => e.field)).toContain('nodes[0].agentId');

    const badRoleWf = await request(ctx.app).post(`${base}/workflows`).send({
      name: 'BadRole',
      agentsDecide: false,
      nodes: [{ name: 'Do', role: 'Nonexistent', prompt: 'Do it', repeat: { mode: 'once' } }],
    });
    expect(badRoleWf.status).toBe(400);
    expect(badRoleWf.body.errors).toContainEqual({ field: 'nodes[0].role', message: 'Choose an existing role' });

    const badRoleTeam = await request(ctx.app).post(`${base}/teams`).send({
      name: 'BadTeam',
      members: [{ role: 'Nonexistent', agentId: agent.id }],
    });
    expect(badRoleTeam.status).toBe(400);
    expect(badRoleTeam.body.errors).toContainEqual({ field: 'members[0].role', message: 'Choose an existing role' });
  });

  it('enforces team compatibility on enabled steps at run start and stopped reassignment, while allowing overrides on compatible teams', async () => {
    const ctx = await setup();
    const claude = ctx.agentStore.create({ name: 'Claude', launchCommand: 'claude', resetCommand: '/clear' });
    const codex = ctx.agentStore.create({ name: 'Codex', launchCommand: 'codex', resetCommand: '/clear' });
    ctx.settingsStore.update({ setupAgentId: claude.id, defaultBaseBranch: null, revision: 1 });

    // Add Brainstorm to spec (Thinking partner, Planner, Committer)
    const added = await request(ctx.app).post(`${base}/builtin-workflows/brainstorm-to-spec/additions`);
    expect(added.status).toBe(201);
    const workflowId = added.body.id;

    // Dev team is missing Thinking partner
    const devTeam = ctx.teamStore.create({
      name: 'Dev Team',
      members: [
        { role: 'Planner', agentId: claude.id },
        { role: 'Committer', agentId: codex.id },
      ],
    });
    // Full team covers all 3 roles
    const fullTeam = ctx.teamStore.create({
      name: 'Full Team',
      members: [
        { role: 'Thinking partner', agentId: claude.id },
        { role: 'Planner', agentId: claude.id },
        { role: 'Committer', agentId: codex.id },
      ],
    });

    // 1. Missing teamId -> 400
    const noTeam = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'req-no-team',
      workflowId,
      project: 'demo',
      input: 'idea',
      worktreePath: '/tmp/demo',
    });
    expect(noTeam.status).toBe(400);
    expect(noTeam.body.errors.map(e => e.field)).toContain('teamId');

    // 2. Incompatible team -> 400 EVEN when stepOverrides provides an agent for Brainstorm
    const incompat = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'req-incompat',
      workflowId,
      project: 'demo',
      input: 'idea',
      worktreePath: '/tmp/demo',
      teamId: devTeam.id,
      stepOverrides: { Brainstorm: claude.id },
    });
    expect(incompat.status).toBe(400);
    expect(incompat.body.errors[0]).toMatchObject({ field: 'teamId' });
    expect(incompat.body.errors[0].message).toContain('Thinking partner');

    // 3. Disabling Brainstorm makes Dev Team compatible -> 201
    const disabledStart = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'req-disabled',
      workflowId,
      project: 'demo',
      input: 'idea',
      worktreePath: '/tmp/demo',
      teamId: devTeam.id,
      disabledSteps: ['Brainstorm'],
    });
    expect(disabledStart.status).toBe(201);
    expect(disabledStart.body.steps.map(s => s.name)).toEqual(['Specify', 'Commit']);

    // Mark that run complete so worktree is free for the next run
    ctx.runStore.update(disabledStart.body.id, { status: 'complete', finishedAt: '2026-11-24T21:00:00.000Z' });

    // 4. Compatible team + per-step override -> 201
    const withOverride = await request(ctx.app).post(`${base}/runs`).send({
      requestId: 'req-override',
      workflowId,
      project: 'demo',
      input: 'idea',
      worktreePath: '/tmp/demo',
      teamId: fullTeam.id,
      stepOverrides: { Specify: codex.id },
    });
    expect(withOverride.status).toBe(201);
    expect(withOverride.body.steps.find(s => s.name === 'Specify').agentName).toBe('Codex');

    // 5. Stop run and try to reassign to incompatible Dev Team -> 400
    const stopped = ctx.runStore.update(withOverride.body.id, { status: 'stopped', stopReason: 'user', finishedAt: '2026-11-24T21:05:00.000Z' });
    const badReassign = await request(ctx.app).put(`${base}/runs/${stopped.id}/team`).send({
      expectedUpdatedAt: stopped.updatedAt,
      teamId: devTeam.id,
    });
    expect(badReassign.status).toBe(400);
    expect(badReassign.body.errors[0]).toMatchObject({ field: 'teamId' });
    expect(badReassign.body.errors[0].message).toContain('Thinking partner');
  });
});
