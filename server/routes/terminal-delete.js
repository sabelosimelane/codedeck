import { randomUUID } from 'node:crypto';
import { isTransportFailure } from '../command-runner.js';
import { SESSION_DELETED_CLOSE_CODE, SESSION_DELETED_CLOSE_REASON } from '../ws-handler.js';

export function createTerminalSessionDeleter({
  sessions, deletedSessionIds, reservedSessionIds, terminalRuntime,
  resolveHostRuntime, namingService, waitingStore, sessionAttention,
  mobileStore, statusCache,
}) {
  return async id => {
    const entry = sessions.get(id);
    deletedSessionIds.add(id);

    try {
      // A detached remote session has no in-memory entry; resolve its host
      // before falling back to the local runtime.
      const hostRuntime = entry?.hostRuntime ?? resolveHostRuntime(id)?.hostRuntime;
      if (hostRuntime) await hostRuntime.killAsync(entry, id);
      else await terminalRuntime.killAsync(entry, id);
    } catch (error) {
      deletedSessionIds.delete(id);
      statusCache.invalidateSession(id);
      throw error;
    }

    reservedSessionIds.delete(id);
    namingService.remove(id);
    waitingStore.clear(id);
    sessionAttention.forget(id);
    mobileStore.retireSession(id);
    for (const attachment of entry?.attachments?.values() ?? []) {
      try {
        attachment.ws.close(SESSION_DELETED_CLOSE_CODE, SESSION_DELETED_CLOSE_REASON);
      } catch (error) {
        console.warn(`[terminal] ws close failed session=${id} error=${error.message}`);
      }
    }
    statusCache.invalidateSession(id);
    sessions.delete(id);
  };
}

export function createTerminalDeleteHandler(deps) {
  const deleteTerminalSession = createTerminalSessionDeleter(deps);
  return async (req, res) => {
    const id = req.params.sessionId;
    try {
      await deleteTerminalSession(id);
      return res.json({ ok: true });
    } catch (error) {
      const status = isTransportFailure(error) ? 503 : 500;
      const title = status === 503 ? 'Terminal Host Unavailable' : 'Terminal Close Failed';
      const detail = status === 503
        ? 'The terminal host could not be reached. The terminal remains open; try closing it again.'
        : 'The terminal session could not be confirmed closed. It remains open; try closing it again.';
      const traceId = randomUUID();
      console.warn(`[terminal] delete failed session=${id} status=${status} traceId=${traceId} error=${error.message}`);
      res.set('X-Trace-Id', traceId);
      return res.status(status).type('application/problem+json').json({
        type: 'about:blank', title, status, detail, error: title,
        message: detail, timestamp: new Date().toISOString(),
        path: req.originalUrl.split('?')[0], traceId,
      });
    }
  };
}
