const THROTTLE_MS = 15000;
let lastSentAt = null;

export function shouldSendDesktopActivity({ lastSentAt, now, visible, socketOpen }) {
  return visible && socketOpen && (lastSentAt === null || now - lastSentAt >= THROTTLE_MS);
}

export function reportDesktopActivity(socket, visibilityState, now = Date.now()) {
  if (!shouldSendDesktopActivity({ lastSentAt, now, visible: visibilityState === 'visible', socketOpen: socket?.readyState === 1 })) return;
  socket.send(JSON.stringify({ type: 'user_activity' }));
  lastSentAt = now;
}
