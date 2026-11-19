import { describe, expect, it, vi } from 'vitest';
import { buildWorktreeGroups, describeWorktreeGroup, groupPlaces, parseSessionWorktree, placeForPath, repositoryLabelForPath, resolveSessionWorktrees, selectStoredWorktrees, selectTabAfterClose } from '../worktreeGroups';

const project = { name: 'Demo', path: '/repo/demo', repositories: [] };
const session = (sessionId, worktreePath, startedAt) => ({ sessionId, worktreePath, startedAt });
const run = (id, path, branch, createdAt) => ({ id, project: 'Demo', status: 'running', workflowName: 'Build', worktree: { path, branch }, createdAt, progress: null, steps: [] });

describe('describeWorktreeGroup', () => {
  const main = { key: 'main', path: '/repo/demo', label: 'Main checkout', branch: null, isMain: true, run: null };
  const plain = { key: '/repo/demo-topic', path: '/repo/demo-topic', label: 'demo-topic', branch: 'feature/topic', isMain: false, run: null };
  it('describes main, a plain worktree and a run with one consistent tooltip', () => {
    expect(describeWorktreeGroup(main)).toEqual({ title: 'Main', detail: null, tooltip: 'demo\n/repo/demo' });
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
      { key: 'main', path: '/repo/demo', label: 'Main', branch: null, isMain: true, sessionIds: [], run: null, task: null,
        repositories: [{ name: 'demo', path: '/repo/demo', own: true }], paths: ['/repo/demo'], worktrees: null },
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

describe('tasks as groups', () => {
  const task = (id, worktreePath, title, createdAt = '2026-11-18T10:00:00.000Z') => ({ id, project: 'Demo', title, state: 'active', worktreePath, branch: `task/${id}`, createdAt,
    worktrees: [{ id: `${id}-1`, repository: 'demo', first: true, worktreePath, branch: `task/${id}`, state: 'active' }] });
  it('names a group after its task and keeps the branch and folder for the tooltip only', () => {
    const group = { key: '/repo/wt-a', path: '/repo/wt-a', label: 'wt-a', branch: 'task/a', isMain: false, run: { id: '57f488b5-1234', workflowName: 'Feature build' }, task: task('a', '/repo/wt-a', 'WhatsApp replies') };
    expect(describeWorktreeGroup(group)).toEqual({ title: 'WhatsApp replies', detail: null, tooltip: 'wt-a\ntask/a\n/repo/wt-a' });
    expect(() => describeWorktreeGroup({ ...group, task: { id: 'a' } })).toThrow(/task.title/);
    expect(() => describeWorktreeGroup({ ...group, task: 'a' })).toThrow(/task/);
  });
  it('shows an open task even before it has a terminal or a run, newest task first among empty ones', () => {
    const groups = buildWorktreeGroups({ project, sessions: [session('Demo-1', '/repo/wt-b', '2026-11-18T09:00:00.000Z')], runs: [],
      tasks: [task('a', '/repo/wt-a', 'Older', '2026-11-18T08:00:00.000Z'), task('c', '/repo/wt-c', 'Newer', '2026-11-18T11:00:00.000Z'), task('b', '/repo/wt-b', 'Has terminal'), { ...task('x', '/repo/wt-x', 'Foreign'), project: 'Other' }] });
    expect(groups.map(group => [group.key, group.task?.title ?? null, group.branch])).toEqual([
      ['main', null, null], ['/repo/wt-b', 'Has terminal', 'task/b'], ['/repo/wt-c', 'Newer', 'task/c'], ['/repo/wt-a', 'Older', 'task/a'],
    ]);
  });
  it('attaches the task to the group of its run', () => {
    const active = run('r', '/repo/wt-a', 'task/a', '2026-01-02');
    const [, group] = buildWorktreeGroups({ project, sessions: [], runs: [active], tasks: [task('a', '/repo/wt-a', 'Replies')] });
    expect(group).toMatchObject({ key: '/repo/wt-a', run: { id: 'r' }, task: { id: 'a', title: 'Replies' } });
  });
  it('rejects malformed tasks', () => {
    expect(() => buildWorktreeGroups({ project, sessions: [], runs: [], tasks: 'x' })).toThrow(/tasks/);
    expect(() => buildWorktreeGroups({ project, sessions: [], runs: [], tasks: [{ ...task('a', '/repo/wt-a', 'T'), worktreePath: 'relative' }] })).toThrow(/task.worktreePath/);
    expect(() => buildWorktreeGroups({ project, sessions: [], runs: [], tasks: [{ ...task('a', '/repo/wt-a', '') }] })).toThrow(/task.title/);
    expect(() => buildWorktreeGroups({ project, sessions: [], runs: [], tasks: [{ ...task('a', '/repo/wt-a', 'T'), createdAt: '' }] })).toThrow(/task.createdAt/);
  });
});

describe('a project and a task with several repositories', () => {
  const group = { name: 'Demo', path: '/group/backend', repositories: [{ name: 'mobile-app', path: '/group/mobile-app' }, { name: 'frontend', path: '/group/worktrees/frontend-main' }] };
  const FOLDER = '/group/worktrees/replies-7a000000';
  const worktree = (repository, first, state = 'active') => ({ id: `wt-${repository}`, repository, first, worktreePath: `${FOLDER}/${repository}`, branch: 'task/replies-7a000000', state });
  const task = { id: 'a', project: 'Demo', title: 'Replies', state: 'active', worktreePath: `${FOLDER}/mobile-app`, branch: 'task/replies-7a000000', createdAt: '2026-11-18T10:00:00.000Z',
    worktrees: [worktree('mobile-app', true), worktree('backend', false)] };
  const KEY = `${FOLDER}/mobile-app`;

  it('keeps the terminals of every worktree of a task in the task\'s one group', () => {
    const sessions = [session('Demo-1', `${FOLDER}/mobile-app`, '2026-11-18T10:00:00.000Z'), session('Demo-2', `${FOLDER}/backend`, '2026-11-18T10:01:00.000Z')];
    const keys = resolveSessionWorktrees({ project: group, sessions, runs: [], tasks: [task] });
    expect([keys.get('Demo-1'), keys.get('Demo-2')]).toEqual([KEY, KEY]);
    const groups = buildWorktreeGroups({ project: group, sessions, runs: [], tasks: [task] });
    expect(groups.map(entry => [entry.key, entry.sessionIds])).toEqual([['main', []], [KEY, ['Demo-1', 'Demo-2']]]);
    expect(groups[1]).toMatchObject({ task: { id: 'a' }, path: KEY, paths: [`${FOLDER}/mobile-app`, `${FOLDER}/backend`], worktrees: task.worktrees });
  });

  it('shows a run on its task whichever of the task\'s worktrees it works in', () => {
    const active = { ...run('r', `${FOLDER}/backend`, 'task/replies-7a000000', '2026-01-02'), steps: [{ name: 'Build', status: 'running', sessionId: 'Demo-3', note: null }] };
    const groups = buildWorktreeGroups({ project: group, sessions: [session('Demo-3', null, null)], runs: [active], tasks: [task] });
    expect(groups.map(entry => entry.key)).toEqual(['main', KEY]);
    expect(groups[1]).toMatchObject({ run: { id: 'r' }, sessionIds: ['Demo-3'] });
    expect(resolveSessionWorktrees({ project: group, sessions: [session('Demo-3', null, null)], runs: [active], tasks: [task] }).get('Demo-3')).toBe(KEY);
  });

  it('keeps a terminal in another repository\'s own checkout in Main, with the repositories it can reach', () => {
    const sessions = [session('Demo-1', null, null), session('Demo-2', '/group/mobile-app', null), session('Demo-3', '/group/worktrees/frontend-main', null)];
    const keys = resolveSessionWorktrees({ project: group, sessions, runs: [], tasks: [] });
    expect([...keys.values()]).toEqual(['main', 'main', 'main']);
    const [main, ...rest] = buildWorktreeGroups({ project: group, sessions, runs: [], tasks: [] });
    expect(rest).toEqual([]);
    expect(main).toMatchObject({
      key: 'main', sessionIds: ['Demo-1', 'Demo-2', 'Demo-3'], paths: ['/group/backend', '/group/mobile-app', '/group/worktrees/frontend-main'],
      repositories: [{ name: 'backend', path: '/group/backend', own: true }, { name: 'mobile-app', path: '/group/mobile-app', own: false }, { name: 'frontend', path: '/group/worktrees/frontend-main', own: false }],
    });
  });

  it('says which repository a terminal is in only where there is more than one to tell apart', () => {
    const [main, taskGroup] = buildWorktreeGroups({ project: group, sessions: [], runs: [], tasks: [task] });
    expect(repositoryLabelForPath(main, '/group/mobile-app')).toBe('mobile-app');
    // The project's own repository is what Main always was: it carries no label.
    expect(repositoryLabelForPath(main, '/group/backend')).toBeNull();
    expect(repositoryLabelForPath(main, null)).toBeNull();
    expect(repositoryLabelForPath(taskGroup, `${FOLDER}/backend`)).toBe('backend');
    expect(repositoryLabelForPath(taskGroup, `${FOLDER}/mobile-app`)).toBe('mobile-app');
    expect(repositoryLabelForPath(taskGroup, '/elsewhere')).toBeNull();
    const [, single] = buildWorktreeGroups({ project, sessions: [], runs: [], tasks: [{ ...task, worktreePath: '/repo/wt-a', worktrees: [{ ...worktree('demo', true), worktreePath: '/repo/wt-a' }] }] });
    expect(repositoryLabelForPath(single, '/repo/wt-a')).toBeNull();
    expect(() => repositoryLabelForPath(null, '/x')).toThrow(/group/);
  });

  it('lists every repository of a task in its tooltip', () => {
    const [, taskGroup] = buildWorktreeGroups({ project: group, sessions: [], runs: [], tasks: [task] });
    expect(describeWorktreeGroup(taskGroup)).toEqual({
      title: 'Replies', detail: null,
      tooltip: `mobile-app · task/replies-7a000000\n${FOLDER}/mobile-app\nbackend · task/replies-7a000000\n${FOLDER}/backend`,
    });
  });

  it('leaves a finished repository of a task out of what it offers', () => {
    const half = { ...task, worktrees: [worktree('mobile-app', true, 'merged'), worktree('backend', false)] };
    const [, taskGroup] = buildWorktreeGroups({ project: group, sessions: [], runs: [], tasks: [half] });
    expect(taskGroup.worktrees.map(entry => [entry.repository, entry.state])).toEqual([['mobile-app', 'merged'], ['backend', 'active']]);
    // The group keeps its key: the task is still the same task.
    expect(taskGroup.key).toBe(KEY);
  });

  it('offers the places a new terminal can open in: the project\'s repositories in Main, a task\'s open worktrees in a task', () => {
    const half = { ...task, worktrees: [worktree('mobile-app', true), worktree('backend', false), worktree('frontend', false, 'closed')] };
    const [main, taskGroup] = buildWorktreeGroups({ project: group, sessions: [], runs: [], tasks: [half] });
    expect(groupPlaces(main)).toEqual([
      { id: 'backend', label: 'backend', path: '/group/backend', own: true },
      { id: 'mobile-app', label: 'mobile-app', path: '/group/mobile-app', own: false },
      { id: 'frontend', label: 'frontend', path: '/group/worktrees/frontend-main', own: false },
    ]);
    expect(groupPlaces(taskGroup)).toEqual([
      { id: 'wt-mobile-app', label: 'mobile-app', path: `${FOLDER}/mobile-app`, own: false },
      { id: 'wt-backend', label: 'backend', path: `${FOLDER}/backend`, own: false },
    ]);
    // A worktree without a task offers nothing: a terminal cannot be opened there from here.
    expect(groupPlaces({ key: '/x', path: '/x', isMain: false, worktrees: null })).toEqual([]);
    expect(() => groupPlaces(null)).toThrow(/group/);
  });

  it('opens a new terminal where the active one is, else in the project\'s own repository or the worktree a task started in', () => {
    const [main, taskGroup] = buildWorktreeGroups({ project: group, sessions: [], runs: [], tasks: [task] });
    expect(placeForPath(main, '/group/mobile-app')).toMatchObject({ id: 'mobile-app' });
    expect(placeForPath(main, null)).toMatchObject({ id: 'backend', own: true });
    expect(placeForPath(main, '/somewhere/else')).toMatchObject({ id: 'backend' });
    expect(placeForPath(taskGroup, `${FOLDER}/backend`)).toMatchObject({ id: 'wt-backend' });
    expect(placeForPath(taskGroup, null)).toMatchObject({ id: 'wt-mobile-app' });
    expect(placeForPath({ key: '/x', path: '/x', isMain: false, worktrees: null }, '/x')).toBeNull();
  });

  it('rejects a project without a list of repositories and a malformed entry or task worktree', () => {
    expect(() => buildWorktreeGroups({ project: { name: 'Demo', path: '/group/backend' }, sessions: [], runs: [], tasks: [] })).toThrow(/project.repositories/);
    expect(() => resolveSessionWorktrees({ project: { name: 'Demo', path: '/group/backend' }, sessions: [], runs: [] })).toThrow(/project.repositories/);
    expect(() => buildWorktreeGroups({ project: { ...group, repositories: [{ name: '', path: '/x' }] }, sessions: [], runs: [], tasks: [] })).toThrow(/repository.name/);
    expect(() => buildWorktreeGroups({ project: { ...group, repositories: [{ name: 'x', path: 'x' }] }, sessions: [], runs: [], tasks: [] })).toThrow(/repository.path/);
    expect(() => buildWorktreeGroups({ project: group, sessions: [], runs: [], tasks: [{ ...task, worktrees: [] }] })).toThrow(/task.worktrees/);
    expect(() => buildWorktreeGroups({ project: group, sessions: [], runs: [], tasks: [{ ...task, worktrees: [{ ...worktree('backend', true), worktreePath: 'relative' }] }] })).toThrow(/worktree.worktreePath/);
  });
});
