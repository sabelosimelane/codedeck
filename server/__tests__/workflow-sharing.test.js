import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
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
import { buildPackage, validatePackage } from '../../shared/workflow-package.mjs';
import { loopbackTestServer } from './helpers/loopback-test-server.js';

const base = '/api/pipelines';
const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });

const AGENT_ID = 'c410a1b2-3456-4789-8abc-def012345678';

async function setup() {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  const agentStore = createAgentStore(db);
  const roleStore = createRoleStore(db);
  roleStore.ensureRole('Developer');
  const workflowStore = createWorkflowStore(db);
  const stores = {
    db,
    agentStore,
    roleStore,
    workflowStore,
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
  const taskService = {
    plan: vi.fn(async () => { throw new Error('no planning here'); }),
    createPlanned: vi.fn(async () => { throw new Error('no planning here'); }),
  };
  const engine = { start: vi.fn(async () => {}) };
  const app = express();
  app.use(createPipelinesRouter({
    ...stores,
    taskService,
    findProject: () => null,
    engine,
    closeRunTerminals: vi.fn(async () => ({ closed: [], notClosed: [] })),
    preflight: vi.fn(async () => ({ eligible: true, reasons: [], branch: 'main', head: 'a'.repeat(40), dirty: false })),
    planNames: vi.fn(({ runId }) => ({ shortId: 'abc', slug: 'w', homeRepoPath: '/tmp', worktreePath: `/tmp/wt-${runId}`, branch: 'b' })),
    resolveHomeRepoPath: vi.fn(async () => '/tmp'),
    scheduleStart: () => {},
  }));
  return { app: await loopbackTestServer(app), ...stores };
}

function agentBody() {
  return { name: 'codex', launchCommand: 'codex --model gpt-5', resetCommand: '/clear' };
}

function storedWorkflow(ctx, overrides = {}) {
  return ctx.workflowStore.create({
    name: 'Bug fix',
    description: 'Investigate and fix.',
    kind: 'bugfix',
    agentsDecide: false,
    progressFile: null,
    nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: true, approval: false, askOwner: false }],
    ...overrides,
  });
}

describe('workflow export', () => {
  it('exports a stored workflow as a package file with its slug name', async () => {
    const ctx = await setup();
    const workflow = storedWorkflow(ctx);
    const res = await request(ctx.app).get(`${base}/workflows/${workflow.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="bug-fix.codedeck-workflow.json"');
    expect(validatePackage(res.body)).toEqual([]);
    expect(res.body.source).toMatchObject({ id: workflow.id, version: workflow.revision });
    expect(res.body.workflow.nodes.every(node => !('agentId' in node))).toBe(true);
    expect(res.body.workflow).toMatchObject({ name: 'Bug fix', kind: 'bugfix' });
  });

  it('404s an unknown workflow', async () => {
    const ctx = await setup();
    expect((await request(ctx.app).get(`${base}/workflows/${randomUUID()}/export`)).status).toBe(404);
  });
});

describe('workflow source view', () => {
  it('appears in list, get, create and update responses; bodies refuse source', async () => {
    const ctx = await setup();
    const fields = {
      name: 'Bug fix', agentsDecide: false,
      nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' } }],
    };
    const created = await request(ctx.app).post(`${base}/workflows`).send(fields);
    expect(created.status).toBe(201);
    expect(created.body.source).toMatchObject({ kind: 'local', id: null, version: null });
    expect(created.body.source).toHaveProperty('updatedToVersionAt', null);
    const list = await request(ctx.app).get(`${base}/workflows`);
    expect(list.body.data.at(0).source).toMatchObject({ kind: 'local' });
    const one = await request(ctx.app).get(`${base}/workflows/${created.body.id}`);
    expect(one.body.source).toMatchObject({ kind: 'local' });
    const updated = await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...fields, revision: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.source).toMatchObject({ kind: 'local' });

    const refusedPost = await request(ctx.app).post(`${base}/workflows`).send({ ...fields, source: { kind: 'local' } });
    expect(refusedPost.status).toBe(400);
    expect(refusedPost.body.errors.map(e => e.field)).toContain('source');
    const refusedPut = await request(ctx.app).put(`${base}/workflows/${created.body.id}`).send({ ...fields, revision: 2, source: { kind: 'local' } });
    expect(refusedPut.status).toBe(400);
    expect(refusedPut.body.errors.map(e => e.field)).toContain('source');
  });
});

describe('workflow imports', () => {
  // One install exports; another imports. Each setup is its own database.
  async function exportedPackage(overrides = {}) {
    const ctx = await setup();
    const workflow = storedWorkflow(ctx, overrides);
    const res = await request(ctx.app).get(`${base}/workflows/${workflow.id}/export`);
    expect(res.status).toBe(200);
    return res.body;
  }

  it('previews a new file and imports it as an imported workflow with team-assigned agents', async () => {
    const ctx = await setup();
    const pkg = await exportedPackage();
    const preview = await request(ctx.app).post(`${base}/workflow-imports/previews`).send({ package: pkg });
    expect(preview.status).toBe(200);
    expect(preview.body.target).toMatchObject({ mode: 'new' });
    expect(preview.body.workflow).toEqual(pkg.workflow);
    expect(preview.body.changes).toEqual([]);
    expect(preview.body.missingRoles).toEqual(['Developer']);

    const agent = ctx.agentStore.create(agentBody());
    ctx.teamStore.create({ name: 'Team', members: [{ role: 'Developer', agentId: agent.id }] });
    const previewCovered = await request(ctx.app).post(`${base}/workflow-imports/previews`).send({ package: pkg });
    expect(previewCovered.body.missingRoles).toEqual([]);

    const applied = await request(ctx.app).post(`${base}/workflow-imports`).send({ package: pkg, target: { mode: 'new' } });
    expect(applied.status).toBe(201);
    expect(applied.body.source).toMatchObject({ kind: 'imported', id: pkg.source.id, version: pkg.source.version });
    expect(applied.body.nodes.at(0)).toMatchObject({ role: 'Developer' });
    expect(applied.body.nodes.at(0)).not.toHaveProperty('agentId');
    expect(applied.body.revision).toBe(1);
  });

  it('offers a copy with another name on a clash', async () => {
    const ctx = await setup();
    const pkg = await exportedPackage();
    // The target install already has its own workflow with the same name.
    storedWorkflow(ctx);
    const preview = await request(ctx.app).post(`${base}/workflow-imports/previews`).send({ package: pkg });
    expect(preview.status).toBe(200);
    expect(preview.body.target.mode).toBe('name-clash');
    expect(preview.body.target.workflowId).toBeDefined();
    const suggested = preview.body.target.suggestedName;
    expect(typeof suggested).toBe('string');
    expect(suggested).not.toBe(pkg.workflow.name);

    const copy = await request(ctx.app).post(`${base}/workflow-imports`).send({ package: pkg, target: { mode: 'new', name: suggested } });
    expect(copy.status).toBe(201);
    expect(copy.body.name).toBe(suggested);
    expect(copy.body.source).toMatchObject({ kind: 'imported' });
  });

  it('409s a nameless copy onto a clash and a second import of the same source', async () => {
    const ctx = await setup();
    const pkg = await exportedPackage();
    storedWorkflow(ctx);
    const clash = await request(ctx.app).post(`${base}/workflow-imports`).send({ package: pkg, target: { mode: 'new' } });
    expect(clash.status).toBe(409);
    const other = await exportedPackage({ name: 'Other' });
    const first = await request(ctx.app).post(`${base}/workflow-imports`).send({ package: other, target: { mode: 'new', name: 'Other copy' } });
    expect(first.status).toBe(201);
    const second = await request(ctx.app).post(`${base}/workflow-imports`).send({ package: other, target: { mode: 'new', name: 'Other copy 2' } });
    expect(second.status).toBe(409);
  });

  it('reports every package field error at once, and 413s a body over 512 KiB', async () => {
    const ctx = await setup();
    const bad = {
      format: 'wrong', formatVersion: 99, source: { id: 'nope' }, exportedAt: 'never',
      bogus: true,
      workflow: { name: '', nodes: [{ name: 'Only', prompt: '', repeat: { mode: 'once' } }] },
    };
    const preview = await request(ctx.app).post(`${base}/workflow-imports/previews`).send({ package: bad });
    expect(preview.status).toBe(400);
    const fields = preview.body.errors.map(error => error.field);
    for (const wanted of ['package.format', 'package.source.id', 'package.source.version', 'package.exportedAt', 'package.bogus']) {
      expect(fields).toContain(wanted);
    }
    expect(fields.some(field => field.startsWith('package.workflow.'))).toBe(true);

    const big = { package: { ...(await exportedPackage()), padding: 'x'.repeat(600 * 1024) } };
    const tooLarge = await request(ctx.app).post(`${base}/workflow-imports/previews`).send(big);
    expect(tooLarge.status).toBe(413);
  });

  it('imports the same file twice concurrently exactly once', async () => {
    const ctx = await setup();
    const pkg = await exportedPackage({ name: 'Shipped' });
    const fresh = { ...pkg, source: { id: randomUUID(), version: 1 } };
    const [first, second] = await Promise.all([
      request(ctx.app).post(`${base}/workflow-imports`).send({ package: fresh, target: { mode: 'new', name: 'Shipped A' } }),
      request(ctx.app).post(`${base}/workflow-imports`).send({ package: fresh, target: { mode: 'new', name: 'Shipped B' } }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
  });

  it('previews up-to-date, update and older-file refusals for a linked import', async () => {
    const ctx = await setup();
    const exported = await exportedPackage({ name: 'Linked' });
    // Import at version 2 so an older file (version 1) is a distinct refusal from up-to-date.
    const pkg = { ...exported, source: { ...exported.source, version: 2 } };
    const imported = await request(ctx.app).post(`${base}/workflow-imports`).send({ package: pkg, target: { mode: 'new' } });
    expect(imported.status).toBe(201);

    const same = await request(ctx.app).post(`${base}/workflow-imports/previews`).send({ package: pkg });
    expect(same.status).toBe(200);
    expect(same.body.target).toEqual({ mode: 'up-to-date', workflowId: imported.body.id });

    const newer = { ...pkg, source: { ...pkg.source, version: 3 } };
    const update = await request(ctx.app).post(`${base}/workflow-imports/previews`).send({ package: newer });
    expect(update.status).toBe(200);
    expect(update.body.target).toMatchObject({
      mode: 'update',
      workflowId: imported.body.id,
      revision: imported.body.revision,
      fromVersion: 2,
    });

    const older = { ...pkg, source: { ...pkg.source, version: 1 } };
    const refusedOlder = await request(ctx.app).post(`${base}/workflow-imports/previews`).send({ package: older });
    expect(refusedOlder.status).toBe(409);
    expect(refusedOlder.body.message).toMatch(/already took version/);

    // Same version with a different definition is also refused.
    const different = {
      ...pkg,
      workflow: { ...pkg.workflow, description: 'Changed on the source install.' },
    };
    const refusedSame = await request(ctx.app).post(`${base}/workflow-imports/previews`).send({ package: different });
    expect(refusedSame.status).toBe(409);
    expect(refusedSame.body.message).toMatch(/already took version/);
  });

  it('refuses malformed targets with a 400 naming target.mode', async () => {
    const ctx = await setup();
    const pkg = await exportedPackage();
    for (const target of [{}, { mode: 'typo' }, { mode: 7 }, { mode: 'new', bogus: 1 }]) {
      const res = await request(ctx.app).post(`${base}/workflow-imports`).send({ package: pkg, target });
      expect(res.status).toBe(400);
      expect(res.body.errors.map(error => error.field)).toContain(target.bogus !== undefined ? 'target.bogus' : 'target.mode');
    }
  });

  it('409s Spec-shaped replace and update applies until Phase 3, and refuses unknown body keys', async () => {
    const ctx = await setup();
    const pkg = await exportedPackage();
    const existing = storedWorkflow(ctx);
    for (const target of [
      { mode: 'replace', workflowId: existing.id, revision: existing.revision, take: [] },
      { mode: 'update', workflowId: existing.id, revision: existing.revision, take: [] },
      { mode: 'replace' },
      { mode: 'update' },
    ]) {
      const res = await request(ctx.app).post(`${base}/workflow-imports`).send({ package: pkg, target });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/not offered in this release/i);
    }
    const unknown = await request(ctx.app).post(`${base}/workflow-imports`).send({ package: pkg, target: { mode: 'new' }, extra: 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors.map(error => error.field)).toContain('extra');
  });

  it('logs one refusal with the route and field names, never values', async () => {
    const ctx = await setup();
    const warned = [];
    const original = console.warn;
    console.warn = (...args) => { warned.push(args.map(String).join(' ')); };
    try {
      const bad = {
        format: 'wrong', formatVersion: 99, source: { id: 'nope' }, exportedAt: 'never',
        extra: 's3cr3t-value',
        workflow: { name: '', nodes: [{ name: 'Only', prompt: '', repeat: { mode: 'once' } }] },
      };
      const res = await request(ctx.app).post(`${base}/workflow-imports/previews`).send({ package: bad });
      expect(res.status).toBe(400);
      const fields = res.body.errors.map(error => error.field);
      expect(warned).toHaveLength(1);
      const [line] = warned;
      expect(line).toMatch(/workflow-imports\/previews/);
      for (const field of fields) expect(line).toContain(field);
      expect(line).not.toContain('s3cr3t-value');
    } finally {
      console.warn = original;
    }
  });

  it('suggests a free copy name when "<name> (imported)" is already taken', async () => {
    const ctx = await setup();
    const pkg = await exportedPackage({ name: 'Bug fix' });
    const existing = storedWorkflow(ctx);
    ctx.workflowStore.create({
      name: 'Bug fix (imported)',
      description: '',
      kind: 'other',
      agentsDecide: false,
      progressFile: null,
      nodes: existing.nodes.map(node => ({ ...node })),
    });
    const preview = await request(ctx.app).post(`${base}/workflow-imports/previews`).send({ package: pkg });
    expect(preview.status).toBe(200);
    expect(preview.body.target.mode).toBe('name-clash');
    expect(preview.body.target.suggestedName).toBe('Bug fix (imported) 2');
  });
});
