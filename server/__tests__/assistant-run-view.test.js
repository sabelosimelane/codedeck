import { describe, expect, it } from 'vitest';
import { createRunViewBuilder } from '../pipelines/run-view.js';

describe('createRunViewBuilder', () => {
  it('requires the stores needed to build the existing route view', () => {
    expect(() => createRunViewBuilder({})).toThrow('runStore');
  });

  it('reads a remote run\'s progress once for views asked for close together', async () => {
    // Every call below is an SSH round trip on a remote host; the runs list and task view poll every two seconds.
    const calls = [];
    const markdown = '## Phase 1: One\n- [ ] task\n';
    const fs = {
      stat: async p => { calls.push(`stat ${p}`); return { isFile: () => p.endsWith('.md'), isDirectory: () => !p.endsWith('.md'), size: Buffer.byteLength(markdown), mtimeMs: 1 }; },
      realpath: async p => { calls.push(`realpath ${p}`); return p; },
      open: async p => { calls.push(`open ${p}`); return { read: async buffer => ({ bytesRead: Buffer.from(markdown).copy(buffer) }), close: async () => {} }; },
    };
    const builder = createRunViewBuilder({
      runStore: {}, taskStore: {}, workflowStore: { get: () => ({ progressFile: 'docs/todo.md' }) },
      decisionStore: { count: () => 0 }, noteStore: { latestByStep: () => new Map() },
      progressReader: { read: async () => { throw new Error('the local reader was used for a remote run'); }, worktreeExists: async () => { throw new Error('the local reader was used for a remote run'); } },
      resolveHostTools: () => ({ fs }),
    });
    const run = {
      id: 'r1', host: 'devbox', project: 'Demo', workflowId: 'w1', status: 'running', currentStepIndex: 0, input: '', steps: [], attachments: [],
      inputRequest: null, worktreePath: '/srv/wt', worktreeState: 'present',
      definition: { workflowName: 'W', steps: [], progressFile: 'docs/todo.md', notesDir: null },
    };

    const first = await builder(run);
    const firstCalls = calls.length;
    const second = await builder(run);

    expect(first.progress).toMatchObject({ status: 'in_progress', tasksTotal: 1 });
    expect(second.progress).toEqual(first.progress);
    expect(firstCalls).toBeGreaterThan(0);
    expect(calls.length).toBe(firstCalls);
  });
});
