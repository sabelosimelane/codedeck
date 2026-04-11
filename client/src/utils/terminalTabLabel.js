export function getTerminalTabLabel(panes, fallbackLabel = 'Terminal') {
  const primarySessionId = panes?.[0]?.sessionId;
  return primarySessionId || fallbackLabel;
}
