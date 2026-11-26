import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createAssistantSocketHandler, routeUpgrade } from '../assistant/ws-upgrade.js';
import { createPrivateAccess } from '../mobile-access.js';

class Socket extends EventEmitter { readyState = 1; sent = []; close(code, reason) { this.code = code; this.reason = reason; this.readyState = 3; this.emit('close'); } send(value) { this.sent.push(JSON.parse(value)); } }
describe('assistant WebSocket routing', () => {
  it('routes an authorized assistant upgrade through the real private access check', () => {
    const access = createPrivateAccess({ owner: 'owner@example.test', serveOrigin: 'https://deck.tail.test', localOrigins: ['http://localhost:43000', 'http://localhost:43001'] });
    const assistant = { handleUpgrade: vi.fn((req, socket, head, callback) => callback(new Socket())), emit: vi.fn() };
    const terminal = { handleUpgrade: vi.fn() };
    const socket = { end: vi.fn(), destroy: vi.fn() };
    const req = { url: '/ws/assistant?project=Demo', headers: { host: 'localhost:43001', origin: 'http://localhost:43000' }, socket: { remoteAddress: '127.0.0.1' } };
    routeUpgrade(req, socket, Buffer.alloc(0), { authorizeUpgrade: access.authorizeUpgrade, assistant, terminal });
    expect(assistant.handleUpgrade).toHaveBeenCalledOnce();
    expect(assistant.emit).toHaveBeenCalledWith('connection', expect.any(Socket), req);
    expect(socket.end).not.toHaveBeenCalled();
  });
  it('refuses assistant and terminal upgrades equally before routing', () => {
    const wss = { handleUpgrade: vi.fn() }; const terminal = { handleUpgrade: vi.fn() };
    for (const url of ['/ws/assistant?project=Demo', '/ws/terminal']) {
      const socket = { end: vi.fn() };
      routeUpgrade({ url }, socket, Buffer.alloc(0), { authorizeUpgrade: () => true, terminal, assistant: wss });
      expect(socket.end).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    }
    expect(wss.handleUpgrade).not.toHaveBeenCalled(); expect(terminal.handleUpgrade).not.toHaveBeenCalled();
  });
  it('closes unknown, remote and missing projects with the specified codes', () => {
    const handler = createAssistantSocketHandler({ findProject: name => name === 'Remote' ? { name, defaultHost: 'remote', path: '/tmp' } : null, store: {}, bridge: vi.fn() });
    for (const [url, code] of [['/ws/assistant?project=No', 4404], ['/ws/assistant?project=Remote', 4409], ['/ws/assistant', 4400]]) {
      const ws = new Socket(); handler(ws, { url }); expect(ws.code).toBe(code);
    }
  });
  it('a second socket takes over one project and ends the old bridge', () => {
    const close = vi.fn(); const bridge = vi.fn(() => ({ close }));
    const notice = { id: 7, conversationId: 'c', role: 'notice', content: 'The assistant was opened elsewhere.', toolName: null, proposalId: null, createdAt: '2026-11-25T20:00:00.000Z' };
    const append = vi.fn(() => notice);
    const handler = createAssistantSocketHandler({ findProject: () => ({ name: 'Demo', defaultHost: 'local', path: '/tmp' }), store: { current: () => ({ id: 'c', project: 'Demo', state: 'current' }), append }, bridge });
    const first = new Socket(); const second = new Socket();
    handler(first, { url: '/ws/assistant?project=Demo' }); handler(second, { url: '/ws/assistant?project=Demo' });
    expect(first.sent).toContainEqual({ type: 'message', message: notice });
    expect(append).toHaveBeenCalledWith('c', { role: 'notice', content: 'The assistant was opened elsewhere.' });
    expect(first.readyState).toBe(3); expect(close).toHaveBeenCalled(); expect(bridge).toHaveBeenCalledTimes(2);
  });
  it('reports bridge start errors to the browser before closing with 1011', () => {
    const error = new Error('adapter unavailable'); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const handler = createAssistantSocketHandler({ findProject: () => ({ name: 'Demo', path: '/tmp' }), store: { current: () => ({ id: 'c', project: 'Demo', state: 'current' }) }, bridge: () => { throw error; } });
      const ws = new Socket(); handler(ws, { url: '/ws/assistant?project=Demo' });
      expect(ws.sent).toContainEqual({ type: 'spawn_error', message: 'adapter unavailable' });
      expect(ws.code).toBe(1011); expect(log).toHaveBeenCalledWith(expect.stringContaining('[assistant]'), error);
    } finally { log.mockRestore(); }
  });
});
