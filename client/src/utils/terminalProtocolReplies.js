// Device attributes (`c`), cursor position (`R`), focus (`I`/`O`) and mode reports (`$y`).
// tmux asks every attaching client whether it supports synchronized output (`CSI ? 2026 $ p`);
// xterm.js answers `CSI ? 2026 ; 0 $ y`, and an answer that reaches tmux late is typed into the pane.
const TERMINAL_PROTOCOL_REPLY_RE = /^(?:\x1b\[\??[0-9;]*(?:[cR]|\$y)|\x1b\[>[0-9;]*c|\x1b\[[IO])$/;

export function isTerminalProtocolReply(data) {
  if (typeof data !== 'string' || data.length === 0) return false;
  return TERMINAL_PROTOCOL_REPLY_RE.test(data);
}
