const BASE = '/api/pipelines';

export class PipelineApiError extends Error {
  constructor(message, { status = 0, errors = [] } = {}) {
    super(message);
    this.name = 'PipelineApiError';
    this.status = status;
    this.errors = Array.isArray(errors) ? errors : [];
  }
}

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    ...(options.body !== undefined
      ? {
          headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
          body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
        }
      : {}),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new PipelineApiError(
      body.message || body.error || `Pipelines request failed (${response.status})`,
      { status: response.status, errors: body.errors },
    );
  }
  return body;
}

async function listAll(path, { signal, query = {} } = {}) {
  const records = [];
  for (let page = 0; ; page++) {
    const params = new URLSearchParams({ page: String(page), size: '100', ...query });
    const body = await request(`${path}?${params}`, { signal });
    if (!Array.isArray(body.data) || typeof body.page?.hasNextPage !== 'boolean') {
      throw new PipelineApiError('Invalid pipelines response');
    }
    records.push(...body.data);
    if (!body.page.hasNextPage) return records;
  }
}

export function listWorkflows({ signal } = {}) {
  return listAll('/workflows', { signal });
}

export function preflightProject(project, { signal } = {}) {
  const params = new URLSearchParams({ project });
  return request(`/preflight?${params}`, { signal });
}

export function listOpenRuns({ project, signal } = {}) {
  const query = { open: 'true' };
  if (project) query.project = project;
  return listAll('/runs', { signal, query });
}

export function getRun(runId, { signal } = {}) {
  return request(`/runs/${encodeURIComponent(runId)}`, { signal });
}

export function startRun({ requestId, workflowId, project, input }, { signal } = {}) {
  return request('/runs', {
    method: 'POST',
    body: { requestId, workflowId, project, input },
    signal,
  });
}

function postAction(runId, action, { signal } = {}) {
  return request(`/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST', signal });
}

export function stopRun(runId, options) {
  return postAction(runId, 'stop', options);
}

export function resumeRun(runId, options) {
  return postAction(runId, 'resume', options);
}

export function continueRun(runId, options) {
  return postAction(runId, 'continue', options);
}

export function cleanupRun(runId, options) {
  return postAction(runId, 'cleanup', options);
}
