import express from 'express';
import { randomUUID } from 'node:crypto';

const BASE = '/api/terminal-waiting';
const SORT_FIELDS = ['sessionId', 'waitingAt'];
const DEFAULT_SIZE = 20;
const MAX_SIZE = 100;

class WaitingError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

function fieldError(field, message) {
  return new WaitingError('One or more fields failed validation.', 400, [{ field, message }]);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parseCollectionQuery(query) {
  const page = query.page === undefined ? 0 : Number(query.page);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000) {
    throw fieldError('page', 'Use an integer from 0 to 100000');
  }
  const size = query.size === undefined ? DEFAULT_SIZE : Number(query.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SIZE) {
    throw fieldError('size', `Use an integer from 1 to ${MAX_SIZE}`);
  }
  const sort = query.sort ?? `${SORT_FIELDS[0]},asc`;
  if (typeof sort !== 'string') throw fieldError('sort', 'Use field,asc or field,desc');
  const [field, direction, extra] = sort.split(',');
  if (!SORT_FIELDS.includes(field) || !['asc', 'desc'].includes(direction) || extra !== undefined) {
    throw fieldError('sort', `Sort by ${SORT_FIELDS.join(' or ')} with asc or desc`);
  }
  if (query.sessionId !== undefined && !isText(query.sessionId)) {
    throw fieldError('sessionId', 'A session ID is required');
  }
  return { page, size, field, direction, sessionId: query.sessionId };
}

// sessionId is the stable tiebreaker — without it, equal waitingAt values let
// pagination repeat and skip rows between pages.
function paginate(records, { page, size, field, direction }) {
  const sorted = [...records].sort((a, b) => {
    const compared = String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
    return (direction === 'desc' ? -compared : compared)
      || String(a.sessionId).localeCompare(String(b.sessionId));
  });
  return {
    data: sorted.slice(page * size, (page + 1) * size),
    page: {
      currentPage: page,
      size,
      totalElements: records.length,
      totalPages: Math.ceil(records.length / size),
      hasNextPage: (page + 1) * size < records.length,
    },
  };
}

export function createTerminalWaitingRouter({ store, sessionExists }) {
  if (!store) throw new Error('terminal waiting router: a store is required');
  if (typeof sessionExists !== 'function') throw new Error('terminal waiting router: sessionExists must be a function');

  const router = express.Router();
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const asView = record => ({ sessionId: record.sessionId, waiting: true, waitingAt: record.waitingAt });

  router.use(BASE, (req, res, next) => {
    req.waitingTraceId = randomUUID();
    res.set('X-Trace-Id', req.waitingTraceId);
    next();
  });
  router.use(BASE, express.json({ limit: '4kb' }));

  router.get(BASE, route((req, res) => {
    const query = parseCollectionQuery(req.query);
    const records = store.list()
      .filter(record => query.sessionId === undefined || record.sessionId === query.sessionId)
      .map(asView);
    res.json(paginate(records, query));
  }));

  router.put(`${BASE}/:sessionId`, route((req, res) => {
    const { sessionId } = req.params;
    const waiting = req.body?.waiting;
    if (typeof waiting !== 'boolean') throw fieldError('waiting', 'Use true to mark waiting or false to clear it');
    if (!isText(sessionId)) throw fieldError('sessionId', 'A session ID is required');
    if (!sessionExists(sessionId)) throw new WaitingError('Terminal session not found', 404);

    if (!waiting) {
      store.clear(sessionId);
      return res.json({ sessionId, waiting: false, waitingAt: null });
    }
    res.json(asView(store.mark(sessionId, new Date().toISOString())));
  }));

  router.use(BASE, (_req, _res, next) => next(new WaitingError('Terminal waiting endpoint not found', 404)));

  router.use((error, req, res, next) => {
    if (!req.originalUrl.startsWith(BASE)) return next(error);
    const status = error instanceof WaitingError
      ? error.status
      : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    const isValidation = status === 400;
    const message = error instanceof WaitingError
      ? error.message
      : isValidation ? 'Malformed JSON body' : status === 413 ? 'Request body too large' : 'Terminal waiting request failed';
    const traceId = req.waitingTraceId ?? randomUUID();
    console.warn(`[terminal-waiting] request failed status=${status} traceId=${traceId}`);
    res.status(status).type('application/problem+json').json({
      type: 'about:blank',
      title: isValidation ? 'Validation Error' : 'Terminal Waiting Error',
      status,
      detail: message,
      error: isValidation ? 'Validation Error' : 'Terminal Waiting Error',
      message,
      timestamp: new Date().toISOString(),
      path: req.originalUrl.split('?')[0],
      traceId,
      ...(isValidation ? { errors: error.errors?.length ? error.errors : [{ field: 'body', message }] } : {}),
    });
  });

  return router;
}
