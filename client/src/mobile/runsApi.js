// Workflow runs and tasks for the phone. These are the endpoints the desktop
// uses, reached at the address of the instance, and every record is checked by
// the desktop's own parsers before the app shows it.
import { isUuid } from '../../../shared/pipeline-definitions.mjs';
import { parseNotePage, parseRun } from '../utils/pipelineRunRecords';
import { parseTaskSummary } from '../utils/tasksApi';
import { normalizeInstanceUrl, sendToInstance } from './companion';

const TEXT_MAX = 4000;
const PAGE_SIZE = 100;

function requireRun(runId) {
  if (!isUuid(runId)) throw new Error('run must be a run identity');
  return runId;
}
function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > TEXT_MAX || /[\x00-\x09\x0b-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be 1–4000 characters without control characters other than new lines`);
  }
  return value;
}

export function createRunsApi(address, request = fetch) {
  const origin = normalizeInstanceUrl(address);

  async function call(path, { method = 'GET', body } = {}) {
    const response = await sendToInstance(request, origin, path, {
      method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok) {
      const field = Array.isArray(payload?.errors) ? payload.errors[0] : null;
      const message = typeof field?.field === 'string' && typeof field?.message === 'string' ? `${field.field}: ${field.message}`
        : typeof payload?.message === 'string' && payload.message.trim() ? payload.message
          : `The instance refused the request (${response.status}).`;
      throw Object.assign(new Error(message), { status: response.status });
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
    listOpenTasks: () => listAll('/api/tasks', 'tasks', parseTaskSummary),
    /** One page of the notes of one step, newest first. */
    async listNotes(runId, page, stepIndex) {
      requireRun(runId);
      if (!Number.isSafeInteger(page) || page < 0) throw new Error('page must be a whole number of 0 or more');
      if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32) throw new Error('stepIndex must be an integer from 0 to 32');
      const params = new URLSearchParams({ page: String(page), size: '50', sort: 'createdAt,desc', stepIndex: String(stepIndex) });
      return parseNotePage(await call(`/api/pipelines/runs/${runId}/notes?${params}`));
    },
    /** The backend types the answer into the terminal of the agent that asked. */
    async answer(runId, answer) { requireRun(runId); return act(runId, 'answer', { answer: requireText(answer, 'answer') }); },
    approve: runId => act(runId, 'approve'),
    async sendBack(runId, comment) { requireRun(runId); return act(runId, 'send-back', { comment: requireText(comment, 'comment') }); },
    resume: runId => act(runId, 'resume'),
    continuePast: runId => act(runId, 'continue'),
  };
}
