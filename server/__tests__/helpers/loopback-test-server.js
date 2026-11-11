import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach } from 'vitest';

const servers = new Set();
afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
  servers.clear();
});

// Supertest targets 127.0.0.1 even when its default listener binds IPv6 ::.
// On macOS that port can already belong to an unrelated IPv4 listener.
export async function loopbackTestServer(listener, { port = 0 } = {}) {
  if (typeof listener !== 'function') throw new TypeError('request listener must be a function');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer from 0 through 65535');
  const server = createServer(listener);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  servers.add(server);
  return server;
}
