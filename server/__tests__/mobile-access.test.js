import { expect, it, vi } from 'vitest';
import { createPrivateAccess, sendMobileProblem } from '../mobile-access.js';
const access = () => createPrivateAccess({ owner: 'owner@example.test', serveOrigin: 'https://deck.tail.test', localOrigins: ['http://localhost:43000', 'http://localhost:43001'] });
const req = (headers = {}, address = '127.0.0.1') => ({ headers: { host: 'deck.tail.test', origin: 'https://localhost', 'tailscale-user-login': 'owner@example.test', ...headers }, socket: { remoteAddress: address } });
it('authorizes the owner only over the loopback Serve path', () => expect(access().authorize(req())).toBeNull());
it.each([
  [{}, '100.1.2.3'], [{ 'tailscale-user-login': 'attacker@example.test' }],
  [{ 'tailscale-user-login': undefined }], [{ origin: 'https://evil.test' }],
  [{ host: 'evil.test' }], [{ origin: 'null' }], [{ origin: undefined }],
])('rejects forged identity and untrusted origins/hosts', (headers, address) => expect(access().authorize(req(headers, address))).toMatchObject({ status: 403 }));
it('permits explicit loopback desktop origins without trusting identity headers', () => {
  expect(access().authorize(req({ host: 'localhost:43001', origin: 'http://localhost:43000', 'tailscale-user-login': undefined }))).toBeNull();
  expect(access().authorize(req({ host: 'localhost:43001', origin: 'https://localhost' }))).toMatchObject({ status: 403 });
});
it('allows originless local CLI reads but rejects originless websocket upgrades', () => {
  const request = req({ host: 'localhost:43001', origin: undefined, 'tailscale-user-login': undefined });
  expect(access().authorize(request)).toBeNull();
  expect(access().authorize(request, { upgrade: true })).toMatchObject({ status: 403 });
});
it('fails closed for partial or malformed private configuration', () => {
  for (const config of [{ owner: 'x' }, { serveOrigin: 'http://bad' }, { owner: 'x', serveOrigin: 'https://a/path' }]) {
    expect(() => createPrivateAccess(config)).toThrow();
  }
});
it.each(['GET', 'HEAD'])('allows same-origin Serve %s assets and API reads without Origin', method => {
  const request = req({ origin: undefined, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }); request.method = method;
  expect(access().authorize(request)).toBeNull();
});
it('does not confuse originless same-origin upgrades with safe HTTP reads', () => {
  const request = req({ origin: undefined, 'sec-fetch-site': 'same-origin' }); request.method = 'GET';
  expect(access().authorize(request, { upgrade: true })).toMatchObject({ status: 403 });
});
it('rejects originless cross-site fetches over Serve', () => {
  const request = req({ origin: undefined, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }); request.method = 'GET';
  expect(access().authorize(request)).toMatchObject({ status: 403 });
});
it('denies malformed upgrade request targets without throwing', () => {
  expect(access().authorizeUpgrade({ ...req(), url: 'http://[' })).toMatchObject({ status: 403 });
  expect(access().authorizeUpgrade({ ...req(), url: '/ws/other' })).toMatchObject({ status: 403 });
  expect(access().authorizeUpgrade({ ...req(), url: '/ws/terminal?protocol=2' })).toBeNull();
});
function problemResponse() {
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, type() { return this; }, json(value) { this.body = value; return this; } };
  return res;
}
it('logs the cause of a 500 beside its trace id while the response stays generic', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const res = problemResponse();
    sendMobileProblem(res, { mobileTraceId: 'trace-1', originalUrl: '/api/mobile/v1/x' }, new Error('ENOENT /Users/secret/path'));
    expect(res.body).toMatchObject({ status: 500, message: 'Companion request failed', traceId: 'trace-1' });
    expect(JSON.stringify(res.body)).not.toContain('/Users/secret');
    const logged = warn.mock.calls.map(args => args.join(' ')).join('\n');
    expect(logged).toContain('traceId=trace-1');
    expect(logged).toContain('ENOENT /Users/secret/path');
  } finally { warn.mockRestore(); }
});
it('does not log stack traces for expected client errors', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    sendMobileProblem(problemResponse(), { mobileTraceId: 'trace-2', originalUrl: '/api/mobile/v1/x' }, Object.assign(new Error('Project not found'), { status: 404 }));
    expect(warn.mock.calls.map(args => args.join(' ')).join('\n')).not.toContain('at ');
  } finally { warn.mockRestore(); }
});
