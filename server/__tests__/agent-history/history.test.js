import { describe, it, expect } from 'vitest';
import { buildResumeCommand } from '../../agent-history/command.js';
import { validateRecord, mergeHistory } from '../../agent-history/index.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const record = (overrides = {}) => ({ cli: 'claude', conversationId: a, title: 'Title', firstPrompt: 'Prompt', cwd: '/one', updatedAt: 100, ...overrides });

describe('agent history invariants', () => {
  it.each(['cli', 'conversationId', 'title', 'firstPrompt', 'cwd', 'updatedAt'])('rejects malformed %s with source identity', field => {
    const bad = { cli: 'wrong', conversationId: 'bad', title: 42, firstPrompt: 42, cwd: 'relative', updatedAt: 'now' }[field];
    expect(() => validateRecord(record({ [field]: bad }), 'fixture:3')).toThrow(new RegExp(`fixture:3.*${field}`));
  });
  it('allows one missing label, but rejects both', () => {
    expect(validateRecord(record({ title: null }), 'fixture')).toMatchObject({ title: null });
    expect(() => validateRecord(record({ title: null, firstPrompt: null }), 'fixture')).toThrow(/fixture.*title/);
  });
  it.each([['claude', 'claude --resume'], ['codex', 'codex resume'], ['cursor', 'agent --resume'], ['agy', 'agy --conversation']])('builds fixed %s command', (cli, prefix) => {
    expect(buildResumeCommand(cli, a)).toBe(`${prefix} ${a}`);
  });
  it.each(['bad', `${a}; echo bad`, a.toUpperCase() + '$()'])('rejects unsafe IDs', id => {
    expect(() => buildResumeCommand('claude', id)).toThrow(/conversationId/);
  });
  it('merges, scopes, filters, matches both labels and sorts across pages', () => {
    const readers = { claude: { list: () => ({ available: true, records: [record(), record({ conversationId: b, title: 'Other', firstPrompt: 'Find ME', updatedAt: 100 }), record({ cwd: '/two', updatedAt: 999 })] }) }, codex: { list: () => ({ available: false, records: [] }) } };
    const result = mergeHistory(readers, ['/one'], { q: 'find', page: 0, size: 1 });
    expect(result.data.map(x => x.conversationId)).toEqual([b]);
    expect(result.page).toMatchObject({ totalElements: 1, totalPages: 1 });
    expect(result.sources).toEqual([{ cli: 'claude', available: true }, { cli: 'codex', available: false }]);
    expect(mergeHistory(readers, ['/one'], { size: 1, page: 1 }).data[0].conversationId).toBe(b);
  });
});
