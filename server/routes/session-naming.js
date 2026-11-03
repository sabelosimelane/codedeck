import express from 'express';
import { randomUUID } from 'node:crypto';
import { NamingError, requireField, isText } from '../session-naming-validation.js';
import { validateCliSettings } from '../cli-naming-client.js';

function pageQuery(query, fields) {
  const page = query.page === undefined ? 0 : Number(query.page);
  const size = query.size === undefined ? 20 : Number(query.size);
  requireField(Number.isSafeInteger(page) && page >= 0 && page <= 100000, 'page', 'Use an integer from 0 to 100000');
  requireField(Number.isSafeInteger(size) && size >= 1 && size <= 100, 'size', 'Use an integer from 1 to 100');
  const sort = query.sort ?? `${fields[0]},asc`;
  requireField(typeof sort === 'string', 'sort', 'Use field,asc or field,desc');
  const [field, direction, extra] = sort.split(',');
  requireField(fields.includes(field) && ['asc', 'desc'].includes(direction) && extra === undefined, 'sort', 'Choose an allowed field and direction');
  return { page, size, field, direction };
}
function paginate(items, query, fields) {
  const { page, size, field, direction } = pageQuery(query, fields);
  const key = fields[0];
  const sorted = [...items].sort((a, b) => {
    const compared = String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
    return (direction === 'desc' ? -compared : compared) || String(a[key]).localeCompare(String(b[key]));
  });
  return { data: sorted.slice(page * size, (page + 1) * size), page: { currentPage: page, size, totalElements: items.length, totalPages: Math.ceil(items.length / size), hasNextPage: (page + 1) * size < items.length } };
}

export function createNamingRouter({ store, service, sessionExists }) {
  const router = express.Router();
  const base = '/api/session-naming';
  router.use(base, (req, res, next) => { req.namingTraceId = randomUUID(); res.set('X-Trace-Id', req.namingTraceId); next(); });
  router.use(base, express.json({ limit: '16kb' }));
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const publicSettings = () => store.settings() ?? { provider: '', model: '', effort: null };
  const assertSession = id => {
    requireField(isText(id), 'sessionId', 'A valid session ID is required');
    if (!sessionExists(id)) throw new NamingError('Terminal session not found', 404);
  };
  router.get(`${base}/settings`, route((_req, res) => res.json(publicSettings())));
  router.put(`${base}/settings`, route(async (req, res) => {
    store.saveSettings(validateCliSettings(req.body));
    res.json(publicSettings());
  }));
  router.get(`${base}/titles`, route((req, res) => {
    let records = store.list();
    if (req.query.sessionId !== undefined) { requireField(isText(req.query.sessionId), 'sessionId', 'A session ID is required'); records = records.filter(r => r.sessionId === req.query.sessionId); }
    if (req.query.state !== undefined) {
      requireField(['waiting', 'queued', 'generating', 'named', 'failed', 'manual'].includes(req.query.state), 'state', 'A naming state is required'); records = records.filter(r => r.state === req.query.state);
    }
    res.json(paginate(records, req.query, ['sessionId', 'title', 'state']));
  }));
  router.put(`${base}/titles/:sessionId`, route((req, res) => { assertSession(req.params.sessionId); res.json(service.rename(req.params.sessionId, req.body?.title)); }));
  router.post(`${base}/titles/:sessionId/retry`, route((req, res) => { assertSession(req.params.sessionId); res.status(202).json(service.retry(req.params.sessionId)); }));
  router.use(base, (_req, _res, next) => next(new NamingError('Naming endpoint not found', 404)));
  router.use((error, req, res, next) => {
    if (!req.originalUrl.startsWith(base)) return next(error);
    const status = error instanceof NamingError ? error.status : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    const message = error instanceof NamingError ? error.message : status === 400 ? 'Malformed JSON body' : status === 413 ? 'Request body too large' : 'Session naming request failed';
    const traceId = req.namingTraceId ?? randomUUID();
    console.warn(`[session-naming] request failed status=${status} traceId=${traceId}`);
    if (status === 503) res.set('Retry-After', '30');
    res.status(status).type('application/problem+json').json({ type: 'about:blank', title: status === 400 ? 'Validation Error' : 'Session Naming Error', status, detail: message, error: status === 400 ? 'Validation Error' : 'Session Naming Error', message, timestamp: new Date().toISOString(), path: req.originalUrl.split('?')[0], traceId, ...(status === 400 ? { errors: error.errors?.length ? error.errors : [{ field: 'body', message }] } : {}) });
  });
  return router;
}
