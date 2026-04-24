(function attachCodeDeckPwaCachePolicy(root) {
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

  function isLiveOnlyPath(pathname) {
    return LIVE_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  }

  function isShellAssetPath(pathname) {
    const normalizedPath = normalizePath(pathname);
    return SHELL_ASSET_FILES.has(normalizedPath)
      || SHELL_ASSET_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
  }

  function isDevShellAssetPath(pathname) {
    const normalizedPath = normalizePath(pathname);
    return DEV_SHELL_ASSET_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
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
})(typeof self !== 'undefined' ? self : globalThis);
