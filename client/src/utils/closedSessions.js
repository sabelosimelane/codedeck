/**
 * Takes terminals the backend has closed out of a project's tab layout: their panes go, what is
 * left of a split shares the width, and a tab left with no pane goes too.
 */
export function removeSessionsFromLayout(layout, sessionIds) {
  if (!Array.isArray(layout?.tabs)) throw new TypeError('layout.tabs must be an array');
  if (!Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string' || id.length === 0)) throw new TypeError('sessionIds must be an array of session ids');
  const closed = new Set(sessionIds);
  if (!layout.tabs.some(tab => tab.panes.some(pane => closed.has(pane.sessionId)))) return layout;

  const tabs = [];
  for (const tab of layout.tabs) {
    const panes = tab.panes.filter(pane => !closed.has(pane.sessionId));
    if (panes.length === tab.panes.length) { tabs.push(tab); continue; }
    if (panes.length === 0) continue;
    tabs.push({ ...tab, panes: panes.map(pane => ({ ...pane, widthFraction: 1 / panes.length })) });
  }
  return { ...layout, tabs, activeTabId: tabs.some(tab => tab.id === layout.activeTabId) ? layout.activeTabId : null };
}
