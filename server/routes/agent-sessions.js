import express from 'express';
import { randomUUID } from 'node:crypto';
import { createAgentSessionsService, SessionError } from '../agent-history/service.js';
const BASE = '/api/agent-sessions';
export function createAgentSessionsRouter(deps) {
  const service = createAgentSessionsService(deps);
  const router = express.Router();
  router.use(BASE, (req, res, next) => { req.agentSessionsTraceId = randomUUID(); res.set('X-Trace-Id', req.agentSessionsTraceId); next(); });
  router.use(BASE, express.json({ limit: '4kb' }));
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  router.get(BASE, route((req, res) => res.json(service.list(req.query))));
  router.post(`${BASE}/resume`, route(async (req, res) => res.status(201).json(await service.resume(req.body))));
  router.use(BASE, (_req, _res, next) => next(new SessionError('Agent sessions endpoint not found', 404)));
  router.use((error, req, res, next) => {
    if (!req.originalUrl.startsWith(BASE)) return next(error);
    const status = error instanceof SessionError ? error.status : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    const message = error instanceof SessionError ? error.message : status === 400 ? 'Malformed JSON body' : status === 413 ? 'Request body too large' : 'Agent sessions request failed';
    const traceId = req.agentSessionsTraceId ?? randomUUID();
    // The cause of a server fault goes to the log only; the caller gets the safe message and the trace id.
    console.warn(`[agent-sessions] request failed status=${status} traceId=${traceId}${status === 500 ? ` error=${error.message}` : ''}`);
    res.status(status).type('application/problem+json').json({ type: 'about:blank', title: status === 400 ? 'Validation Error' : 'Agent Sessions Error', status, detail: message, error: status === 400 ? 'Validation Error' : 'Agent Sessions Error', message, timestamp: new Date().toISOString(), path: req.originalUrl.split('?')[0], traceId, ...(status === 400 ? { errors: error.errors?.length ? error.errors : [{ field: 'body', message }] } : {}) });
  });
  return router;
}
