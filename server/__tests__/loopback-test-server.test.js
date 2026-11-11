import { expect, it } from 'vitest';
import request from 'supertest';
import { loopbackTestServer } from './helpers/loopback-test-server.js';

it('binds the same IPv4 loopback address that Supertest requests', async () => {
  const server = await loopbackTestServer((_req, res) => res.end('fixture'));
  expect(server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  const result = await request(server).get('/');
  expect(result.status).toBe(200); expect(result.text).toBe('fixture');
});
it('fails rather than routing tests to another IPv4 listener on the same port', async () => {
  const other = await loopbackTestServer((_req, res) => { res.setHeader('X-Test-Responder', 'other'); res.writeHead(401); res.end('fixture auth'); });
  const port = other.address().port;
  await expect(loopbackTestServer((_req, res) => res.end('intended fixture'), { port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  const result = await request(other).get('/');
  expect(result.status).toBe(401); expect(result.headers['x-test-responder']).toBe('other');
});
it.each([null, {}, 'app'])('rejects invalid request listener %j', async app => {
  await expect(loopbackTestServer(app)).rejects.toThrow('listener');
});
it.each([-1, 65536, '0', null])('rejects invalid port %j', async port => {
  await expect(loopbackTestServer((_req, res) => res.end(), { port })).rejects.toThrow('port');
});
