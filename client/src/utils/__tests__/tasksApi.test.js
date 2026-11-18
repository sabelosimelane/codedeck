import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask, listOpenTasks, openTaskTerminal, parseTask } from '../tasksApi';

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
