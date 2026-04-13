export function isTerminalViewportAtBottom(buffer) {
  if (!buffer) return true;
  return buffer.viewportY >= buffer.baseY;
}

export function shouldPauseAutoScrollOnWheel({ deltaY, buffer }) {
  if (deltaY >= 0 || !buffer) return false;
  return buffer.baseY > 0;
}
