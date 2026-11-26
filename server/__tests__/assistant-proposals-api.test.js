import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { createConversationStore } from '../assistant/conversation-store.js';
import { createProposalStore } from '../assistant/proposal-store.js';
import { createProposalExecutor } from '../assistant/proposal-executor.js';
import { createSessionTokens } from '../assistant/session-tokens.js';
import { createAssistantRouter } from '../routes/assistant.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TASK_ID = '22222222-2222-4222-8222-222222222222';
const WORKTREE_ID = '44444444-4444-4444-8444-444444444444';

const dbs = [];
const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise(resolve => server.close(resolve));
  }
  dbs.splice(0).forEach(db => db.close());
});

async function setup({ landingImpl, taskServiceImpl, startRunImpl } = {}) {
  const db = new Database(':memory:');
  dbs.push(db);
  const store = createConversationStore(db);
  const proposalStore = createProposalStore(db);
  const sessionTokens = createSessionTokens();
  const tasks = new Map([
    [TASK_ID, { id: TASK_ID, project: 'Demo', state: 'active', worktrees: [{ id: WORKTREE_ID, repository: 'backend', state: 'active' }] }],
    [OTHER_TASK_ID, { id: OTHER_TASK_ID, project: 'Other', state: 'active', worktrees: [] }],
  ]);
  const taskStore = { get: id => tasks.get(id) ?? null };
  const landing = landingImpl ?? {
    commit: vi.fn(async () => ({ commitsAhead: 1 })),
    merge: vi.fn(async () => ({ mergedInto: 'main' })),
    pullRequest: vi.fn(async () => ({ prUrl: 'https://github.com/org/repo/pull/1' })),
    close: vi.fn(async () => ({ taskFinished: true })),
    closeWorktree: vi.fn(async () => ({ taskFinished: false })),
  };
  const taskService = taskServiceImpl ?? {
    create: vi.fn(async ({ title }) => ({ id: TASK_ID, title })),
  };
  const startRun = startRunImpl ?? vi.fn(async body => ({ id: 'run-1', requestId: body.requestId }));
  const proposalExecutor = createProposalExecutor({ proposalStore, landing, taskService, startRun, logger: { info: () => {}, warn: () => {}, error: () => {} } });

  const pushedProposals = [];
  const pushedSituations = [];
  const compose = vi.fn(async project => ({ project, generatedAt: new Date().toISOString(), flags: [{ code: 'merge_blocked', message: 'Blocked', where: {} }], markdown: '# Demo' }));
  const findProject = name => {
    if (name === 'Demo') return { name: 'Demo', path: '/tmp/demo', host: 'local' };
    if (name === 'Remote') return { name: 'Remote', path: '/tmp/remote', host: 'ssh-box' };
    return null;
  };

  const app = express();
  app.use(createAssistantRouter({
    compose,
    store,
    proposalStore,
    proposalExecutor,
    findProject,
    sessionTokens,
    taskStore,
    landing,
    onProposal: (project, proposal) => pushedProposals.push({ project, proposal }),
    onSituationFlags: (project, flags) => pushedSituations.push({ project, flags }),
  }));

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const conversation = store.current('Demo');
  const token = sessionTokens.issue({ project: 'Demo', conversationId: conversation.id }).token;

  return { db, store, proposalStore, sessionTokens, landing, taskService, startRun, compose, pushedProposals, pushedSituations, baseUrl, conversation, token };
}

describe('assistant proposals API (six dimensions)', () => {
  it('happy: creates, lists, gets, approves, and declines proposals, pushing socket events', async () => {
    const h = await setup();
    const createRes = await fetch(`${h.baseUrl}/api/assistant/sessions/${h.token}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'commit',
        payload: { taskId: TASK_ID, worktreeId: WORKTREE_ID, message: 'wip: checkpoint' },
        summary: 'Commit changes in task',
        reason: 'Protect uncommitted work.',
      }),
    });
    expect(createRes.status).toBe(201);
    expect(createRes.headers.get('x-trace-id')).toBeTruthy();
    const created = await createRes.json();
    expect(created).toMatchObject({ kind: 'commit', state: 'pending', project: 'Demo', conversationId: h.conversation.id });
    expect(h.pushedProposals).toHaveLength(1);

    const listRes = await fetch(`${h.baseUrl}/api/assistant/proposals?project=Demo&conversationId=${h.conversation.id}&state=pending`);
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].id).toBe(created.id);

    const getRes = await fetch(`${h.baseUrl}/api/assistant/proposals/${created.id}`);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).id).toBe(created.id);

    const approveRes = await fetch(`${h.baseUrl}/api/assistant/proposals/${created.id}/approve`, { method: 'POST' });
    expect(approveRes.status).toBe(200);
    const approved = await approveRes.json();
    expect(approved.state).toBe('done');
    expect(h.landing.commit).toHaveBeenCalledTimes(1);
    expect(h.pushedProposals).toHaveLength(2);
    expect(h.pushedSituations).toHaveLength(1);

    // Second proposal: decline never calls service
    const secondRes = await fetch(`${h.baseUrl}/api/assistant/sessions/${h.token}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'merge',
        payload: { taskId: TASK_ID },
        summary: 'Merge task',
        reason: 'Ready.',
      }),
    });
    const second = await secondRes.json();
    const declineRes = await fetch(`${h.baseUrl}/api/assistant/proposals/${second.id}/decline`, { method: 'POST' });
    expect(declineRes.status).toBe(200);
    expect((await declineRes.json()).state).toBe('declined');
    expect(h.landing.merge).not.toHaveBeenCalled();
  });

  it('sad: enforces auth, validation, 10-pending limit, refusal 409, and expiry on new conversation', async () => {
    const h = await setup({
      landingImpl: {
        commit: vi.fn(),
        merge: vi.fn(async () => {
          throw Object.assign(new Error('Main has uncommitted changes.'), {
            status: 409,
            extra: { reasons: [{ code: 'main_dirty', message: 'Main has uncommitted changes.' }] },
          });
        }),
        pullRequest: vi.fn(),
        close: vi.fn(),
        closeWorktree: vi.fn(),
      },
    });

    // Wrong token -> 401
    const unauth = await fetch(`${h.baseUrl}/api/assistant/sessions/${'a'.repeat(64)}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'merge', payload: { taskId: TASK_ID }, summary: 'Merge', reason: 'Ready.' }),
    });
    expect(unauth.status).toBe(401);
    expect((await unauth.json()).traceId).toBeTruthy();

    // Another project's task + deleteIgnored -> 400 with field errors
    const badTask = await fetch(`${h.baseUrl}/api/assistant/sessions/${h.token}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'close', payload: { taskId: OTHER_TASK_ID, deleteIgnored: true }, summary: 'Close', reason: 'Done.' }),
    });
    expect(badTask.status).toBe(400);
    const badBody = await badTask.json();
    expect(badBody.errors.map(e => e.field)).toEqual(expect.arrayContaining(['payload.taskId', 'payload.deleteIgnored']));

    // 10 pending allowed, 11th -> 409
    let firstId;
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`${h.baseUrl}/api/assistant/sessions/${h.token}/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'merge', payload: { taskId: TASK_ID }, summary: `Merge ${i}`, reason: 'Ready.' }),
      });
      expect(res.status).toBe(201);
      if (i === 0) firstId = (await res.json()).id;
    }
    const eleventh = await fetch(`${h.baseUrl}/api/assistant/sessions/${h.token}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'merge', payload: { taskId: TASK_ID }, summary: 'Merge 11', reason: 'Too many.' }),
    });
    expect(eleventh.status).toBe(409);

    // Service refusal -> 409 with reasons
    const refused = await fetch(`${h.baseUrl}/api/assistant/proposals/${firstId}/approve`, { method: 'POST' });
    expect(refused.status).toBe(409);
    const refusedBody = await refused.json();
    expect(refusedBody.reasons).toEqual([expect.objectContaining({ code: 'main_dirty' })]);
    expect(refusedBody.proposal.state).toBe('failed');

    // Starting a new conversation expires remaining 9 pending proposals and revokes the old session token
    const newConvRes = await fetch(`${h.baseUrl}/api/assistant/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Demo' }),
    });
    expect(newConvRes.status).toBe(201);
    const expiredList = await (await fetch(`${h.baseUrl}/api/assistant/proposals?project=Demo&conversationId=${h.conversation.id}&state=expired`)).json();
    expect(expiredList.data).toHaveLength(9);
    expect(h.sessionTokens.verify(h.token)).toBeNull();
  });

  it('boundary, empty/null, and fuzzing: paging, unknown fields, malformed JSON, body limits, unknown/remote projects', async () => {
    const h = await setup();

    // Empty list
    const empty = await fetch(`${h.baseUrl}/api/assistant/proposals?project=Demo`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      data: [],
      page: { currentPage: 0, size: 20, totalElements: 0, totalPages: 0, hasNextPage: false },
    });

    // Missing project -> 400, unknown project -> 404, remote project -> 409
    expect((await fetch(`${h.baseUrl}/api/assistant/proposals`)).status).toBe(400);
    expect((await fetch(`${h.baseUrl}/api/assistant/proposals?project=Missing`)).status).toBe(404);
    expect((await fetch(`${h.baseUrl}/api/assistant/proposals?project=Remote`)).status).toBe(409);

    // Paging bounds and invalid filters
    expect((await fetch(`${h.baseUrl}/api/assistant/proposals?project=Demo&size=101`)).status).toBe(400);
    expect((await fetch(`${h.baseUrl}/api/assistant/proposals?project=Demo&state=bogus`)).status).toBe(400);
    expect((await fetch(`${h.baseUrl}/api/assistant/proposals?project=Demo&extra=1`)).status).toBe(400);
    expect((await fetch(`${h.baseUrl}/api/assistant/proposals/not-a-uuid`)).status).toBe(400);
    expect((await fetch(`${h.baseUrl}/api/assistant/proposals/99999999-9999-4999-8999-999999999999`)).status).toBe(404);

    // Malformed JSON and oversized body
    const malformed = await fetch(`${h.baseUrl}/api/assistant/sessions/${h.token}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${h.baseUrl}/api/assistant/sessions/${h.token}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'merge', payload: { taskId: TASK_ID }, summary: 'x', reason: 'a'.repeat(20_000) }),
    });
    expect(oversized.status).toBe(413);

    // Non-empty body on approve -> 400
    const created = await (await fetch(`${h.baseUrl}/api/assistant/sessions/${h.token}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'merge', payload: { taskId: TASK_ID }, summary: 'Merge', reason: 'Ready.' }),
    })).json();
    const badApprove = await fetch(`${h.baseUrl}/api/assistant/proposals/${created.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(badApprove.status).toBe(400);
  });

  it('concurrency: two concurrent approves return one 200 and one 409 and call the service once', async () => {
    const mergeSpy = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return { mergedInto: 'main' };
    });
    const h = await setup({
      landingImpl: { commit: vi.fn(), merge: mergeSpy, pullRequest: vi.fn(), close: vi.fn(), closeWorktree: vi.fn() },
    });
    const created = await (await fetch(`${h.baseUrl}/api/assistant/sessions/${h.token}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'merge', payload: { taskId: TASK_ID }, summary: 'Merge', reason: 'Ready.' }),
    })).json();

    const [r1, r2] = await Promise.all([
      fetch(`${h.baseUrl}/api/assistant/proposals/${created.id}/approve`, { method: 'POST' }),
      fetch(`${h.baseUrl}/api/assistant/proposals/${created.id}/approve`, { method: 'POST' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(mergeSpy).toHaveBeenCalledTimes(1);
  });
});
