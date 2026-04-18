const TERMINAL_PROTOCOL_REPLY_RE = /^(?:\x1b\[\??[0-9;]*[cR]|\x1b\[>[0-9;]*c|\x1b\[[IO])$/;

export function isTerminalProtocolReply(data) {
  if (typeof data !== 'string' || data.length === 0) return false;
  return TERMINAL_PROTOCOL_REPLY_RE.test(data);
}
