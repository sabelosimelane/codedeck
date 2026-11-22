import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TaskError } from '../tasks/task-service.js';
import { isTaskTitle, TASK_STATES, TASK_TITLE_MAX } from '../tasks/task-store.js';
import { parseCollectionQuery, paginate } from './collection-query.js';

const BASE = '/api/tasks';
const SORT_FIELDS = ['createdAt', 'updatedAt', 'title'];
const WORKTREE_SORT_FIELDS = ['repository'];
const OPEN_STATES = ['active', 'pr_open'];
const CHANGE_SORT_FIELDS = ['mergedAt'];

const fieldError = (field, message) => new TaskError('One or more fields failed validation.', 400, [{ field, message }]);

const FILTERS = [
  { name: 'project', parse: raw => { if (typeof raw !== 'string' || raw.length === 0) throw fieldError('project', 'Use a project name'); return raw; } },
  { name: 'state', parse: raw => { if (!TASK_STATES.includes(raw)) throw fieldError('state', `Use one of ${TASK_STATES.join(', ')}`); return raw; } },
  { name: 'open', parse: raw => { if (raw !== 'true' && raw !== 'false') throw fieldError('open', 'Use true or false'); return raw === 'true'; } },
];

const CHANGE_FILTERS = [FILTERS[0]];

/** A merged task as the list of changes shows it; spelled out for the same reason as a task. */
function changeView(change) {
  return {
    id: change.id,
    project: change.project,
    title: change.title,
    mergedAt: change.mergedAt,
    workflow: change.workflow,
    // The first line and the whole of the note the run's last step wrote; null when there is none.
    summary: change.summary,
    detail: change.detail,
    repositories: change.repositories.map(entry => ({
      repository: entry.repository, branch: entry.branch, baseBranch: entry.baseBranch, commit: entry.commit, mergedAt: entry.mergedAt,
    })),
  };
}

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
    host: task.host ?? 'local',
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
    folder: task.folder,
    // One entry per repository of the task, the one it started in first. The fields above are that first one's.
    worktrees: task.worktrees.map(worktree => ({
      id: worktree.id,
      repository: worktree.repository,
      own: worktree.own,
      first: worktree.first,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      baseCommit: worktree.baseCommit,
      state: worktree.state,
      prUrl: worktree.prUrl,
    })),
  };
}

const reasonView = reason => ({ code: reason.code, message: reason.message });

function candidateView(candidate) {
  return {
    path: candidate.path,
    name: candidate.name,
    repository: candidate.repository,
    own: candidate.own,
    branch: candidate.branch,
    head: candidate.head,
    uncommittedCount: candidate.uncommittedCount,
    selectable: candidate.selectable,
    reason: candidate.reason === null ? null : reasonView(candidate.reason),
  };
}

/** How one repository of a task stands; spelled out for the same reason as a task. */
function worktreeLandingView(view) {
  return {
    taskId: view.taskId,
    worktreeId: view.worktreeId,
    repository: view.repository,
    own: view.own,
    first: view.first,
    worktreePath: view.worktreePath,
    state: view.state,
    branch: view.branch,
    baseBranch: view.baseBranch,
    prUrl: view.prUrl,
    filesPresent: view.filesPresent,
    runActive: view.runActive,
    uncommitted: view.uncommitted,
    uncommittedCount: view.uncommittedCount,
    commitsAhead: view.commitsAhead,
    commitsBehind: view.commitsBehind,
    alreadyInBase: view.alreadyInBase,
    ignoredAtRisk: [...view.ignoredAtRisk],
    ignoredAtRiskCount: view.ignoredAtRiskCount,
    main: { branch: view.main.branch, dirty: view.main.dirty },
    remotes: view.remotes.map(remote => ({ name: remote.name, host: remote.host, tool: remote.tool })),
    blockers: {
      commit: view.blockers.commit.map(reasonView),
      merge: view.blockers.merge.map(reasonView),
      pullRequest: view.blockers.pullRequest.map(reasonView),
      close: view.blockers.close.map(reasonView),
    },
  };
}

export function createTasksRouter({ service, taskStore, landing, changes } = {}) {
  for (const method of ['create', 'get', 'rename', 'openTerminal', 'addRepository']) {
    if (typeof service?.[method] !== 'function') throw new TypeError(`tasks router requires service.${method}`);
  }
  if (typeof taskStore?.list !== 'function') throw new TypeError('tasks router requires taskStore.list');
  for (const method of ['status', 'commit', 'merge', 'pullRequest', 'close', 'worktrees', 'closeWorktree']) {
    if (typeof landing?.[method] !== 'function') throw new TypeError(`tasks router requires landing.${method}`);
  }
  if (typeof changes?.list !== 'function') throw new TypeError('tasks router requires changes.list');
  const noBody = req => {
    if (req.body !== undefined && Object.keys(requireBody(req.body, [])).length) throw fieldError('body', 'This request takes no body');
  };

  /** Close takes no body, or `{deleteIgnored}`: the owner's word that ignored files only the task holds go with its folder. */
  const closeOptions = (req) => {
    if (req.body === undefined || Object.keys(requireBody(req.body, ['deleteIgnored'])).length === 0) return [];
    if (typeof req.body.deleteIgnored !== 'boolean') throw fieldError('deleteIgnored', 'Use true or false');
    return [{ deleteIgnored: req.body.deleteIgnored }];
  };

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
    // `repositories` names the project's repositories the task includes, the one it starts in first; left out, its own only.
    const body = requireBody(req.body, ['project', 'title', 'repositories', 'worktreePath', 'host', 'skipSync']);
    if (body.host !== undefined && (typeof body.host !== 'string' || !body.host.trim())) throw fieldError('host', 'Use a host name');
    if (body.skipSync !== undefined && typeof body.skipSync !== 'boolean') throw fieldError('skipSync', 'Use true or false');
    if (Object.hasOwn(body, 'worktreePath')) {
      if (Object.hasOwn(body, 'repositories')) throw new TaskError('One or more fields failed validation.', 400,
        [{ field: 'worktreePath', message: 'Choose either worktreePath or repositories' }, { field: 'repositories', message: 'Choose either repositories or worktreePath' }]);
      if (typeof body.project !== 'string' || !body.project) throw fieldError('project', 'A project name is required');
      if (typeof body.worktreePath !== 'string' || !path.isAbsolute(body.worktreePath) || body.worktreePath.includes('\0')) throw fieldError('worktreePath', 'Use an absolute worktree path');
      if (body.title !== undefined && !isTaskTitle(body.title)) throw fieldError('title', `Use 1–${TASK_TITLE_MAX} characters on one line`);
      res.status(201).json(taskView(await service.adoptWorktree(body)));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'repositories') && !Array.isArray(body.repositories)) throw fieldError('repositories', 'Use a list of repository names');
    res.status(201).json(taskView(await service.create({
      project: body.project,
      title: body.title,
      repositories: body.repositories,
      ...(body.host !== undefined ? { host: body.host } : {}),
      ...(body.skipSync !== undefined ? { skipSync: body.skipSync } : {}),
    })));
  }));

  router.get(`${BASE}/worktree-candidates`, route(async (req, res) => {
    const query = parseCollectionQuery(req.query, { sortFields: ['path'], defaultSort: 'path,asc', filters: [FILTERS[0]] }, fieldError);
    if (query.filters.project === undefined) throw fieldError('project', 'A project name is required');
    const page = paginate(await service.listWorktreeCandidates(query.filters.project), query);
    res.json({ data: page.data.map(candidateView), page: page.page });
  }));

  // What has been merged, newest first. Registered before `/:id`: a task id is a UUID, never this word.
  router.get(`${BASE}/changes`, route((req, res) => {
    const query = parseCollectionQuery(req.query, { sortFields: CHANGE_SORT_FIELDS, defaultSort: 'mergedAt,desc', filters: CHANGE_FILTERS }, fieldError);
    const { project } = query.filters;
    const page = paginate(changes.list().filter(change => project === undefined || change.project === project), query);
    res.json({ data: page.data.map(changeView), page: page.page });
  }));

  router.get(`${BASE}/:id`, route((req, res) => {
    res.json(taskView(service.get(req.params.id)));
  }));

  router.put(`${BASE}/:id`, route((req, res) => {
    const body = requireBody(req.body, ['title', 'revision']);
    res.json(taskView(service.rename(req.params.id, { title: body.title, revision: body.revision })));
  }));

  router.post(`${BASE}/:id/terminals`, route(async (req, res) => {
    // `worktreeId` names the repository of the task to open the terminal in; left out, the one the task started in.
    const body = req.body === undefined ? {} : requireBody(req.body, ['worktreeId']);
    res.status(201).json(await service.openTerminal(req.params.id, Object.prototype.hasOwnProperty.call(body, 'worktreeId') ? { worktreeId: body.worktreeId } : {}));
  }));

  // --- Landing: how a task's work gets back into the project ---

  router.get(`${BASE}/:id/landing`, route(async (req, res) => {
    if (Object.keys(req.query).length) throw fieldError(Object.keys(req.query)[0], 'Unknown query field');
    res.json(await landing.status(req.params.id));
  }));

  router.post(`${BASE}/:id/commit`, route(async (req, res) => {
    const body = requireBody(req.body, ['message']);
    res.json(await landing.commit(req.params.id, { message: body.message }));
  }));

  router.post(`${BASE}/:id/merge`, route(async (req, res) => {
    noBody(req);
    const result = await landing.merge(req.params.id);
    res.json({ ...result, task: taskView(result.task) });
  }));

  router.post(`${BASE}/:id/pull-request`, route(async (req, res) => {
    const body = requireBody(req.body, ['remote']);
    const result = await landing.pullRequest(req.params.id, { remote: body.remote });
    res.json({ ...result, task: taskView(result.task) });
  }));

  router.post(`${BASE}/:id/close`, route(async (req, res) => {
    const result = await landing.close(req.params.id, ...closeOptions(req));
    res.json({ ...result, task: taskView(result.task) });
  }));

  // --- Landing one repository of a task ---

  // One more repository for an open task, named one way: `{repository}` (one of the project's, by name), `{path}` (a repository the
  // project does not list, by its folder) or `{worktreePath}` (a worktree that already exists, taken as it is). The service checks the
  // body, since it knows the project's repositories and reads the folders.
  router.post(`${BASE}/:id/worktrees`, route(async (req, res) => {
    res.status(201).json(taskView(await service.addRepository(req.params.id, req.body ?? null)));
  }));

  router.get(`${BASE}/:id/worktrees`, route(async (req, res) => {
    const query = parseCollectionQuery(req.query, { sortFields: WORKTREE_SORT_FIELDS, defaultSort: 'repository,asc', filters: [] }, fieldError);
    const views = await landing.worktrees(req.params.id);
    const page = paginate(views.map(view => ({ ...view, id: view.worktreeId })), query);
    res.json({ data: page.data.map(worktreeLandingView), page: page.page });
  }));

  router.post(`${BASE}/:id/worktrees/:worktreeId/commit`, route(async (req, res) => {
    const body = requireBody(req.body, ['message']);
    res.json(worktreeLandingView(await landing.commit(req.params.id, { message: body.message, worktreeId: req.params.worktreeId })));
  }));

  router.post(`${BASE}/:id/worktrees/:worktreeId/merge`, route(async (req, res) => {
    noBody(req);
    const result = await landing.merge(req.params.id, { worktreeId: req.params.worktreeId });
    res.json({ ...result, task: taskView(result.task) });
  }));

  router.post(`${BASE}/:id/worktrees/:worktreeId/pull-request`, route(async (req, res) => {
    const body = requireBody(req.body, ['remote']);
    const result = await landing.pullRequest(req.params.id, { remote: body.remote, worktreeId: req.params.worktreeId });
    res.json({ ...result, task: taskView(result.task) });
  }));

  router.post(`${BASE}/:id/worktrees/:worktreeId/close`, route(async (req, res) => {
    const result = await landing.closeWorktree(req.params.id, req.params.worktreeId, ...closeOptions(req));
    res.json({ ...result, task: taskView(result.task) });
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
      // Why an action was refused: `reasons` (each with a code and message) or `conflicts` (file paths).
      ...(error instanceof TaskError && error.extra ? error.extra : {}),
    });
  });

  return router;
}
