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
  const notice = { id: 7, conversationId: 'c', role: 'notice', content: 'The assistant was opened elsewhere.', toolName: null, proposalId: null, createdAt: '2026-11-25T20:00:00.000Z' };
  const demo = () => ({ name: 'Demo', defaultHost: 'local', path: '/tmp' });
  it('a second socket for the same conversation and settings takes over the running agent', () => {
    const live = { close: vi.fn(), attach: vi.fn(), sameSettings: vi.fn(() => true) }; const bridge = vi.fn(() => live);
    const append = vi.fn(() => notice);
    const handler = createAssistantSocketHandler({ findProject: demo, store: { current: () => ({ id: 'c', project: 'Demo', state: 'current' }), append }, bridge });
    const first = new Socket(); const second = new Socket();
    handler(first, { url: '/ws/assistant?project=Demo' }); handler(second, { url: '/ws/assistant?project=Demo' });
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(live.attach).toHaveBeenCalledWith(second); expect(live.close).not.toHaveBeenCalled();
    expect(first.sent).toContainEqual({ type: 'message', message: notice });
    expect(append).toHaveBeenCalledWith('c', { role: 'notice', content: 'The assistant was opened elsewhere.' });
  });
  it('a reload whose old socket already closed takes over the agent without a notice', () => {
    const live = { close: vi.fn(), attach: vi.fn(), sameSettings: () => true }; const bridge = vi.fn(() => live);
    const append = vi.fn(() => notice);
    const handler = createAssistantSocketHandler({ findProject: demo, store: { current: () => ({ id: 'c', project: 'Demo', state: 'current' }), append }, bridge });
    const first = new Socket(); handler(first, { url: '/ws/assistant?project=Demo' }); first.close();
    const second = new Socket(); handler(second, { url: '/ws/assistant?project=Demo' });
    expect(bridge).toHaveBeenCalledTimes(1); expect(live.attach).toHaveBeenCalledWith(second); expect(append).not.toHaveBeenCalled();
  });
  it.each([
    ['the assistant settings changed', { id: 'c' }, false],
    ['a new conversation started', { id: 'd' }, true],
  ])('starts a fresh agent when %s, ending the old one', (_case, next, same) => {
    const old = { close: vi.fn(), attach: vi.fn(), sameSettings: () => same }; const fresh = { close: vi.fn(), attach: vi.fn(), sameSettings: () => true };
    const bridge = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(fresh);
    let conversation = { id: 'c', project: 'Demo', state: 'current' };
    const handler = createAssistantSocketHandler({ findProject: demo, store: { current: () => conversation, append: vi.fn(() => notice) }, bridge });
    const first = new Socket(); handler(first, { url: '/ws/assistant?project=Demo' });
    conversation = { ...conversation, ...next };
    const second = new Socket(); handler(second, { url: '/ws/assistant?project=Demo' });
    expect(old.close).toHaveBeenCalled(); expect(old.attach).not.toHaveBeenCalled(); expect(first.readyState).toBe(3);
    expect(bridge).toHaveBeenCalledTimes(2); expect(bridge.mock.calls[1][0]).toBe(second);
  });
  it('starts a fresh agent once the old one has ended by itself', () => {
    const bridge = vi.fn((ws, { onClosed }) => ({ close: vi.fn(), attach: vi.fn(), sameSettings: () => true, end: onClosed }));
    const handler = createAssistantSocketHandler({ findProject: demo, store: { current: () => ({ id: 'c', project: 'Demo', state: 'current' }), append: vi.fn(() => notice) }, bridge });
    handler(new Socket(), { url: '/ws/assistant?project=Demo' });
    bridge.mock.results[0].value.end();
    handler(new Socket(), { url: '/ws/assistant?project=Demo' });
    expect(bridge).toHaveBeenCalledTimes(2); expect(bridge.mock.results[0].value.attach).not.toHaveBeenCalled();
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
