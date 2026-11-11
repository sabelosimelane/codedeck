import { randomUUID } from 'node:crypto';

const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
function origin(value, protocols) {
  const parsed = new URL(value);
  if (!protocols.includes(parsed.protocol) || parsed.origin !== value || parsed.username || parsed.password) throw new Error('Private access expects an origin without a path or credentials');
  return parsed;
}
export function sendMobileProblem(res, req, error) {
  const status = error.status ?? 500;
  const message = status === 500 ? 'Companion request failed' : error.message;
  const traceId = req.mobileTraceId ?? randomUUID();
  console.warn(`[companion] request_failed status=${status} traceId=${traceId}`);
  // A 500 hides its cause from the client; the log keeps it under the same trace id.
  if (status === 500) console.warn(`[companion] request_failed_cause traceId=${traceId}`, error?.stack ?? String(error));
  res.status(status).type('application/problem+json').json({
    type: 'about:blank', title: status === 400 ? 'Validation Error' : 'Companion Error', status,
    detail: message, error: status === 400 ? 'Validation Error' : 'Companion Error', message,
    timestamp: new Date().toISOString(), path: (req.originalUrl ?? req.url).split('?')[0], traceId,
    ...(status === 400 ? { errors: error.errors?.length ? error.errors : [{ field: 'body', message }] } : {}),
  });
}

export function createPrivateAccess({ owner = null, serveOrigin = null, localOrigins = ['http://localhost:43000', 'http://localhost:43001'], capacitorOrigin = 'https://localhost' } = {}) {
  if ((owner === null) !== (serveOrigin === null)) throw new Error('Configure both Tailscale owner and Serve HTTPS origin');
  if (owner !== null && (typeof owner !== 'string' || !owner.trim())) throw new Error('Tailscale owner must be nonempty');
  const serve = serveOrigin === null ? null : origin(serveOrigin, ['https:']);
  if (!Array.isArray(localOrigins) || !localOrigins.length) throw new Error('Explicit local origins are required');
  const local = localOrigins.map(value => {
    const parsed = origin(value, ['http:', 'https:']);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Development origins must be loopback');
    return parsed;
  });
  origin(capacitorOrigin, ['https:']);
  function authorize(req, { upgrade = false } = {}) {
    const deny = { status: 403, message: 'Private instance access denied' };
    if (!isLoopback(req.socket?.remoteAddress)) return deny;
    const headers = req.headers;
    const requestedOrigin = headers.origin;
    if (local.some(value => value.host === headers.host)) {
      if (!requestedOrigin && !upgrade && !headers['tailscale-user-login']) return null;
      return localOrigins.includes(requestedOrigin) && !headers['tailscale-user-login'] ? null : deny;
    }
    if (!serve || headers.host !== serve.host || headers['tailscale-user-login'] !== owner) return deny;
    // Top-level HTTPS document navigation has no Origin. WebSocket and API
    // requests must carry an allow-listed origin (GET navigations only).
    if (!requestedOrigin && !upgrade && req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate') return null;
    if (!requestedOrigin && !upgrade && ['GET', 'HEAD'].includes(req.method) && headers['sec-fetch-site'] === 'same-origin') return null;
    return [serveOrigin, capacitorOrigin].includes(requestedOrigin) ? null : deny;
  }
  return {
    authorize,
    authorizeUpgrade(req) {
      try {
        if (typeof req.url !== 'string' || !req.url.startsWith('/') || new URL(req.url, 'http://localhost').pathname !== '/ws/terminal') return { status: 403, message: 'Private instance access denied' };
        return authorize(req, { upgrade: true });
      } catch { return { status: 403, message: 'Private instance access denied' }; }
    },
    middleware(req, res, next) {
      const failure = authorize(req);
      if (failure) return sendMobileProblem(res, req, failure);
      if (req.headers.origin) {
        res.set('Access-Control-Allow-Origin', req.headers.origin);
        res.set('Vary', 'Origin');
        res.set('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    },
  };
}
