import { describe, expect, it, vi } from 'vitest';
import { buildWorktreeGroups, describeWorktreeGroup, parseSessionWorktree, resolveSessionWorktrees, selectStoredWorktrees, selectTabAfterClose } from '../worktreeGroups';

const project = { name: 'Demo', path: '/repo/demo' };
const session = (sessionId, worktreePath, startedAt) => ({ sessionId, worktreePath, startedAt });
const run = (id, path, branch, createdAt) => ({ id, project: 'Demo', status: 'running', workflowName: 'Build', worktree: { path, branch }, createdAt, progress: null, steps: [] });

describe('describeWorktreeGroup', () => {
  const main = { key: 'main', path: '/repo/demo', label: 'Main checkout', branch: null, isMain: true, run: null };
  const plain = { key: '/repo/demo-topic', path: '/repo/demo-topic', label: 'demo-topic', branch: 'feature/topic', isMain: false, run: null };
  it('describes main, a plain worktree and a run with one consistent tooltip', () => {
    expect(describeWorktreeGroup(main)).toEqual({ title: 'Main checkout', detail: null, tooltip: 'demo\n/repo/demo' });
    expect(describeWorktreeGroup(plain)).toEqual({ title: 'demo-topic', detail: null, tooltip: 'demo-topic\nfeature/topic\n/repo/demo-topic' });
    expect(describeWorktreeGroup({ ...plain, run: { id: '57f488b5-1234', workflowName: 'Medium Feature Build' } })).toEqual({ title: 'Medium Feature Build · 57f488b5', detail: null, tooltip: 'demo-topic\nfeature/topic\n/repo/demo-topic' });
  });
  it('rejects malformed fields at the edge', () => {
    expect(() => describeWorktreeGroup(null)).toThrow(/group/);
    expect(() => describeWorktreeGroup({ ...plain, path: null })).toThrow(/path/);
    expect(() => describeWorktreeGroup({ ...plain, run: { workflowName: 'Build' } })).toThrow(/run.id/);
  });
});

describe('buildWorktreeGroups', () => {
  it('places a legacy run step with its open run, while a recorded path wins', () => {
    const active = { ...run('r', '/repo/feature', 'feature', '2026-01-02'), steps: [{ name: 'Build', status: 'running', sessionId: 'Demo-1', note: null }] };
    const args = { project, sessions: [session('Demo-1', null, null)], runs: [active] };
    expect(resolveSessionWorktrees(args).get('Demo-1')).toBe('/repo/feature');
    expect(buildWorktreeGroups(args)[1].sessionIds).toEqual(['Demo-1']);
    expect(resolveSessionWorktrees({ ...args, sessions: [session('Demo-1', '/repo/recorded', null)] }).get('Demo-1')).toBe('/repo/recorded');
  });
  it('uses main for a run in the project checkout and for a session without a run', () => {
    const mainRun = { ...run('r', project.path, 'main', '2026-01-02'), steps: [{ name: 'Build', status: 'running', sessionId: 'Demo-1', note: null }] };
    expect([...resolveSessionWorktrees({ project, sessions: [session('Demo-1', null, null), session('Demo-2', null, null)], runs: [mainRun] })]).toEqual([['Demo-1', 'main'], ['Demo-2', 'main']]);
  });
  it('uses the newest open run and ignores a run for another project', () => {
    const step = { name: 'Build', status: 'running', sessionId: 'Demo-1', note: null };
    const old = { ...run('old', '/repo/old', 'old', '2026-01-01'), steps: [step] };
    const fresh = { ...run('new', '/repo/new', 'new', '2026-01-03'), steps: [step] };
    const foreign = { ...run('foreign', '/repo/foreign', 'foreign', '2026-01-04'), project: 'Other', steps: [step] };
    expect(resolveSessionWorktrees({ project, sessions: [session('Demo-1', null, null)], runs: [old, fresh, foreign] }).get('Demo-1')).toBe('/repo/new');
  });
  it('rejects invalid resolver inputs', () => {
    expect(() => resolveSessionWorktrees({ project, sessions: null, runs: [] })).toThrow('sessions');
    expect(() => resolveSessionWorktrees({ project, sessions: [session('Demo-1', undefined, null)], runs: [] })).toThrow('worktreePath');
    expect(() => resolveSessionWorktrees({ project, sessions: [], runs: [{ ...run('r', '/repo/new', 'new', '2026-01-01'), steps: [{ name: 'Build', status: 'running', sessionId: undefined, note: null }] }] })).toThrow('sessionId');
  });
  it('does not read storage for a project with only the main group', () => {
    const read = vi.fn();
    const groups = new Map([['Demo', buildWorktreeGroups({ project, sessions: [], runs: [] })]]);
    expect(selectStoredWorktrees([project], groups, {}, read)).toEqual({ Demo: 'main' });
    expect(read).not.toHaveBeenCalled();
  });
  it('prefers the nearest remaining tab in the closed tab worktree', () => {
    const tabs = [{ id: 'a', group: 'main' }, { id: 'b', group: 'work' }, { id: 'c', group: 'main' }, { id: 'd', group: 'work' }];
    expect(selectTabAfterClose(tabs, 'b', tab => tab.group)).toBe('d');
    expect(selectTabAfterClose(tabs, 'c', tab => tab.group)).toBe('a');
    expect(selectTabAfterClose(tabs, 'a', tab => tab.group)).toBe('c');
    expect(selectTabAfterClose(tabs.slice(0, 2), 'b', tab => tab.group)).toBe('a');
  });
  it('validates each session worktree field at the API edge', () => {
    expect(parseSessionWorktree({ sessionId: 'Demo-1', worktreePath: null })).toEqual({ sessionId: 'Demo-1', worktreePath: null });
    expect(() => parseSessionWorktree({ sessionId: 'Demo-1' })).toThrow('worktreePath');
    expect(() => parseSessionWorktree({ sessionId: '', worktreePath: null })).toThrow('sessionId');
    expect(() => parseSessionWorktree({ sessionId: 'Demo-1', worktreePath: 'relative' })).toThrow('worktreePath');
  });
  it('always includes an empty main checkout', () => {
    expect(buildWorktreeGroups({ project, sessions: [], runs: [] })).toEqual([
      { key: 'main', path: '/repo/demo', label: 'Main checkout', branch: null, isMain: true, sessionIds: [], run: null },
    ]);
  });

  it('groups sessions and runs by path, orders worktrees by first session then path, and picks newest run', () => {
    const groups = buildWorktreeGroups({
      project,
      sessions: [session('Demo-1', '/repo/b', '2026-01-02'), session('Demo-2', null, '2026-01-01'), session('Demo-3', '/repo/a', '2026-01-01')],
      runs: [run('old', '/repo/a', 'old', '2026-01-01'), run('new', '/repo/a', 'new', '2026-01-03'), run('main', '/repo/demo', 'main', '2026-01-02')],
    });
    expect(groups.map(group => group.key)).toEqual(['main', '/repo/a', '/repo/b']);
    expect(groups[0].sessionIds).toEqual(['Demo-2']);
    expect(groups[0].run.id).toBe('main');
    expect(groups[1].sessionIds).toEqual(['Demo-3']);
    expect(groups[1].run.id).toBe('new');
    expect(groups[1].branch).toBe('new');
  });

  it('includes a run worktree without sessions', () => {
    expect(buildWorktreeGroups({ project, sessions: [], runs: [run('r', '/repo/only', 'feature', '2026-01-01')] })[1].sessionIds).toEqual([]);
  });

  it.each([
    [{ project: null, sessions: [], runs: [] }, 'project'],
    [{ project: { name: '', path: '/repo' }, sessions: [], runs: [] }, 'name'],
    [{ project: { name: 'Demo', path: 'relative' }, sessions: [], runs: [] }, 'project.path'],
    [{ project, sessions: null, runs: [] }, 'sessions'],
    [{ project, sessions: [], runs: null }, 'runs'],
    [{ project, sessions: [session('', null, '2026-01-01')], runs: [] }, 'sessionId'],
    [{ project, sessions: [session('Demo-1', 'relative', null)], runs: [] }, 'worktreePath'],
    [{ project, sessions: [null], runs: [] }, 'session'],
    [{ project, sessions: [], runs: [run('r', 'relative', 'feature', '2026-01-01')] }, 'path'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), id: '' }] }, 'run.id'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), project: '' }] }, 'run.project'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), status: '' }] }, 'run.status'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), workflowName: '' }] }, 'run.workflowName'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), worktree: { path: '/repo/r', branch: '' } }] }, 'run.worktree.branch'],
    [{ project, sessions: [session('Demo-1', null, undefined)], runs: [] }, 'startedAt'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), createdAt: undefined }] }, 'createdAt'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), steps: null }] }, 'steps'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), progress: undefined }] }, 'progress'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), steps: [{ status: '', name: 'Build', sessionId: null, note: null }] }] }, 'step.status'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), steps: [{ status: 'running', name: '', sessionId: null, note: null }] }] }, 'step.name'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), steps: [{ status: 'running', name: 'Build', sessionId: '', note: null }] }] }, 'step.sessionId'],
    [{ project, sessions: [], runs: [{ ...run('r', '/repo/r', 'feature', '2026-01-01'), steps: [{ status: 'running', name: 'Build', sessionId: null, note: undefined }] }] }, 'step.note'],
  ])('rejects invalid edge fields', (args, field) => {
    expect(() => buildWorktreeGroups(args)).toThrow(field);
  });
});
