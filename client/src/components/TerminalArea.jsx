import React, { useState, useEffect, useCallback, useRef } from 'react';
import Terminal from './Terminal';
import PaneDivider from './PaneDivider';
import { Plus, X, Columns } from 'lucide-react';

let tabCounter = 0;
let sessionCounter = 0;

function createPane(projectName) {
  const sessionId = `${projectName}-${++sessionCounter}`;
  return { id: `pane-${sessionId}`, sessionId, widthFraction: 1 };
}

function createTab(projectName) {
  const pane = createPane(projectName);
  return {
    id: `tab-${++tabCounter}`,
    label: `Terminal ${tabCounter}`,
    panes: [pane],
  };
}

// --- localStorage layout persistence helpers ---
const LAYOUT_KEY_PREFIX = 'codedeck-layout-';

function saveLayout(projectName, state) {
  if (!projectName || !state.tabs.length) return;
  try {
    const data = {
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      tabCounter,
      sessionCounter,
    };
    localStorage.setItem(LAYOUT_KEY_PREFIX + projectName, JSON.stringify(data));
  } catch {
    // localStorage full or unavailable — non-critical, skip silently
  }
}

function loadLayout(projectName) {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY_PREFIX + projectName);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearLayout(projectName) {
  try {
    localStorage.removeItem(LAYOUT_KEY_PREFIX + projectName);
  } catch {
    // non-critical
  }
}

/**
 * Filter a saved layout against live backend sessions.
 * Removes any panes whose sessionId is no longer alive on the server.
 * Returns null if no valid panes remain.
 */
function filterLayoutByLiveSessions(saved, liveSessions) {
  const aliveIds = new Set(liveSessions.filter(s => s.alive).map(s => s.sessionId));
  const filteredTabs = [];

  for (const tab of saved.tabs) {
    const livePanes = tab.panes.filter(p => aliveIds.has(p.sessionId));
    if (livePanes.length > 0) {
      // Redistribute widths equally among surviving panes
      const fraction = 1 / livePanes.length;
      filteredTabs.push({
        ...tab,
        panes: livePanes.map(p => ({ ...p, widthFraction: fraction })),
      });
    }
  }

  if (filteredTabs.length === 0) return null;

  // If the saved active tab was removed, fall back to the last remaining tab
  const activeTabId = filteredTabs.find(t => t.id === saved.activeTabId)
    ? saved.activeTabId
    : filteredTabs[filteredTabs.length - 1].id;

  return { tabs: filteredTabs, activeTabId };
}

export default function TerminalArea({ project }) {
  const [state, setState] = useState({ tabs: [], activeTabId: null });
  const containerRef = useRef(null);
  const prevProjectRef = useRef(null);
  const saveTimerRef = useRef(null);
  const restoringRef = useRef(false);
  const { tabs, activeTabId } = state;
  const activeTab = tabs.find(t => t.id === activeTabId);

  // Persist layout to localStorage on state changes (debounced).
  // Skips saves while a project-switch restore is in progress to avoid
  // writing the outgoing project's state under the incoming project's key.
  useEffect(() => {
    if (!project.name || tabs.length === 0 || restoringRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveLayout(project.name, state);
    }, 300);
    return () => clearTimeout(saveTimerRef.current);
  }, [state, project.name]);

  // Save/restore layout when project changes
  useEffect(() => {
    // Save the outgoing project's layout before switching
    if (prevProjectRef.current && prevProjectRef.current !== project.name) {
      // Flush immediately — the debounced save may not have fired yet
      saveLayout(prevProjectRef.current, state);
    }
    prevProjectRef.current = project.name;
    restoringRef.current = true;

    // Try to restore saved layout for the incoming project
    const saved = loadLayout(project.name);
    if (!saved) {
      // No saved layout — start fresh
      tabCounter = 0;
      sessionCounter = 0;
      const tab = createTab(project.name);
      setState({ tabs: [tab], activeTabId: tab.id });
      restoringRef.current = false;
      return;
    }

    // Validate saved sessions against the backend before restoring
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error('Failed to fetch sessions');
        const liveSessions = await res.json();

        if (cancelled) return;

        const restored = filterLayoutByLiveSessions(saved, liveSessions);
        if (restored) {
          // Restore counters so new tabs/panes get unique IDs
          tabCounter = saved.tabCounter;
          sessionCounter = saved.sessionCounter;
          setState(restored);
        } else {
          // All saved sessions are dead — start fresh
          clearLayout(project.name);
          tabCounter = 0;
          sessionCounter = 0;
          const tab = createTab(project.name);
          setState({ tabs: [tab], activeTabId: tab.id });
        }
      } catch {
        // Backend unreachable — start fresh rather than showing stale layout
        clearLayout(project.name);
        tabCounter = 0;
        sessionCounter = 0;
        const tab = createTab(project.name);
        setState({ tabs: [tab], activeTabId: tab.id });
      } finally {
        if (!cancelled) restoringRef.current = false;
      }
    })();

    return () => { cancelled = true; restoringRef.current = false; };
  }, [project.name]);

  const setActiveTabId = useCallback((id) => {
    setState(prev => ({ ...prev, activeTabId: id }));
  }, []);

  // Split right — add pane to active tab, redistribute widths equally
  const splitRight = useCallback(() => {
    const pane = createPane(project.name);
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab => {
        if (tab.id !== prev.activeTabId) return tab;
        const newPanes = [...tab.panes, pane];
        const fraction = 1 / newPanes.length;
        return { ...tab, panes: newPanes.map(p => ({ ...p, widthFraction: fraction })) };
      }),
    }));
  }, [project.name]);

  // New tab with one pane
  const addTab = useCallback(() => {
    const tab = createTab(project.name);
    setState(prev => ({
      tabs: [...prev.tabs, tab],
      activeTabId: tab.id,
    }));
  }, [project.name]);

  // Close a single pane — redistribute, or close tab if last pane
  const closePane = useCallback((tabId, paneId, sessionId) => {
    fetch(`/api/terminal/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      .catch(err => console.warn('Failed to close terminal session:', err));
    setState(prev => {
      const tab = prev.tabs.find(t => t.id === tabId);
      if (!tab) return prev;

      const remainingPanes = tab.panes.filter(p => p.id !== paneId);

      if (remainingPanes.length > 0) {
        const fraction = 1 / remainingPanes.length;
        return {
          ...prev,
          tabs: prev.tabs.map(t => t.id === tabId
            ? { ...t, panes: remainingPanes.map(p => ({ ...p, widthFraction: fraction })) }
            : t
          ),
        };
      }

      // Last pane in tab → close the tab
      const remainingTabs = prev.tabs.filter(t => t.id !== tabId);
      if (remainingTabs.length > 0) {
        return {
          tabs: remainingTabs,
          activeTabId: prev.activeTabId === tabId
            ? remainingTabs[remainingTabs.length - 1].id
            : prev.activeTabId,
        };
      }

      // Last tab → create fresh default
      const newTab = createTab(project.name);
      return { tabs: [newTab], activeTabId: newTab.id };
    });
  }, [project.name]);

  // Close entire tab — kill all PTY sessions
  const closeTab = useCallback((tabId) => {
    setState(prev => {
      const tab = prev.tabs.find(t => t.id === tabId);
      if (tab) {
        tab.panes.forEach(p => {
          fetch(`/api/terminal/${encodeURIComponent(p.sessionId)}`, { method: 'DELETE' })
            .catch(err => console.warn('Failed to close terminal session:', err));
        });
      }

      const remaining = prev.tabs.filter(t => t.id !== tabId);
      if (remaining.length > 0) {
        return {
          tabs: remaining,
          activeTabId: prev.activeTabId === tabId
            ? remaining[remaining.length - 1].id
            : prev.activeTabId,
        };
      }

      const newTab = createTab(project.name);
      return { tabs: [newTab], activeTabId: newTab.id };
    });
  }, [project.name]);

  // Divider drag — resize adjacent panes, enforce 200px minimum
  const handleDividerDrag = useCallback((tabId, leftIndex, deltaPixels) => {
    setState(prev => {
      const tab = prev.tabs.find(t => t.id === tabId);
      if (!tab) return prev;

      const containerWidth = containerRef.current?.offsetWidth || 1;
      const availableWidth = containerWidth - (tab.panes.length - 1) * 4;
      const deltaFraction = deltaPixels / availableWidth;
      const minFraction = 200 / availableWidth;

      const panes = [...tab.panes];
      const left = panes[leftIndex];
      const right = panes[leftIndex + 1];
      if (!left || !right) return prev;

      let newLeft = left.widthFraction + deltaFraction;
      let newRight = right.widthFraction - deltaFraction;

      if (newLeft < minFraction) {
        newRight += newLeft - minFraction;
        newLeft = minFraction;
      }
      if (newRight < minFraction) {
        newLeft += newRight - minFraction;
        newRight = minFraction;
      }

      panes[leftIndex] = { ...left, widthFraction: newLeft };
      panes[leftIndex + 1] = { ...right, widthFraction: newRight };

      return {
        ...prev,
        tabs: prev.tabs.map(t => t.id === tabId ? { ...t, panes } : t),
      };
    });
  }, []);

  // Divider double-click — reset all panes in tab to equal width
  const handleDividerReset = useCallback((tabId) => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab => {
        if (tab.id !== tabId) return tab;
        const fraction = 1 / tab.panes.length;
        return { ...tab, panes: tab.panes.map(p => ({ ...p, widthFraction: fraction })) };
      }),
    }));
  }, []);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        height: 38,
        background: 'var(--bg-sidebar)',
        borderBottom: '1px solid var(--border)',
        padding: '0 8px',
        gap: 2,
        flexShrink: 0,
      }}>
        {/* Project name */}
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          color: 'var(--accent)',
          fontWeight: 600,
          marginRight: 12,
          letterSpacing: '0.3px',
        }}>
          {project.name}
        </span>

        {/* Tab list */}
        <div style={{ display: 'flex', gap: 2, flex: 1, overflow: 'hidden' }}>
          {tabs.map(tab => {
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                style={{
                  padding: '4px 10px',
                  fontSize: '12px',
                  fontFamily: 'var(--font-mono)',
                  borderRadius: 4,
                  background: isActive ? 'var(--bg-active)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {tab.label}
                {tab.panes.length > 1 && (
                  <span style={{ fontSize: '10px', opacity: 0.5 }}>
                    ({tab.panes.length})
                  </span>
                )}
                {tabs.length > 1 && (
                  <span
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                    style={{ opacity: 0.5, display: 'flex' }}
                  >
                    <X size={10} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Actions */}
        <button
          onClick={splitRight}
          title="Split right"
          style={{ padding: 4, borderRadius: 4, color: 'var(--text-muted)' }}
        >
          <Columns size={14} />
        </button>
        <button
          onClick={addTab}
          title="New tab"
          style={{ padding: 4, borderRadius: 4, color: 'var(--text-muted)' }}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Pane groups — render ALL tabs, hide inactive ones to preserve terminal state */}
      {tabs.map(tab => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            ref={isActive ? containerRef : undefined}
            style={{
              flex: 1,
              display: isActive ? 'flex' : 'none',
              minHeight: 0,
            }}
          >
            {tab.panes.map((pane, index) => (
              <React.Fragment key={pane.id}>
                {index > 0 && (
                  <PaneDivider
                    onDrag={(delta) => handleDividerDrag(tab.id, index - 1, delta)}
                    onDoubleClick={() => handleDividerReset(tab.id)}
                  />
                )}
                <div
                  className="pane-wrapper"
                  style={{
                    flex: pane.widthFraction,
                    minWidth: 0,
                    minHeight: 0,
                    position: 'relative',
                  }}
                >
                  {tab.panes.length > 1 && (
                    <button
                      onClick={() => closePane(tab.id, pane.id, pane.sessionId)}
                      title="Close pane"
                      className="pane-close-btn"
                      style={{
                        position: 'absolute',
                        top: 4,
                        right: 8,
                        zIndex: 20,
                        padding: '2px 6px',
                        borderRadius: 3,
                        background: 'rgba(30,30,34,0.85)',
                        color: 'var(--text-muted)',
                        fontSize: '10px',
                        lineHeight: 1,
                        opacity: 0.7,
                        transition: 'opacity 0.15s',
                        cursor: 'pointer',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <X size={10} />
                    </button>
                  )}
                  <Terminal
                    sessionId={pane.sessionId}
                    cwd={project.path}
                    isVisible={isActive}
                  />
                </div>
              </React.Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
}
