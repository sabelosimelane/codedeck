import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTerminalDeleteHandler, createTerminalSessionDeleter } from '../routes/terminal-delete.js';

function setup(killError = null) {
  const attachment = { ws: { close: vi.fn() } };
  const entry = { attachments: new Map([['browser', attachment]]) };
  const sessions = new Map([['demo-1', entry]]);
  const deletedSessionIds = new Set();
  const reservedSessionIds = new Set(['demo-1']);
  const kill = vi.fn(async () => { if (killError) throw killError; });
  const waitingStore = { clear: vi.fn() };
  const namingService = { remove: vi.fn() };
  const sessionAttention = { forget: vi.fn() };
  const mobileStore = { retireSession: vi.fn() };
  const statusCache = { invalidateSession: vi.fn() };
  const app = express();
  const deps = {
    sessions, deletedSessionIds, reservedSessionIds, terminalRuntime: { killAsync: kill },
    resolveHostRuntime: () => null, namingService, waitingStore,
    sessionAttention, mobileStore, statusCache,
  };
  app.delete('/api/terminal/:sessionId', createTerminalDeleteHandler(deps));
  return { app, attachment, sessions, deletedSessionIds, reservedSessionIds, kill, waitingStore, namingService, sessionAttention, mobileStore, statusCache };
}

describe('DELETE /api/terminal/:sessionId', () => {
  it('kills then closes attachments and removes tracked state', async () => {
    const state = setup();
    const res = await request(state.app).delete('/api/terminal/demo-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(state.kill).toHaveBeenCalledWith(expect.any(Object), 'demo-1');
    expect(state.attachment.ws.close).toHaveBeenCalledOnce();
    expect(state.sessions.has('demo-1')).toBe(false);
    expect(state.deletedSessionIds.has('demo-1')).toBe(true);
    expect(state.waitingStore.clear).toHaveBeenCalledWith('demo-1');
  });

  it.each([
    [new Error('permission denied'), 500],
    [Object.assign(new Error('host unreachable'), { code: 255 }), 503],
  ])('retains all state after a failed kill: %s', async (error, status) => {
    const state = setup(error);
    const res = await request(state.app).delete('/api/terminal/demo-1');
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ type: 'about:blank', status, path: '/api/terminal/demo-1', traceId: expect.any(String), detail: expect.any(String) });
    expect(res.headers['x-trace-id']).toBe(res.body.traceId);
    expect(state.sessions.has('demo-1')).toBe(true);
    expect(state.deletedSessionIds.has('demo-1')).toBe(false);
    expect(state.reservedSessionIds.has('demo-1')).toBe(true);
    expect(state.attachment.ws.close).not.toHaveBeenCalled();
    expect(state.waitingStore.clear).not.toHaveBeenCalled();
    expect(state.namingService.remove).not.toHaveBeenCalled();
    expect(state.sessionAttention.forget).not.toHaveBeenCalled();
    expect(state.mobileStore.retireSession).not.toHaveBeenCalled();
    expect(state.statusCache.invalidateSession).toHaveBeenCalledWith('demo-1');
  });
});

it('exposes the same deletion cleanup to project removal', async () => {
  const state = setup();
  const deleteTerminalSession = createTerminalSessionDeleter({
    sessions: state.sessions, deletedSessionIds: state.deletedSessionIds,
    reservedSessionIds: state.reservedSessionIds, terminalRuntime: { killAsync: state.kill },
    resolveHostRuntime: () => null, namingService: state.namingService,
    waitingStore: state.waitingStore, sessionAttention: state.sessionAttention,
    mobileStore: state.mobileStore, statusCache: state.statusCache,
  });
  await deleteTerminalSession('demo-1');
  expect(state.sessions.has('demo-1')).toBe(false);
  expect(state.attachment.ws.close).toHaveBeenCalledOnce();
});
