import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { builtinTemplateDefinition } from '../pipelines/workflow-store.js';
import { createSettingsStore } from '../pipelines/settings-store.js';
import { createRunStore } from '../pipelines/run-store.js';
import { createRequestStore } from '../pipelines/request-store.js';
import { createTaskStore } from '../tasks/task-store.js';
import { createReviewStore } from '../pipelines/review-store.js';
import { createAnswerStore } from '../pipelines/answer-store.js';
import { createTeamStore, createTemplateStore, createStepPresetStore } from '../pipelines/library-store.js';
import { createDecisionStore } from '../pipelines/decision-store.js';
import { createNoteStore } from '../pipelines/note-store.js';
import { createPipelinesRouter } from '../routes/pipelines.js';
import { WORKFLOW_TEMPLATES } from '../../shared/workflow-templates.mjs';
import { loopbackTestServer } from './helpers/loopback-test-server.js';

const base = '/api/pipelines';
const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });

async function setup() {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  const stores = {
    agentStore: createAgentStore(db),
    workflowStore: createWorkflowStore(db),
    settingsStore: createSettingsStore(db),
    runStore: createRunStore(db),
    requestStore: createRequestStore(db),
    decisionStore: createDecisionStore(db),
    noteStore: createNoteStore(db),
    reviewStore: createReviewStore(db),
    answerStore: createAnswerStore(db),
    teamStore: createTeamStore(db),
    templateStore: createTemplateStore(db),
    stepPresetStore: createStepPresetStore(db),
    taskStore: createTaskStore(db),
  };
  const app = express();
  app.use(createPipelinesRouter({
    ...stores,
    taskService: {
      plan: vi.fn(async () => { throw new Error('no planning here'); }),
      createPlanned: vi.fn(async () => { throw new Error('no planning here'); }),
    },
    findProject: () => null,
    engine: { start: vi.fn(async () => {}) },
    closeRunTerminals: vi.fn(async () => ({ closed: [], notClosed: [] })),
    preflight: vi.fn(async () => ({ eligible: true, reasons: [], branch: 'main', head: 'a'.repeat(40), dirty: false })),
    planNames: vi.fn(({ runId }) => ({ shortId: 'abc', slug: 'w', homeRepoPath: '/tmp', worktreePath: `/tmp/wt-${runId}`, branch: 'b' })),
    resolveHomeRepoPath: vi.fn(async () => '/tmp'),
    scheduleStart: () => {},
  }));
  return { app: await loopbackTestServer(app), ...stores };
}

const template = WORKFLOW_TEMPLATES.find(item => item.id === 'bug-fix');

function builtinBody(fromTemplate = template) {
  const definition = builtinTemplateDefinition(fromTemplate);
  return {
    ...definition,
    nodes: definition.nodes.map(node => ({ ...node, agentId: null })),
  };
}

describe('built-in source view', () => {
  it('reports latestVersion and updateAvailable for a linked built-in', async () => {
    const ctx = await setup();
    const created = ctx.workflowStore.create(builtinBody(), {
      source: { kind: 'builtin', id: 'bug-fix', version: 1, base: builtinTemplateDefinition(template), updatedAt: null },
    });
    const res = await request(ctx.app).get(`${base}/workflows/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.source).toMatchObject({
      kind: 'builtin', id: 'bug-fix', version: 1, latestVersion: template.version,
      updateAvailable: false, updatedToVersionAt: null, shipped: true,
    });
  });

  it('reports a retired built-in as no longer shipped with no update', async () => {
    const ctx = await setup();
    const created = ctx.workflowStore.create({
      name: 'Retired', description: '', kind: 'other', agentsDecide: false, progressFile: null,
      nodes: [{ name: 'Do', role: 'Maker', agentId: null, prompt: 'Do it', repeat: { mode: 'once' } }],
    }, {
      source: { kind: 'builtin', id: 'retired-thing', version: 3, base: null, updatedAt: null },
    });
    const res = await request(ctx.app).get(`${base}/workflows/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.source).toMatchObject({
      kind: 'builtin', id: 'retired-thing', version: 3, latestVersion: null,
      updateAvailable: false, updatedToVersionAt: null, shipped: false,
    });
  });
});

describe('GET /builtin-workflows', () => {
  it('lists shipped templates with linked, dismissed and new statuses, paged with a name sort and id tiebreak', async () => {
    const ctx = await setup();
    ctx.workflowStore.create(builtinBody(), {
      source: { kind: 'builtin', id: 'bug-fix', version: template.version, base: null, updatedAt: null },
    });
    ctx.workflowStore.dismissBuiltinTemplate('quick-change');
    const page1 = await request(ctx.app).get(`${base}/builtin-workflows`).query({ size: 3 });
    expect(page1.status).toBe(200);
    expect(page1.body.data.map(row => row.id)).toEqual(['brainstorm-to-spec', 'bug-fix', 'feature-build']);
    expect(page1.body.page).toMatchObject({ size: 3, totalElements: WORKFLOW_TEMPLATES.length, hasNextPage: true });
    const bugFix = page1.body.data.find(row => row.id === 'bug-fix');
    expect(bugFix).toMatchObject({ name: 'Bug fix', kind: 'bugfix', version: template.version, status: 'linked' });
    expect(bugFix.workflowId).toEqual(expect.any(String));
    expect(page1.body.data.find(row => row.id === 'brainstorm-to-spec')).toMatchObject({ status: 'new', workflowId: null });
    const onlyNew = await request(ctx.app).get(`${base}/builtin-workflows`).query({ status: 'new' });
    expect(onlyNew.status).toBe(200);
    expect(onlyNew.body.data.every(row => row.status === 'new')).toBe(true);
    expect(onlyNew.body.data.some(row => row.id === 'quick-change')).toBe(false);
    const dismissed = await request(ctx.app).get(`${base}/builtin-workflows`).query({ status: 'dismissed' });
    expect(dismissed.body.data.map(row => row.id)).toEqual(['quick-change']);
    expect((await request(ctx.app).get(`${base}/builtin-workflows`).query({ status: 'bogus' })).status).toBe(400);
    expect((await request(ctx.app).get(`${base}/builtin-workflows`).query({ sort: 'version,asc' })).status).toBe(400);
  });
});

describe('POST /builtin-workflows/:id/additions', () => {
  it('links a new built-in, 404s an unshipped id, and 409s a linked one naming the workflow', async () => {
    const ctx = await setup();
    const added = await request(ctx.app).post(`${base}/builtin-workflows/bug-fix/additions`);
    expect(added.status).toBe(201);
    expect(added.body.source).toMatchObject({ kind: 'builtin', id: 'bug-fix', version: template.version });
    expect(added.body.nodes.every(node => node.agentId === null)).toBe(true);
    expect(added.body.revision).toBe(1);
    expect((await request(ctx.app).post(`${base}/builtin-workflows/retired-thing/additions`)).status).toBe(404);
    const again = await request(ctx.app).post(`${base}/builtin-workflows/bug-fix/additions`);
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/Bug fix/);
  });

  it('lifts the dismissal when a dismissed built-in is added', async () => {
    const ctx = await setup();
    expect((await request(ctx.app).post(`${base}/builtin-workflows/quick-change/dismissals`)).status).toBe(204);
    const added = await request(ctx.app).post(`${base}/builtin-workflows/quick-change/additions`);
    expect(added.status).toBe(201);
    expect(ctx.workflowStore.builtinDismissals()).toEqual([]);
    const listed = await request(ctx.app).get(`${base}/builtin-workflows`).query({ status: 'linked' });
    expect(listed.body.data.map(row => row.id)).toContain('quick-change');
  });

  it('409s when the name is taken by an unlinked workflow', async () => {
    const ctx = await setup();
    ctx.workflowStore.create({ ...builtinBody(), name: 'Bug fix' });
    const res = await request(ctx.app).post(`${base}/builtin-workflows/bug-fix/additions`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Bug fix/);
  });
});

describe('POST /builtin-workflows/:id/dismissals', () => {
  it('dismisses a new built-in, repeats with 204, 404s an unshipped id and 409s a linked one', async () => {
    const ctx = await setup();
    expect((await request(ctx.app).post(`${base}/builtin-workflows/bug-fix/dismissals`)).status).toBe(204);
    expect((await request(ctx.app).post(`${base}/builtin-workflows/bug-fix/dismissals`)).status).toBe(204);
    expect(ctx.workflowStore.builtinDismissals().map(row => row.templateId)).toEqual(['bug-fix']);
    expect((await request(ctx.app).post(`${base}/builtin-workflows/retired-thing/dismissals`)).status).toBe(404);
    await request(ctx.app).post(`${base}/builtin-workflows/quick-change/additions`);
    expect((await request(ctx.app).post(`${base}/builtin-workflows/quick-change/dismissals`)).status).toBe(409);
  });
});
