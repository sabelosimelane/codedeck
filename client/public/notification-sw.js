try {
  importScripts('/pwa-cache-policy.js');
} catch {
  // The installed app must still start its fetch handler when the origin is
  // unavailable and this imported helper cannot be re-fetched.
}

if (!self.CodeDeckPwaCachePolicy) {
  (function attachFallbackCodeDeckPwaCachePolicy(root) {
    const LIVE_ONLY_PREFIXES = ['/api/', '/ws/'];
    const SHELL_ASSET_PREFIXES = ['/assets/'];
    const DEV_SHELL_ASSET_PREFIXES = [
      '/@react-refresh',
      '/@vite/',
      '/node_modules/.vite/',
      '/src/',
    ];
    const SHELL_ASSET_FILES = new Set([
      '/',
      '/favicon.svg',
      '/manifest.webmanifest',
      '/notification-sw.js',
      '/pwa-icon-192.png',
      '/pwa-icon-512.png',
      '/pwa-maskable-icon-512.png',
    ]);

    function normalizePath(pathname) {
      if (!pathname || pathname === '/index.html') {
        return '/';
      }

      return pathname;
    }

    function toUrl(request, origin) {
      const requestUrl = typeof request === 'string' ? request : request.url;
      return new URL(requestUrl, origin);
    }

    function hasPrefix(pathname, prefixes) {
      return prefixes.some((prefix) => pathname.startsWith(prefix));
    }

    function isLiveOnlyPath(pathname) {
      return hasPrefix(pathname, LIVE_ONLY_PREFIXES);
    }

    function isShellAssetPath(pathname) {
      const normalizedPath = normalizePath(pathname);
      return SHELL_ASSET_FILES.has(normalizedPath)
        || hasPrefix(normalizedPath, SHELL_ASSET_PREFIXES);
    }

    function isDevShellAssetPath(pathname) {
      return hasPrefix(normalizePath(pathname), DEV_SHELL_ASSET_PREFIXES);
    }

    function classifyRequest(request, options) {
      const origin = options?.origin || root.location?.origin;
      const url = toUrl(request, origin);
      const method = request.method || 'GET';
      const mode = request.mode;
      const destination = request.destination;
      const sameOrigin = url.origin === origin;
      const pathname = normalizePath(url.pathname);

      if (url.protocol === 'ws:' || url.protocol === 'wss:') {
        return { kind: 'live', strategy: 'network-only', reason: 'websocket' };
      }

      if (method !== 'GET') {
        return { kind: 'live', strategy: 'network-only', reason: 'non-get' };
      }

      if (!sameOrigin) {
        return { kind: 'external', strategy: 'network-only', reason: 'cross-origin' };
      }

      if (isLiveOnlyPath(pathname)) {
        return { kind: 'live', strategy: 'network-only', reason: 'live-route' };
      }

      if (mode === 'navigate' || destination === 'document') {
        return { kind: 'navigation-shell', strategy: 'network-first', cacheKey: '/' };
      }

      if (isDevShellAssetPath(pathname)) {
        return { kind: 'shell-asset', strategy: 'network-first', cacheKey: pathname };
      }

      if (isShellAssetPath(pathname)) {
        return { kind: 'shell-asset', strategy: 'cache-first', cacheKey: pathname };
      }

      return { kind: 'other', strategy: 'network-only', reason: 'not-shell-asset' };
    }

    root.CodeDeckPwaCachePolicy = {
      classifyRequest,
      isDevShellAssetPath,
      isLiveOnlyPath,
      isShellAssetPath,
      normalizePath,
    };
  })(self);
}

const SHELL_CACHE_NAME = 'codedeck-shell-v1';

function shouldCache(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default');
}

async function cacheResponse(cacheKey, response) {
  if (!shouldCache(response)) {
    return;
  }

  const cache = await caches.open(SHELL_CACHE_NAME);
  await cache.put(cacheKey, response.clone());
}

async function networkFirstShell(request, policy) {
  try {
    const response = await fetch(request);
    await cacheResponse(policy.cacheKey, response);
    return response;
  } catch (error) {
    const cache = await caches.open(SHELL_CACHE_NAME);
    const cached = await cache.match(policy.cacheKey);
    if (cached) {
      return cached;
    }

    throw error;
  }
}

async function cacheFirstShellAsset(request, policy) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  const cached = await cache.match(policy.cacheKey);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  await cacheResponse(policy.cacheKey, response);
  return response;
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const policy = self.CodeDeckPwaCachePolicy.classifyRequest(event.request);

  if (policy.strategy === 'network-first') {
    event.respondWith(networkFirstShell(event.request, policy));
    return;
  }

  if (policy.strategy === 'cache-first') {
    event.respondWith(cacheFirstShellAsset(event.request, policy));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow('/');
    }
  })());
});
