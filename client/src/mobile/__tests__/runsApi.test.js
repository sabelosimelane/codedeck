import { describe, it, expect, vi } from 'vitest';
import { createRunsApi } from '../runsApi';
import { run, askingRun, approvalRun, task, pageOf, RUN_ID, TASK_ID, WORKTREE_ID, landing, committedLanding } from './runFixtures';

const ok = body => ({ ok: true, status: 200, json: async () => body });
const refused = (status, body) => ({ ok: false, status, json: async () => body });
const api = request => createRunsApi('https://host.tail.ts.net:8443', request);
const NOTE = { id: 7, stepIndex: 1, stepName: 'Fix', status: 'written', summary: 'Done', attempt: 1, pass: 1, createdAt: '2026-11-10T17:50:00.000Z', content: '# Fix\n\nDone.' };

describe('reading runs and tasks from the instance', () => {
  it('reads every page of the open runs from the address of the instance', async () => {
    const second = run({ id: '11111111-1111-4111-8111-111111111111' });
    const request = vi.fn()
      .mockResolvedValueOnce(ok({ data: [run()], page: { currentPage: 0, size: 100, totalElements: 2, totalPages: 2, hasNextPage: true } }))
      .mockResolvedValueOnce(ok(pageOf([second])));
    expect((await api(request).listOpenRuns()).map(item => item.id)).toEqual([RUN_ID, second.id]);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://host.tail.ts.net:8443/api/pipelines/runs?open=true&page=0&size=100',
      'https://host.tail.ts.net:8443/api/pipelines/runs?open=true&page=1&size=100',
    ]);
    expect(request.mock.calls[0][1]).not.toHaveProperty('body');
    expect(request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it('reads the open tasks', async () => {
    const request = vi.fn().mockResolvedValue(ok(pageOf([task()])));
    // An instance of an earlier release does not say which repositories a task includes.
    expect(await api(request).listOpenTasks()).toEqual([{ ...task(), worktrees: null }]);
    expect(request.mock.calls[0][0]).toBe('https://host.tail.ts.net:8443/api/tasks?open=true&page=0&size=100');
  });
  it('reads the repositories of a task from an instance that sends them', async () => {
    const worktrees = [{ id: '7b000000-0000-4000-8000-000000000001', repository: 'p', own: true, first: true, worktreePath: task().worktreePath, branch: task().branch, baseBranch: 'main', baseCommit: task().baseCommit, state: 'active', prUrl: null }];
    const request = vi.fn().mockResolvedValue(ok(pageOf([{ ...task(), folder: null, worktrees }])));
    expect(await api(request).listOpenTasks()).toEqual([{ ...task(), worktrees }]);
  });
  it.each([
    ['a run with an unknown status', pageOf([run({ status: 'paused' })]), `Invalid run ${RUN_ID} field status`],
    ['a response that is not a page', { data: [run()] }, 'Invalid runs response'],
    ['a response without records', { page: { hasNextPage: false } }, 'Invalid runs response'],
  ])('refuses %s', async (_name, body, message) => {
    await expect(api(vi.fn().mockResolvedValue(ok(body))).listOpenRuns()).rejects.toThrow(message);
  });
  it('refuses a task with a missing title', async () => {
    await expect(api(vi.fn().mockResolvedValue(ok(pageOf([task({ title: '' })])))).listOpenTasks()).rejects.toThrow('field title');
  });
  it('refuses a tasks response that is not a page', async () => {
    await expect(api(vi.fn().mockResolvedValue(ok({ data: [] }))).listOpenTasks()).rejects.toThrow('Invalid tasks response');
  });
  it('reads the newest note of one step', async () => {
    const request = vi.fn().mockResolvedValue(ok(pageOf([NOTE])));
    expect(await api(request).listNotes(RUN_ID, 0, 1)).toMatchObject({ notes: [NOTE], hasNextPage: false });
    expect(request.mock.calls[0][0]).toBe(`https://host.tail.ts.net:8443/api/pipelines/runs/${RUN_ID}/notes?page=0&size=50&sort=createdAt%2Cdesc&stepIndex=1`);
  });
  it.each([[RUN_ID, -1, 1, 'page'], [RUN_ID, 0, 33, 'stepIndex'], [RUN_ID, 0, 1.5, 'stepIndex'], ['not-a-run', 0, 1, 'run']])('requires a run, a page and a step for notes (%s, %s, %s)', async (runId, page, stepIndex, field) => {
    const request = vi.fn();
    await expect(api(request).listNotes(runId, page, stepIndex)).rejects.toThrow(field);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('acting on a run', () => {
  it('sends an answer and returns the run as it now stands', async () => {
    const request = vi.fn().mockResolvedValue(ok(run()));
    expect(await api(request).answer(RUN_ID, 'Proceed.')).toMatchObject({ id: RUN_ID, status: 'running' });
    const [url, options] = request.mock.calls[0];
    expect(url).toBe(`https://host.tail.ts.net:8443/api/pipelines/runs/${RUN_ID}/answer`);
    expect(options).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: 'Proceed.' }) });
  });
  it('sends a step back with what to change', async () => {
    const request = vi.fn().mockResolvedValue(ok(run()));
    await api(request).sendBack(RUN_ID, 'Use the first name.');
    expect(request.mock.calls[0][0]).toBe(`https://host.tail.ts.net:8443/api/pipelines/runs/${RUN_ID}/send-back`);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ comment: 'Use the first name.' });
  });
  it.each([['approve', 'approve'], ['resume', 'resume'], ['continuePast', 'continue']])('%s posts to the run without a body', async (method, path) => {
    const request = vi.fn().mockResolvedValue(ok(run()));
    await api(request)[method](RUN_ID);
    const [url, options] = request.mock.calls[0];
    expect(url).toBe(`https://host.tail.ts.net:8443/api/pipelines/runs/${RUN_ID}/${path}`);
    expect(options.method).toBe('POST');
    expect(options).not.toHaveProperty('body');
  });
  it.each([
    ['answer', ['']], ['answer', ['   ']], ['answer', [null]], ['answer', ['x'.repeat(4001)]],
    ['sendBack', ['']], ['sendBack', [undefined]], ['sendBack', ['x'.repeat(4001)]], ['sendBack', ['tab\there']],
  ])('%s refuses %j before asking the instance', async (method, args) => {
    const request = vi.fn();
    await expect(api(request)[method](RUN_ID, ...args)).rejects.toThrow(/1–4000 characters/);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([['answer', ['ok']], ['approve', []], ['sendBack', ['ok']], ['resume', []], ['continuePast', []]])('%s requires a run identity', async (method, args) => {
    const request = vi.fn();
    await expect(api(request)[method]('../other', ...args)).rejects.toThrow('run must be a run identity');
    expect(request).not.toHaveBeenCalled();
  });
  it('refuses an answer that comes back as something other than a run', async () => {
    await expect(api(vi.fn().mockResolvedValue(ok({ id: RUN_ID }))).approve(RUN_ID)).rejects.toThrow(`Invalid run ${RUN_ID} field`);
  });
});

describe('what the instance refuses', () => {
  it('reports the message of the instance and its status', async () => {
    const request = vi.fn().mockResolvedValue(refused(409, { message: 'The run is not waiting for an answer', status: 409 }));
    await expect(api(request).answer(RUN_ID, 'ok')).rejects.toMatchObject({ message: 'The run is not waiting for an answer', status: 409 });
  });
  it('reports the first field error of a validation failure', async () => {
    const request = vi.fn().mockResolvedValue(refused(400, { message: 'One or more fields failed validation.', errors: [{ field: 'answer', message: 'Use 1–4000 characters' }] }));
    await expect(api(request).answer(RUN_ID, 'ok')).rejects.toThrow('answer: Use 1–4000 characters');
  });
  it('reports a refusal that says nothing by its status', async () => {
    await expect(api(vi.fn().mockResolvedValue(refused(502, {}))).approve(RUN_ID)).rejects.toThrow('The instance refused the request (502).');
  });
  it('says which instance it could not reach', async () => {
    await expect(api(vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))).listOpenRuns()).rejects.toThrow('Could not reach https://host.tail.ts.net:8443.');
  });
  it('requires an HTTPS instance address', () => {
    expect(() => createRunsApi('http://host')).toThrow('Use the instance HTTPS origin');
  });
});

it('accepts the runs that ask and wait for approval', async () => {
  const request = vi.fn().mockResolvedValue(ok(pageOf([askingRun(), approvalRun({ id: '11111111-1111-4111-8111-111111111111' })])));
  expect((await api(request).listOpenRuns()).map(item => item.status)).toEqual(['needs_input', 'awaiting_approval']);
});

describe('limit recovery from the phone', () => {
  it('continuePast sends the pause the owner saw', async () => {
    const request = vi.fn().mockResolvedValue(ok(run()));
    await api(request).continuePast(RUN_ID, { stepIndex: 1, roundsCompleted: 7, extraRounds: 1 });
    const [url, options] = request.mock.calls[0];
    expect(url).toBe(`https://host.tail.ts.net:8443/api/pipelines/runs/${RUN_ID}/continue`);
    expect(JSON.parse(options.body)).toEqual({ stepIndex: 1, roundsCompleted: 7, extraRounds: 1 });
  });
  it('stop ends the run with what remains', async () => {
    const request = vi.fn().mockResolvedValue(ok(run()));
    await api(request).stop(RUN_ID);
    expect(request.mock.calls[0][0]).toBe(`https://host.tail.ts.net:8443/api/pipelines/runs/${RUN_ID}/stop`);
  });
});

describe('closing a run from the phone', () => {
  it('posts cleanup and returns the run with the terminals it closed', async () => {
    const request = vi.fn().mockResolvedValue(ok({ ...run(), terminalsClosed: ['p-1'], terminalsNotClosed: [] }));
    const closed = await api(request).cleanup(RUN_ID);
    expect(request.mock.calls[0][0]).toBe(`https://host.tail.ts.net:8443/api/pipelines/runs/${RUN_ID}/cleanup`);
    expect(request.mock.calls[0][1].method).toBe('POST');
    expect(closed.run.id).toBe(RUN_ID);
    expect(closed.terminalsClosed).toEqual(['p-1']);
    expect(closed.terminalsNotClosed).toEqual([]);
  });
  it.each(['terminalsClosed', 'terminalsNotClosed'])('refuses an answer without %s', async field => {
    const body = { ...run(), terminalsClosed: [], terminalsNotClosed: [] };
    delete body[field];
    await expect(api(vi.fn().mockResolvedValue(ok(body))).cleanup(RUN_ID)).rejects.toThrow(`Invalid close run response: ${field}`);
  });
  it('requires a run identity', async () => {
    await expect(api(vi.fn()).cleanup('nope')).rejects.toThrow('run must be a run identity');
  });
});

describe('reading what happened on a step', () => {
  const page = data => ({ data, page: { currentPage: 0, size: 100, totalElements: data.length, totalPages: 1, hasNextPage: false } });
  const AT = '2026-11-10T17:50:00.000Z';
  it('reads the decisions of one step', async () => {
    const decision = { id: 3, stepIndex: 1, stepName: 'Fix', pass: 1, questions: '1. Keep it?', truncated: false, answer: 'Yes', createdAt: AT };
    const request = vi.fn().mockResolvedValue(ok(page([decision])));
    expect(await api(request).listRecords('decisions', RUN_ID, 1)).toEqual({ items: [decision], total: 1 });
    expect(request.mock.calls[0][0]).toBe(`https://host.tail.ts.net:8443/api/pipelines/runs/${RUN_ID}/decisions?page=0&size=100&sort=createdAt%2Casc&stepIndex=1`);
  });
  it('reads the answers and the reviews of one step', async () => {
    const answer = { id: 1, stepIndex: 1, stepName: 'Fix', pass: 1, questions: null, answer: 'Yes', createdAt: AT };
    const review = { id: 2, stepIndex: 1, stepName: 'Fix', attempt: 1, verdict: 'approved', comment: null, createdAt: AT };
    expect(await api(vi.fn().mockResolvedValue(ok(page([answer])))).listRecords('answers', RUN_ID, 1)).toEqual({ items: [answer], total: 1 });
    expect(await api(vi.fn().mockResolvedValue(ok(page([review])))).listRecords('reviews', RUN_ID, 1)).toEqual({ items: [review], total: 1 });
  });
  it('refuses a record that does not hold', async () => {
    await expect(api(vi.fn().mockResolvedValue(ok(page([{ id: 2, stepIndex: 1, stepName: 'Fix', attempt: 1, verdict: 'maybe', comment: null, createdAt: AT }])))).listRecords('reviews', RUN_ID, 1))
      .rejects.toThrow('Invalid reviews response field data[0].verdict');
  });
  it('reads only the kinds it knows, for a step that can exist', async () => {
    await expect(api(vi.fn()).listRecords('audit', RUN_ID, 1)).rejects.toThrow('kind must be decisions, answers or reviews');
    await expect(api(vi.fn()).listRecords('answers', RUN_ID, 33)).rejects.toThrow('stepIndex must be an integer from 0 to 32');
  });
});

describe('landing a task from the phone', () => {
  const BASE = `https://host.tail.ts.net:8443/api/tasks/${TASK_ID}/worktrees`;
  const page = (data, hasNextPage = false) => ({ data, page: { currentPage: 0, size: 100, totalElements: data.length, totalPages: 1, hasNextPage } });
  const taskBody = { ...task(), worktrees: undefined };
  delete taskBody.worktrees;
  it('reads how every repository of a task stands, the first one first', async () => {
    const other = landing({ worktreeId: '7b000000-0000-4000-8000-000000000002', repository: 'backend', own: false, first: false, worktreePath: '/work/worktrees/t/backend' });
    const request = vi.fn().mockResolvedValueOnce(ok(page([other], true))).mockResolvedValueOnce(ok(page([landing()])));
    const landings = await api(request).listLandings(TASK_ID);
    expect(landings.map(entry => entry.repository)).toEqual(['p', 'backend']);
    expect(request.mock.calls.map(([url]) => url)).toEqual([`${BASE}?size=100&page=0`, `${BASE}?size=100&page=1`]);
  });
  it('refuses a landing that does not hold', async () => {
    await expect(api(vi.fn().mockResolvedValue(ok(page([landing({ uncommittedCount: -1 })])))).listLandings(TASK_ID)).rejects.toThrow('Invalid landing response: uncommittedCount');
  });
  it('commits one repository with the message given', async () => {
    const request = vi.fn().mockResolvedValue(ok(committedLanding()));
    expect((await api(request).commit(TASK_ID, WORKTREE_ID, ' Use the first name ')).commitsAhead).toBe(3);
    expect(request.mock.calls[0][0]).toBe(`${BASE}/${WORKTREE_ID}/commit`);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ message: 'Use the first name' });
  });
  it('merges one repository and says whether that finished the task', async () => {
    const request = vi.fn().mockResolvedValue(ok({ task: taskBody, repository: 'p', mergedInto: 'main', filesRemoved: true, branchDeleted: true, taskFinished: true, terminalsClosed: ['p-1'], terminalsNotClosed: [] }));
    expect(await api(request).merge(TASK_ID, WORKTREE_ID)).toEqual({ repository: 'p', mergedInto: 'main', filesRemoved: true, taskFinished: true, terminalsClosed: ['p-1'], terminalsNotClosed: [] });
    expect(request.mock.calls[0][0]).toBe(`${BASE}/${WORKTREE_ID}/merge`);
    expect(request.mock.calls[0][1].method).toBe('POST');
  });
  it('opens a pull request on the remote chosen', async () => {
    const request = vi.fn().mockResolvedValue(ok({ task: taskBody, repository: 'p', prUrl: 'https://github.com/o/p/pull/4', remote: 'origin' }));
    expect(await api(request).pullRequest(TASK_ID, WORKTREE_ID, 'origin')).toEqual({ repository: 'p', prUrl: 'https://github.com/o/p/pull/4' });
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ remote: 'origin' });
  });
  it('closes one repository, never deleting ignored files', async () => {
    const request = vi.fn().mockResolvedValue(ok({ task: taskBody, repository: 'p', branchKept: 'task/the-call-3858fe63', unmergedCommits: 0, taskFinished: true, terminalsClosed: [], terminalsNotClosed: [] }));
    expect(await api(request).closeWorktree(TASK_ID, WORKTREE_ID)).toEqual({ repository: 'p', branchKept: 'task/the-call-3858fe63', unmergedCommits: 0, taskFinished: true, terminalsClosed: [], terminalsNotClosed: [] });
    expect(request.mock.calls[0][0]).toBe(`${BASE}/${WORKTREE_ID}/close`);
    expect(request.mock.calls[0][1]).not.toHaveProperty('body');
  });
  it('gives landing two minutes, and reads fifteen seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const request = vi.fn().mockResolvedValue(ok({ task: taskBody, repository: 'p', prUrl: 'https://github.com/o/p/pull/4', remote: 'origin' }));
    await api(request).pullRequest(TASK_ID, WORKTREE_ID, 'origin');
    expect(timeout).toHaveBeenLastCalledWith(120000);
    await api(vi.fn().mockResolvedValue(ok(page([landing()])))).listLandings(TASK_ID);
    expect(timeout).toHaveBeenLastCalledWith(15000);
    timeout.mockRestore();
  });
  it('keeps the reasons and conflicts of a refusal', async () => {
    const request = vi.fn().mockResolvedValue(refused(409, { message: 'The merge conflicts', reasons: [{ code: 'main_dirty', message: 'Main has uncommitted changes' }], conflicts: ['src/call.js'] }));
    await expect(api(request).merge(TASK_ID, WORKTREE_ID)).rejects.toMatchObject({ message: 'The merge conflicts', status: 409, reasons: ['Main has uncommitted changes'], conflicts: ['src/call.js'] });
  });
  it.each([
    ['a task', () => api(vi.fn()).merge('nope', WORKTREE_ID), 'task must be a task identity'],
    ['a worktree', () => api(vi.fn()).merge(TASK_ID, 'nope'), 'worktree must be a worktree identity'],
    ['a commit message', () => api(vi.fn()).commit(TASK_ID, WORKTREE_ID, '  '), 'message must be 1–200 characters'],
    ['a remote', () => api(vi.fn()).pullRequest(TASK_ID, WORKTREE_ID, ''), 'remote must be a remote name'],
  ])('requires %s', async (_name, call, message) => {
    await expect(call()).rejects.toThrow(message);
  });
});
