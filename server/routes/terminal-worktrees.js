import express from 'express';
import { randomUUID } from 'node:crypto';
import { TerminalWorktreeError, validateBranchSyntax } from '../terminal-worktree-service.js';

const BASE = '/api/terminal-worktrees';
const REQUIRED = ['project', 'branch'];

function validate(body) {
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    errors.push({ field: 'body', message: 'Use an object with project and branch' });
  } else {
    if (typeof body.project !== 'string' || body.project.length === 0) errors.push({ field: 'project', message: 'A nonempty project string is required' });
    try { validateBranchSyntax(body.branch); }
    catch (error) {
      if (!(error instanceof TerminalWorktreeError)) throw error;
      errors.push(...error.errors);
    }
    for (const field of Object.keys(body)) {
      if (!REQUIRED.includes(field)) errors.push({ field, message: 'Unknown field' });
    }
  }
  if (errors.length) throw new TerminalWorktreeError('One or more fields failed validation.', 400, errors);
  return { project: body.project, branch: body.branch };
}

export function createTerminalWorktreesRouter({ service } = {}) {
  if (typeof service?.open !== 'function') throw new TypeError('terminal worktrees router requires service.open');
  const router = express.Router();
  router.use(BASE, (req, res, next) => {
    req.terminalWorktreeTraceId = randomUUID();
    res.set('X-Trace-Id', req.terminalWorktreeTraceId);
    next();
  });
  router.use(BASE, express.json({ limit: '4kb' }));
  router.post(BASE, async (req, res, next) => {
    try {
      res.status(201).json(await service.open(validate(req.body)));
    } catch (error) { next(error); }
  });
  router.use(BASE, (_req, _res, next) => next(new TerminalWorktreeError('Terminal worktree endpoint not found', 404)));
  router.use((error, req, res, next) => {
    if (!req.originalUrl.startsWith(BASE)) return next(error);
    const status = error instanceof TerminalWorktreeError && [400, 404, 409, 500, 503].includes(error.status)
      ? error.status : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    const message = error instanceof TerminalWorktreeError ? error.message
      : status === 400 ? 'Malformed JSON body' : status === 413 ? 'Request body too large' : 'Terminal worktree request failed';
    const title = status === 400 ? 'Validation Error' : 'Terminal Worktree Error';
    const traceId = req.terminalWorktreeTraceId ?? randomUUID();
    console.warn(`[terminal-worktrees] request failed status=${status} traceId=${traceId}${status >= 500 ? ` cause=${error.cause?.message ?? error.message}` : ''}`);
    res.status(status).type('application/problem+json').json({
      type: 'about:blank', title, status, detail: message, error: title, message,
      timestamp: new Date().toISOString(), path: req.originalUrl.split('?')[0], traceId,
      ...(status === 400 ? { errors: error.errors?.length ? error.errors : [{ field: 'body', message }] } : {}),
    });
  });
  return router;
}
