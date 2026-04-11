function resolveWebSocketProtocol(protocol) {
  return protocol === 'https:' ? 'wss:' : 'ws:';
}

function resolveTerminalHost(location) {
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isViteDevPort = location.port === '43000';

  if (isLocalhost && isViteDevPort) {
    return `${location.hostname}:43001`;
  }

  return location.host;
}

export function buildTerminalWebSocketUrl({ location, cwd, sessionId, cols, rows }) {
  const protocol = resolveWebSocketProtocol(location.protocol);
  const host = resolveTerminalHost(location);

  return `${protocol}//${host}/ws/terminal?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}&cols=${cols}&rows=${rows}`;
}
