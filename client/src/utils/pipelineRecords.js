import { isUuid } from '../../../shared/pipeline-definitions.mjs';
import { PipelineApiError, getPipelineSettings, listAgents, listWorkflows } from './pipelinesApi';

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

function parseRepeat(repeat, path, id) {
  if (!isObject(repeat)) throw invalid('workflow', `${path}.repeat`, id);
  if (repeat.mode === 'once') {
    if (repeat.max !== undefined) throw invalid('workflow', `${path}.repeat.max`, id);
    return { mode: 'once' };
  }
  if (repeat.mode === 'until_complete') {
    if (!Number.isInteger(repeat.max) || repeat.max < 1 || repeat.max > 100) {
      throw invalid('workflow', `${path}.repeat.max`, id);
    }
    return { mode: 'until_complete', max: repeat.max };
  }
  throw invalid('workflow', `${path}.repeat.mode`, id);
}

function parseNode(node, index, id) {
  const path = `nodes[${index}]`;
  if (!isObject(node)) throw invalid('workflow', path, id);
  if (!isText(node.name)) throw invalid('workflow', `${path}.name`, id);
  if (!isUuid(node.agentId)) throw invalid('workflow', `${path}.agentId`, id);
  if (!isText(node.prompt)) throw invalid('workflow', `${path}.prompt`, id);
  return { name: node.name, agentId: node.agentId, prompt: node.prompt, repeat: parseRepeat(node.repeat, path, id) };
}

export function parseWorkflow(record) {
  if (!isObject(record)) throw invalid('workflow', 'workflow');
  const { id, name, revision, nodes, createdAt, updatedAt } = record;
  if (!isUuid(id)) throw invalid('workflow', 'id');
  if (!isText(name)) throw invalid('workflow', 'name', id);
  if (!isRevision(revision)) throw invalid('workflow', 'revision', id);
  if (!isTimestamp(createdAt)) throw invalid('workflow', 'createdAt', id);
  if (!isTimestamp(updatedAt)) throw invalid('workflow', 'updatedAt', id);
  if (!Array.isArray(nodes) || nodes.length < 1) throw invalid('workflow', 'nodes', id);
  return { id, name, revision, nodes: nodes.map((node, index) => parseNode(node, index, id)), createdAt, updatedAt };
}

export function parseSettings(record) {
  if (!isObject(record)) throw invalid('settings', 'settings');
  const { setupAgentId, revision } = record;
  if (setupAgentId !== null && !isUuid(setupAgentId)) throw invalid('settings', 'setupAgentId');
  if (!isRevision(revision)) throw invalid('settings', 'revision');
  return { setupAgentId, revision };
}

export async function loadDefinitions({ signal } = {}) {
  const [agents, workflows, settings] = await Promise.all([
    listAgents({ signal }),
    listWorkflows({ signal }),
    getPipelineSettings({ signal }),
  ]);
  return {
    agents: agents.map(parseAgent),
    workflows: workflows.map(parseWorkflow),
    settings: parseSettings(settings),
  };
}
