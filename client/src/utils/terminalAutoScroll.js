export function isTerminalViewportAtBottom(buffer) {
  if (!buffer) return true;
  return buffer.viewportY >= buffer.baseY;
}

export function shouldPauseAutoScrollOnWheel({ deltaY, buffer }) {
  if (!buffer || buffer.baseY <= 0 || deltaY === 0) return false;
  return isTerminalViewportAtBottom(buffer);
}

export function shouldBlockXtermWheelViewportFallback(buffer) {
  if (!buffer) return false;
  return buffer.type !== 'alternate' && buffer.baseY <= 0;
}

export function shouldRouteWheelToTmuxHistory({ runtimeType, buffer, deltaY }) {
  if (runtimeType !== 'tmux' || !buffer || deltaY === 0) return false;
  return buffer.baseY <= 0;
}

export function getTmuxHistoryScrollLines(deltaY) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  return Math.max(1, Math.round(Math.abs(deltaY) / 24));
}
