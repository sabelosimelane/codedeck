import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether a terminal's pane is in a folder or below it. Both paths are compared after resolving
 * links, since tmux reports the real path (`/private/var/…` on macOS for `/var/…`).
 * `inspectPane(sessionId)` answers with the pane's `currentPath`.
 */
export function createTerminalInFolder(inspectPane, { sessionHost = () => 'local', resolveRealpath = (_sessionId, target) => realpath(target) } = {}) {
  if (typeof inspectPane !== 'function') throw new Error('createTerminalInFolder: inspectPane must be a function');
  return async function terminalInFolder(sessionId, folder, expectedHost) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) {
      throw new Error(`terminalInFolder: folder must be an absolute path, got ${folder}`);
    }
    if (expectedHost !== undefined) {
      if (typeof expectedHost !== 'string' || !expectedHost.trim()) throw new Error('terminalInFolder requires a host name');
      if (await sessionHost(sessionId) !== expectedHost) return false;
    }
    const pane = await inspectPane(sessionId);
    if (typeof pane?.currentPath !== 'string' || !path.isAbsolute(pane.currentPath)) {
      throw new Error(`terminalInFolder: the pane of ${sessionId} has no absolute current path`);
    }
    const [here, there] = await Promise.all([resolveRealpath(sessionId, pane.currentPath), resolveRealpath(sessionId, folder)]);
    return here === there || here.startsWith(there + path.sep);
  };
}
