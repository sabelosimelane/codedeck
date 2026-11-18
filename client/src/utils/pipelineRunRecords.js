import { isUuid, isProgressFilePath } from '../../../shared/pipeline-definitions.mjs';
import { PipelineApiError } from './pipelinesApi';

const RUN_STATUSES = ['pending', 'running', 'needs_input', 'limit_paused', 'awaiting_approval', 'interrupted', 'stopped', 'error', 'complete'];
const STEP_STATUSES = ['pending', 'launching', 'running', 'needs_input', 'awaiting_approval', 'complete', 'limit_reached', 'limit_accepted', 'failed', 'stopped', 'interrupted'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value));
const nullable = (value, check) => value === null || check(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

const QUESTIONS_MAX = 4000;
const NOTES_DIR = /^\.codedeck\/runs\/[0-9a-f]{8}$/;
const NOTE_STATUSES = ['written', 'unchanged', 'missing', 'unreadable', 'too_large'];
const noteFileName = (index, name) => `${String(index).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'step'}.md`;

function parseNoteMeta(note, guard, prefix) {
  guard(note === null || object(note), prefix);
  if (note === null) return;
  guard(NOTE_STATUSES.includes(note.status), `${prefix}.status`);
  guard(note.status === 'written' ? typeof note.summary === 'string' && note.summary.length <= 200 : note.summary === null, `${prefix}.summary`);
  guard(integer(note.attempt) && note.attempt >= 1, `${prefix}.attempt`);
  guard(integer(note.pass) && note.pass >= 1 && note.pass <= 100, `${prefix}.pass`);
  guard(stamp(note.createdAt), `${prefix}.createdAt`);
}

export function parseNote(note) {
  const guard = (condition, field) => { if (!condition) throw new PipelineApiError(`Invalid note field ${field}`); };
  guard(object(note), 'note');
  guard(Number.isSafeInteger(note.id) && note.id >= 1, 'id');
  guard(integer(note.stepIndex) && note.stepIndex <= 32, 'stepIndex');
  guard(text(note.stepName) && note.stepName.length <= 64 && !/[\r\n]/.test(note.stepName), 'stepName');
  parseNoteMeta(note, guard, 'note');
  guard(note.status === 'written' ? typeof note.content === 'string' && new TextEncoder().encode(note.content).length <= 262_144 : note.content === null, 'content');
  return note;
}

export function parseNotePage(body) {
  const guard = (condition, field) => { if (!condition) throw new PipelineApiError(`Invalid notes response field ${field}`); };
  guard(object(body), 'body');
  guard(Array.isArray(body.data), 'data');
  guard(object(body.page), 'page');
  const { currentPage, size, totalElements, totalPages, hasNextPage } = body.page;
  guard(integer(currentPage), 'page.currentPage');
  guard(integer(size) && size >= 1 && size <= 100, 'page.size');
  guard(integer(totalElements), 'page.totalElements');
  guard(integer(totalPages), 'page.totalPages');
  guard(typeof hasNextPage === 'boolean', 'page.hasNextPage');
  return { notes: body.data.map(parseNote), hasNextPage, total: totalElements };
}

function parseProgress(run, guard) {
  const progress = run.progress;
  guard(progress === null || object(progress), 'progress');
  if (progress === null) return null;
  guard(isProgressFilePath(progress.file, 512), 'progress.file');
  guard(['in_progress', 'all_done', 'no_phases', 'missing', 'unreadable'].includes(progress.status), 'progress.status');
  const counted = progress.status === 'in_progress' || progress.status === 'all_done';
  guard(counted ? integer(progress.phaseCount) && progress.phaseCount >= 1 : progress.phaseCount === null, 'progress.phaseCount');
  guard(progress.status === 'in_progress' ? object(progress.phase) : progress.phase === null, 'progress.phase');
  if (progress.status === 'in_progress') {
    const phase = progress.phase;
    guard(integer(phase.number), 'progress.phase.number');
    guard(typeof phase.title === 'string' && phase.title.length <= 120, 'progress.phase.title');
    guard(integer(phase.tasksTotal) && phase.tasksTotal >= 1, 'progress.phase.tasksTotal');
    guard(integer(phase.tasksDone) && phase.tasksDone < phase.tasksTotal, 'progress.phase.tasksDone');
  }
  return progress;
}

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

/**
 * The fields the runs bar reads about loops and decisions: whether the run's agents decide,
 * how many requests they settled, and for each step its repeat and completed rounds.
 * Throws naming the field; returns nothing.
 */
export function parseRunAutonomy(run, index = 0) {
  const identity = isUuid(run?.id) ? run.id : `index ${index}`;
  const guard = (condition, field) => {
    if (!condition) throw new PipelineApiError(`Invalid run ${identity} field ${field}`);
  };
  guard(object(run), 'run');
  guard(typeof run.agentsDecide === 'boolean', 'agentsDecide');
  guard(run.notesDir === null || typeof run.notesDir === 'string' && NOTES_DIR.test(run.notesDir), 'notesDir');
  parseProgress(run, guard);
  guard(integer(run.decisionCount), 'decisionCount');
  guard(Array.isArray(run.steps), 'steps');
  run.steps.forEach((step, i) => {
    guard(object(step), `steps[${i}]`);
    guard(object(step.repeat), `steps[${i}].repeat`);
    const loops = step.repeat.mode === 'loop_back';
    if (loops) guard(integer(step.repeat.max) && step.repeat.max >= 1 && step.repeat.max <= 100, `steps[${i}].repeat.max`);
    guard(integer(step.roundsCompleted) && (loops ? step.roundsCompleted < step.repeat.max : step.roundsCompleted === 0), `steps[${i}].roundsCompleted`);
    guard(step.notePath === null || (typeof step.notePath === 'string' && step.notePath === `${run.notesDir}/${noteFileName(i, step.name)}` && step.kind === 'node'), `steps[${i}].notePath`);
    guard(run.notesDir !== null && step.kind === 'node' ? step.notePath !== null : step.notePath === null, `steps[${i}].notePath`);
    parseNoteMeta(step.note, guard, `steps[${i}].note`);
  });
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
  // Whether this run's agents settle their own questions, and how many they have settled.
  guard(typeof run.agentsDecide === 'boolean', 'agentsDecide');
  guard(run.notesDir === null || typeof run.notesDir === 'string' && NOTES_DIR.test(run.notesDir), 'notesDir');
  parseProgress(run, guard);
  guard(integer(run.decisionCount), 'decisionCount');
  guard(text(run.project) && run.project.length <= 256 && !/[\x00-\x1f\x7f]/.test(run.project), 'project');
  guard(typeof run.input === 'string' && run.input.length <= 4096 && !/[\x00-\x1f\x7f]/.test(run.input), 'input');
  guard(RUN_STATUSES.includes(run.status), 'status');
  guard(run.status === 'stopped' ? ['user', 'terminal', 'no_progress'].includes(run.stopReason) : run.stopReason === null, 'stopReason');
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
    guard(typeof step.readOnly === 'boolean' && (step.kind !== 'setup' || !step.readOnly), field('readOnly'));
    guard(typeof step.approval === 'boolean' && (step.kind !== 'setup' || !step.approval), field('approval'));
    guard(step.notePath === null || (typeof step.notePath === 'string' && run.notesDir !== null && step.kind === 'node' && step.notePath === `${run.notesDir}/${noteFileName(i, step.name)}`), field('notePath'));
    guard(run.notesDir === null || step.kind === 'setup' ? step.notePath === null : step.notePath !== null, field('notePath'));
    parseNoteMeta(step.note, guard, field('note'));
    guard(text(step.agentName) && step.agentName.length <= 64, field('agentName'));
    guard(object(step.repeat), field('repeat'));
    guard(['once', 'until_complete', 'loop_back'].includes(step.repeat.mode), field('repeat.mode'));
    const loops = step.repeat.mode === 'loop_back';
    guard(!loops || !step.approval, field('approval'));
    // A loop names the earlier step it returns to; no other repeat has a target.
    guard(loops ? integer(step.repeat.toStepIndex) && step.repeat.toStepIndex < i : step.repeat.toStepIndex === undefined, field('repeat.toStepIndex'));
    guard(step.repeat.mode === 'once' ? step.repeat.max === undefined : integer(step.repeat.max) && step.repeat.max >= 1 && step.repeat.max <= 100, field('repeat.max'));
    guard(integer(step.roundsCompleted) && (loops ? step.roundsCompleted < step.repeat.max : step.roundsCompleted === 0), field('roundsCompleted'));
    guard(STEP_STATUSES.includes(step.status), field('status'));
    guard(nullable(step.sessionId, session), field('sessionId'));
    guard(Array.isArray(step.priorSessionIds) && step.priorSessionIds.every(session), field('priorSessionIds'));
    guard(integer(step.attempt), field('attempt'));
    guard(integer(step.iteration), field('iteration'));
    guard(nullable(step.detail, value => text(value) && value.length <= 2000), field('detail'));
    guard(nullable(step.startedAt, stamp), field('startedAt'));
    guard(nullable(step.finishedAt, stamp), field('finishedAt'));
  });
  guard(run.approvalRequest === null || object(run.approvalRequest), 'approvalRequest');
  if (run.status === 'awaiting_approval') {
    const approval = run.approvalRequest;
    guard(object(approval), 'approvalRequest');
    guard(integer(approval.stepIndex) && approval.stepIndex === run.currentStepIndex, 'approvalRequest.stepIndex');
    guard(text(approval.stepName) && approval.stepName === run.steps[approval.stepIndex].name, 'approvalRequest.stepName');
    parseNoteMeta(approval.note, guard, 'approvalRequest.note');
    guard(run.steps[approval.stepIndex].status === 'awaiting_approval', 'approvalRequest');
  } else guard(run.approvalRequest === null, 'approvalRequest');
  guard(object(run.worktree), 'worktree');
  guard(text(run.worktree.path) && run.worktree.path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(run.worktree.path), 'worktree.path');
  guard(text(run.worktree.branch) && run.worktree.branch.length <= 256, 'worktree.branch');
  guard(nullable(run.worktree.baseCommit, value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)), 'worktree.baseCommit');
  guard(['not_created', 'present', 'removed', 'removal_blocked', 'external', 'released'].includes(run.worktree.state), 'worktree.state');
  guard(['present', 'external', 'removal_blocked'].includes(run.worktree.state) || run.progress === null, 'progress');
  guard(nullable(run.worktree.detail, value => text(value) && value.length <= 2000), 'worktree.detail');
  guard(object(run.actions), 'actions');
  for (const action of ['stop', 'resume', 'continue', 'cleanup', 'answer', 'approve', 'sendBack']) guard(typeof run.actions[action] === 'boolean', `actions.${action}`);
  const inputRequest = parseInputRequest(run, index);
  // Only a request the agent signalled can be answered from here.
  guard(run.actions.answer === (run.status === 'needs_input' && inputRequest !== null), 'actions.answer');
  guard(run.actions.approve === (run.status === 'awaiting_approval'), 'actions.approve');
  guard(run.actions.sendBack === (run.status === 'awaiting_approval'), 'actions.sendBack');
  guard(stamp(run.createdAt), 'createdAt');
  guard(stamp(run.updatedAt), 'updatedAt');
  guard(nullable(run.finishedAt, stamp) && (!['complete', 'stopped', 'error'].includes(run.status) || run.finishedAt !== null), 'finishedAt');
  return run;
}

const DECISION_TEXT_MAX = 4000;

/**
 * One request an agent settled itself: what it listed and the answer typed for it.
 * A failure names the record and field, never what was asked or answered.
 */
export function parseDecision(decision) {
  const identity = Number.isSafeInteger(decision?.id) ? ` ${decision.id}` : '';
  const guard = (condition, field) => {
    if (!condition) throw new PipelineApiError(`Invalid decision${identity} field ${field}`);
  };
  guard(object(decision), 'decision');
  const { id, stepIndex, stepName, pass, questions, truncated, answer, createdAt } = decision;
  guard(Number.isSafeInteger(id) && id >= 1, 'id');
  guard(integer(stepIndex) && stepIndex <= 32, 'stepIndex');
  guard(text(stepName) && stepName.length <= 64, 'stepName');
  guard(integer(pass) && pass >= 1 && pass <= 100, 'pass');
  guard(text(questions) && questions.length <= DECISION_TEXT_MAX, 'questions');
  guard(typeof truncated === 'boolean', 'truncated');
  guard(text(answer) && answer.length <= DECISION_TEXT_MAX, 'answer');
  guard(stamp(createdAt), 'createdAt');
  return { id, stepIndex, stepName, pass, questions, truncated, answer, createdAt };
}

/** A page of GET /runs/:id/decisions: its decisions, whether more follow, and how many there are in all. */
export function parseDecisionPage(body) {
  const guard = (condition, field) => {
    if (!condition) throw new PipelineApiError(`Invalid decisions response field ${field}`);
  };
  guard(object(body), 'body');
  guard(Array.isArray(body.data), 'data');
  guard(object(body.page), 'page');
  const { currentPage, size, totalElements, totalPages, hasNextPage } = body.page;
  guard(integer(currentPage), 'page.currentPage');
  guard(integer(size) && size >= 1, 'page.size');
  guard(integer(totalElements), 'page.totalElements');
  guard(integer(totalPages), 'page.totalPages');
  guard(typeof hasNextPage === 'boolean', 'page.hasNextPage');
  return { decisions: body.data.map(parseDecision), hasNextPage, total: totalElements };
}
