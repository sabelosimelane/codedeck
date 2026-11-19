import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addTaskRepository, closeTask, closeTaskWorktree, commitTask, commitTaskWorktree, createTask, getTaskLanding, listOpenTasks, listTaskWorktreeLandings, mergeTask, mergeTaskWorktree,
  openTaskPullRequest, openTaskTerminal, openTaskWorktreePullRequest, parseLanding, parseTask, parseTaskSummary, parseWorktreeLanding, renameTask,
} from '../tasksApi';

const ID = '7a000000-0000-4000-8000-000000000001';
const WT = '7b000000-0000-4000-8000-000000000001';
const WT2 = '7b000000-0000-4000-8000-000000000002';
const worktree = (overrides = {}) => ({
  id: WT, repository: 'demo', own: true, first: true, worktreePath: '/tmp/worktrees/demo-replies',
  branch: 'task/replies-7a000000', baseBranch: 'main', baseCommit: 'a'.repeat(40), state: 'active', prUrl: null, ...overrides,
});
const task = (overrides = {}) => ({
  id: ID, project: 'Demo', title: 'Replies', state: 'active', worktreePath: '/tmp/worktrees/demo-replies',
  branch: 'task/replies-7a000000', baseBranch: 'main', baseCommit: 'a'.repeat(40), prUrl: null, revision: 1,
  createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z', finishedAt: null,
  folder: null, worktrees: [worktree()], ...overrides,
});
const reply = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });
const page = (data, hasNextPage = false) => ({ data, page: { currentPage: 0, size: 100, totalElements: data.length, totalPages: 1, hasNextPage } });
afterEach(() => vi.unstubAllGlobals());

describe('parseTask', () => {
  it('returns exactly the known fields', () => {
    expect(parseTask({ ...task(), surprise: true })).toEqual(task());
    expect(parseTask(task({ baseBranch: null, state: 'pr_open', prUrl: 'https://example.test/pr/1' })).prUrl).toBe('https://example.test/pr/1');
  });
  it.each([
    ['id', 'nope'], ['project', ''], ['title', ''], ['title', 'x'.repeat(81)], ['state', 'done'], ['worktreePath', 'relative'],
    ['branch', ''], ['baseBranch', ''], ['baseCommit', 'abc'], ['prUrl', 'javascript:x'], ['revision', 0],
    ['createdAt', 'yesterday'], ['updatedAt', null], ['finishedAt', 'x'],
  ])('refuses an invalid %s (%j)', (field, value) => {
    expect(() => parseTask(task({ [field]: value }))).toThrow(new RegExp(`field ${field}`));
  });
  it('refuses a non-object', () => {
    expect(() => parseTask(null, 3)).toThrow('Invalid task index 3 field task');
  });

  it('reads the folder of a task and every repository it includes, with only their known fields', () => {
    const second = worktree({ id: WT2, repository: 'mobile-app', own: false, first: false, worktreePath: '/tmp/worktrees/replies/mobile-app', baseBranch: null, state: 'pr_open', prUrl: 'https://example.test/pr/2' });
    const parsed = parseTask(task({ folder: '/tmp/worktrees/replies', worktrees: [{ ...worktree(), surprise: 1 }, second] }));
    expect(parsed.folder).toBe('/tmp/worktrees/replies');
    expect(parsed.worktrees).toEqual([worktree(), second]);
  });

  it.each([
    ['folder', 'relative'], ['folder', undefined], ['worktrees', undefined], ['worktrees', []], ['worktrees', 'none'],
    ['worktrees', [worktree({ first: false })]], ['worktrees', [worktree(), worktree({ id: WT2 })]],
  ])('refuses a task with an invalid %s (%j)', (field, value) => {
    expect(() => parseTask(task({ [field]: value }))).toThrow(new RegExp(`field ${field}`));
  });

  it.each([
    ['id', 'nope'], ['repository', ''], ['repository', 'a/b'], ['own', 'yes'], ['first', 1], ['worktreePath', 'relative'], ['branch', ''],
    ['baseBranch', ''], ['baseCommit', 'abc'], ['state', 'done'], ['prUrl', 'javascript:x'],
  ])('refuses a repository of a task with an invalid %s (%j)', (field, value) => {
    expect(() => parseTask(task({ worktrees: [worktree({ [field]: value })] }))).toThrow(new RegExp(`field worktrees\\.${field}`));
  });
});

describe('parseTaskSummary', () => {
  const { folder, worktrees, ...summary } = task();
  it('reads a task from a backend of any release: with or without its repositories', () => {
    expect(parseTaskSummary(summary)).toEqual(summary);
    expect(parseTaskSummary(task())).toEqual(summary);
    expect(folder).toBeNull();
    expect(worktrees).toHaveLength(1);
  });
  it.each([['id', 'nope'], ['title', ''], ['state', 'done'], ['worktreePath', 'relative'], ['branch', ''], ['baseCommit', 'abc'], ['revision', 0], ['updatedAt', null]])('refuses an invalid %s (%j)', (field, value) => {
    expect(() => parseTaskSummary({ ...summary, [field]: value })).toThrow(new RegExp(`field ${field}`));
  });
});

describe('tasks API client', () => {
  it('lists every page of open tasks', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(page([task()], true)))
      .mockResolvedValueOnce(reply(page([task({ id: '7a000000-0000-4000-8000-000000000002', title: 'Second' })])));
    vi.stubGlobal('fetch', fetchMock);
    expect((await listOpenTasks()).map(item => item.title)).toEqual(['Replies', 'Second']);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/tasks?open=true&size=100&page=0', '/api/tasks?open=true&size=100&page=1']);
  });

  it('refuses a list response without the page envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply([task()])));
    await expect(listOpenTasks()).rejects.toThrow('Invalid tasks response');
  });

  it('creates a task with a trimmed title', async () => {
    const fetchMock = vi.fn(async () => reply(task(), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await createTask({ project: 'Demo', title: '  Replies ' })).toEqual(task());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ project: 'Demo', title: 'Replies' });
    await expect(createTask({ project: 'Demo', title: ' ' })).rejects.toThrow('title');
    await expect(createTask({ project: '', title: 'x' })).rejects.toThrow('project');
  });

  it('creates a task in the repositories asked for, the one it starts in first', async () => {
    const fetchMock = vi.fn(async () => reply(task(), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await createTask({ project: 'Demo', title: 'Replies', repositories: ['mobile-app', 'backend'] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ project: 'Demo', title: 'Replies', repositories: ['mobile-app', 'backend'] });
    for (const repositories of [[], 'backend', ['backend', ''], [7]]) {
      await expect(createTask({ project: 'Demo', title: 'x', repositories })).rejects.toThrow('repositories');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens a terminal in a task', async () => {
    const fetchMock = vi.fn(async () => reply({ sessionId: 'Demo-4', taskId: ID, project: 'Demo', worktreeId: WT }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await openTaskTerminal(ID)).toEqual({ sessionId: 'Demo-4', taskId: ID, project: 'Demo', worktreeId: WT });
    expect(fetchMock.mock.calls[0]).toEqual([`/api/tasks/${ID}/terminals`, { method: 'POST', signal: undefined }]);
    await expect(openTaskTerminal('nope')).rejects.toThrow('taskId');
  });

  it('opens a terminal in one repository of a task', async () => {
    const fetchMock = vi.fn(async () => reply({ sessionId: 'Demo-5', taskId: ID, project: 'Demo', worktreeId: WT2 }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await openTaskTerminal(ID, WT2)).toEqual({ sessionId: 'Demo-5', taskId: ID, project: 'Demo', worktreeId: WT2 });
    expect(fetchMock.mock.calls[0]).toEqual([`/api/tasks/${ID}/terminals`, { method: 'POST', signal: undefined, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worktreeId: WT2 }) }]);
    await expect(openTaskTerminal(ID, 'nope')).rejects.toThrow('worktreeId');
    // The backend says where the terminal opened; an answer for another repository is refused.
    await expect(openTaskTerminal(ID, WT)).rejects.toThrow('Invalid task terminal response: worktreeId');
  });

  it('refuses a terminal response for another task or without a session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ sessionId: 'Demo-4', taskId: 'other', project: 'Demo', worktreeId: WT })));
    await expect(openTaskTerminal(ID)).rejects.toThrow('taskId');
    vi.stubGlobal('fetch', vi.fn(async () => reply({ taskId: ID, project: 'Demo', worktreeId: WT })));
    await expect(openTaskTerminal(ID)).rejects.toThrow('sessionId');
    vi.stubGlobal('fetch', vi.fn(async () => reply({ sessionId: 'Demo-4', taskId: ID, project: 'Demo' })));
    await expect(openTaskTerminal(ID)).rejects.toThrow('worktreeId');
  });

  it('reports the server message, the field message, an unreachable server and an unreadable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ message: 'This task is finished.' }, { ok: false, status: 409 })));
    await expect(openTaskTerminal(ID)).rejects.toThrow('This task is finished.');
    vi.stubGlobal('fetch', vi.fn(async () => reply({ message: 'One or more fields failed validation.', errors: [{ field: 'title', message: 'Use 1–80 characters on one line' }] }, { ok: false, status: 400 })));
    await expect(createTask({ project: 'Demo', title: 'x' })).rejects.toThrow('Use 1–80 characters on one line');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    await expect(listOpenTasks()).rejects.toThrow('Server unreachable');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error('html'); } })));
    await expect(listOpenTasks()).rejects.toThrow('Something went wrong. Please try again.');
  });
});

describe('landing API client', () => {
  const landing = (overrides = {}) => ({
    taskId: ID, state: 'active', branch: 'task/replies', baseBranch: 'main', prUrl: null, filesPresent: true, runActive: false,
    uncommitted: ['a.txt'], uncommittedCount: 1, commitsAhead: 2, commitsBehind: 0, main: { branch: 'main', dirty: false },
    remotes: [{ name: 'origin', host: 'gitlab.com', tool: 'glab' }],
    blockers: { commit: [], merge: [{ code: 'uncommitted', message: 'Commit first.' }], pullRequest: [], close: [] }, ...overrides,
  });

  it('reads the landing status and keeps exactly its known fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ ...landing(), surprise: 1 })));
    expect(await getTaskLanding(ID)).toEqual(landing());
    await expect(getTaskLanding('nope')).rejects.toThrow('taskId');
  });

  it.each([
    ['taskId', 'x'], ['state', 'done'], ['branch', ''], ['baseBranch', 12], ['prUrl', 'ftp://x'], ['filesPresent', 'yes'], ['runActive', null],
    ['uncommitted', 'a.txt'], ['uncommittedCount', 0], ['commitsAhead', -1], ['commitsBehind', 'x'], ['main', null], ['remotes', {}], ['blockers', null],
  ])('refuses a landing status with an invalid %s', (field, value) => {
    expect(() => parseLanding(landing({ [field]: value }))).toThrow(`Invalid landing response: ${field}`);
  });

  it('refuses malformed remotes and blockers', () => {
    expect(() => parseLanding(landing({ remotes: [{ name: 'origin', host: 'h', tool: 'svn' }] }))).toThrow('remotes.tool');
    expect(() => parseLanding(landing({ blockers: { ...landing().blockers, merge: [{ code: 'x' }] } }))).toThrow('blockers.merge');
    expect(() => parseLanding(landing({ blockers: { ...landing().blockers, close: 'none' } }))).toThrow('blockers.close');
  });

  it('commits, merges, opens a pull request, closes and renames through the backend', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(landing({ uncommitted: [], uncommittedCount: 0 })))
      .mockResolvedValueOnce(reply({ task: task({ state: 'merged', finishedAt: '2026-11-18T11:00:00.000Z' }), mergedInto: 'main', filesRemoved: true, filesDetail: null, branchDeleted: true, terminalsClosed: ['Demo-2'], terminalsNotClosed: [] }))
      .mockResolvedValueOnce(reply({ task: task({ state: 'pr_open', prUrl: 'https://example.test/pr/1' }), prUrl: 'https://example.test/pr/1', remote: 'origin' }))
      .mockResolvedValueOnce(reply({ task: task({ state: 'closed', finishedAt: '2026-11-18T11:00:00.000Z' }), branchKept: 'task/replies', unmergedCommits: 2, terminalsClosed: [], terminalsNotClosed: ['Demo-3'] }))
      .mockResolvedValueOnce(reply(task({ title: 'Renamed', revision: 2 })));
    vi.stubGlobal('fetch', fetchMock);
    expect((await commitTask(ID, ' Add replies ')).uncommittedCount).toBe(0);
    expect(await mergeTask(ID)).toMatchObject({ mergedInto: 'main', filesRemoved: true, branchDeleted: true, terminalsClosed: ['Demo-2'], terminalsNotClosed: [], task: { state: 'merged' } });
    expect(await openTaskPullRequest(ID, 'origin')).toMatchObject({ prUrl: 'https://example.test/pr/1', remote: 'origin' });
    expect(await closeTask(ID)).toMatchObject({ branchKept: 'task/replies', unmergedCommits: 2, terminalsClosed: [], terminalsNotClosed: ['Demo-3'] });
    expect((await renameTask(ID, { title: ' Renamed ', revision: 1 })).title).toBe('Renamed');
    expect(fetchMock.mock.calls.map(call => [call[0], call[1].method, call[1].body ?? null])).toEqual([
      [`/api/tasks/${ID}/commit`, 'POST', JSON.stringify({ message: 'Add replies' })],
      [`/api/tasks/${ID}/merge`, 'POST', null],
      [`/api/tasks/${ID}/pull-request`, 'POST', JSON.stringify({ remote: 'origin' })],
      [`/api/tasks/${ID}/close`, 'POST', null],
      [`/api/tasks/${ID}`, 'PUT', JSON.stringify({ title: 'Renamed', revision: 1 })],
    ]);
  });

  it('refuses blank input before calling the backend, and malformed results after', async () => {
    const fetchMock = vi.fn(async () => reply({ mergedInto: 'main' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(commitTask(ID, '  ')).rejects.toThrow('message');
    await expect(openTaskPullRequest(ID, '')).rejects.toThrow('remote');
    await expect(renameTask(ID, { title: '', revision: 1 })).rejects.toThrow('title');
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(mergeTask(ID)).rejects.toThrow('Invalid merge response');
    await expect(closeTask(ID)).rejects.toThrow('Invalid close response');
    await expect(openTaskPullRequest(ID, 'origin')).rejects.toThrow('prUrl');
  });

  it('carries the reasons and conflicting files of a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ message: 'Nothing was merged.', conflicts: ['shared.txt', 12], reasons: [{ code: 'main_dirty', message: 'Main has uncommitted changes.' }, { code: 'bad' }] }, { ok: false, status: 409 })));
    const error = await mergeTask(ID).catch(failure => failure);
    expect(error).toMatchObject({ message: 'Nothing was merged.', status: 409, conflicts: ['shared.txt'], reasons: [{ code: 'main_dirty', message: 'Main has uncommitted changes.' }] });
  });
});

describe('landing one repository of a task', () => {
  const standing = (overrides = {}) => ({
    taskId: ID, worktreeId: WT2, repository: 'mobile-app', own: false, first: false, worktreePath: '/tmp/worktrees/replies/mobile-app',
    state: 'active', branch: 'task/replies', baseBranch: 'main', prUrl: null, filesPresent: true, runActive: false,
    uncommitted: ['a.txt'], uncommittedCount: 1, commitsAhead: 2, commitsBehind: 0, main: { branch: 'main', dirty: false },
    remotes: [{ name: 'origin', host: 'github.com', tool: 'gh' }],
    blockers: { commit: [], merge: [{ code: 'uncommitted', message: 'Commit first.' }], pullRequest: [], close: [] }, ...overrides,
  });
  const finishedBody = extra => ({ task: task(), repository: 'mobile-app', taskFinished: false, terminalsClosed: ['Demo-4'], terminalsNotClosed: [], ...extra });

  it('reads how a repository stands and keeps exactly its known fields', () => {
    expect(parseWorktreeLanding({ ...standing(), surprise: 1 })).toEqual(standing());
  });

  it.each([
    ['worktreeId', 'nope'], ['repository', ''], ['own', 'no'], ['first', 0], ['worktreePath', 'relative'], ['state', 'done'], ['uncommittedCount', 0], ['blockers', null],
  ])('refuses a standing with an invalid %s', (field, value) => {
    expect(() => parseWorktreeLanding(standing({ [field]: value }))).toThrow(`Invalid landing response: ${field}`);
  });

  it('lists every repository of a task, the one it started in first', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(page([standing()], true)))
      .mockResolvedValueOnce(reply(page([standing({ worktreeId: WT, repository: 'backend', own: true, first: true })])));
    vi.stubGlobal('fetch', fetchMock);
    expect((await listTaskWorktreeLandings(ID)).map(entry => entry.repository)).toEqual(['backend', 'mobile-app']);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([`/api/tasks/${ID}/worktrees?size=100&page=0`, `/api/tasks/${ID}/worktrees?size=100&page=1`]);
    vi.stubGlobal('fetch', vi.fn(async () => reply([standing()])));
    await expect(listTaskWorktreeLandings(ID)).rejects.toThrow('Invalid task worktrees response');
    await expect(listTaskWorktreeLandings('nope')).rejects.toThrow('taskId');
  });

  it('commits one repository with a trimmed message', async () => {
    const fetchMock = vi.fn(async () => reply(standing({ uncommitted: [], uncommittedCount: 0 })));
    vi.stubGlobal('fetch', fetchMock);
    expect((await commitTaskWorktree(ID, WT2, '  Mobile part ')).uncommittedCount).toBe(0);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/tasks/${ID}/worktrees/${WT2}/commit`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ message: 'Mobile part' });
    await expect(commitTaskWorktree(ID, WT2, ' ')).rejects.toThrow('message');
    await expect(commitTaskWorktree(ID, 'nope', 'x')).rejects.toThrow('worktreeId');
  });

  it('merges one repository and says whether that finished the task', async () => {
    const fetchMock = vi.fn(async () => reply(finishedBody({ mergedInto: 'main', filesRemoved: true, filesDetail: null, branchDeleted: true })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await mergeTaskWorktree(ID, WT2)).toEqual({
      task: task(), repository: 'mobile-app', mergedInto: 'main', filesRemoved: true, filesDetail: null, branchDeleted: true, taskFinished: false,
      terminalsClosed: ['Demo-4'], terminalsNotClosed: [],
    });
    expect(fetchMock.mock.calls[0]).toEqual([`/api/tasks/${ID}/worktrees/${WT2}/merge`, { method: 'POST', signal: undefined }]);
    vi.stubGlobal('fetch', vi.fn(async () => reply(finishedBody({ mergedInto: 'main', filesRemoved: true, branchDeleted: true, taskFinished: 'no' }))));
    await expect(mergeTaskWorktree(ID, WT2)).rejects.toThrow('Invalid merge response: taskFinished');
  });

  it('opens a pull request for one repository', async () => {
    const fetchMock = vi.fn(async () => reply({ task: task(), repository: 'mobile-app', prUrl: 'https://example.test/pr/2', remote: 'origin' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await openTaskWorktreePullRequest(ID, WT2, 'origin')).toEqual({ task: task(), repository: 'mobile-app', prUrl: 'https://example.test/pr/2', remote: 'origin' });
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/tasks/${ID}/worktrees/${WT2}/pull-request`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ remote: 'origin' });
    await expect(openTaskWorktreePullRequest(ID, WT2, '')).rejects.toThrow('remote');
  });

  it('closes one repository and says which branch was kept', async () => {
    const fetchMock = vi.fn(async () => reply(finishedBody({ branchKept: 'task/replies', unmergedCommits: 2, taskFinished: true })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await closeTaskWorktree(ID, WT2)).toEqual({ task: task(), repository: 'mobile-app', branchKept: 'task/replies', unmergedCommits: 2, taskFinished: true, terminalsClosed: ['Demo-4'], terminalsNotClosed: [] });
    expect(fetchMock.mock.calls[0]).toEqual([`/api/tasks/${ID}/worktrees/${WT2}/close`, { method: 'POST', signal: undefined }]);
    vi.stubGlobal('fetch', vi.fn(async () => reply(finishedBody({ branchKept: '', unmergedCommits: 2 }))));
    await expect(closeTaskWorktree(ID, WT2)).rejects.toThrow('Invalid close response');
  });

  it('adds one of the project\'s repositories to a task and returns the task with it', async () => {
    const second = worktree({ id: WT2, repository: 'mobile-app', own: false, first: false, worktreePath: '/tmp/worktrees/replies/mobile-app' });
    const fetchMock = vi.fn(async () => reply(task({ worktrees: [worktree(), second] }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await addTaskRepository(ID, 'mobile-app')).worktrees.map(entry => entry.repository)).toEqual(['demo', 'mobile-app']);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/tasks/${ID}/worktrees`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ repository: 'mobile-app' });
    await expect(addTaskRepository(ID, '')).rejects.toThrow('repository');
    await expect(addTaskRepository('nope', 'mobile-app')).rejects.toThrow('taskId');
    vi.stubGlobal('fetch', vi.fn(async () => reply({ message: 'A workflow run is working in this task. Add the repository when it pauses or finishes.' }, { ok: false, status: 409 })));
    await expect(addTaskRepository(ID, 'mobile-app')).rejects.toThrow('A workflow run is working in this task. Add the repository when it pauses or finishes.');
  });

  it('passes on why a repository could not be landed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ message: 'mobile-app conflicts with main in 1 file. Nothing was merged.', conflicts: ['README.md'] }, { ok: false, status: 409 })));
    await expect(mergeTaskWorktree(ID, WT2)).rejects.toMatchObject({ message: 'mobile-app conflicts with main in 1 file. Nothing was merged.', status: 409, conflicts: ['README.md'] });
  });
});
