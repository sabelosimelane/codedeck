import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createConversationStore } from '../assistant/conversation-store.js';
import { createSessionTokens } from '../assistant/session-tokens.js';
import { createAssistantRouter } from '../routes/assistant.js';

const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_OTHER = '22222222-2222-4222-8222-222222222222';
const WT_A = '33333333-3333-4333-8333-333333333333';
const RUN_A1 = '44444444-4444-4444-8444-444444444444';
const RUN_A2 = '55555555-5555-4555-8555-555555555555';
const RUN_OTHER = '66666666-6666-4666-8666-666666666666';

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function expectProblem(response, status) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/problem\+json/);
  expect(response.body.traceId).toBe(response.headers['x-trace-id']);
  expect(response.body.status).toBe(status);
  expect(typeof response.body.message).toBe('string');
  expect(response.body.message.length).toBeGreaterThan(0);
}

async function setup() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-session-reads-'));
  cleanups.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

  const mainRoot = path.join(tmpDir, 'main-repo');
  const wtRoot = path.join(tmpDir, 'wt-repo');
  const outsideFile = path.join(tmpDir, 'secret.md');
  await fs.mkdir(path.join(mainRoot, 'docs', 'todos'), { recursive: true });
  await fs.mkdir(path.join(mainRoot, 'docs', 'specifications'), { recursive: true });
  await fs.mkdir(path.join(wtRoot, 'docs', 'todos'), { recursive: true });
  await fs.writeFile(path.join(mainRoot, 'docs', 'todos', 'a.md'), '# Main Todo\n');
  await fs.writeFile(path.join(mainRoot, 'docs', 'specifications', 'a-spec.md'), '# Main Spec\n');
  await fs.writeFile(path.join(wtRoot, 'docs', 'todos', 'task.md'), '# Task Todo\n');
  await fs.writeFile(path.join(mainRoot, 'docs', 'todos', 'exact-512k.md'), 'x'.repeat(512 * 1024));
  await fs.writeFile(path.join(mainRoot, 'docs', 'todos', 'over-512k.md'), 'x'.repeat(512 * 1024 + 1));
  await fs.writeFile(outsideFile, '# Secret outside repo\n');
  await fs.symlink(outsideFile, path.join(mainRoot, 'docs', 'todos', 'escape.md'));

  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const store = createConversationStore(db);
  const sessionTokens = createSessionTokens();
  const conv = store.current('Demo');
  const session = sessionTokens.issue({ project: 'Demo', conversationId: conv.id });

  const tasks = new Map([
    [TASK_A, { id: TASK_A, project: 'Demo', title: 'Demo task', state: 'active', worktrees: [{ id: WT_A, repository: 'backend', worktreePath: wtRoot }] }],
    [TASK_OTHER, { id: TASK_OTHER, project: 'Other', title: 'Other task', state: 'active', worktrees: [{ id: WT_A, repository: 'backend', worktreePath: wtRoot }] }],
  ]);

  const runs = [
    { id: RUN_A1, project: 'Demo', taskId: TASK_A, status: 'complete', createdAt: '2026-11-25T10:00:00.000Z' },
    { id: RUN_A2, project: 'Demo', taskId: null, status: 'running', createdAt: '2026-11-25T11:00:00.000Z' },
    { id: RUN_OTHER, project: 'Other', taskId: TASK_OTHER, status: 'complete', createdAt: '2026-11-25T12:00:00.000Z' },
  ];

  const app = express();
  app.use(createAssistantRouter({
    compose: async project => ({
      project,
      generatedAt: '2026-11-26T00:00:00.000Z',
      flags: [{ code: 'other_repository_dirty', message: 'Main has dirty files', where: { repository: 'backend' } }],
      markdown: `# ${project} — where things stand`,
      truncated: { dirty: false, todos: false, specifications: false },
      skipped: [],
    }),
    store,
    findProject: name => (name === 'Demo' ? { name, path: mainRoot, defaultHost: 'local' } : null),
    sessionTokens,
    repositoryService: {
      list: async project => (project === 'Demo' ? [{ name: 'backend', own: true, path: mainRoot, usable: true }] : []),
    },
    taskStore: {
      get: id => tasks.get(id) ?? null,
    },
    landing: {
      worktrees: async id => [{ worktreeId: WT_A, repository: 'backend', worktreePath: wtRoot, branch: `task/${id}`, commitsAhead: 0, uncommittedCount: 3 }],
    },
    runStore: {
      get: id => runs.find(r => r.id === id) ?? null,
      list: () => runs,
    },
    noteStore: {
      lastWritten: (runId, stepIndex) => (runId === RUN_A1 && stepIndex === 2
        ? { id: 9, runId, stepIndex, stepName: 'Test', attempt: 1, pass: 2, status: 'written', summary: 'Stopped at limit', content: '# Note body', createdAt: '2026-11-25T10:30:00.000Z' }
        : null),
    },
    runView: async run => ({ id: run.id, project: run.project, taskId: run.taskId, status: run.status, createdAt: run.createdAt }),
  }));

  return { app, session, sessionTokens };
}

describe('assistant session token read routes', () => {
  it('refuses unknown, malformed, or ended tokens with 401 RFC 9457 problems', async () => {
    const { app, session, sessionTokens } = await setup();
    for (const badToken of ['invalid', 'a'.repeat(64)]) {
      expectProblem(await request(app).get(`/api/assistant/sessions/${badToken}/situation`), 401);
      expectProblem(await request(app).get(`/api/assistant/sessions/${badToken}/tasks/${TASK_A}/landing`), 401);
      expectProblem(await request(app).get(`/api/assistant/sessions/${badToken}/todo?location=main:backend&path=docs/todos/a.md`), 401);
      expectProblem(await request(app).get(`/api/assistant/sessions/${badToken}/runs/${RUN_A1}/notes?stepIndex=2`), 401);
      expectProblem(await request(app).get(`/api/assistant/sessions/${badToken}/runs`), 401);
    }

    sessionTokens.end(session.token);
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/situation`), 401);
  });

  it('returns the project situation and rejects unknown query parameters', async () => {
    const { app, session } = await setup();
    const ok = await request(app).get(`/api/assistant/sessions/${session.token}/situation`);
    expect(ok.status).toBe(200);
    expect(ok.headers['x-trace-id']).toBeTruthy();
    expect(ok.body).toMatchObject({
      project: 'Demo',
      markdown: '# Demo — where things stand',
      flags: [expect.objectContaining({ code: 'other_repository_dirty' })],
    });

    const bad = await request(app).get(`/api/assistant/sessions/${session.token}/situation?extra=1`);
    expectProblem(bad, 400);
    expect(bad.body.errors).toContainEqual(expect.objectContaining({ field: 'extra' }));
  });

  it('returns task landing for the token project and refuses other projects or bad ids', async () => {
    const { app, session } = await setup();
    const ok = await request(app).get(`/api/assistant/sessions/${session.token}/tasks/${TASK_A}/landing`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      taskId: TASK_A,
      project: 'Demo',
      worktrees: [expect.objectContaining({ worktreeId: WT_A, uncommittedCount: 3 })],
    });

    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/tasks/${TASK_OTHER}/landing`), 404);
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/tasks/not-a-uuid/landing`), 400);
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/tasks/${TASK_A}/landing?foo=1`), 400);
  });

  it('reads todos and specs inside allowed locations and enforces path containment and 512 KiB limit', async () => {
    const { app, session } = await setup();
    const mainTodo = await request(app).get(`/api/assistant/sessions/${session.token}/todo?location=main:backend&path=docs/todos/a.md`);
    expect(mainTodo.status).toBe(200);
    expect(mainTodo.body).toMatchObject({ location: 'main:backend', path: 'docs/todos/a.md', content: '# Main Todo\n' });

    const mainSpec = await request(app).get(`/api/assistant/sessions/${session.token}/todo?location=main:backend&path=docs/specifications/a-spec.md`);
    expect(mainSpec.status).toBe(200);
    expect(mainSpec.body.content).toBe('# Main Spec\n');

    const taskTodo = await request(app).get(`/api/assistant/sessions/${session.token}/todo?location=task:${TASK_A}/${WT_A}&path=docs/todos/task.md`);
    expect(taskTodo.status).toBe(200);
    expect(taskTodo.body.content).toBe('# Task Todo\n');

    // Boundary: exact 512 KiB succeeds, 512 KiB + 1 byte is refused with 413
    const exact = await request(app).get(`/api/assistant/sessions/${session.token}/todo?location=main:backend&path=docs/todos/exact-512k.md`);
    expect(exact.status).toBe(200);
    expect(exact.body.size).toBe(512 * 1024);

    const tooLarge = await request(app).get(`/api/assistant/sessions/${session.token}/todo?location=main:backend&path=docs/todos/over-512k.md`);
    expectProblem(tooLarge, 413);

    // Path traversal, outside docs/todos|specifications, symlinks, bad locations
    for (const badPath of ['../secret.md', 'docs/todos/../secret.md', 'docs/todos/sub/a.md', 'README.md', 'docs/todos/a.txt', '', 'docs/todos/escape.md']) {
      const res = await request(app).get(`/api/assistant/sessions/${session.token}/todo`).query({ location: 'main:backend', path: badPath });
      expectProblem(res, 400);
    }

    for (const badLocation of ['', 'other:backend', 'main:', 'task:bad/w1', `task:${TASK_A}/`]) {
      const res = await request(app).get(`/api/assistant/sessions/${session.token}/todo`).query({ location: badLocation, path: 'docs/todos/a.md' });
      expectProblem(res, 400);
    }

    // Cross-project task location and unknown files -> 404
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/todo`).query({ location: `task:${TASK_OTHER}/${WT_A}`, path: 'docs/todos/task.md' }), 404);
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/todo`).query({ location: 'main:unknown', path: 'docs/todos/a.md' }), 404);
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/todo`).query({ location: 'main:backend', path: 'docs/todos/missing.md' }), 404);
  });

  it('returns the latest written run note for the project and rejects bad stepIndex or other-project runs', async () => {
    const { app, session } = await setup();
    const ok = await request(app).get(`/api/assistant/sessions/${session.token}/runs/${RUN_A1}/notes?stepIndex=2`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ runId: RUN_A1, stepIndex: 2, note: { summary: 'Stopped at limit', content: '# Note body' } });

    const none = await request(app).get(`/api/assistant/sessions/${session.token}/runs/${RUN_A1}/notes?stepIndex=0`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ runId: RUN_A1, stepIndex: 0, note: null });

    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/runs/${RUN_OTHER}/notes?stepIndex=0`), 404);
    for (const query of ['', '?stepIndex=', '?stepIndex=-1', '?stepIndex=33', '?stepIndex=abc', '?stepIndex=0&extra=1']) {
      expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/runs/${RUN_A1}/notes${query}`), 400);
    }
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/runs/not-a-uuid/notes?stepIndex=0`), 400);
  });

  it('lists paginated runs scoped to the token project with optional taskId filter and concurrent reads', async () => {
    const { app, session } = await setup();
    const all = await request(app).get(`/api/assistant/sessions/${session.token}/runs`);
    expect(all.status).toBe(200);
    expect(all.body.data.map(r => r.id)).toEqual([RUN_A2, RUN_A1]);
    expect(all.body.page).toEqual({ currentPage: 0, size: 20, totalElements: 2, totalPages: 1, hasNextPage: false });

    const filtered = await request(app).get(`/api/assistant/sessions/${session.token}/runs?taskId=${TASK_A}&size=1`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.map(r => r.id)).toEqual([RUN_A1]);
    expect(filtered.body.page).toEqual({ currentPage: 0, size: 1, totalElements: 1, totalPages: 1, hasNextPage: false });

    // Other project's taskId returns empty page (never leaks runs)
    const empty = await request(app).get(`/api/assistant/sessions/${session.token}/runs?taskId=${TASK_OTHER}`);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);

    // Boundary & validation
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/runs?size=0`), 400);
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/runs?size=101`), 400);
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/runs?taskId=not-a-uuid`), 400);
    expectProblem(await request(app).get(`/api/assistant/sessions/${session.token}/runs?unknown=1`), 400);

    // Concurrent reads
    const [r1, r2] = await Promise.all([
      request(app).get(`/api/assistant/sessions/${session.token}/runs`),
      request(app).get(`/api/assistant/sessions/${session.token}/situation`),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
