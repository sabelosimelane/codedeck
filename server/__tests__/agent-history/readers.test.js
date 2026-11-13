import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createAgentHistory } from '../../agent-history/index.js';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function home() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-')); roots.push(dir); return dir; }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
const id = '11111111-1111-4111-8111-111111111111';
const cwd = '/repo/demo';
const make = root => createAgentHistory({ home: root, fs, Database }).readers;
describe('CLI readers', () => {
  it('reports absent stores individually', () => { const readers = make(home()); for (const reader of Object.values(readers)) expect(reader.list([cwd])).toEqual({ available: false, records: [] }); });
  it('Claude chooses custom title and first typed prompt, excludes headless and sidechain', () => {
    const root = home(); const dir = path.join(root, '.claude/projects/-repo-demo');
    const row = extra => ({ type: 'user', sessionId: id, cwd, entrypoint: 'cli', isSidechain: false, timestamp: '2026-01-01T00:00:00Z', message: { content: 'First typed prompt' }, ...extra });
    write(path.join(dir, `${id}.jsonl`), [row({ isMeta: true, message: { content: 'meta' } }), row({ promptSource: 'hook', message: { content: 'Hook wrapper' } }), row({ promptSource: 'typed' }), { type: 'ai-title', aiTitle: 'AI title', sessionId: id }, { type: 'custom-title', customTitle: 'Custom title', sessionId: id }].map(JSON.stringify).join('\n'));
    write(path.join(dir, '22222222-2222-4222-8222-222222222222.jsonl'), JSON.stringify(row({ entrypoint: 'sdk-cli' })));
    write(path.join(dir, '33333333-3333-4333-8333-333333333333.jsonl'), JSON.stringify(row({ isSidechain: true })));
    const records = make(root).claude.list([cwd]).records;
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ title: 'Custom title', firstPrompt: 'First typed prompt' });
  });
  it('Codex excludes archived and non-cli sources, uses name and first message', () => {
    const root = home(); const file = path.join(root, '.codex/state_5.sqlite'); fs.mkdirSync(path.dirname(file), { recursive: true }); const db = new Database(file);
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, name TEXT, first_user_message TEXT, updated_at_ms INTEGER, source TEXT, archived INTEGER)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run(id, cwd, 'Name', 'Prompt', 123, 'cli', 0); insert.run('2', cwd, 'Skip', 'Prompt', 123, 'exec', 0); insert.run('3', cwd, 'Skip', 'Prompt', 123, 'cli', 1); db.close();
    expect(make(root).codex.list([cwd]).records).toMatchObject([{ title: 'Name', firstPrompt: 'Prompt' }]);
  });
  it('Cursor extracts user_query and excludes subagents, false conversations and no cwd', () => {
    const root = home(); const group = path.join(root, '.cursor/chats/hash'); const meta = (uuid, fields) => write(path.join(group, uuid, 'meta.json'), JSON.stringify({ cwd, updatedAtMs: 123, hasConversation: true, ...fields }));
    meta(id, {}); meta('22222222-2222-4222-8222-222222222222', { isSubagent: true }); meta('33333333-3333-4333-8333-333333333333', { hasConversation: false }); meta('44444444-4444-4444-8444-444444444444', { cwd: null });
    write(path.join(root, `.cursor/projects/repo-demo/agent-transcripts/${id}/${id}.jsonl`), JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>Actual prompt</user_query>' }] } }));
    expect(make(root).cursor.list([cwd]).records).toMatchObject([{ firstPrompt: 'Actual prompt' }]);
  });
  it('Agy uses earliest non-command history and excludes nested rows and rows without cwd', () => {
    const root = home(); const file = path.join(root, '.gemini/antigravity-cli/conversation_summaries.db'); fs.mkdirSync(path.dirname(file), { recursive: true }); const db = new Database(file);
    db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT, last_modified_time TEXT, nesting_depth INTEGER)');
    const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)');
    insert.run(id, '', '["file:///repo/demo"]', '2026-01-01 00:00:00+00:00', 0); insert.run('2', 'Skip', '["file:///repo/demo"]', '2026-01-01 00:00:00+00:00', 1); insert.run('3', 'Skip', '', '2026-01-01 00:00:00+00:00', 0); db.close();
    write(path.join(root, '.gemini/antigravity-cli/history.jsonl'), [{ conversationId: id, display: '/help', timestamp: 1, type: 'slash_command' }, { conversationId: id, display: 'Later', timestamp: 3 }, { conversationId: id, display: 'First', timestamp: 2 }].map(JSON.stringify).join('\n'));
    expect(make(root).agy.list([cwd]).records).toMatchObject([{ title: null, firstPrompt: 'First', cwd }]);
  });
});

describe('reader field guards', () => {
  it('Codex rejects a numeric title on a matching row', () => {
    const root = home(); const file = path.join(root, '.codex/state_5.sqlite'); fs.mkdirSync(path.dirname(file), { recursive: true }); const db = new Database(file);
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, name, first_user_message TEXT, updated_at_ms INTEGER, source TEXT, archived INTEGER)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, cwd, 42, 'Prompt', 123, 'cli', 0); db.close();
    expect(() => make(root).codex.list([cwd])).toThrow(/name/);
  });
  it('Cursor rejects a numeric title on a matching meta record', () => {
    const root = home(); write(path.join(root, `.cursor/chats/hash/${id}/meta.json`), JSON.stringify({ cwd, title: 42, hasConversation: true, updatedAtMs: 123 }));
    expect(() => make(root).cursor.list([cwd])).toThrow(/title/);
  });
  it('Agy rejects a numeric title on a matching summary', () => {
    const root = home(); const file = path.join(root, '.gemini/antigravity-cli/conversation_summaries.db'); fs.mkdirSync(path.dirname(file), { recursive: true }); const db = new Database(file);
    db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT, title, workspace_uris TEXT, last_modified_time TEXT, nesting_depth INTEGER)');
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run(id, 42, '["file:///repo/demo"]', '2026-01-01 00:00:00+00:00', 0); db.close();
    write(path.join(root, '.gemini/antigravity-cli/history.jsonl'), JSON.stringify({ conversationId: id, display: 'Prompt', timestamp: 2 }));
    expect(() => make(root).agy.list([cwd])).toThrow(/title/);
  });
  it('Claude rejects a numeric AI title on a matching file', () => {
    const root = home(); const file = path.join(root, `.claude/projects/-repo-demo/${id}.jsonl`);
    write(file, [{ type: 'user', sessionId: id, cwd, entrypoint: 'cli', timestamp: '2026-01-01T00:00:00Z', message: { content: 'Prompt' } }, { type: 'ai-title', sessionId: id, aiTitle: 42 }].map(JSON.stringify).join('\n'));
    expect(() => make(root).claude.list([cwd])).toThrow(/aiTitle/);
  });
});
describe('Claude transcript being appended', () => {
  const row = extra => ({ type: 'user', sessionId: id, cwd, entrypoint: 'cli', isSidechain: false, timestamp: '2026-01-01T00:00:00Z', message: { content: 'First typed prompt' }, ...extra });
  it('ignores an unterminated final line that is still being written', () => {
    const root = home();
    write(path.join(root, `.claude/projects/-repo-demo/${id}.jsonl`), `${JSON.stringify(row())}\n{"type":"user","mess`);
    expect(make(root).claude.list([cwd]).records).toMatchObject([{ conversationId: id, firstPrompt: 'First typed prompt' }]);
  });
  it('still rejects a malformed line that was fully written', () => {
    const root = home();
    const file = path.join(root, `.claude/projects/-repo-demo/${id}.jsonl`);
    write(file, `${JSON.stringify(row())}\n{"type":"user","mess\n`);
    expect(() => make(root).claude.list([cwd])).toThrow(`${file}:2: invalid JSON`);
  });
});
