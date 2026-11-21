/**
 * The repositories of a project over HTTP: the list, the repositories found beside the
 * project, adding one and removing one. Lists are paginated; errors are RFC 9457 problem
 * documents with a trace id that is also in the log line of the same request.
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import { RepositoryError } from '../project-repositories.js';
import { parseCollectionQuery, paginate } from './collection-query.js';

// Everything this router answers, and nothing else under /api/projects.
export const REPOSITORIES_PATH = /^\/api\/projects\/[^/]+\/(?:repositories|repository-candidates|terminals)(?:\/|$)/;
const SORT = { sortFields: ['name'], defaultSort: 'name,asc' };

const fieldError = (field, message) => new RepositoryError('One or more fields failed validation.', 400, [{ field, message }]);

/** The response shapes are spelled out so nothing stored or computed leaks by accident. */
function repositoryView(entry) {
  return {
    name: entry.name,
    path: entry.path,
    own: entry.own,
    branch: entry.branch,
    head: entry.head,
    dirty: entry.dirty,
    usable: entry.usable,
    reason: entry.reason === null ? null : { code: entry.reason.code, message: entry.reason.message },
  };
}

const candidateView = entry => ({ name: entry.name, path: entry.path, branch: entry.branch });

export function createProjectRepositoriesRouter({ service } = {}) {
  for (const method of ['list', 'candidates', 'add', 'remove', 'openTerminal']) {
    if (typeof service?.[method] !== 'function') throw new TypeError(`project repositories router requires service.${method}`);
  }

  const router = express.Router();
  const serves = req => REPOSITORIES_PATH.test(req.path);
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const parseJson = express.json({ limit: '4kb' });

  router.use((req, res, next) => {
    if (!serves(req)) return next();
    req.repositoriesTraceId = randomUUID();
    res.set('X-Trace-Id', req.repositoriesTraceId);
    return parseJson(req, res, next);
  });

  /** One page of a list whose entries are known by their path. */
  const page = (req, entries, view) => {
    const query = parseCollectionQuery(req.query, SORT, fieldError);
    const result = paginate(entries.map(entry => ({ ...entry, id: entry.path })), query);
    return { data: result.data.map(view), page: result.page };
  };

  router.get('/api/projects/:name/repositories', route(async (req, res) => {
    const { host, ...restQuery } = req.query;
    parseCollectionQuery(restQuery, SORT, fieldError);
    res.json(page({ query: restQuery }, await service.list(req.params.name, host ? { host } : {}), repositoryView));
  }));

  router.get('/api/projects/:name/repository-candidates', route(async (req, res) => {
    const { host, ...restQuery } = req.query;
    parseCollectionQuery(restQuery, SORT, fieldError);
    res.json(page({ query: restQuery }, await service.candidates(req.params.name, host ? { host } : {}), candidateView));
  }));

  router.post('/api/projects/:name/repositories', route(async (req, res) => {
    res.status(201).json(repositoryView(await service.add(req.params.name, req.body)));
  }));

  // A terminal in the own checkout of one of the project's repositories, so every repository is reached from the project.
  router.post('/api/projects/:name/terminals', route(async (req, res) => {
    const opened = await service.openTerminal(req.params.name, req.body);
    res.status(201).json({
      sessionId: opened.sessionId,
      project: opened.project,
      host: opened.host ?? 'local',
      repository: opened.repository,
      path: opened.path,
      ...(opened.sync ? { sync: opened.sync } : {}),
    });
  }));

  router.delete('/api/projects/:name/repositories/:repository', route(async (req, res) => {
    await service.remove(req.params.name, req.params.repository, req.query.host ? { host: req.query.host } : {});
    res.status(204).end();
  }));

  router.use((req, _res, next) => (serves(req) ? next(new RepositoryError('Repositories endpoint not found', 404)) : next()));

  router.use((error, req, res, next) => {
    if (!serves(req)) return next(error);
    const known = error instanceof RepositoryError && [400, 404, 409, 500, 503].includes(error.status);
    const status = known ? error.status : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    const message = known ? error.message
      : status === 400 ? 'One or more fields failed validation.' : status === 413 ? 'Request body too large' : 'The repositories request failed.';
    const errors = status !== 400 ? undefined : known && error.errors?.length ? error.errors : [{ field: 'body', message: known ? message : 'Malformed JSON body' }];
    const title = status === 400 ? 'Validation Error' : 'Repositories Error';
    const traceId = req.repositoriesTraceId ?? randomUUID();
    const where = `${req.method} ${req.route?.path ?? 'unmatched'}`;
    if (status >= 500) console.error(`[project-repositories] request failed status=${status} route=${where} traceId=${traceId}`, error);
    else console.warn(`[project-repositories] request refused status=${status} route=${where} traceId=${traceId}${errors ? ` fields=${errors.map(item => item.field).join(',')}` : ''}`);
    res.status(status).type('application/problem+json').json({
      type: 'about:blank', title, status, detail: message, error: title, message,
      timestamp: new Date().toISOString(), path: req.originalUrl.split('?')[0], traceId,
      ...(errors ? { errors } : {}),
      ...(error instanceof RepositoryError && error.extra ? error.extra : {}),
    });
  });

  return router;
}
