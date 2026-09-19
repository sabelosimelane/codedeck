import express from 'express';
import { randomUUID } from 'node:crypto';
import { NamingError, requireField, isText, validateEndpoint, validateSettings, validateSelection } from '../session-naming-validation.js';

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

export function createNamingRouter({ store, service, credentials, conduit, sessionExists }) {
  const router = express.Router();
  const base = '/api/session-naming';
  const previews = new Map();
  router.use(base, (req, res, next) => { req.namingTraceId = randomUUID(); res.set('X-Trace-Id', req.namingTraceId); next(); });
  router.use(base, express.json({ limit: '16kb' }));
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const publicSettings = () => ({ ...(store.settings() ?? { baseUrl: '', provider: '', model: '', effort: null }), hasCredential: credentials.read() !== null });
  const connectionCredential = (body, baseUrl) => {
    if (Object.hasOwn(body, 'credential')) {
      requireField(body.credential === null || isText(body.credential, 4096), 'credential', 'Use a nonempty credential or null');
      return body.credential;
    }
    const saved = store.settings();
    if (saved && saved.baseUrl !== baseUrl && credentials.read() !== null) throw new NamingError('Re-enter the credential when changing the Conduit endpoint', 400, [{ field: 'credential', message: 'Re-enter for the new endpoint' }]);
    return credentials.read();
  };
  const assertSession = id => {
    requireField(isText(id), 'sessionId', 'A valid session ID is required');
    if (!sessionExists(id)) throw new NamingError('Terminal session not found', 404);
  };
  router.get(`${base}/settings`, route((_req, res) => res.json(publicSettings())));
  router.put(`${base}/settings`, route(async (req, res) => {
    const settings = validateSettings(req.body);
    const credential = connectionCredential(req.body, settings.baseUrl);
    validateSelection(settings, await conduit.catalog(settings.baseUrl, credential));
    credentials.write(credential); store.saveSettings(settings);
    res.json(publicSettings());
  }));
  router.post(`${base}/connection-test`, route(async (req, res) => {
    const baseUrl = validateEndpoint(req.body?.baseUrl);
    const credential = connectionCredential(req.body, baseUrl);
    const providers = await conduit.catalog(baseUrl, credential);
    for (const [id, preview] of previews) if (preview.expires <= Date.now()) previews.delete(id);
    if (previews.size >= 20) previews.delete(previews.keys().next().value);
    const connectionId = randomUUID(); previews.set(connectionId, { providers, expires: Date.now() + 300000 });
    res.json({ connectionId });
  }));
  router.get(`${base}/catalog`, route(async (req, res) => {
    pageQuery(req.query, ['id']);
    let providers;
    if (req.query.connectionId !== undefined) {
      requireField(isText(req.query.connectionId), 'connectionId', 'A connection ID is required');
      const preview = previews.get(req.query.connectionId);
      if (!preview || preview.expires <= Date.now()) throw new NamingError('Connection test expired. Test the connection again.', 404);
      providers = preview.providers;
    } else {
      const settings = store.settings(); if (!settings) throw new NamingError('Test or save a Conduit connection first', 409);
      providers = await conduit.catalog(settings.baseUrl);
    }
    for (const field of ['enabled', 'available']) if (req.query[field] !== undefined) {
      requireField(['true', 'false'].includes(req.query[field]), field, 'Use true or false');
      providers = providers.filter(p => p[field] === (req.query[field] === 'true'));
    }
    if (req.query.id !== undefined) { requireField(isText(req.query.id), 'id', 'A provider ID is required'); providers = providers.filter(p => p.id === req.query.id); }
    res.json(paginate(providers, req.query, ['id']));
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
  router.get(`${base}/health`, route((_req, res) => res.json({ circuits: conduit.metrics() })));
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
