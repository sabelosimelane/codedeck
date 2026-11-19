import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeTask, commitTask, createTask, getTaskLanding, listOpenTasks, mergeTask, openTaskPullRequest, openTaskTerminal, parseLanding, parseTask, renameTask } from '../tasksApi';

const ID = '7a000000-0000-4000-8000-000000000001';
const task = (overrides = {}) => ({
  id: ID, project: 'Demo', title: 'Replies', state: 'active', worktreePath: '/tmp/worktrees/demo-replies',
  branch: 'task/replies-7a000000', baseBranch: 'main', baseCommit: 'a'.repeat(40), prUrl: null, revision: 1,
  createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z', finishedAt: null, ...overrides,
});
const reply = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });
const page = (data, hasNextPage = false) => ({ data, page: { currentPage: 0, size: 100, totalElements: data.length, totalPages: 1, hasNextPage } });
afterEach(() => vi.unstubAllGlobals());

describe('parseTask', () => {
  it('returns exactly the known fields', () => {
    expect(parseTask({ ...task(), surprise: true })).toEqual(task());
    // A newer backend also sends the task's folder and one entry per repository; this parser reads the task as before.
    expect(parseTask({ ...task(), folder: null, worktrees: [{ id: '7b000000-0000-4000-8000-000000000001', repository: 'demo', own: true, first: true,
      worktreePath: '/tmp/worktrees/demo-replies', branch: 'task/replies-7a000000', baseBranch: 'main', baseCommit: 'a'.repeat(40), state: 'active', prUrl: null }] })).toEqual(task());
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

  it('opens a terminal in a task', async () => {
    const fetchMock = vi.fn(async () => reply({ sessionId: 'Demo-4', taskId: ID, project: 'Demo' }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await openTaskTerminal(ID)).toEqual({ sessionId: 'Demo-4', taskId: ID, project: 'Demo' });
    expect(fetchMock.mock.calls[0]).toEqual([`/api/tasks/${ID}/terminals`, { method: 'POST', signal: undefined }]);
    await expect(openTaskTerminal('nope')).rejects.toThrow('taskId');
  });

  it('refuses a terminal response for another task or without a session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ sessionId: 'Demo-4', taskId: 'other', project: 'Demo' })));
    await expect(openTaskTerminal(ID)).rejects.toThrow('taskId');
    vi.stubGlobal('fetch', vi.fn(async () => reply({ taskId: ID, project: 'Demo' })));
    await expect(openTaskTerminal(ID)).rejects.toThrow('sessionId');
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
