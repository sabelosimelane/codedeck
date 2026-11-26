import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createConversationStore } from '../assistant/conversation-store.js';
import { createProposalStore } from '../assistant/proposal-store.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const dbs = [];
afterEach(() => { dbs.splice(0).forEach(db => db.close()); });

function setup() {
  const db = new Database(':memory:');
  dbs.push(db);
  const conversations = createConversationStore(db);
  const proposals = createProposalStore(db);
  const conversation = conversations.current('Demo');
  return { db, conversations, proposals, conversation };
}

describe('proposal store', () => {
  it('creates, gets, lists, approves, finishes, declines, and expires proposals', () => {
    const { proposals, conversation } = setup();
    const created = proposals.create({
      conversationId: conversation.id,
      project: 'Demo',
      kind: 'commit',
      payload: { taskId: TASK_ID, message: 'wip: checkpoint' },
      summary: 'Commit 3 files in task',
      reason: 'Save uncommitted work before merging.',
    });
    expect(created).toMatchObject({
      conversationId: conversation.id,
      project: 'Demo',
      kind: 'commit',
      payload: { taskId: TASK_ID, message: 'wip: checkpoint' },
      state: 'pending',
      result: null,
      decidedAt: null,
      finishedAt: null,
    });
    expect(proposals.get(created.id)).toEqual(created);

    const listed = proposals.list({ project: 'Demo', conversationId: conversation.id, state: 'pending' });
    expect(listed.data).toEqual([created]);
    expect(listed.page).toEqual({ currentPage: 0, size: 20, totalElements: 1, totalPages: 1, hasNextPage: false });

    const claimed = proposals.claimApprove(created.id);
    expect(claimed.state).toBe('approved');
    expect(claimed.decidedAt).toMatch(/Z$/);
    // Second claim loses the race cleanly.
    expect(proposals.claimApprove(created.id)).toBeNull();
    expect(proposals.decline(created.id)).toBeNull();

    const finished = proposals.finish(created.id, { state: 'done', result: { commitsAhead: 1 } });
    expect(finished.state).toBe('done');
    expect(finished.result).toEqual({ commitsAhead: 1 });
    expect(finished.finishedAt).toMatch(/Z$/);

    const second = proposals.create({
      conversationId: conversation.id,
      project: 'Demo',
      kind: 'merge',
      payload: { taskId: TASK_ID },
      summary: 'Merge task',
      reason: 'Ready to land.',
    });
    const declined = proposals.decline(second.id);
    expect(declined.state).toBe('declined');
    expect(declined.decidedAt).toMatch(/Z$/);

    const third = proposals.create({
      conversationId: conversation.id,
      project: 'Demo',
      kind: 'close',
      payload: { taskId: TASK_ID },
      summary: 'Close task',
      reason: 'Work already merged.',
    });
    expect(proposals.expireForConversation(conversation.id)).toBe(1);
    expect(proposals.get(third.id).state).toBe('expired');
    expect(proposals.get(third.id).decidedAt).toMatch(/Z$/);
  });

  it('enforces the 10-pending limit per conversation', () => {
    const { proposals, conversation } = setup();
    for (let i = 0; i < 10; i += 1) {
      proposals.create({
        conversationId: conversation.id,
        project: 'Demo',
        kind: 'merge',
        payload: { taskId: TASK_ID },
        summary: `Merge ${i}`,
        reason: 'Ready.',
      });
    }
    expect(() => proposals.create({
      conversationId: conversation.id,
      project: 'Demo',
      kind: 'merge',
      payload: { taskId: TASK_ID },
      summary: 'Merge 11',
      reason: 'One too many.',
    })).toThrow(/10 pending/i);
  });

  it('fails loudly naming row id and column without leaking payload/result on corrupt rows', () => {
    const { db, proposals, conversation } = setup();
    const created = proposals.create({
      conversationId: conversation.id,
      project: 'Demo',
      kind: 'commit',
      payload: { taskId: TASK_ID, message: 'secret-commit-msg' },
      summary: 'Commit files',
      reason: 'Checkpoint.',
    });

    // Corrupt payload JSON
    db.prepare('UPDATE assistant_proposals SET payload = ? WHERE id = ?').run('{not-json-secret}', created.id);
    expect(() => proposals.get(created.id)).toThrow(new RegExp(`${created.id}.*payload`));
    try {
      proposals.get(created.id);
    } catch (error) {
      expect(error.message).not.toContain('not-json-secret');
    }

    // Corrupt payload shape for kind (missing message on commit)
    db.prepare('UPDATE assistant_proposals SET payload = ? WHERE id = ?').run(JSON.stringify({ taskId: TASK_ID, secret: 'leak' }), created.id);
    try {
      proposals.get(created.id);
      expect.unreachable('should throw');
    } catch (error) {
      expect(error.message).toContain(created.id);
      expect(error.message).toContain('payload');
      expect(error.message).not.toContain('leak');
    }

    // Restore valid payload, corrupt result on done row
    db.prepare('UPDATE assistant_proposals SET payload = ?, state = ?, decided_at = ?, finished_at = ?, result = ? WHERE id = ?')
      .run(JSON.stringify({ taskId: TASK_ID, message: 'ok' }), 'done', created.createdAt, created.createdAt, '{bad-result-secret', created.id);
    try {
      proposals.get(created.id);
      expect.unreachable('should throw');
    } catch (error) {
      expect(error.message).toContain(created.id);
      expect(error.message).toContain('result');
      expect(error.message).not.toContain('bad-result-secret');
    }

    // Corrupt state bypassing CHECK via pragma
    db.pragma('ignore_check_constraints = ON');
    db.prepare('UPDATE assistant_proposals SET state = ? WHERE id = ?').run('bogus', created.id);
    expect(() => proposals.get(created.id)).toThrow(new RegExp(`${created.id}.*state`));

    db.prepare('UPDATE assistant_proposals SET state = ?, kind = ? WHERE id = ?').run('pending', 'bogus_kind', created.id);
    expect(() => proposals.get(created.id)).toThrow(new RegExp(`${created.id}.*kind`));
  });
});
