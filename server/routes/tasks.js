import express from 'express';
import { randomUUID } from 'node:crypto';
import { TaskError } from '../tasks/task-service.js';
import { TASK_STATES } from '../tasks/task-store.js';
import { parseCollectionQuery, paginate } from './collection-query.js';

const BASE = '/api/tasks';
const SORT_FIELDS = ['createdAt', 'updatedAt', 'title'];
const OPEN_STATES = ['active', 'pr_open'];

const fieldError = (field, message) => new TaskError('One or more fields failed validation.', 400, [{ field, message }]);

const FILTERS = [
  { name: 'project', parse: raw => { if (typeof raw !== 'string' || raw.length === 0) throw fieldError('project', 'Use a project name'); return raw; } },
  { name: 'state', parse: raw => { if (!TASK_STATES.includes(raw)) throw fieldError('state', `Use one of ${TASK_STATES.join(', ')}`); return raw; } },
  { name: 'open', parse: raw => { if (raw !== 'true' && raw !== 'false') throw fieldError('open', 'Use true or false'); return raw === 'true'; } },
];

function requireBody(body, allowed) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw fieldError('body', `Use an object with ${allowed.join(' and ')}`);
  const unknown = Object.keys(body).filter(field => !allowed.includes(field));
  if (unknown.length) throw new TaskError('One or more fields failed validation.', 400, unknown.map(field => ({ field, message: 'Unknown field' })));
  return body;
}

/** The response shape is spelled out so a stored column never leaks by accident. */
function taskView(task) {
  return {
    id: task.id,
    project: task.project,
    title: task.title,
    state: task.state,
    worktreePath: task.worktreePath,
    branch: task.branch,
    baseBranch: task.baseBranch,
    baseCommit: task.baseCommit,
    prUrl: task.prUrl,
    revision: task.revision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
  };
}

export function createTasksRouter({ service, taskStore } = {}) {
  for (const method of ['create', 'get', 'rename', 'openTerminal']) {
    if (typeof service?.[method] !== 'function') throw new TypeError(`tasks router requires service.${method}`);
  }
  if (typeof taskStore?.list !== 'function') throw new TypeError('tasks router requires taskStore.list');

  const router = express.Router();
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  router.use(BASE, (req, res, next) => {
    req.tasksTraceId = randomUUID();
    res.set('X-Trace-Id', req.tasksTraceId);
    next();
  });
  router.use(BASE, express.json({ limit: '4kb' }));

  router.get(BASE, route((req, res) => {
    const query = parseCollectionQuery(req.query, { sortFields: SORT_FIELDS, defaultSort: 'createdAt,desc', filters: FILTERS }, fieldError);
    const { project, state, open } = query.filters;
    const tasks = taskStore.list().filter(task => (project === undefined || task.project === project)
      && (state === undefined || task.state === state)
      && (open === undefined || OPEN_STATES.includes(task.state) === open));
    const page = paginate(tasks, query);
    res.json({ data: page.data.map(taskView), page: page.page });
  }));

  router.post(BASE, route(async (req, res) => {
    const body = requireBody(req.body, ['project', 'title']);
    res.status(201).json(taskView(await service.create({ project: body.project, title: body.title })));
  }));

  router.get(`${BASE}/:id`, route((req, res) => {
    res.json(taskView(service.get(req.params.id)));
  }));

  router.put(`${BASE}/:id`, route((req, res) => {
    const body = requireBody(req.body, ['title', 'revision']);
    res.json(taskView(service.rename(req.params.id, { title: body.title, revision: body.revision })));
  }));

  router.post(`${BASE}/:id/terminals`, route(async (req, res) => {
    if (req.body !== undefined && Object.keys(requireBody(req.body, [])).length) throw fieldError('body', 'This request takes no body');
    res.status(201).json(await service.openTerminal(req.params.id));
  }));

  router.use(BASE, (_req, _res, next) => next(new TaskError('Tasks endpoint not found', 404)));

  router.use((error, req, res, next) => {
    if (!req.originalUrl.startsWith(BASE)) return next(error);
    const status = error instanceof TaskError && [400, 404, 409, 500, 503].includes(error.status)
      ? error.status : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    const message = error instanceof TaskError ? error.message
      : status === 400 ? 'Malformed JSON body' : status === 413 ? 'Request body too large' : 'Task request failed';
    const title = status === 400 ? 'Validation Error' : 'Task Error';
    const traceId = req.tasksTraceId ?? randomUUID();
    const fields = status === 400 ? ` fields=${(error.errors ?? []).map(item => item.field).join(',')}` : '';
    if (status >= 500) console.error(`[tasks] request failed status=${status} traceId=${traceId}`, error.cause ?? error);
    else console.warn(`[tasks] request failed status=${status} traceId=${traceId} path=${req.originalUrl.split('?')[0]}${fields}`);
    res.status(status).type('application/problem+json').json({
      type: 'about:blank', title, status, detail: message, error: title, message,
      timestamp: new Date().toISOString(), path: req.originalUrl.split('?')[0], traceId,
      ...(status === 400 ? { errors: error.errors?.length ? error.errors : [{ field: 'body', message }] } : {}),
    });
  });

  return router;
}
