import express from 'express';
import { randomUUID } from 'node:crypto';

const BASE = '/api/session-attention';

class NotFound extends Error { constructor() { super('Session attention endpoint not found'); this.status = 404; } }

/** Desktop endpoint for muting a session's status colours and acknowledging finished work. */
export function createSessionAttentionRouter({ service }) {
  if (typeof service?.apply !== 'function') throw new Error('session attention router: a state service is required');
  const router = express.Router();
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  router.use(BASE, (req, res, next) => { req.attentionTraceId = randomUUID(); res.set('X-Trace-Id', req.attentionTraceId); next(); });
  router.use(BASE, express.json({ limit: '4kb', strict: false }));
  router.put(`${BASE}/:sessionId`, route((req, res) => res.json(service.apply(req.params.sessionId, req.body))));
  router.use(BASE, (_req, _res, next) => next(new NotFound()));

  router.use((error, req, res, next) => {
    if (!req.originalUrl.startsWith(BASE)) return next(error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && !error.type ? error.status
      : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    const isValidation = status === 400;
    const message = error.type === 'entity.parse.failed' ? 'Malformed JSON body'
      : status === 413 ? 'Request body too large'
        : status === 500 ? 'Session attention request failed' : error.message;
    const traceId = req.attentionTraceId ?? randomUUID();
    console.warn(`[session-attention] request failed status=${status} traceId=${traceId}`);
    // A 500 hides its cause from the client; the log keeps it under the same trace id.
    if (status === 500) console.warn(`[session-attention] request_failed_cause traceId=${traceId}`, error?.stack ?? String(error));
    res.status(status).type('application/problem+json').json({
      type: 'about:blank',
      title: isValidation ? 'Validation Error' : 'Session Attention Error',
      status,
      detail: message,
      error: isValidation ? 'Validation Error' : 'Session Attention Error',
      message,
      timestamp: new Date().toISOString(),
      path: req.originalUrl.split('?')[0],
      traceId,
      ...(isValidation ? { errors: error.errors?.length ? error.errors : [{ field: 'body', message }] } : {}),
    });
  });
  return router;
}
