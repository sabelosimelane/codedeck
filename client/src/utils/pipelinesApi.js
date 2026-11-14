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

export function listAgents({ signal } = {}) {
  return listAll('/agents', { signal });
}

function itemPath(collection, id) {
  return `/${collection}/${encodeURIComponent(id)}`;
}

export function getAgent(id, { signal } = {}) {
  return request(itemPath('agents', id), { signal });
}

export function createAgent(fields, { signal } = {}) {
  return request('/agents', { method: 'POST', body: fields, signal });
}

export function updateAgent(id, fields, { signal } = {}) {
  return request(itemPath('agents', id), { method: 'PUT', body: fields, signal });
}

export function deleteAgent(id, { signal } = {}) {
  return request(itemPath('agents', id), { method: 'DELETE', signal });
}

export function getWorkflow(id, { signal } = {}) {
  return request(itemPath('workflows', id), { signal });
}

export function createWorkflow(fields, { signal } = {}) {
  return request('/workflows', { method: 'POST', body: fields, signal });
}

export function updateWorkflow(id, fields, { signal } = {}) {
  return request(itemPath('workflows', id), { method: 'PUT', body: fields, signal });
}

export function deleteWorkflow(id, { signal } = {}) {
  return request(itemPath('workflows', id), { method: 'DELETE', signal });
}

export function getPipelineSettings({ signal } = {}) {
  return request('/settings', { signal });
}

export function updatePipelineSettings({ setupAgentId, revision }, { signal } = {}) {
  return request('/settings', { method: 'PUT', body: { setupAgentId, revision }, signal });
}

export function preflightProject(project, { signal } = {}) {
  const params = new URLSearchParams({ project });
  return request(`/preflight?${params}`, { signal });
}

/** Every working tree of the project's repository: its home checkout and linked worktrees. */
export function listWorktrees(project, { signal } = {}) {
  return listAll('/worktrees', { signal, query: { project } });
}

export function listOpenRuns({ project, signal } = {}) {
  const query = { open: 'true' };
  if (project) query.project = project;
  return listAll('/runs', { signal, query });
}

export function getRun(runId, { signal } = {}) {
  return request(`/runs/${encodeURIComponent(runId)}`, { signal });
}

/** `worktreePath` names an existing worktree to run in; without it the run gets a new worktree. */
export function startRun({ requestId, workflowId, project, input, worktreePath }, { signal } = {}) {
  return request('/runs', {
    method: 'POST',
    body: { requestId, workflowId, project, input, ...(worktreePath === undefined ? {} : { worktreePath }) },
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

/** Types the owner's answer into the terminal of an agent that signalled NEEDS_INPUT. */
export function answerRun(runId, answer, { signal } = {}) {
  if (typeof answer !== 'string' || !answer.trim()) throw new PipelineApiError('answer must be a non-empty string');
  return request(`/runs/${encodeURIComponent(runId)}/answer`, { method: 'POST', body: { answer }, signal });
}

const DECISIONS_PAGE_SIZE = 50;

/** One page of the requests a run's agents settled themselves, in the order they were settled. */
export function listRunDecisions(runId, page, { signal } = {}) {
  if (!Number.isSafeInteger(page) || page < 0) throw new PipelineApiError('page must be a whole number of 0 or more');
  const params = new URLSearchParams({ page: String(page), size: String(DECISIONS_PAGE_SIZE), sort: 'createdAt,asc' });
  return request(`/runs/${encodeURIComponent(runId)}/decisions?${params}`, { signal });
}

export function cleanupRun(runId, options) {
  return postAction(runId, 'cleanup', options);
}
