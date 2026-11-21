import { teamScoreResponse } from '../../../shared/team-score-responses.mjs';

const BASE = '/api/pipelines';

export class PipelineApiError extends Error {
  constructor(message, { status = 0, errors = [], reservation = null, code = null, host = null, results = null } = {}) {
    super(message);
    this.name = 'PipelineApiError';
    this.status = status;
    this.errors = Array.isArray(errors) ? errors : [];
    this.reservation = reservation;
    if (code) this.code = code;
    if (host) this.host = host;
    if (results) this.results = results;
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
    ...(options.body !== undefined && !(options.body instanceof FormData)
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
      {
        status: response.status,
        errors: body.errors,
        reservation: body.reservation,
        code: body.code,
        host: body.host,
        results: body.results,
      },
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

export function listTeams({ signal } = {}) {
  return listAll('/teams', { signal });
}

export function saveTeam(id, fields) {
  return id === null ? request('/teams', { method: 'POST', body: fields })
    : request(itemPath('teams', id), { method: 'PUT', body: fields });
}

export function deleteTeam(id) {
  return request(itemPath('teams', id), { method: 'DELETE' });
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

/**
 * What the agent of one step would be sent, composed by the backend with the functions a run
 * uses. `workflow` is the draft without agents; nothing is saved.
 */
export function previewPrompt({ workflow, nodeIndex, input }, { signal } = {}) {
  return request('/prompt-previews', { method: 'POST', body: { workflow, nodeIndex, input }, signal });
}

/** What a run of this workflow with this input would work from: where its todo is and which repositories it names. Reads only. */
export function planRun({ workflowId, project, input }, { signal } = {}) {
  return request('/run-plans', { method: 'POST', body: { workflowId, project, input }, signal });
}

/** Workflow templates the owner saved; the built-in ones are shared code, not records. */
export function listTemplates({ signal } = {}) {
  return listAll('/templates', { signal });
}

export function createTemplate(fields, { signal } = {}) {
  return request('/templates', { method: 'POST', body: fields, signal });
}

export function deleteTemplate(id, { signal } = {}) {
  return request(itemPath('templates', id), { method: 'DELETE', signal });
}

/** Steps the owner saved for reuse; inserting one copies it into a workflow. */
export function listStepPresets({ signal } = {}) {
  return listAll('/step-presets', { signal });
}

export function createStepPreset(fields, { signal } = {}) {
  return request('/step-presets', { method: 'POST', body: fields, signal });
}

export function deleteStepPreset(id, { signal } = {}) {
  return request(itemPath('step-presets', id), { method: 'DELETE', signal });
}

export function getPipelineSettings({ signal } = {}) {
  return request('/settings', { signal });
}

export function updatePipelineSettings({ setupAgentId, revision }, { signal } = {}) {
  return request('/settings', { method: 'PUT', body: { setupAgentId, revision }, signal });
}

export function preflightProject(project, { host, signal } = {}) {
  const params = new URLSearchParams({ project, ...(host ? { host } : {}) });
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

/**
 * Where the run works is one of: `newTask` (a task created for it; `{ title }` when the owner
 * typed one, `{}` to have it named from the run's work), `taskId` (an open
 * task) or `worktreePath` (an existing working tree, such as Main). `startIn` names the repository
 * of the task the run starts in, for a project with several.
 */
export function startRun({ requestId, workflowId, project, input, worktreePath, taskId, newTask, startIn, teamId, stepOverrides, host, skipSync, files = [] }, { signal } = {}) {
  if (!Array.isArray(files)) throw new TypeError('Workflow files must be an array');
  const fields = {
    requestId, workflowId, project, input, teamId, stepOverrides,
    ...(worktreePath === undefined ? {} : { worktreePath }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(newTask === undefined ? {} : { newTask }),
    ...(startIn === undefined ? {} : { startIn }),
    ...(host === undefined ? {} : { host }),
    ...(skipSync === undefined ? {} : { skipSync }),
  };
  if (files.length === 0) return request('/runs', { method: 'POST', body: fields, signal });
  const body = new FormData();
  body.append('run', JSON.stringify(fields));
  for (const file of files) {
    if (!(file instanceof File)) throw new TypeError('Workflow attachment must be a File');
    body.append('files', file);
  }
  return request('/runs', { method: 'POST', body, signal });
}

function postAction(runId, action, { signal } = {}) {
  return request(`/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST', signal });
}

export function changeRunTeam(runId, assignment) {
  return request(`/runs/${encodeURIComponent(runId)}/team`, { method: 'PUT', body: assignment });
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

export function approveRun(runId, options) {
  return postAction(runId, 'approve', options);
}

export function sendBackRun(runId, comment, { signal } = {}) {
  if (typeof comment !== 'string' || !comment.trim() || comment.length > 4000 || /[\x00-\x09\x0b-\x1f\x7f]/.test(comment)) throw new PipelineApiError('comment must be 1–4000 characters without control characters other than new lines');
  return request(`/runs/${encodeURIComponent(runId)}/send-back`, { method: 'POST', body: { comment }, signal });
}

/** Types the owner's answer into the terminal of an agent that signalled NEEDS_INPUT. */
export function answerRun(runId, answer, { signal } = {}) {
  if (typeof answer !== 'string' || !answer.trim()) throw new PipelineApiError('answer must be a non-empty string');
  return request(`/runs/${encodeURIComponent(runId)}/answer`, { method: 'POST', body: { answer }, signal });
}

const DECISIONS_PAGE_SIZE = 50;

/** One page of the requests a run's agents settled themselves, in the order they were settled. */
const requireStepIndex = stepIndex => {
  if (stepIndex !== undefined && (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32)) throw new PipelineApiError('stepIndex must be an integer from 0 to 32');
};

export function listRunDecisions(runId, page, { signal, stepIndex } = {}) {
  if (!Number.isSafeInteger(page) || page < 0) throw new PipelineApiError('page must be a whole number of 0 or more');
  requireStepIndex(stepIndex);
  const params = new URLSearchParams({ page: String(page), size: String(DECISIONS_PAGE_SIZE), sort: 'createdAt,asc' });
  if (stepIndex !== undefined) params.set('stepIndex', String(stepIndex));
  return request(`/runs/${encodeURIComponent(runId)}/decisions?${params}`, { signal });
}

/** What the owner answered when an agent asked, oldest first; `stepIndex` narrows it to one step. */
export function listRunAnswers(runId, { signal, stepIndex } = {}) {
  requireStepIndex(stepIndex);
  const params = new URLSearchParams({ page: '0', size: '100', sort: 'createdAt,asc' });
  if (stepIndex !== undefined) params.set('stepIndex', String(stepIndex));
  return request(`/runs/${encodeURIComponent(runId)}/answers?${params}`, { signal });
}

/** The owner's approvals and send-backs of a run, oldest first; `stepIndex` narrows them to one step. */
export function listRunReviews(runId, { signal, stepIndex } = {}) {
  requireStepIndex(stepIndex);
  const params = new URLSearchParams({ page: '0', size: '100', sort: 'createdAt,asc' });
  if (stepIndex !== undefined) params.set('stepIndex', String(stepIndex));
  return request(`/runs/${encodeURIComponent(runId)}/reviews?${params}`, { signal });
}

/** One page of notes reported by a run's steps, newest first. */
export function listRunNotes(runId, page, { signal, stepIndex } = {}) {
  if (!Number.isSafeInteger(page) || page < 0) throw new PipelineApiError('page must be a whole number of 0 or more');
  if (stepIndex !== undefined && (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32)) throw new PipelineApiError('stepIndex must be an integer from 0 to 32');
  const params = new URLSearchParams({ page: String(page), size: '50', sort: 'createdAt,desc' });
  if (stepIndex !== undefined) params.set('stepIndex', String(stepIndex));
  return request(`/runs/${encodeURIComponent(runId)}/notes?${params}`, { signal });
}

/**
 * Close run (or, for a run with a worktree of its own, clean it up). The answer is the run with
 * `terminalsClosed` and `terminalsNotClosed`: which of the run's terminals the backend closed, and which it could not.
 */
export async function cleanupRun(runId, options) {
  const closed = await postAction(runId, 'cleanup', options);
  for (const field of ['terminalsClosed', 'terminalsNotClosed']) {
    if (!Array.isArray(closed?.[field]) || !closed[field].every(id => typeof id === 'string' && id.trim() !== '')) {
      throw new PipelineApiError(`Invalid close run response: ${field}`);
    }
  }
  return closed;
}

export function improvementDashboard(query, signal) {
  return Promise.all([
    listAll('/improvements/outcomes', { query, signal }),
    listAll('/improvements/proposals', { query, signal }),
    listAll('/improvements/calls', { query, signal }),
    request('/improvements/status', { signal }),
  ]);
}
export function improvementEvidence(id, signal) {
  return request(itemPath('improvements/outcomes', id), { signal });
}
export function improvementAction(path, body) {
  return request('/improvements/' + path, { method: 'POST', body });
}
export function configureReviewer(body) {
  return request('/improvements/model', { method: 'PUT', body });
}

const teamBase = '/improvements/teams';
export function teamImprovementDashboard(signal) {
  return Promise.all([
    listAll(teamBase + '/scorecards', { signal }).then(teamScoreResponse.scorecards),
    listAll(teamBase + '/trials', { signal }).then(teamScoreResponse.trials),
  ]);
}
export function teamScoreRuns(cardId, signal) {
  return listAll(teamBase + '/runs', { signal, query: { cardId } }).then(teamScoreResponse.runs);
}
export function teamRunEvidence(id, signal) {
  return request(itemPath('improvements/teams/runs', id), { signal }).then(teamScoreResponse.detail);
}
export function teamRunHistory(id, signal) {
  return listAll(itemPath('improvements/teams/runs', id) + '/history', { signal }).then(teamScoreResponse.history);
}
export function correctDeliveryVerdict(id, body) {
  return request(itemPath('improvements/teams/runs', id) + '/corrections', { method: 'POST', body }).then(teamScoreResponse.detail);
}
export function decideTeamTrial(id, body) {
  return request(itemPath('improvements/teams/trials', id) + '/decision', { method: 'POST', body }).then(teamScoreResponse.trial);
}
