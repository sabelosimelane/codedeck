// Workflow runs and tasks for the phone. These are the endpoints the desktop
// uses, reached at the address of the instance, and every record is checked by
// the desktop's own parsers before the app shows it.
import { isUuid } from '../../../shared/pipeline-definitions.mjs';
import { parseAnswerPage, parseDecisionPage, parseNotePage, parseReviewPage, parseRun } from '../utils/pipelineRunRecords';
import { parseTaskForPhone, parseWorktreeLanding } from '../utils/tasksApi';
import { normalizeInstanceUrl, sendToInstance } from './companion';

const TEXT_MAX = 4000;
// What one step left besides its notes, oldest first, each read with the desktop's parser.
const RECORDS = {
  decisions: body => { const page = parseDecisionPage(body); return { items: page.decisions, total: page.total }; },
  answers: body => { const page = parseAnswerPage(body); return { items: page.answers, total: page.total }; },
  reviews: body => { const page = parseReviewPage(body); return { items: page.reviews, total: page.total }; },
};
const PAGE_SIZE = 100;
// Git can take a while: a merge, a push and a pull request are given two minutes.
const LANDING_TIMEOUT_MS = 120_000;

function requireRun(runId) {
  if (!isUuid(runId)) throw new Error('run must be a run identity');
  return runId;
}
function requireTask(taskId) {
  if (!isUuid(taskId)) throw new Error('task must be a task identity');
  return taskId;
}
function requireWorktree(worktreeId) {
  if (!isUuid(worktreeId)) throw new Error('worktree must be a worktree identity');
  return worktreeId;
}
const named = value => typeof value === 'string' && value.trim().length > 0;
function terminals(body, action) {
  for (const field of ['terminalsClosed', 'terminalsNotClosed']) {
    if (!Array.isArray(body?.[field]) || !body[field].every(named)) throw new Error(`Invalid ${action} response: ${field}`);
  }
  return { terminalsClosed: [...body.terminalsClosed], terminalsNotClosed: [...body.terminalsNotClosed] };
}
/** What every landing of one repository says: which repository, and whether that finished the task. */
function outcome(body, action) {
  if (!named(body?.repository)) throw new Error(`Invalid ${action} response: repository`);
  if (typeof body.taskFinished !== 'boolean') throw new Error(`Invalid ${action} response: taskFinished`);
  return { repository: body.repository, taskFinished: body.taskFinished };
}
function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > TEXT_MAX || /[\x00-\x09\x0b-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be 1–4000 characters without control characters other than new lines`);
  }
  return value;
}

export function createRunsApi(address, request = fetch) {
  const origin = normalizeInstanceUrl(address);

  async function call(path, { method = 'GET', body, timeoutMs } = {}) {
    const response = await sendToInstance(request, origin, path, {
      method, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok) {
      const field = Array.isArray(payload?.errors) ? payload.errors[0] : null;
      const message = typeof field?.field === 'string' && typeof field?.message === 'string' ? `${field.field}: ${field.message}`
        : typeof payload?.message === 'string' && payload.message.trim() ? payload.message
          : `The instance refused the request (${response.status}).`;
      // A landing refusal may say why: `reasons` (each with a message) and `conflicts` (file paths).
      const reasons = Array.isArray(payload?.reasons) ? payload.reasons.filter(reason => typeof reason?.message === 'string' && reason.message.trim()).map(reason => reason.message) : [];
      const conflicts = Array.isArray(payload?.conflicts) ? payload.conflicts.filter(path => typeof path === 'string' && path.trim()) : [];
      throw Object.assign(new Error(message), { status: response.status, reasons, conflicts });
    }
    return payload;
  }

  async function listAll(path, kind, parse) {
    const records = [];
    for (let page = 0; ; page += 1) {
      const body = await call(`${path}?open=true&page=${page}&size=${PAGE_SIZE}`);
      if (!Array.isArray(body?.data) || typeof body?.page?.hasNextPage !== 'boolean') throw new Error(`Invalid ${kind} response`);
      body.data.forEach((record, index) => records.push(parse(record, index)));
      if (!body.page.hasNextPage) return records;
    }
  }

  // Every action answers with the run as it now stands.
  const act = async (runId, action, body) => parseRun(await call(`/api/pipelines/runs/${requireRun(runId)}/${action}`, { method: 'POST', body }));

  return {
    listOpenRuns: () => listAll('/api/pipelines/runs', 'runs', parseRun),
    listOpenTasks: () => listAll('/api/tasks', 'tasks', parseTaskForPhone),
    /** One page of the notes of one step, newest first. */
    async listNotes(runId, page, stepIndex) {
      requireRun(runId);
      if (!Number.isSafeInteger(page) || page < 0) throw new Error('page must be a whole number of 0 or more');
      if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32) throw new Error('stepIndex must be an integer from 0 to 32');
      const params = new URLSearchParams({ page: String(page), size: '50', sort: 'createdAt,desc', stepIndex: String(stepIndex) });
      return parseNotePage(await call(`/api/pipelines/runs/${runId}/notes?${params}`));
    },
    /** How every repository of a task stands for landing, read live from Git; the one it started in first. */
    async listLandings(taskId) {
      requireTask(taskId);
      const landings = [];
      for (let page = 0; ; page += 1) {
        const body = await call(`/api/tasks/${taskId}/worktrees?size=100&page=${page}`);
        if (!Array.isArray(body?.data) || typeof body?.page?.hasNextPage !== 'boolean') throw new Error('Invalid task worktrees response');
        body.data.forEach(entry => landings.push(parseWorktreeLanding(entry)));
        if (!body.page.hasNextPage) break;
      }
      return landings.sort((a, b) => Number(b.first) - Number(a.first) || a.repository.localeCompare(b.repository));
    },
    async commit(taskId, worktreeId, message) {
      const path = `/api/tasks/${requireTask(taskId)}/worktrees/${requireWorktree(worktreeId)}/commit`;
      if (typeof message !== 'string' || !message.trim() || message.trim().length > 200) throw new Error('message must be 1–200 characters');
      return parseWorktreeLanding(await call(path, { method: 'POST', body: { message: message.trim() }, timeoutMs: LANDING_TIMEOUT_MS }));
    },
    async merge(taskId, worktreeId) {
      const body = await call(`/api/tasks/${requireTask(taskId)}/worktrees/${requireWorktree(worktreeId)}/merge`, { method: 'POST', timeoutMs: LANDING_TIMEOUT_MS });
      if (!named(body?.mergedInto) || typeof body.filesRemoved !== 'boolean') throw new Error('Invalid merge response');
      const { repository, taskFinished } = outcome(body, 'merge');
      return { repository, mergedInto: body.mergedInto, filesRemoved: body.filesRemoved, taskFinished, ...terminals(body, 'merge') };
    },
    async pullRequest(taskId, worktreeId, remote) {
      const path = `/api/tasks/${requireTask(taskId)}/worktrees/${requireWorktree(worktreeId)}/pull-request`;
      if (!named(remote)) throw new Error('remote must be a remote name');
      const body = await call(path, { method: 'POST', body: { remote }, timeoutMs: LANDING_TIMEOUT_MS });
      if (typeof body?.prUrl !== 'string' || !/^https?:\/\//.test(body.prUrl)) throw new Error('Invalid pull request response: prUrl');
      if (!named(body.repository)) throw new Error('Invalid pull request response: repository');
      return { repository: body.repository, prUrl: body.prUrl };
    },
    /** Closes one repository of a task. The phone never deletes files Git ignores: a close that would is refused. */
    async closeWorktree(taskId, worktreeId) {
      const body = await call(`/api/tasks/${requireTask(taskId)}/worktrees/${requireWorktree(worktreeId)}/close`, { method: 'POST', timeoutMs: LANDING_TIMEOUT_MS });
      if (!named(body?.branchKept) || !Number.isSafeInteger(body.unmergedCommits) || body.unmergedCommits < 0) throw new Error('Invalid close response');
      const { repository, taskFinished } = outcome(body, 'close');
      return { repository, branchKept: body.branchKept, unmergedCommits: body.unmergedCommits, taskFinished, ...terminals(body, 'close') };
    },
    /** One step's decisions, answers or reviews: `{ items, total }`, the first 100, oldest first. */
    async listRecords(kind, runId, stepIndex) {
      if (!Object.hasOwn(RECORDS, kind)) throw new Error('kind must be decisions, answers or reviews');
      requireRun(runId);
      if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32) throw new Error('stepIndex must be an integer from 0 to 32');
      const params = new URLSearchParams({ page: '0', size: '100', sort: 'createdAt,asc', stepIndex: String(stepIndex) });
      return RECORDS[kind](await call(`/api/pipelines/runs/${runId}/${kind}?${params}`));
    },
    /** The backend types the answer into the terminal of the agent that asked. */
    async answer(runId, answer) { requireRun(runId); return act(runId, 'answer', { answer: requireText(answer, 'answer') }); },
    approve: runId => act(runId, 'approve'),
    async sendBack(runId, comment) { requireRun(runId); return act(runId, 'send-back', { comment: requireText(comment, 'comment') }); },
    resume: runId => act(runId, 'resume'),
    stop: runId => act(runId, 'stop'),
    /** Close run: the run as it now stands, with which of its terminals the backend closed and which it could not. */
    async cleanup(runId) {
      const body = await call(`/api/pipelines/runs/${requireRun(runId)}/cleanup`, { method: 'POST' });
      for (const field of ['terminalsClosed', 'terminalsNotClosed']) {
        if (!Array.isArray(body?.[field]) || !body[field].every(id => typeof id === 'string' && id.trim() !== '')) throw new Error(`Invalid close run response: ${field}`);
      }
      const { terminalsClosed, terminalsNotClosed, ...record } = body;
      return { run: parseRun(record), terminalsClosed: [...terminalsClosed], terminalsNotClosed: [...terminalsNotClosed] };
    },
    continuePast: (runId, grant) => act(runId, 'continue', grant === undefined ? undefined : { stepIndex: grant.stepIndex, roundsCompleted: grant.roundsCompleted, extraRounds: grant.extraRounds }),
  };
}
