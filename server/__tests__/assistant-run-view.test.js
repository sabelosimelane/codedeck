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
      runStore: { list: () => [] }, taskStore: {}, workflowStore: { get: () => ({ progressFile: 'docs/todo.md' }) },
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

  it('gives an open run the terminals of the runs it replaced in its worktree, which it did not take over', async () => {
    const step = (sessionId, priorSessionIds = []) => ({ status: 'complete', sessionId, priorSessionIds, attempt: 1, iteration: 1, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 });
    const defStep = name => ({ kind: 'node', name, role: null, askOwner: false, readOnly: false, approval: false, agent: { id: 'a', name: 'A' }, repeat: { mode: 'once' } });
    const base = { host: 'local', project: 'Demo', workflowId: 'w1', currentStepIndex: 0, input: '', attachments: [], inputRequest: null, worktreePath: '/wt/task',
      definition: { workflowName: 'W', steps: [defStep('Develop'), defStep('Review')], progressFile: null, notesDir: null } };
    const replaced = { ...base, id: 'r1', status: 'complete', worktreeState: 'released', createdAt: '2026-01-01T00:00:00.000Z', steps: [step('Demo-14', ['Demo-11']), step('Demo-15', ['Demo-12'])] };
    const elsewhere = { ...base, id: 'r0', status: 'complete', worktreeState: 'released', worktreePath: '/wt/other', createdAt: '2025-12-01T00:00:00.000Z', steps: [step('Demo-2'), step('Demo-3')] };
    const current = { ...base, id: 'r2', status: 'error', worktreeState: 'external', createdAt: '2026-01-02T00:00:00.000Z', steps: [step('Demo-33'), step('Demo-14')] };
    const builder = createRunViewBuilder({
      runStore: { list: () => [elsewhere, replaced, current] }, taskStore: { get: () => null }, workflowStore: { get: () => null },
      decisionStore: { count: () => 0 }, noteStore: { latestByStep: () => new Map() },
      progressReader: { read: async () => null, worktreeExists: async () => true },
    });

    expect((await builder(current)).inheritedSessionIds).toEqual(['Demo-11', 'Demo-15', 'Demo-12']);
    expect((await builder(replaced)).inheritedSessionIds).toEqual([]);
  });
});
