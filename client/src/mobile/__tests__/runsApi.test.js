import { describe, it, expect, vi } from 'vitest';
import { createRunsApi } from '../runsApi';
import { run, askingRun, approvalRun, task, pageOf, RUN_ID } from './runFixtures';

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
