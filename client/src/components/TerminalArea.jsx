import React, { useState, useEffect, useCallback, useRef } from 'react';
import Terminal from './Terminal';
import PaneDivider from './PaneDivider';
import { Plus, X, Columns, Eraser, PlugZap, TerminalSquare, RotateCcw, Bug } from 'lucide-react';
import TerminalInspector from './TerminalInspector';
import { shouldPersistLayout } from '../utils/terminalLayout';
import { resolveInitialTerminalState } from '../utils/terminalLayoutState';
import { getTabTerminalStatus } from '../utils/terminalActivity';
import { getTerminalTabLabel } from '../utils/terminalTabLabel';

let tabCounter = 0;
let sessionCounter = 0;

function createPane(projectName) {
  const sessionId = `${projectName}-${++sessionCounter}`;
  return {
    id: `pane-${sessionId}`,
    sessionId,
    widthFraction: 1,
    isConnected: true,
  };
}

function createTab(projectName) {
  const pane = createPane(projectName);
  return {
    id: `tab-${++tabCounter}`,
    label: getTerminalTabLabel([pane]),
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

const TAB_STATUS_STYLES = {
  none: {
    dotColor: 'rgba(138, 146, 166, 0.35)',
    dotShadow: 'none',
    borderColor: 'transparent',
    textColor: 'var(--text-muted)',
  },
  busy: {
    dotColor: 'var(--accent)',
    dotShadow: '0 0 12px rgba(95, 224, 186, 0.5)',
    borderColor: 'rgba(95, 224, 186, 0.38)',
    textColor: 'var(--text-primary)',
  },
  idle: {
    dotColor: 'var(--text-muted)',
    dotShadow: 'none',
    borderColor: 'rgba(154, 165, 184, 0.22)',
    textColor: 'var(--text-secondary)',
  },
  dead: {
    dotColor: 'var(--danger)',
    dotShadow: '0 0 10px rgba(248, 113, 113, 0.22)',
    borderColor: 'rgba(248, 113, 113, 0.28)',
    textColor: 'var(--text-primary)',
  },
};

export default function TerminalArea({ project, sessionStatus = [] }) {
  const [state, setState] = useState({ tabs: [], activeTabId: null });
  const [inspectingSessionId, setInspectingSessionId] = useState(null);
  const containerRef = useRef(null);
  const terminalRefs = useRef(new Map());
  const prevProjectRef = useRef(null);
  const saveTimerRef = useRef(null);
  const restoringRef = useRef(false);
  const { tabs, activeTabId } = state;
  const activeTab = tabs.find(t => t.id === activeTabId);
  const sessionLookup = new Map(sessionStatus.map(session => [session.sessionId, session]));

  // Persist layout to localStorage on state changes (debounced).
  // Skips saves while a project-switch restore is in progress to avoid
  // writing the outgoing project's state under the incoming project's key.
  useEffect(() => {
    if (!shouldPersistLayout({
      projectName: project.name,
      prevProjectName: prevProjectRef.current,
      tabsLength: tabs.length,
      isRestoring: restoringRef.current,
    })) return;
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

    const saved = loadLayout(project.name);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error('Failed to fetch sessions');
        const liveSessions = await res.json();

        if (cancelled) return;

        const resolved = resolveInitialTerminalState({
          projectName: project.name,
          projectPath: project.path,
          savedLayout: saved,
          liveSessions,
        });

        if (resolved.shouldClearSavedLayout) {
          clearLayout(project.name);
        }

        tabCounter = resolved.tabCounter;
        sessionCounter = resolved.sessionCounter;
        setState(resolved.state);
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

  const clearPane = useCallback((paneId) => {
    const terminal = terminalRefs.current.get(paneId);
    terminal?.clear?.();
  }, []);

  const setPaneConnection = useCallback((tabId, paneId, isConnected) => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab => {
        if (tab.id !== tabId) return tab;
        return {
          ...tab,
          panes: tab.panes.map(pane => (
            pane.id === paneId ? { ...pane, isConnected } : pane
          )),
        };
      }),
    }));
  }, []);

  const disconnectPane = useCallback((tabId, paneId, sessionId) => {
    setPaneConnection(tabId, paneId, false);
    fetch(`/api/terminal/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      .catch(err => console.warn('Failed to disconnect terminal session:', err));
  }, [setPaneConnection]);

  const reconnectPane = useCallback((tabId, paneId) => {
    setPaneConnection(tabId, paneId, true);
  }, [setPaneConnection]);

  const registerTerminalRef = useCallback((paneId, instance) => {
    if (instance) {
      terminalRefs.current.set(paneId, instance);
    } else {
      terminalRefs.current.delete(paneId);
    }
  }, []);

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
            const tabStatus = getTabTerminalStatus(tab, sessionLookup);
            const statusStyle = TAB_STATUS_STYLES[tabStatus] || TAB_STATUS_STYLES.none;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={tabStatus === 'busy' ? 'terminal-tab terminal-tab-busy' : 'terminal-tab'}
                style={{
                  padding: '4px 10px',
                  fontSize: '12px',
                  fontFamily: 'var(--font-mono)',
                  borderRadius: 4,
                  background: isActive ? 'var(--bg-active)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : statusStyle.textColor,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  border: `1px solid ${isActive ? statusStyle.borderColor : 'transparent'}`,
                  boxShadow: isActive && tabStatus === 'busy' ? 'inset 0 1px 0 rgba(255, 255, 255, 0.04)' : 'none',
                  transition: 'border-color 0.15s ease, background 0.15s ease, color 0.15s ease',
                }}
                title={tabStatus === 'none' ? tab.label : `${tab.label} · ${tabStatus}`}
              >
                <span
                  className={tabStatus === 'busy' ? 'terminal-dot-busy' : undefined}
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: statusStyle.dotColor,
                    boxShadow: statusStyle.dotShadow,
                    flexShrink: 0,
                  }}
                />
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
                    padding: '12px 12px 10px',
                    background: 'linear-gradient(180deg, rgba(26, 26, 30, 0.95), rgba(14, 14, 16, 0.98))',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      minHeight: 0,
                      border: '1px solid rgba(110, 231, 183, 0.12)',
                      borderRadius: 16,
                      overflow: 'hidden',
                      background: 'radial-gradient(circle at top, rgba(110, 231, 183, 0.06), rgba(14, 14, 16, 0) 42%), #09090b',
                      boxShadow: '0 20px 45px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.03)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '10px 14px',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                        background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0))',
                      }}
                    >
                      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: pane.isConnected ? 'var(--accent)' : 'rgba(138, 138, 150, 0.85)',
                              boxShadow: pane.isConnected ? '0 0 14px rgba(110, 231, 183, 0.55)' : 'none',
                            }}
                          />
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12,
                              fontWeight: 600,
                              color: 'var(--text-primary)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {pane.sessionId}
                          </span>
                        </div>
                        <span
                          style={{
                            fontFamily: 'var(--font-sans)',
                            fontSize: 11,
                            letterSpacing: '0.03em',
                            color: pane.isConnected ? 'var(--text-muted)' : 'rgba(228, 228, 232, 0.68)',
                          }}
                        >
                          {pane.isConnected ? 'Live terminal attached' : 'Detached. Reopen when you need it.'}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <button
                          onClick={() => setInspectingSessionId(pane.sessionId)}
                          title="Inspect terminal"
                          className="terminal-action-btn"
                          style={{ opacity: 0.4 }}
                        >
                          <Bug size={13} />
                        </button>
                        {pane.isConnected ? (
                          <>
                            <button
                              onClick={() => clearPane(pane.id)}
                              title="Clear terminal"
                              className="terminal-action-btn"
                            >
                              <Eraser size={13} />
                            </button>
                            <button
                              onClick={() => disconnectPane(tab.id, pane.id, pane.sessionId)}
                              title="Disconnect terminal"
                              className="terminal-action-btn"
                            >
                              <PlugZap size={13} />
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => reconnectPane(tab.id, pane.id)}
                            title="Reopen terminal"
                            className="terminal-action-btn"
                          >
                            <RotateCcw size={13} />
                          </button>
                        )}

                        {tab.panes.length > 1 && (
                          <button
                            onClick={() => closePane(tab.id, pane.id, pane.sessionId)}
                            title="Close pane"
                            className="terminal-action-btn pane-close-btn"
                          >
                            <X size={13} />
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                      {pane.isConnected ? (
                        <Terminal
                          ref={(instance) => registerTerminalRef(pane.id, instance)}
                          sessionId={pane.sessionId}
                          cwd={project.path}
                          isVisible={isActive}
                        />
                      ) : (
                        <div className="terminal-empty-state">
                          <div className="terminal-empty-orb" />
                          <div className="terminal-empty-card">
                            <div className="terminal-empty-icon">
                              <TerminalSquare size={18} />
                            </div>
                            <div className="terminal-empty-label">Summon some mischief</div>
                            <div className="terminal-empty-copy">
                              This terminal is taking a dramatic pause. Reopen it when it&apos;s time to start cooking again.
                            </div>
                            <button
                              onClick={() => reconnectPane(tab.id, pane.id)}
                              className="terminal-empty-cta"
                            >
                              <RotateCcw size={14} />
                              <span>Reopen terminal</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </React.Fragment>
            ))}
          </div>
        );
      })}

      {inspectingSessionId && (
        <TerminalInspector
          sessionId={inspectingSessionId}
          onClose={() => setInspectingSessionId(null)}
          onAction={(action) => {
            // Find the pane with this sessionId and call the recovery method on its Terminal ref
            for (const tab of tabs) {
              const pane = tab.panes.find(p => p.sessionId === inspectingSessionId);
              if (pane) {
                const terminalRef = terminalRefs.current.get(pane.id);
                if (terminalRef && typeof terminalRef[action] === 'function') {
                  terminalRef[action]();
                }
                break;
              }
            }
          }}
        />
      )}
    </div>
  );
}
