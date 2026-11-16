import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorktreeTerminal } from '../terminalWorktreesApi.js';

const valid = { sessionId: 'Demo-1', project: 'Demo', branch: 'new', worktreePath: '/tmp/worktrees/repo-new', baseCommit: 'a'.repeat(40) };
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

describe('createWorktreeTerminal', () => {
  it('POSTs project and branch and validates the response', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => valid }));
    expect(await createWorktreeTerminal({ project: 'Demo', branch: 'new' })).toEqual(valid);
    expect(global.fetch).toHaveBeenCalledWith('/api/terminal-worktrees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'Demo', branch: 'new' }) });
  });
  it('uses the server message on an HTTP error', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ message: 'Branch exists' }) }));
    await expect(createWorktreeTerminal({ project: 'Demo', branch: 'new' })).rejects.toThrow('Branch exists');
  });
  it('reports a network failure', async () => {
    global.fetch = vi.fn(async () => { throw new Error('offline'); });
    await expect(createWorktreeTerminal({ project: 'Demo', branch: 'new' })).rejects.toThrow('Server unreachable');
  });
  it.each(Object.keys(valid))('rejects a missing or invalid %s response field', async field => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ...valid, [field]: null }) }));
    await expect(createWorktreeTerminal({ project: 'Demo', branch: 'new' })).rejects.toThrow(field);
  });
});
