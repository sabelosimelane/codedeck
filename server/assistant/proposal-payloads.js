import { isRepositoryName, isUuid, validateRunStartBody } from '../../shared/pipeline-definitions.mjs';
import { isTaskTitle, TASK_TITLE_MAX } from '../tasks/task-store.js';

export const PROPOSAL_KINDS = Object.freeze(['commit', 'merge', 'pull_request', 'close', 'new_task', 'start_run']);
export const PROPOSAL_STATES = Object.freeze(['pending', 'approved', 'declined', 'done', 'failed', 'expired']);
export const DECIDED_STATES = Object.freeze(['declined', 'done', 'failed', 'expired']);

const OPEN_TASK_STATES = new Set(['active', 'pr_open']);
const SINGLE_LINE_CONTROL = /[\x00-\x1f\x7f]/;
const MULTI_LINE_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const START_RUN_ALLOWED = ['workflowId', 'input', 'teamId', 'taskId', 'newTask', 'startIn'];

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isOneLine = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max && !SINGLE_LINE_CONTROL.test(value);
const isReason = value => typeof value === 'string' && value.trim().length >= 1 && value.length <= 2000 && !MULTI_LINE_CONTROL.test(value);

export const isValidProposalSummary = value => isOneLine(value, 1, 300);
export const isValidProposalReason = value => isReason(value);

function unknownFields(errors, object, allowed, prefix, customMessages = {}) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      errors.push({ field: `${prefix}${key}`, message: customMessages[key] ?? 'Unknown field' });
    }
  }
}

function checkTaskAndWorktreeShape(errors, payload, prefix) {
  if (!isUuid(payload.taskId)) {
    errors.push({ field: `${prefix}taskId`, message: 'Use a valid task UUID' });
  }
  if (payload.worktreeId !== undefined && !isUuid(payload.worktreeId)) {
    errors.push({ field: `${prefix}worktreeId`, message: 'Use a valid worktree UUID' });
  }
}

export function validateProposalPayloadShape(kind, payload, { fieldPrefix = '' } = {}) {
  const errors = [];
  if (!PROPOSAL_KINDS.includes(kind)) {
    errors.push({ field: fieldPrefix ? fieldPrefix.replace(/\.$/, '') : 'kind', message: `Use one of ${PROPOSAL_KINDS.join(', ')}` });
    return errors;
  }
  if (!isPlain(payload)) {
    errors.push({ field: fieldPrefix ? fieldPrefix.replace(/\.$/, '') : 'payload', message: 'Use a JSON object' });
    return errors;
  }

  switch (kind) {
    case 'commit':
      unknownFields(errors, payload, ['taskId', 'worktreeId', 'message'], fieldPrefix);
      checkTaskAndWorktreeShape(errors, payload, fieldPrefix);
      if (!isOneLine(payload.message, 1, 200)) {
        errors.push({ field: `${fieldPrefix}message`, message: 'Use 1–200 characters on one line' });
      }
      break;
    case 'merge':
      unknownFields(errors, payload, ['taskId', 'worktreeId'], fieldPrefix);
      checkTaskAndWorktreeShape(errors, payload, fieldPrefix);
      break;
    case 'pull_request':
      unknownFields(errors, payload, ['taskId', 'worktreeId', 'remote'], fieldPrefix);
      checkTaskAndWorktreeShape(errors, payload, fieldPrefix);
      if (typeof payload.remote !== 'string' || !REMOTE_NAME.test(payload.remote)) {
        errors.push({ field: `${fieldPrefix}remote`, message: 'Use a remote name of 1–100 characters' });
      }
      break;
    case 'close':
      unknownFields(errors, payload, ['taskId', 'worktreeId'], fieldPrefix, {
        deleteIgnored: 'deleteIgnored is not allowed in assistant proposals',
      });
      checkTaskAndWorktreeShape(errors, payload, fieldPrefix);
      break;
    case 'new_task':
      unknownFields(errors, payload, ['title', 'repositories'], fieldPrefix);
      if (!isTaskTitle(payload.title)) {
        errors.push({ field: `${fieldPrefix}title`, message: `Use 1–${TASK_TITLE_MAX} characters on one line` });
      }
      if (payload.repositories !== undefined && (
        !Array.isArray(payload.repositories)
        || payload.repositories.length < 1
        || payload.repositories.length > 9
        || !payload.repositories.every(isRepositoryName)
        || new Set(payload.repositories).size !== payload.repositories.length
      )) {
        errors.push({ field: `${fieldPrefix}repositories`, message: 'Use a list of 1–9 different repository names' });
      }
      break;
    case 'start_run': {
      unknownFields(errors, payload, START_RUN_ALLOWED, fieldPrefix);
      const allowedBody = { project: 'placeholder', requestId: 'placeholder' };
      for (const key of START_RUN_ALLOWED) {
        if (Object.hasOwn(payload, key)) allowedBody[key] = payload[key];
      }
      for (const item of validateRunStartBody(allowedBody, { requireTeam: true })) {
        errors.push({ field: `${fieldPrefix}${item.field}`, message: item.message });
      }
      break;
    }
    default:
      break;
  }
  return errors;
}

export function validateProposalPayload(kind, payload, { project, taskStore, fieldPrefix = '' } = {}) {
  const errors = validateProposalPayloadShape(kind, payload, { fieldPrefix });
  if (!isPlain(payload) || !PROPOSAL_KINDS.includes(kind)) return errors;

  const needsTaskCheck = ['commit', 'merge', 'pull_request', 'close'].includes(kind)
    || (kind === 'start_run' && payload.taskId !== undefined);
  if (needsTaskCheck && isUuid(payload.taskId) && taskStore && typeof taskStore.get === 'function') {
    const task = taskStore.get(payload.taskId);
    if (!task) {
      errors.push({ field: `${fieldPrefix}taskId`, message: 'Task not found' });
    } else if (project !== undefined && task.project !== project) {
      errors.push({ field: `${fieldPrefix}taskId`, message: 'This task belongs to another project' });
    } else if (!OPEN_TASK_STATES.has(task.state)) {
      errors.push({ field: `${fieldPrefix}taskId`, message: 'Task must be open' });
    } else if (payload.worktreeId !== undefined && isUuid(payload.worktreeId)) {
      const worktrees = Array.isArray(task.worktrees) ? task.worktrees : [];
      if (!worktrees.some(worktree => worktree.id === payload.worktreeId)) {
        errors.push({ field: `${fieldPrefix}worktreeId`, message: 'Unknown worktree for this task' });
      }
    }
  }
  return errors;
}

export function validateProposalCreateBody(body, { project, taskStore } = {}) {
  const errors = [];
  if (!isPlain(body)) {
    return [{ field: 'body', message: 'Use a JSON object' }];
  }
  unknownFields(errors, body, ['kind', 'payload', 'summary', 'reason'], '');
  const kindValid = PROPOSAL_KINDS.includes(body.kind);
  if (!kindValid) {
    errors.push({ field: 'kind', message: `Use one of ${PROPOSAL_KINDS.join(', ')}` });
  }
  if (!isValidProposalSummary(body.summary)) {
    errors.push({ field: 'summary', message: 'Use 1–300 characters on one line' });
  }
  if (!isValidProposalReason(body.reason)) {
    errors.push({ field: 'reason', message: 'Use 1–2000 characters' });
  }
  if (kindValid) {
    errors.push(...validateProposalPayload(body.kind, body.payload, { project, taskStore, fieldPrefix: 'payload.' }));
  } else if (!isPlain(body.payload)) {
    errors.push({ field: 'payload', message: 'Use a JSON object' });
  }
  return errors;
}
