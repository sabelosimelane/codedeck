export function isTerminalViewportAtBottom(buffer) {
  if (!buffer) return true;
  return buffer.viewportY >= buffer.baseY;
}

export function shouldPauseAutoScrollOnWheel({ deltaY, buffer }) {
  if (!buffer || buffer.baseY <= 0 || deltaY >= 0) return false;
  return isTerminalViewportAtBottom(buffer);
}

export function shouldBlockXtermWheelViewportFallback(buffer) {
  if (!buffer) return false;
  return buffer.type !== 'alternate' && buffer.baseY <= 0;
}
