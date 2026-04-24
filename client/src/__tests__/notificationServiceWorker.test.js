import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadServiceWorker({ importScripts = vi.fn() } = {}) {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'public/notification-sw.js'),
    'utf8',
  );
  const listeners = new Map();
  const self = {
    location: {
      origin: 'http://localhost:43000',
    },
    clients: {
      claim: vi.fn(),
    },
    addEventListener: vi.fn((eventName, handler) => {
      listeners.set(eventName, handler);
    }),
    skipWaiting: vi.fn(),
  };

  vm.runInNewContext(source, {
    URL,
    caches: {
      open: vi.fn(),
    },
    importScripts,
    self,
  });

  return { listeners, self };
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

describe('notification service worker shell fallback', () => {
  it('keeps the fetch handler available when the imported cache policy cannot load', () => {
    const { listeners, self } = loadServiceWorker({
      importScripts: vi.fn(() => {
        throw new Error('origin unavailable');
      }),
    });

    expect(listeners.has('fetch')).toBe(true);
    expect(self.CodeDeckPwaCachePolicy.classifyRequest(request('/api/projects'))).toMatchObject({
      kind: 'live',
      strategy: 'network-only',
    });
    expect(self.CodeDeckPwaCachePolicy.classifyRequest(request('/', {
      destination: 'document',
      mode: 'navigate',
    }))).toMatchObject({
      kind: 'navigation-shell',
      strategy: 'network-first',
      cacheKey: '/',
    });
    expect(self.CodeDeckPwaCachePolicy.classifyRequest(request('/src/main.jsx', {
      destination: 'script',
    }))).toMatchObject({
      kind: 'shell-asset',
      strategy: 'network-first',
      cacheKey: '/src/main.jsx',
    });
  });
});
