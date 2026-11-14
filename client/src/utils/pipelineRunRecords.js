import { isUuid } from '../../../shared/pipeline-definitions.mjs';
import { PipelineApiError } from './pipelinesApi';

const RUN_STATUSES = ['pending', 'running', 'needs_input', 'limit_paused', 'interrupted', 'stopped', 'error', 'complete'];
const STEP_STATUSES = ['pending', 'launching', 'running', 'needs_input', 'complete', 'limit_reached', 'failed', 'stopped', 'interrupted'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value));
const nullable = (value, check) => value === null || check(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

const QUESTIONS_MAX = 4000;

/**
 * What an agent that signalled NEEDS_INPUT asked for: null when the run is not waiting on such a
 * request (also for a dialog the agent shows in its terminal), otherwise the stated questions
 * (null when it stated none) and whether they were cut.
 */
export function parseInputRequest(run, index = 0) {
  const identity = isUuid(run?.id) ? run.id : `index ${index}`;
  const guard = (condition, field) => {
    if (!condition) throw new PipelineApiError(`Invalid run ${identity} field ${field}`);
  };
  guard(object(run), 'run');
  const request = run.inputRequest;
  guard(request === null || object(request), 'inputRequest');
  if (request === null) return null;
  guard(run.status === 'needs_input', 'inputRequest');
  guard(nullable(request.questions, value => text(value) && value.length <= QUESTIONS_MAX), 'inputRequest.questions');
  guard(typeof request.truncated === 'boolean' && !(request.truncated && request.questions === null), 'inputRequest.truncated');
  return { questions: request.questions, truncated: request.truncated };
}

export function parseRun(run, index = 0) {
  const identity = isUuid(run?.id) ? run.id : `index ${index}`;
  const guard = (condition, field) => {
    if (!condition) throw new PipelineApiError(`Invalid run ${identity} field ${field}`);
  };
  guard(object(run), 'run');
  guard(isUuid(run.id), 'id');
  guard(typeof run.requestId === 'string' && /^[\w-]{1,128}$/.test(run.requestId), 'requestId');
  guard(isUuid(run.workflowId), 'workflowId');
  guard(text(run.workflowName) && run.workflowName.length <= 64, 'workflowName');
  guard(text(run.project) && run.project.length <= 256 && !/[\x00-\x1f\x7f]/.test(run.project), 'project');
  guard(typeof run.input === 'string' && run.input.length <= 4096 && !/[\x00-\x1f\x7f]/.test(run.input), 'input');
  guard(RUN_STATUSES.includes(run.status), 'status');
  guard(run.status === 'stopped' ? ['user', 'terminal'].includes(run.stopReason) : run.stopReason === null, 'stopReason');
  guard(run.status === 'error' ? text(run.error) && run.error.length <= 2000 : run.error === null, 'error');
  guard(Array.isArray(run.steps) && run.steps.length >= 1 && run.steps.length <= 33, 'steps');
  guard(integer(run.currentStepIndex) && run.currentStepIndex < run.steps.length, 'currentStepIndex');
  const session = value => typeof value === 'string' && value.startsWith(`${run.project}-`) && /^\d+$/.test(value.slice(run.project.length + 1));
  run.steps.forEach((step, i) => {
    const field = name => `steps[${i}].${name}`;
    guard(object(step), `steps[${i}]`);
    guard(step.index === i, field('index'));
    guard(['setup', 'node'].includes(step.kind), field('kind'));
    guard(text(step.name) && step.name.length <= 64, field('name'));
    guard(text(step.agentName) && step.agentName.length <= 64, field('agentName'));
    guard(object(step.repeat), field('repeat'));
    guard(['once', 'until_complete'].includes(step.repeat.mode), field('repeat.mode'));
    guard(step.repeat.mode === 'once' ? step.repeat.max === undefined : integer(step.repeat.max) && step.repeat.max >= 1 && step.repeat.max <= 100, field('repeat.max'));
    guard(STEP_STATUSES.includes(step.status), field('status'));
    guard(nullable(step.sessionId, session), field('sessionId'));
    guard(Array.isArray(step.priorSessionIds) && step.priorSessionIds.every(session), field('priorSessionIds'));
    guard(integer(step.attempt), field('attempt'));
    guard(integer(step.iteration), field('iteration'));
    guard(nullable(step.detail, value => text(value) && value.length <= 2000), field('detail'));
    guard(nullable(step.startedAt, stamp), field('startedAt'));
    guard(nullable(step.finishedAt, stamp), field('finishedAt'));
  });
  guard(object(run.worktree), 'worktree');
  guard(text(run.worktree.path) && run.worktree.path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(run.worktree.path), 'worktree.path');
  guard(text(run.worktree.branch) && run.worktree.branch.length <= 256, 'worktree.branch');
  guard(nullable(run.worktree.baseCommit, value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)), 'worktree.baseCommit');
  guard(['not_created', 'present', 'removed', 'removal_blocked', 'external', 'released'].includes(run.worktree.state), 'worktree.state');
  guard(nullable(run.worktree.detail, value => text(value) && value.length <= 2000), 'worktree.detail');
  guard(object(run.actions), 'actions');
  for (const action of ['stop', 'resume', 'continue', 'cleanup', 'answer']) guard(typeof run.actions[action] === 'boolean', `actions.${action}`);
  const inputRequest = parseInputRequest(run, index);
  // Only a request the agent signalled can be answered from here.
  guard(run.actions.answer === (run.status === 'needs_input' && inputRequest !== null), 'actions.answer');
  guard(stamp(run.createdAt), 'createdAt');
  guard(stamp(run.updatedAt), 'updatedAt');
  guard(nullable(run.finishedAt, stamp) && (!['complete', 'stopped', 'error'].includes(run.status) || run.finishedAt !== null), 'finishedAt');
  return run;
}
