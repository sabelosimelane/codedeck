import { validateTeamBody, isBranchName, isUuid, loopTargetIndex, WORKFLOW_KINDS } from '../../../shared/pipeline-definitions.mjs';
import { PipelineApiError, getPipelineSettings, listAgents, listStepPresets, listTemplates, listWorkflows } from './pipelinesApi';

// Responses are an edge: every field of an agent, workflow and settings response is checked before use.
// Failures name the record and field, never a command's or prompt's content.

function invalid(kind, field, id) {
  return new PipelineApiError(`Invalid ${kind} from the pipelines API: ${field}${isUuid(id) ? ` (id ${id})` : ''}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRevision(value) {
  return Number.isInteger(value) && value >= 1;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isTimestamp(value) {
  return typeof value === 'string' && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

export function parseTeam(record) {
  if (!isObject(record)) throw invalid('team', 'record');
  const { id, name, members, revision, createdAt, updatedAt } = record;
  if (!isUuid(id)) throw invalid('team', 'id');
  const [error] = validateTeamBody({ name, members, revision }, { revisionRequired: true, allowFallbackClear: false });
  if (error) throw invalid('team', error.field, id);
  if (!isTimestamp(createdAt)) throw invalid('team', 'createdAt', id);
  if (!isTimestamp(updatedAt)) throw invalid('team', 'updatedAt', id);
  return { id, name, members, revision, createdAt, updatedAt };
}

export function parseAgent(record) {
  if (!isObject(record)) throw invalid('agent', 'agent');
  const { id, name, launchCommand, resetCommand, revision, createdAt, updatedAt } = record;
  if (!isUuid(id)) throw invalid('agent', 'id');
  if (!isText(name)) throw invalid('agent', 'name', id);
  if (!isText(launchCommand)) throw invalid('agent', 'launchCommand', id);
  if (!isText(resetCommand)) throw invalid('agent', 'resetCommand', id);
  if (!isRevision(revision)) throw invalid('agent', 'revision', id);
  if (!isTimestamp(createdAt)) throw invalid('agent', 'createdAt', id);
  if (!isTimestamp(updatedAt)) throw invalid('agent', 'updatedAt', id);
  return { id, name, launchCommand, resetCommand, revision, createdAt, updatedAt };
}

function parseRepeat(nodes, index, id) {
  const path = `nodes[${index}]`;
  const { repeat } = nodes[index];
  if (!isObject(repeat)) throw invalid('workflow', `${path}.repeat`, id);
  if (!['once', 'until_complete', 'loop_back'].includes(repeat.mode)) throw invalid('workflow', `${path}.repeat.mode`, id);
  const loops = repeat.mode === 'loop_back';
  // A loop names an earlier node of the workflow; no other repeat has a target.
  if (loops ? loopTargetIndex(nodes, index) < 0 : repeat.to !== undefined) throw invalid('workflow', `${path}.repeat.to`, id);
  if (repeat.mode === 'once') {
    if (repeat.max !== undefined) throw invalid('workflow', `${path}.repeat.max`, id);
    return { mode: 'once' };
  }
  if (!Number.isInteger(repeat.max) || repeat.max < 1 || repeat.max > 100) {
    throw invalid('workflow', `${path}.repeat.max`, id);
  }
  return loops ? { mode: 'loop_back', to: repeat.to, max: repeat.max } : { mode: 'until_complete', max: repeat.max };
}

const isLine = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** `withAgent` is false for a saved template, whose steps name no agent. */
function parseNode(nodes, index, id, kind = 'workflow', withAgent = true) {
  const node = nodes[index];
  const path = `nodes[${index}]`;
  if (!isObject(node)) throw invalid(kind, path, id);
  if (!isText(node.name)) throw invalid(kind, `${path}.name`, id);
  if (!isLine(node.role, 32)) throw invalid(kind, `${path}.role`, id);
  if (withAgent ? !(isUuid(node.agentId) || (node.agentId === null && isText(node.role))) : node.agentId !== undefined) throw invalid(kind, `${path}.agentId`, id);
  if (!isText(node.prompt)) throw invalid(kind, `${path}.prompt`, id);
  if (typeof node.readOnly !== 'boolean') throw invalid(kind, `${path}.readOnly`, id);
  if (typeof node.approval !== 'boolean' || (node.repeat?.mode === 'loop_back' && node.approval)) throw invalid(kind, `${path}.approval`, id);
  // Whether this step's questions always come to the owner, also when agents decide.
  if (typeof node.askOwner !== 'boolean') throw invalid(kind, `${path}.askOwner`, id);
  if (node.enabled !== undefined && typeof node.enabled !== 'boolean') throw invalid(kind, `${path}.enabled`, id);
  return { name: node.name, role: node.role, askOwner: node.askOwner, ...(withAgent ? { agentId: node.agentId } : {}), prompt: node.prompt, repeat: parseRepeat(nodes, index, id), readOnly: node.readOnly, approval: node.approval, ...(node.enabled === false ? { enabled: false } : {}) };
}

function parseDefinition(record, kind, withAgent) {
  if (!isObject(record)) throw invalid(kind, kind);
  const { id, name, description, agentsDecide, progressFile, revision, nodes, createdAt, updatedAt } = record;
  if (!isUuid(id)) throw invalid(kind, 'id');
  if (!isText(name)) throw invalid(kind, 'name', id);
  // What the workflow is for; it groups workflows and never changes how a run behaves.
  if (!WORKFLOW_KINDS.includes(record.kind)) throw invalid(kind, 'kind', id);
  if (!isLine(description, 280)) throw invalid(kind, 'description', id);
  // Whether the workflow's agents settle their own questions instead of pausing for the owner.
  if (typeof agentsDecide !== 'boolean') throw invalid(kind, 'agentsDecide', id);
  if (progressFile !== null && !isText(progressFile)) throw invalid(kind, 'progressFile', id);
  if (!isRevision(revision)) throw invalid(kind, 'revision', id);
  if (!isTimestamp(createdAt)) throw invalid(kind, 'createdAt', id);
  if (!isTimestamp(updatedAt)) throw invalid(kind, 'updatedAt', id);
  if (!Array.isArray(nodes) || nodes.length < 1) throw invalid(kind, 'nodes', id);
  return { id, name, kind: record.kind, description, agentsDecide, progressFile, revision, nodes: nodes.map((_node, index) => parseNode(nodes, index, id, kind, withAgent)), createdAt, updatedAt };
}

export function parseWorkflow(record) {
  return parseDefinition(record, 'workflow', true);
}

/** A workflow template the owner saved: a workflow whose steps name no agent. */
export function parseTemplate(record) {
  return parseDefinition(record, 'template', false);
}

/** A step the owner saved: a named prompt with its options, never a loop. */
export function parseStepPreset(record) {
  const kind = 'saved step';
  if (!isObject(record)) throw invalid(kind, 'step');
  const { id, name, role, prompt, repeat, readOnly, approval, askOwner, revision, createdAt, updatedAt } = record;
  if (!isUuid(id)) throw invalid(kind, 'id');
  if (!isText(name)) throw invalid(kind, 'name', id);
  if (!isLine(role, 32)) throw invalid(kind, 'role', id);
  if (!isText(prompt)) throw invalid(kind, 'prompt', id);
  if (!isObject(repeat) || !['once', 'until_complete'].includes(repeat.mode)) throw invalid(kind, 'repeat.mode', id);
  if (repeat.mode === 'until_complete' && (!Number.isInteger(repeat.max) || repeat.max < 1 || repeat.max > 100)) throw invalid(kind, 'repeat.max', id);
  if (typeof readOnly !== 'boolean') throw invalid(kind, 'readOnly', id);
  if (typeof approval !== 'boolean') throw invalid(kind, 'approval', id);
  if (typeof askOwner !== 'boolean') throw invalid(kind, 'askOwner', id);
  if (!isRevision(revision)) throw invalid(kind, 'revision', id);
  if (!isTimestamp(createdAt)) throw invalid(kind, 'createdAt', id);
  if (!isTimestamp(updatedAt)) throw invalid(kind, 'updatedAt', id);
  return { id, name, role, prompt, repeat: repeat.mode === 'once' ? { mode: 'once' } : { mode: 'until_complete', max: repeat.max }, readOnly, approval, askOwner, revision, createdAt, updatedAt };
}

export function parseSettings(record) {
  if (!isObject(record)) throw invalid('settings', 'settings');
  const { setupAgentId, defaultBaseBranch, revision } = record;
  if (setupAgentId !== null && !isUuid(setupAgentId)) throw invalid('settings', 'setupAgentId');
  if (defaultBaseBranch !== null && !isBranchName(defaultBaseBranch)) throw invalid('settings', 'defaultBaseBranch');
  if (!isRevision(revision)) throw invalid('settings', 'revision');
  return { setupAgentId, defaultBaseBranch, revision };
}

const COMMIT_ID = /^[0-9a-f]{40}$/;
const WORKTREE_REASON_CODES = ['missing', 'unreadable', 'detached', 'in_use'];

function parseWorktreeReason(reason) {
  if (reason === null) return null;
  if (!isObject(reason)) throw invalid('worktree', 'reason');
  if (!WORKTREE_REASON_CODES.includes(reason.code)) throw invalid('worktree', 'reason.code');
  if (!isText(reason.message)) throw invalid('worktree', 'reason.message');
  return { code: reason.code, message: reason.message };
}

/** One entry of GET /worktrees. Failures name the field only, never the path. */
export function parseWorktree(record) {
  if (!isObject(record)) throw invalid('worktree', 'worktree');
  const { path, name, branch, head, current, dirty, selectable } = record;
  if (typeof path !== 'string' || !path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)) throw invalid('worktree', 'path');
  if (!isText(name)) throw invalid('worktree', 'name');
  if (branch !== null && !isText(branch)) throw invalid('worktree', 'branch');
  if (typeof head !== 'string' || !COMMIT_ID.test(head)) throw invalid('worktree', 'head');
  if (typeof current !== 'boolean') throw invalid('worktree', 'current');
  if (dirty !== null && typeof dirty !== 'boolean') throw invalid('worktree', 'dirty');
  if (typeof selectable !== 'boolean') throw invalid('worktree', 'selectable');
  if (record.reason === undefined) throw invalid('worktree', 'reason');
  const reason = parseWorktreeReason(record.reason);
  // A worktree is selectable exactly when nothing refuses it.
  if (selectable !== (reason === null)) throw invalid('worktree', 'selectable');
  return { path, name, branch, head, current, dirty, selectable, reason };
}

const PLAN_ROLES = ['this', 'minor', 'todo'];

/** The POST /run-plans response: where a run's todo is and what its Repositories line asks for. */
export function parseRunPlan(record) {
  const bad = field => new Error(`Invalid run plan field ${field}`);
  if (!isObject(record)) throw bad('plan');
  const { progressFile, input, foundIn, problem } = record;
  if (progressFile !== null && !isText(progressFile)) throw bad('progressFile');
  if (!isText(input)) throw bad('input');
  if (foundIn !== null && !isText(foundIn)) throw bad('foundIn');
  if (problem !== null && !isText(problem)) throw bad('problem');
  if (record.repositories !== null && !Array.isArray(record.repositories)) throw bad('repositories');
  const repositories = record.repositories === null ? null : record.repositories.map((entry, index) => {
    const at = `repositories[${index}]`;
    if (!isObject(entry)) throw bad(at);
    if (!isText(entry.repository)) throw bad(`${at}.repository`);
    if (!PLAN_ROLES.includes(entry.role)) throw bad(`${at}.role`);
    // Only another repository's own todo has a path.
    if (entry.role === 'todo' ? !isText(entry.todo) : entry.todo !== null) throw bad(`${at}.todo`);
    if (entry.input !== null && !isText(entry.input)) throw bad(`${at}.input`);
    if (typeof entry.listed !== 'boolean') throw bad(`${at}.listed`);
    if (entry.present !== null && typeof entry.present !== 'boolean') throw bad(`${at}.present`);
    return { repository: entry.repository, role: entry.role, todo: entry.todo, input: entry.input, listed: entry.listed, present: entry.present };
  });
  return { progressFile, input, foundIn, problem, repositories };
}

/** The GET /preflight response for a project. */
export function parsePreflight(record) {
  if (!isObject(record)) throw invalid('preflight', 'preflight');
  const { project, eligible, branch, head, dirty } = record;
  if (!isText(project)) throw invalid('preflight', 'project');
  if (typeof eligible !== 'boolean') throw invalid('preflight', 'eligible');
  if (!Array.isArray(record.reasons)) throw invalid('preflight', 'reasons');
  const reasons = record.reasons.map((reason, index) => {
    if (!isObject(reason)) throw invalid('preflight', `reasons[${index}]`);
    if (!isText(reason.code)) throw invalid('preflight', `reasons[${index}].code`);
    if (!isText(reason.message)) throw invalid('preflight', `reasons[${index}].message`);
    return { code: reason.code, message: reason.message };
  });
  // A project is eligible exactly when nothing stands in the way.
  if (eligible !== (reasons.length === 0)) throw invalid('preflight', 'eligible');
  if (branch !== null && !isText(branch)) throw invalid('preflight', 'branch');
  if (head !== null && (typeof head !== 'string' || !COMMIT_ID.test(head))) throw invalid('preflight', 'head');
  if (dirty !== null && typeof dirty !== 'boolean') throw invalid('preflight', 'dirty');
  return { project, eligible, reasons, branch, head, dirty };
}

export async function loadDefinitions({ signal } = {}) {
  const [agents, workflows, settings, templates, stepPresets] = await Promise.all([
    listAgents({ signal }),
    listWorkflows({ signal }),
    getPipelineSettings({ signal }),
    listTemplates({ signal }),
    listStepPresets({ signal }),
  ]);
  return {
    agents: agents.map(parseAgent),
    workflows: workflows.map(parseWorkflow),
    settings: parseSettings(settings),
    templates: templates.map(parseTemplate),
    stepPresets: stepPresets.map(parseStepPreset),
  };
}
