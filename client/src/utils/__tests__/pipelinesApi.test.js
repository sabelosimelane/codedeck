import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PipelineApiError,
  cleanupRun,
  continueRun,
  createAgent,
  createWorkflow,
  deleteAgent,
  deleteWorkflow,
  getAgent,
  getPipelineSettings,
  getRun,
  getWorkflow,
  listAgents,
  listOpenRuns,
  listWorkflows,
  updateAgent,
  updatePipelineSettings,
  updateWorkflow,
  listWorktrees,
  preflightProject,
  resumeRun,
  planRun,
  startRun,
  stopRun,
  answerRun,
  approveRun,
  sendBackRun,
  listRunDecisions,
  listRunNotes,
} from '../pipelinesApi';

const TIMEOUTS = { agentReadySeconds: 120, resetSettleSeconds: 15, finalSignalIdleSeconds: 24, lostPromptSeconds: 30, stallWarningMinutes: 15 };

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

describe('pipelinesApi', () => {
  it('posts approval and send-back and filters notes to the gated step', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ id: 'r1' }));
    await approveRun('r1');
    await sendBackRun('r1', 'More detail');
    await listRunNotes('r1', 0, { stepIndex: 2 });
    expect(global.fetch.mock.calls[0][0]).toBe('/api/pipelines/runs/r1/approve');
    expect(global.fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ comment: 'More detail' }) });
    expect(global.fetch.mock.calls[2][0]).toContain('stepIndex=2');
  });
  it('loads a run notes page newest first', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ data: [], page: { hasNextPage: false } }));
    await listRunNotes('run-1', 2);
    expect(global.fetch.mock.calls[0][0]).toBe('/api/pipelines/runs/run-1/notes?page=2&size=50&sort=createdAt%2Cdesc');
  });
  it('lists workflows from the paginated envelope', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      data: [{ id: 'w1', name: 'Feature' }],
      page: { hasNextPage: false },
    }));

    await expect(listWorkflows()).resolves.toEqual([{ id: 'w1', name: 'Feature' }]);
    expect(global.fetch).toHaveBeenCalledWith('/api/pipelines/workflows?page=0&size=100', expect.anything());
  });

  it('fetches preflight for a project', async () => {
    const body = { project: 'Demo', eligible: true, reasons: [], dirty: false, branch: 'main', head: 'a'.repeat(40) };
    global.fetch = vi.fn(async () => jsonResponse(body));

    await expect(preflightProject('Demo')).resolves.toEqual(body);
    expect(global.fetch).toHaveBeenCalledWith('/api/pipelines/preflight?project=Demo', expect.anything());
  });

  it('lists open runs with open=true and size=100', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      data: [{ id: 'r1', status: 'running' }],
      page: { hasNextPage: false },
    }));

    await expect(listOpenRuns({ project: 'Demo' })).resolves.toEqual([{ id: 'r1', status: 'running' }]);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/pipelines/runs?');
    expect(url).toContain('open=true');
    expect(url).toContain('size=100');
    expect(url).toContain('project=Demo');
  });

  it('fetches a single run by id', async () => {
    const run = { id: 'r1', status: 'complete' };
    global.fetch = vi.fn(async () => jsonResponse(run));

    await expect(getRun('r1')).resolves.toEqual(run);
    expect(global.fetch).toHaveBeenCalledWith('/api/pipelines/runs/r1', expect.anything());
  });

  it('sends ordered file parts and multiline metadata with a browser-generated boundary', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ id: 'r1' }, { status: 201 }));
    const fields = { requestId: 'req-1', workflowId: 'w1', project: 'Demo', input: 'a\n\nb' };
    const files = [new File(['a'], 'ref.txt'), new File(['bc'], 'ref.txt')];
    await startRun({ ...fields, files });
    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers).toBeUndefined();
    expect(options.body).toBeInstanceOf(FormData);
    expect(JSON.parse(options.body.get('run'))).toEqual(fields);
    expect(options.body.getAll('files')).toEqual(files);
  });

  it('starts a run and returns the run view', async () => {
    const run = { id: 'r1', status: 'pending', actions: { stop: true } };
    global.fetch = vi.fn(async () => jsonResponse(run, { status: 201 }));

    await expect(startRun({
      requestId: 'req-1',
      workflowId: '11111111-1111-1111-1111-111111111111',
      project: 'Demo',
      input: 'build it',
    })).resolves.toEqual(run);

    expect(global.fetch).toHaveBeenCalledWith('/api/pipelines/runs', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'req-1',
        workflowId: '11111111-1111-1111-1111-111111111111',
        project: 'Demo',
        input: 'build it',
      }),
    }));
  });

  it('lists every page of a project\'s worktrees', async () => {
    global.fetch = vi.fn(async (url) => jsonResponse(String(url).includes('page=0')
      ? { data: [{ path: '/a' }], page: { hasNextPage: true } }
      : { data: [{ path: '/b' }], page: { hasNextPage: false } }));

    await expect(listWorktrees('My Project')).resolves.toEqual([{ path: '/a' }, { path: '/b' }]);
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/pipelines/worktrees?page=0&size=100&project=My+Project',
      '/api/pipelines/worktrees?page=1&size=100&project=My+Project',
    ]);
  });

  it('sends worktreePath only when an existing worktree is chosen', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ id: 'r1' }, { status: 201 }));
    const fields = { requestId: 'req-1', workflowId: '11111111-1111-1111-1111-111111111111', project: 'Demo', input: 'x' };

    await startRun({ ...fields, worktreePath: '/git/worktrees/demo-feature' });
    await startRun({ ...fields, worktreePath: undefined });
    const bodies = global.fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(bodies).toEqual([{ ...fields, worktreePath: '/git/worktrees/demo-feature' }, fields]);
  });

  it('asks what a run would work from', async () => {
    const plan = { progressFile: null, input: 'x', foundIn: null, problem: null, repositories: null };
    global.fetch = vi.fn(async () => jsonResponse(plan));
    const signal = new AbortController().signal;
    expect(await planRun({ workflowId: '11111111-1111-1111-1111-111111111111', project: 'Demo', input: 'x' }, { signal })).toEqual(plan);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/pipelines/run-plans');
    expect(options.method).toBe('POST');
    expect(options.signal).toBe(signal);
    expect(JSON.parse(options.body)).toEqual({ workflowId: '11111111-1111-1111-1111-111111111111', project: 'Demo', input: 'x' });
  });

  it('sends the repository the run starts in, with an open task and with a new one', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ id: 'r1' }, { status: 201 }));
    const fields = { requestId: 'req-1', workflowId: '11111111-1111-1111-1111-111111111111', project: 'Demo', input: 'x' };
    const inTask = { ...fields, taskId: '7a000000-0000-4000-8000-000000000001', startIn: 'mobile-app' };
    const forNew = { ...fields, newTask: { repositories: ['mobile-app', 'backend'] }, startIn: 'mobile-app' };

    await startRun(inTask);
    await startRun(forNew);
    await startRun({ ...fields, startIn: undefined });
    expect(global.fetch.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([inTask, forNew, fields]);
  });

  it.each([
    ['stopRun', stopRun, '/api/pipelines/runs/r1/stop'],
    ['resumeRun', resumeRun, '/api/pipelines/runs/r1/resume'],
    ['continueRun', continueRun, '/api/pipelines/runs/r1/continue'],
  ])('%s posts to the owner-action endpoint', async (_name, action, url) => {
    const run = { id: 'r1', status: 'stopped' };
    global.fetch = vi.fn(async () => jsonResponse(run));

    await expect(action('r1')).resolves.toEqual(run);
    expect(global.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST' }));
  });

  it('cleanupRun posts to the cleanup endpoint and returns the run with the terminals the backend closed', async () => {
    const closed = { id: 'r1', status: 'complete', terminalsClosed: ['Demo-3', 'Demo-4'], terminalsNotClosed: ['Demo-5'] };
    global.fetch = vi.fn(async () => jsonResponse(closed));

    await expect(cleanupRun('r1')).resolves.toEqual(closed);
    expect(global.fetch).toHaveBeenCalledWith('/api/pipelines/runs/r1/cleanup', expect.objectContaining({ method: 'POST' }));
  });

  it.each([
    ['terminalsClosed', { id: 'r1', terminalsNotClosed: [] }],
    ['terminalsClosed', { id: 'r1', terminalsClosed: 'Demo-3', terminalsNotClosed: [] }],
    ['terminalsClosed', { id: 'r1', terminalsClosed: [''], terminalsNotClosed: [] }],
    ['terminalsNotClosed', { id: 'r1', terminalsClosed: [] }],
    ['terminalsNotClosed', { id: 'r1', terminalsClosed: [], terminalsNotClosed: [7] }],
  ])('cleanupRun refuses a response without a readable %s', async (field, body) => {
    global.fetch = vi.fn(async () => jsonResponse(body));
    await expect(cleanupRun('r1')).rejects.toThrow(`Invalid close run response: ${field}`);
  });

  it('answerRun posts the answer as the JSON body of the answer endpoint', async () => {
    const run = { id: 'r1', status: 'running' };
    global.fetch = vi.fn(async () => jsonResponse(run));

    await expect(answerRun('r1', '1. yes\n2. no')).resolves.toEqual(run);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/pipelines/runs/r1/answer');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ answer: '1. yes\n2. no' });
  });

  it('listRunDecisions fetches one page of a run\'s decisions, oldest first', async () => {
    const body = { data: [], page: { currentPage: 2, size: 50, totalElements: 0, totalPages: 0, hasNextPage: false } };
    global.fetch = vi.fn(async () => jsonResponse(body));

    await expect(listRunDecisions('r 1', 2)).resolves.toEqual(body);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/pipelines/runs/r%201/decisions?page=2&size=50&sort=createdAt%2Casc');
    expect(init.method).toBeUndefined();
  });

  it.each([undefined, null, -1, 1.5, '0'])('listRunDecisions refuses the page %j before any request', async (page) => {
    global.fetch = vi.fn();
    expect(() => listRunDecisions('r1', page)).toThrow('page must be a whole number of 0 or more');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('listRunDecisions carries the server\'s refusal', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ message: 'Run not found' }, { ok: false, status: 404 }));
    await expect(listRunDecisions('r1', 0)).rejects.toMatchObject({ name: 'PipelineApiError', status: 404, message: 'Run not found' });
  });

  it.each([undefined, null, '', '   ', 5])('answerRun refuses the answer %j before any request', async (answer) => {
    global.fetch = vi.fn();
    expect(() => answerRun('r1', answer)).toThrow('answer must be a non-empty string');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws PipelineApiError with message and errors when the response is not ok', async () => {
    global.fetch = vi.fn(async () => jsonResponse({
      message: 'One or more fields failed validation.',
      errors: [{ field: 'input', message: 'must be a single line' }],
    }, { ok: false, status: 400 }));

    await expect(startRun({
      requestId: 'req-1',
      workflowId: '11111111-1111-1111-1111-111111111111',
      project: 'Demo',
      input: 'a\nb',
    })).rejects.toMatchObject({
      name: 'PipelineApiError',
      message: 'One or more fields failed validation.',
      status: 400,
      errors: [{ field: 'input', message: 'must be a single line' }],
    });
  });

  it('falls back to a status message when the problem body has no message', async () => {
    global.fetch = vi.fn(async () => jsonResponse({}, { ok: false, status: 500 }));

    await expect(listOpenRuns()).rejects.toBeInstanceOf(PipelineApiError);
    await expect(listOpenRuns()).rejects.toThrow(/failed \(500\)/i);
  });

  it('rejects a non-array data envelope', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ data: null, page: { hasNextPage: false } }));

    await expect(listOpenRuns()).rejects.toThrow(/invalid/i);
  });

  describe('definitions', () => {
    const AGENT_ID = '6f1c1c1c-1111-4111-8111-111111111111';
    const WORKFLOW_ID = 'a2d0a2d0-2222-4222-8222-222222222222';

    function lastCall() {
      const [url, options] = global.fetch.mock.calls.at(-1);
      return { url, method: options.method, body: options.body === undefined ? undefined : JSON.parse(options.body) };
    }

    it('lists every agent across pages', async () => {
      global.fetch = vi.fn(async (url) => jsonResponse(String(url).includes('page=0')
        ? { data: [{ id: 'a1' }], page: { hasNextPage: true } }
        : { data: [{ id: 'a2' }], page: { hasNextPage: false } }));

      await expect(listAgents()).resolves.toEqual([{ id: 'a1' }, { id: 'a2' }]);
      expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
        '/api/pipelines/agents?page=0&size=100',
        '/api/pipelines/agents?page=1&size=100',
      ]);
    });

    it('creates, reads, replaces and deletes an agent', async () => {
      global.fetch = vi.fn(async () => jsonResponse({ id: AGENT_ID }));
      const fields = { name: 'codex', launchCommand: 'codex', resetCommand: '/clear' };

      await createAgent(fields);
      expect(lastCall()).toEqual({ url: '/api/pipelines/agents', method: 'POST', body: fields });

      await getAgent(AGENT_ID);
      expect(global.fetch.mock.calls.at(-1)[0]).toBe(`/api/pipelines/agents/${AGENT_ID}`);

      await updateAgent(AGENT_ID, { ...fields, revision: 3 });
      expect(lastCall()).toEqual({ url: `/api/pipelines/agents/${AGENT_ID}`, method: 'PUT', body: { ...fields, revision: 3 } });

      global.fetch = vi.fn(async () => ({ ok: true, status: 204, json: async () => { throw new Error('no body'); } }));
      await expect(deleteAgent(AGENT_ID)).resolves.toEqual({});
      expect(lastCall()).toEqual({ url: `/api/pipelines/agents/${AGENT_ID}`, method: 'DELETE', body: undefined });
    });

    it('creates, reads, replaces and deletes a workflow', async () => {
      global.fetch = vi.fn(async () => jsonResponse({ id: WORKFLOW_ID }));
      const fields = { name: 'Feature', nodes: [{ name: 'Develop', agentId: AGENT_ID, prompt: '/dev {input}', repeat: { mode: 'once' } }] };

      await createWorkflow(fields);
      expect(lastCall()).toEqual({ url: '/api/pipelines/workflows', method: 'POST', body: fields });

      await getWorkflow(WORKFLOW_ID);
      expect(global.fetch.mock.calls.at(-1)[0]).toBe(`/api/pipelines/workflows/${WORKFLOW_ID}`);

      await updateWorkflow(WORKFLOW_ID, { ...fields, revision: 2 });
      expect(lastCall()).toEqual({ url: `/api/pipelines/workflows/${WORKFLOW_ID}`, method: 'PUT', body: { ...fields, revision: 2 } });

      await deleteWorkflow(WORKFLOW_ID);
      expect(lastCall()).toEqual({ url: `/api/pipelines/workflows/${WORKFLOW_ID}`, method: 'DELETE', body: undefined });
    });

    it('reads and replaces the pipeline settings', async () => {
      global.fetch = vi.fn(async () => jsonResponse({ setupAgentId: null, setupEffort: null, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1 }));

      await expect(getPipelineSettings()).resolves.toEqual({ setupAgentId: null, setupEffort: null, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1 });
      expect(global.fetch.mock.calls.at(-1)[0]).toBe('/api/pipelines/settings');

      await updatePipelineSettings({ setupAgentId: AGENT_ID, setupEffort: null, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1 });
      expect(lastCall()).toEqual({ url: '/api/pipelines/settings', method: 'PUT', body: { setupAgentId: AGENT_ID, setupEffort: null, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1 } });
    });

    it('carries the status, message and field errors of a refused mutation', async () => {
      global.fetch = vi.fn(async () => jsonResponse(
        { message: 'Cannot delete an agent used by a workflow', errors: [] },
        { ok: false, status: 409 },
      ));

      const failure = await deleteAgent(AGENT_ID).catch(error => error);
      expect(failure).toBeInstanceOf(PipelineApiError);
      expect(failure).toMatchObject({ status: 409, message: 'Cannot delete an agent used by a workflow' });
    });
  });
});

it('continueRun sends the pause the owner saw', async () => {
  const run = { id: 'r1', status: 'running' };
  global.fetch = vi.fn(async () => jsonResponse(run));
  await expect(continueRun('r1', { stepIndex: 1, roundsCompleted: 7, extraRounds: 1 })).resolves.toEqual(run);
  expect(global.fetch).toHaveBeenCalledWith('/api/pipelines/runs/r1/continue',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ stepIndex: 1, roundsCompleted: 7, extraRounds: 1 }) }));
});
