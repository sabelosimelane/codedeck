import { teamScoreResponse } from '../../../shared/team-score-responses.mjs';
import { DESCRIPTION_MAX, WORKFLOW_KINDS, isUuid, validateWorkflowBody } from '../../../shared/pipeline-definitions.mjs';
import { isUuidV4, validatePackage } from '../../../shared/workflow-package.mjs';

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

async function request(path, { expectedStatus, ...options } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    ...(options.body !== undefined && !(options.body instanceof FormData)
      ? {
          headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
          body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
        }
      : {}),
  });
  if (!response.ok) {
    const body = await readBody(response);
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
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new PipelineApiError(`Unexpected pipelines response status (${response.status})`, { status: response.status });
  }
  return expectedStatus === 204 ? {} : readBody(response);
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

const BUILT_IN_STATUSES = ['new', 'linked', 'dismissed'];

/** One shipped built-in with whether this install linked or dismissed it (§5.3, §7). */
function isBuiltinRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
  if (typeof row.id !== 'string' || row.id.length < 1 || row.id.length > 64 || !BUILT_IN_ID_RE.test(row.id)) return false;
  if (typeof row.name !== 'string' || row.name.trim() === '') return false;
  if (!WORKFLOW_KINDS.includes(row.kind)) return false;
  if (typeof row.description !== 'string') return false;
  if (!Number.isInteger(row.version) || row.version < 1 || row.version > IMPORT_SOURCE_VERSION_MAX) return false;
  if (!BUILT_IN_STATUSES.includes(row.status)) return false;
  // A linked row names the workflow; any other row names none.
  if (row.status === 'linked') return isUuid(row.workflowId);
  return row.workflowId === null;
}

/** Every built-in shipped with CodeDeck with whether this install linked or dismissed it. */
export async function listBuiltinWorkflows({ signal } = {}) {
  const rows = await listAll('/builtin-workflows', { signal });
  if (!rows.every(isBuiltinRow)) throw new PipelineApiError('Invalid built-in workflows from the pipelines API');
  return rows;
}

/** Link a shipped built-in as a new workflow; the 201 carries a §4.4 source view. */
export async function addBuiltinWorkflow(id, { signal } = {}) {
  const body = await request(`/builtin-workflows/${encodeURIComponent(id)}/additions`, { method: 'POST', signal });
  // The addition is a linked built-in of the requested id with every step unassigned
  // (§5.1 / §5.3). A local, imported, wrong-id or assigned receipt is malformed.
  if (!isImportWorkflow(body)
    || body.source.kind !== 'builtin'
    || body.source.id !== id
    || !body.nodes.every(node => node.agentId === null)) {
    throw new PipelineApiError('Invalid built-in workflow from the pipelines API');
  }
  return body;
}

/** Dismiss a new built-in so it is never offered again (§5.3). */
export function dismissBuiltinWorkflow(id, { signal } = {}) {
  return request(`/builtin-workflows/${encodeURIComponent(id)}/dismissals`, { method: 'POST', signal, expectedStatus: 204 });
}

/** The package file of a workflow, as the export endpoint writes it. */
export async function exportWorkflow(id, { signal } = {}) {
  const body = await request(`${itemPath('workflows', id)}/export`, { signal });
  const [firstError] = validatePackage(body);
  if (firstError) throw new PipelineApiError(`Invalid workflow package from the pipelines API: ${firstError.field}`);
  return body;
}

const IMPORT_MODES = ['new', 'name-clash', 'update', 'up-to-date'];

function isPreviewTarget(target) {
  if (target === null || typeof target !== 'object' || Array.isArray(target) || !IMPORT_MODES.includes(target.mode)) {
    return false;
  }
  if (target.mode === 'new') {
    return Object.keys(target).every(key => key === 'mode');
  }
  if (!isUuid(target.workflowId)) return false;
  if (target.mode === 'up-to-date') {
    return Object.keys(target).every(key => key === 'mode' || key === 'workflowId');
  }
  if (!Number.isInteger(target.revision) || target.revision < 1) return false;
  if (target.mode === 'name-clash') {
    return typeof target.suggestedName === 'string' && target.suggestedName.trim().length > 0
      && Object.keys(target).every(key => ['mode', 'workflowId', 'revision', 'suggestedName'].includes(key));
  }
  return Number.isInteger(target.fromVersion) && target.fromVersion >= 1
    && Object.keys(target).every(key => ['mode', 'workflowId', 'revision', 'fromVersion'].includes(key));
}

/** A preview workflow is a definition: every field validated, every node carrying a role. */
function isPreviewWorkflow(workflow) {
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) return false;
  if (Object.hasOwn(workflow, 'revision')) return false;
  if (validateWorkflowBody(workflow, { template: true }).length) return false;
  return workflow.nodes.every(node => node !== null && typeof node === 'object'
    && typeof node.role === 'string' && node.role.trim() !== '');
}

/** Import previews carry no comparison yet: every staged mode previews with an empty change list until Phase 3 implements the §6.2 shape. */
function isPreviewChanges(changes) {
  return Array.isArray(changes) && changes.length === 0;
}

/** What importing a package file would do on this install, before anything is written. */
export async function previewImport(pkg, { signal } = {}) {
  const body = await request('/workflow-imports/previews', { method: 'POST', body: { package: pkg }, signal });
  if (body === null || typeof body !== 'object' || Array.isArray(body)
    || !isPreviewTarget(body.target)
    || !isPreviewWorkflow(body.workflow)
    || !isPreviewChanges(body.changes)
    || !Array.isArray(body.missingRoles)
    || !body.missingRoles.every(role => typeof role === 'string' && role.trim() !== '')) {
    throw new PipelineApiError('Invalid import preview from the pipelines API');
  }
  return body;
}

const IMPORT_SOURCE_KINDS = ['local', 'builtin', 'imported'];
const BUILT_IN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMPORT_SOURCE_VERSION_MAX = 2 ** 31 - 1;
const IMPORT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const IMPORT_TIMESTAMP_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

export function isImportTimestamp(value) {
  if (typeof value !== 'string' || !IMPORT_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) return false;
  // Date.parse rolls an impossible date over (Feb 30 becomes Mar 2), so the
  // calendar components must form a real date on their own.
  const parts = IMPORT_TIMESTAMP_PARTS.exec(value);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return Boolean(daysInMonth) && day >= 1 && day <= daysInMonth
    && Number(parts[4]) <= 23 && Number(parts[5]) <= 59 && Number(parts[6]) <= 59;
}

/** The `source` view of a workflow response (§4.4): kind, id, version and the read-only fields agree. */
function isImportSource(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return false;
  const { kind, id, version, latestVersion, updateAvailable, updatedToVersionAt, shipped } = source;
  if (!IMPORT_SOURCE_KINDS.includes(kind)) return false;
  if (kind === 'local') {
    if (id !== null || version !== null || latestVersion !== null || updateAvailable !== false || shipped !== null) {
      return false;
    }
  } else if (kind === 'imported') {
    if (!isUuidV4(id)) return false;
    if (!Number.isInteger(version) || version < 1 || version > IMPORT_SOURCE_VERSION_MAX) return false;
    if (latestVersion !== null || updateAvailable !== false || shipped !== null) return false;
  } else {
    if (typeof id !== 'string' || id.length < 1 || id.length > 64 || !BUILT_IN_ID_RE.test(id)) return false;
    if (!Number.isInteger(version) || version < 1 || version > IMPORT_SOURCE_VERSION_MAX) return false;
    if (typeof updateAvailable !== 'boolean' || typeof shipped !== 'boolean') return false;
    if (!shipped) {
      if (latestVersion !== null || updateAvailable !== false) return false;
    } else {
      if (!Number.isInteger(latestVersion) || latestVersion < 1 || latestVersion > IMPORT_SOURCE_VERSION_MAX) return false;
      if (updateAvailable !== (latestVersion > version)) return false;
    }
  }
  if (updatedToVersionAt !== null && !isImportTimestamp(updatedToVersionAt)) return false;
  return true;
}

/** The created workflow of an import (§7–8): a full workflow record with a §4.4 source view. */
function isImportWorkflow(body, { targetMode = null, pkgSource = null } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  if (!isUuid(body.id)) return false;
  if (!isImportSource(body.source)) return false;
  if (!isImportTimestamp(body.createdAt) || !isImportTimestamp(body.updatedAt)) return false;
  const { id: _id, source: _source, createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = body;
  if (validateWorkflowBody(definition, { revisionRequired: true }).length) return false;
  // The receipt is a persisted record, not a write body: WorkflowList parses it
  // with parseWorkflow, so fields the write validator lets callers omit must be
  // present here in their stored form.
  if (typeof definition.description !== 'string' || definition.description.length > DESCRIPTION_MAX
    || /[\x00-\x1f\x7f]/.test(definition.description)) return false;
  if (!WORKFLOW_KINDS.includes(definition.kind)) return false;
  if (definition.progressFile !== null
    && (typeof definition.progressFile !== 'string' || definition.progressFile.trim() === '')) return false;
  const nodesOk = definition.nodes.every(node => node !== null && typeof node === 'object' && !Array.isArray(node)
    && typeof node.role === 'string' && node.role.trim() !== ''
    && (isUuid(node.agentId) || (node.agentId === null && node.role.trim() !== ''))
    && typeof node.readOnly === 'boolean'
    && typeof node.approval === 'boolean'
    && typeof node.askOwner === 'boolean'
    && (node.enabled === undefined || typeof node.enabled === 'boolean'));
  if (!nodesOk) return false;
  // A new import (§5.6) is a linked copy: the server creates it as `imported`
  // from the file's source with every step unassigned (agentId null, assigned
  // by team role on this install). Any other receipt for mode=new is malformed.
  // Linkage is required, not optional: without the sent package's source the
  // client cannot tell whether the receipt is linked to that file.
  if (targetMode === 'new') {
    if (body.source.kind !== 'imported') return false;
    if (pkgSource === null || typeof pkgSource !== 'object' || Array.isArray(pkgSource)
      || typeof pkgSource.id !== 'string' || !Number.isInteger(pkgSource.version)
      || body.source.id !== pkgSource.id || body.source.version !== pkgSource.version) {
      return false;
    }
    if (!definition.nodes.every(node => node.agentId === null)) return false;
  }
  return true;
}

/** Applies an import preview choice; a new workflow is created, nothing is renamed in place. */
export async function importWorkflow(pkg, target, { signal } = {}) {
  const body = await request('/workflow-imports', { method: 'POST', body: { package: pkg, target }, signal });
  if (!isImportWorkflow(body, { targetMode: target?.mode, pkgSource: pkg?.source })) {
    throw new PipelineApiError('Invalid import response from the pipelines API');
  }
  return body;
}

/**
 * What the agent of one step would be sent, composed by the backend with the functions a run
 * uses. `workflow` is the draft without agents; nothing is saved.
 */
export function previewPrompt({ workflow, nodeIndex, input }, { signal } = {}) {
  return request('/prompt-previews', { method: 'POST', body: { workflow, nodeIndex, input }, signal });
}

/** What a run of this workflow with this input would work from: where its todo is and which repositories it names. Reads only. */
export function planRun({ workflowId, project, input, host }, { signal } = {}) {
  return request('/run-plans', {
    method: 'POST',
    body: {
      workflowId,
      project,
      input,
      ...(host === undefined ? {} : { host }),
    },
    signal,
  });
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

export function updatePipelineSettings({ setupAgentId, defaultBaseBranch, revision }, { signal } = {}) {
  return request('/settings', { method: 'PUT', body: { setupAgentId, defaultBaseBranch, revision }, signal });
}

export function preflightProject(project, { host, signal } = {}) {
  const params = new URLSearchParams({ project, ...(host ? { host } : {}) });
  return request(`/preflight?${params}`, { signal });
}

/** Every working tree of the project's repository: its home checkout and linked worktrees. */
export function listWorktrees(project, { host, signal } = {}) {
  return listAll('/worktrees', { signal, query: { project, ...(host ? { host } : {}) } });
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
export function startRun({ requestId, workflowId, project, input, worktreePath, taskId, newTask, startIn, teamId, stepOverrides, disabledSteps, host, skipSync, files = [] }, { signal } = {}) {
  if (!Array.isArray(files)) throw new TypeError('Workflow files must be an array');
  const fields = {
    requestId, workflowId, project, input, teamId, stepOverrides,
    ...(disabledSteps === undefined ? {} : { disabledSteps }),
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
export async function listRunAudit(runId, stepIndex) {
  if (typeof runId !== 'string' || !runId.trim()) throw new PipelineApiError('Audit requires a run id');
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32) throw new PipelineApiError('Audit requires a step index');
  const rows = await listAll(`/runs/${encodeURIComponent(runId)}/audit`, {query:{sort:'id,asc',stepIndex:String(stepIndex)}});
  for (const row of rows) {
    if (!row || row.runId !== runId || row.stepIndex !== stepIndex || !Number.isSafeInteger(row.id) || row.id < 1
      || !Number.isInteger(row.attempt) || row.attempt < 0 || !Number.isInteger(row.pass) || row.pass < 0
      || !['kind','host','worktreePath','agentName','createdAt'].every(key => typeof row[key] === 'string' && row[key].trim())
      || !Number.isFinite(Date.parse(row.createdAt)) || !['model','effort','sessionId','detail'].every(key => row[key] === null || typeof row[key] === 'string')) {
      throw new PipelineApiError('Invalid audit event');
    }
  }
  return rows;
}

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
