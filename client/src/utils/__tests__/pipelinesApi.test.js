import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PipelineApiError,
  cleanupRun,
  continueRun,
  getRun,
  listOpenRuns,
  listWorkflows,
  preflightProject,
  resumeRun,
  startRun,
  stopRun,
} from '../pipelinesApi';

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

  it.each([
    ['stopRun', stopRun, '/api/pipelines/runs/r1/stop'],
    ['resumeRun', resumeRun, '/api/pipelines/runs/r1/resume'],
    ['continueRun', continueRun, '/api/pipelines/runs/r1/continue'],
    ['cleanupRun', cleanupRun, '/api/pipelines/runs/r1/cleanup'],
  ])('%s posts to the owner-action endpoint', async (_name, action, url) => {
    const run = { id: 'r1', status: 'stopped' };
    global.fetch = vi.fn(async () => jsonResponse(run));

    await expect(action('r1')).resolves.toEqual(run);
    expect(global.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST' }));
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
});
