import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadPolicy() {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'public/pwa-cache-policy.js'),
    'utf8',
  );
  const sandbox = {
    self: {
      location: {
        origin: 'http://localhost:43000',
      },
    },
    URL,
  };

  vm.runInNewContext(source, sandbox);
  return sandbox.self.CodeDeckPwaCachePolicy;
}

function request(url, overrides = {}) {
  return {
    destination: '',
    method: 'GET',
    mode: 'same-origin',
    url,
    ...overrides,
  };
}

describe('CodeDeck PWA cache policy', () => {
  const policy = loadPolicy();

  it('treats navigation as network-first shell fallback', () => {
    expect(policy.classifyRequest(request('/', {
      destination: 'document',
      mode: 'navigate',
    }))).toEqual({
      kind: 'navigation-shell',
      strategy: 'network-first',
      cacheKey: '/',
    });
  });

  it('treats built and installability assets as cacheable shell assets', () => {
    expect(policy.classifyRequest(request('/assets/index-abc123.js', {
      destination: 'script',
    }))).toMatchObject({
      kind: 'shell-asset',
      strategy: 'cache-first',
      cacheKey: '/assets/index-abc123.js',
    });
    expect(policy.classifyRequest(request('/manifest.webmanifest'))).toMatchObject({
      kind: 'shell-asset',
      strategy: 'cache-first',
      cacheKey: '/manifest.webmanifest',
    });
    expect(policy.classifyRequest(request('/pwa-icon-512.png'))).toMatchObject({
      kind: 'shell-asset',
      strategy: 'cache-first',
      cacheKey: '/pwa-icon-512.png',
    });
  });

  it('treats Vite dev shell modules as network-first shell assets', () => {
    expect(policy.classifyRequest(request('/src/main.jsx', {
      destination: 'script',
    }))).toMatchObject({
      kind: 'shell-asset',
      strategy: 'network-first',
      cacheKey: '/src/main.jsx',
    });
    expect(policy.classifyRequest(request('/@vite/client', {
      destination: 'script',
    }))).toMatchObject({
      kind: 'shell-asset',
      strategy: 'network-first',
      cacheKey: '/@vite/client',
    });
    expect(policy.classifyRequest(request('/node_modules/.vite/deps/react.js?v=abc123', {
      destination: 'script',
    }))).toMatchObject({
      kind: 'shell-asset',
      strategy: 'network-first',
      cacheKey: '/node_modules/.vite/deps/react.js',
    });
  });

  it('keeps API, websocket, and terminal routes live-only', () => {
    expect(policy.classifyRequest(request('/api/projects'))).toMatchObject({
      kind: 'live',
      strategy: 'network-only',
      reason: 'live-route',
    });
    expect(policy.classifyRequest(request('/ws/terminal'))).toMatchObject({
      kind: 'live',
      strategy: 'network-only',
      reason: 'live-route',
    });
    expect(policy.classifyRequest(request('ws://localhost:43000/ws/terminal'))).toMatchObject({
      kind: 'live',
      strategy: 'network-only',
      reason: 'websocket',
    });
  });

  it('does not cache cross-origin or mutating requests', () => {
    expect(policy.classifyRequest(request('https://fonts.googleapis.com/css2?family=Outfit'))).toMatchObject({
      kind: 'external',
      strategy: 'network-only',
      reason: 'cross-origin',
    });
    expect(policy.classifyRequest(request('/assets/index-abc123.js', {
      method: 'POST',
    }))).toMatchObject({
      kind: 'live',
      strategy: 'network-only',
      reason: 'non-get',
    });
  });

  it('normalizes index.html to the root shell cache key', () => {
    expect(policy.classifyRequest(request('/index.html'))).toMatchObject({
      kind: 'shell-asset',
      strategy: 'cache-first',
      cacheKey: '/',
    });
  });
});
