export function getTerminalTabLabel(panes, fallbackLabel = 'Terminal', titles = {}) {
  const primarySessionId = panes?.[0]?.sessionId;
  return titles[primarySessionId]?.title || primarySessionId || fallbackLabel;
}
