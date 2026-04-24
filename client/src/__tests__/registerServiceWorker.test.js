import { describe, expect, it, vi } from 'vitest';

import { registerServiceWorker, serviceWorkerRegistration } from '../registerServiceWorker';

function createWindow({ serviceWorker, readyState = 'loading' } = {}) {
  const listeners = new Map();

  return {
    console: {
      warn: vi.fn(),
    },
    document: {
      readyState,
    },
    navigator: {
      serviceWorker,
    },
    addEventListener: vi.fn((eventName, callback, options) => {
      listeners.set(eventName, { callback, options });
    }),
    dispatch(eventName) {
      listeners.get(eventName)?.callback();
    },
    listenerOptions(eventName) {
      return listeners.get(eventName)?.options;
    },
  };
}

describe('registerServiceWorker', () => {
  it('registers the notification service worker at root scope after load', () => {
    const serviceWorker = {
      register: vi.fn(() => Promise.resolve()),
    };
    const win = createWindow({ serviceWorker });

    expect(registerServiceWorker(win)).toBe(true);
    expect(win.addEventListener).toHaveBeenCalledWith('load', expect.any(Function), { once: true });
    expect(win.listenerOptions('load')).toEqual({ once: true });

    win.dispatch('load');

    expect(serviceWorker.register).toHaveBeenCalledWith('/notification-sw.js', { scope: '/' });
  });

  it('registers immediately when the document already finished loading', () => {
    const serviceWorker = {
      register: vi.fn(() => Promise.resolve()),
    };
    const win = createWindow({ serviceWorker, readyState: 'complete' });

    expect(registerServiceWorker(win)).toBe(true);

    expect(win.addEventListener).not.toHaveBeenCalled();
    expect(serviceWorker.register).toHaveBeenCalledWith('/notification-sw.js', { scope: '/' });
  });

  it('skips registration when service workers are unavailable', () => {
    const win = createWindow();

    expect(registerServiceWorker(win)).toBe(false);
    expect(win.addEventListener).not.toHaveBeenCalled();
  });

  it('logs registration failures instead of swallowing them', async () => {
    const error = new Error('registration failed');
    const serviceWorker = {
      register: vi.fn(() => Promise.reject(error)),
    };
    const win = createWindow({ serviceWorker, readyState: 'complete' });

    registerServiceWorker(win);
    await Promise.resolve();

    expect(win.console.warn).toHaveBeenCalledWith('CodeDeck service worker registration failed', error);
  });

  it('exports the installability registration contract', () => {
    expect(serviceWorkerRegistration).toEqual({
      scope: '/',
      url: '/notification-sw.js',
    });
  });
});
