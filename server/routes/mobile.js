import express from 'express';
import { randomUUID } from 'node:crypto';
import { MobileError, requireField, isUuid } from '../mobile-store.js';
import { sendMobileProblem } from '../mobile-access.js';
const BASE = '/api/mobile/v1';
const PROJECT_STATES = ['active', 'waiting', 'shelved'];
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && value !== 'null' && !/[\x00-\x1f<>;'"=]/.test(value);
function parseQuery(query, fields, filters) {
  const errors = [];
  const check = (valid, field, message) => { if (!valid) errors.push({ field, message }); };
  for (const key of Object.keys(query)) check(['page', 'size', 'sort', ...filters].includes(key), key, 'Unknown query field');
  for (const [key, max] of [['page', 100000], ['size', 100]]) {
    if (query[key] !== undefined) check(typeof query[key] === 'string' && /^\d+$/.test(query[key]) && Number(query[key]) >= (key === 'size' ? 1 : 0) && Number(query[key]) <= max, key, `Use an integer from ${key === 'size' ? 1 : 0} to ${max}`);
  }
  const sort = query.sort ?? `${fields[0]},asc`;
  const [field, direction, extra] = typeof sort === 'string' ? sort.split(',') : [];
  check(fields.includes(field) && ['asc', 'desc'].includes(direction) && extra === undefined, 'sort', `Use ${fields.join(' or ')},asc or ,desc`);
  for (const key of filters) if (query[key] !== undefined) check(text(query[key]), key, 'Use nonempty filter text of at most 256 characters');
  if (query.status !== undefined) check(['running', 'idle', 'dead', 'unknown'].includes(query.status), 'status', 'Unknown session status');
  if (query.state !== undefined) check(PROJECT_STATES.includes(query.state), 'state', `Use ${PROJECT_STATES.join(', ')}`);
  if (errors.length) throw new MobileError('One or more fields failed validation.', 400, errors);
  return { page: Number(query.page ?? 0), size: Number(query.size ?? 20), field, direction };
}
function paginate(data, query) {
  const { page, size, field, direction } = query;
  // Activity time is numeric, and unknown (null) is older than anything known.
  const rank = value => (value === null ? -1 : value);
  const compare = (a, b) => (field === 'lastActivityAt' ? rank(a[field]) - rank(b[field]) : String(a[field]).localeCompare(String(b[field])));
  data.sort((a, b) => (direction === 'asc' ? 1 : -1) * compare(a, b) || a.id.localeCompare(b.id));
  return { data: data.slice(page * size, (page + 1) * size), page: { currentPage: page, size, totalElements: data.length, totalPages: Math.ceil(data.length / size), hasNextPage: (page + 1) * size < data.length } };
}
function projectView(value) {
  for (const field of ['id', 'name']) requireField(typeof value?.[field] === 'string' && value[field].trim().length > 0, field, 'Project field must be nonempty');
  requireField(PROJECT_STATES.includes(value.state), 'state', `Project state must be ${PROJECT_STATES.join(', ')}`);
  requireField(value.stateChangedAt === null || (typeof value.stateChangedAt === 'string' && !Number.isNaN(Date.parse(value.stateChangedAt))), 'stateChangedAt', 'Project state time must be an ISO timestamp or null');
  return { id: value.id, name: value.name, state: value.state, stateChangedAt: value.stateChangedAt };
}
function sessionView(value) {
  for (const field of ['id', 'projectId', 'title', 'host', 'runtimeType']) requireField(typeof value?.[field] === 'string' && value[field].trim().length > 0, field, 'Session field must be nonempty');
  requireField(isUuid(value.incarnationId), 'incarnationId', 'Session incarnation must be a UUID');
  requireField(['running', 'idle', 'dead', 'unknown'].includes(value.status), 'status', 'Session status must be explicit');
  requireField(typeof value.live === 'boolean', 'live', 'Session freshness must be explicit');
  requireField(value.cwd === null || typeof value.cwd === 'string', 'cwd', 'Session cwd must be a string or null');
  for (const field of ['finished', 'muted', 'waiting', 'needsInput']) requireField(typeof value[field] === 'boolean', field, 'Session attention flag must be explicit');
  requireField(value.lastActivityAt === null || (Number.isSafeInteger(value.lastActivityAt) && value.lastActivityAt >= 0), 'lastActivityAt', 'Session activity time must be a nonnegative integer or null');
  return Object.fromEntries(['id', 'incarnationId', 'projectId', 'title', 'status', 'live', 'cwd', 'host', 'runtimeType', 'finished', 'muted', 'waiting', 'needsInput', 'lastActivityAt'].map(field => [field, value[field]]));
}
function sessionStateView(value) {
  requireField(typeof value?.sessionId === 'string' && value.sessionId.trim().length > 0, 'sessionId', 'Session identity must be nonempty');
  for (const field of ['finished', 'muted', 'waiting']) requireField(typeof value[field] === 'boolean', field, 'Session attention flag must be explicit');
  requireField(value.lastActivityAt === null || (Number.isSafeInteger(value.lastActivityAt) && value.lastActivityAt >= 0), 'lastActivityAt', 'Session activity time must be a nonnegative integer or null');
  return { sessionId: value.sessionId, finished: value.finished, muted: value.muted, waiting: value.waiting, lastActivityAt: value.lastActivityAt };
}
export function createMobileRouter({ store, notifications, notificationsReady, listProjects, listSessions, startSession, setSessionState, terminalMetrics }) {
  requireField(store && typeof store.ensureIncarnation === 'function', 'store', 'Companion store required');
  requireField(notifications && typeof notifications.queueTest === 'function' && typeof notifications.resolveEvent === 'function', 'notifications', 'Notification service required');
  for (const [field, value] of Object.entries({ notificationsReady, listProjects, listSessions, startSession, setSessionState, terminalMetrics })) requireField(typeof value === 'function', field, 'Function required');
  const router = express.Router();
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  router.use(BASE, (req, res, next) => { req.mobileTraceId = randomUUID(); res.set('X-Trace-Id', req.mobileTraceId); next(); });
  router.use(BASE, express.json({ limit: '12kb' }));
  router.get(`${BASE}/capabilities`, route((_req, res) => res.json({ instanceId: store.instanceId, protocolVersion: 2, notificationsReady: notificationsReady(), capabilities: ['multi-client', 'control-revisions', 'session-incarnations', 'push-notifications', 'project-state', 'session-start', 'session-state'], diagnostics: { terminals: terminalMetrics(), notifications: notifications.metrics() } })));
  router.get(`${BASE}/projects`, route(async (req, res) => {
    const query = parseQuery(req.query, ['name', 'id'], ['name', 'state']);
    const records = (await listProjects()).map(projectView).filter(item => ['name', 'state'].every(key => req.query[key] === undefined || item[key] === req.query[key]));
    res.json(paginate(records, query));
  }));
  router.post(`${BASE}/projects/:projectId/sessions`, route(async (req, res) => {
    const errors = [];
    if (!text(req.params.projectId)) errors.push({ field: 'projectId', message: 'Use a nonempty project identity of at most 256 characters without control or markup characters' });
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) errors.push({ field: 'body', message: 'Send an empty JSON object or no body' });
    else for (const key of Object.keys(body)) errors.push({ field: key, message: 'Unknown body field; this request takes no fields' });
    if (errors.length) throw new MobileError('One or more fields failed validation.', 400, errors);
    const session = sessionView(await startSession(req.params.projectId));
    res.status(201).location(`${BASE}/sessions?id=${encodeURIComponent(session.id)}`).json(session);
  }));
  router.get(`${BASE}/sessions`, route(async (req, res) => {
    const query = parseQuery(req.query, ['title', 'id', 'status', 'lastActivityAt'], ['id', 'projectId', 'status']);
    const records = (await listSessions()).map(sessionView).filter(item => ['id', 'projectId', 'status'].every(key => req.query[key] === undefined || item[key] === req.query[key]));
    res.json(paginate(records, query));
  }));
  // Validation of the change itself lives in the shared state service, so the
  // desktop and the phone are held to identical rules.
  router.put(`${BASE}/sessions/:sessionId/state`, route((req, res) => res.json(sessionStateView(setSessionState(req.params.sessionId, req.body)))));
  router.put(`${BASE}/devices/:installationId`, route((req, res) => res.json(store.registerDevice(req.params.installationId, req.body))));
  router.delete(`${BASE}/devices/:installationId`, route((req, res) => { store.unregisterDevice(req.params.installationId); res.sendStatus(204); }));
  router.post(`${BASE}/devices/:installationId/test-notification`, route((req, res) => {
    requireField(isUuid(req.params.installationId), 'installationId', 'Use a UUID');
    const device = store.listDevices().find(item => item.installationId === req.params.installationId);
    if (!device) throw new MobileError('Installation not found', 404);
    if (!notificationsReady()) throw new MobileError('Notifications are not configured', 503);
    if (!device.notificationsEnabled || device.permission !== 'granted' || device.token === null) throw new MobileError('Notifications are not enabled for this installation', 409);
    res.status(202).json(notifications.queueTest(req.params.installationId));
  }));
  router.get(`${BASE}/events/:eventId`, route(async (req, res) => {
    requireField(isUuid(req.params.eventId), 'eventId', 'Use a UUID');
    const event = notifications.resolveEvent(req.params.eventId);
    if (!event) throw new MobileError('Notification event not found', 404);
    if (event.sessionId !== null) await listSessions();
    const current = event.sessionId === null ? null : store.currentIncarnation(event.sessionId);
    res.json({ ...event, ...(event.sessionId !== null && current !== event.incarnationId ? { status: 'ended' } : {}) });
  }));
  router.use(BASE, (_req, _res, next) => next(new MobileError('Companion endpoint not found', 404)));
  router.use((error, req, res, next) => {
    if (!req.originalUrl.startsWith(BASE)) return next(error);
    if (error.type === 'entity.parse.failed') error = new MobileError('Malformed JSON body', 400);
    if (error.type === 'entity.too.large') error = new MobileError('Request body too large', 413);
    sendMobileProblem(res, req, error);
  });
  return router;
}
