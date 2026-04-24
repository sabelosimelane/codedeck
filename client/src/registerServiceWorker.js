const SERVICE_WORKER_URL = '/notification-sw.js';
const SERVICE_WORKER_SCOPE = '/';

function registerNow(win) {
  const registration = win.navigator.serviceWorker.register(SERVICE_WORKER_URL, {
    scope: SERVICE_WORKER_SCOPE,
  });

  if (registration && typeof registration.catch === 'function') {
    registration.catch((error) => {
      win.console?.warn?.('CodeDeck service worker registration failed', error);
    });
  }
}

export function registerServiceWorker(win = window) {
  if (!win.navigator?.serviceWorker) {
    return false;
  }

  if (win.document?.readyState === 'complete') {
    registerNow(win);
    return true;
  }

  win.addEventListener('load', () => registerNow(win), { once: true });
  return true;
}

export const serviceWorkerRegistration = {
  scope: SERVICE_WORKER_SCOPE,
  url: SERVICE_WORKER_URL,
};
