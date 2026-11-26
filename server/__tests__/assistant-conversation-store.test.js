import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createConversationStore, hydrateMessage } from '../assistant/conversation-store.js';

const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function setup() { const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); databases.push(db); return { db, store: createConversationStore(db) }; }

describe('assistant conversation store', () => {
  it('reports invalid paging fields as 400 with field errors', () => {
    const { store } = setup(); const id = store.current('Demo').id;
    for (const [options, field] of [[{ page: -1 }, 'page'], [{ size: 101 }, 'size'], [{ direction: 'sideways' }, 'direction']]) {
      try { store.messages(id, options); throw new Error('accepted invalid paging'); }
      catch (error) { expect(error.status).toBe(400); expect(error.errors).toContainEqual(expect.objectContaining({ field })); }
    }
  });
  it('creates one current conversation and replaces it atomically', () => {
    const { db, store } = setup();
    const first = store.current('Demo');
    expect(store.current('Demo').id).toBe(first.id);
    const second = store.startNew('Demo');
    expect(second.id).not.toBe(first.id);
    expect(store.get(first.id)).toMatchObject({ state: 'ended', endedAt: expect.any(String) });
    expect(db.prepare("SELECT count(*) n FROM assistant_conversations WHERE project='Demo' AND state='current'").get().n).toBe(1);
    expect(() => store.append(first.id, { role: 'owner', content: 'late' })).toThrow(/ended/);
  });
  it('validates all message fields and pages with an id tiebreaker', () => {
    const { store } = setup(); const id = store.current('Demo').id;
    for (const content of ['', 'x'.repeat(200001), null]) expect(() => store.append(id, { role: 'owner', content })).toThrow(/content/);
    expect(() => store.append(id, { role: 'tool', content: 'call' })).toThrow(/toolName/);
    expect(() => store.append(id, { role: 'owner', content: 'yes', toolName: 'bad' })).toThrow(/toolName/);
    store.append(id, { role: 'owner', content: 'one' }); store.append(id, { role: 'tool', content: 'two', toolName: 'Read' });
    expect(store.messages(id, { page: 0, size: 1, direction: 'asc' }).data).toMatchObject([{ content: 'one' }]);
    expect(store.messages(id, { page: 0, size: 1, direction: 'desc' }).data).toMatchObject([{ content: 'two' }]);
  });
  it.each(['id', 'project', 'state', 'created_at', 'ended_at'])('rejects corrupt conversation %s with row identity', column => {
    const { db, store } = setup(); const row = store.current('Demo');
    db.exec('PRAGMA ignore_check_constraints = ON');
    const invalid = column === 'ended_at' ? 'bad' : column === 'id' ? 'bad-id' : '';
    db.prepare(`UPDATE assistant_conversations SET ${column}=? WHERE id=?`).run(invalid, row.id);
    expect(() => column === 'id' ? store.current('Demo') : store.get(row.id)).toThrow(new RegExp(`assistant_conversations.*${column}`));
  });
  it.each(['id', 'conversation_id', 'role', 'content', 'tool_name', 'proposal_id', 'created_at'])('rejects corrupt message %s with row identity', column => {
    const { db, store } = setup(); const conversationId = store.current('Demo').id;
    const message = store.append(conversationId, { role: 'owner', content: 'safe' });
    db.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON');
    const invalid = column === 'id' ? -1 : column === 'proposal_id' ? 7 : '';
    db.prepare(`UPDATE assistant_messages SET ${column}=? WHERE id=?`).run(invalid, message.id);
    expect(() => hydrateMessage(db.prepare('SELECT * FROM assistant_messages WHERE id=?').get(column === 'id' ? -1 : message.id))).toThrow(new RegExp(`assistant_messages.*${column}`));
  });
});
