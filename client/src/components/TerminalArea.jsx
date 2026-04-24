import React, { useState, useEffect, useCallback, useRef } from 'react';
import Terminal from './Terminal';
import PaneDivider from './PaneDivider';
import { Plus, X, Columns, Eraser, Bug, Paintbrush, TerminalSquare } from 'lucide-react';
import TerminalInspector from './TerminalInspector';
import { useToast } from './ToastContext';
import {
  shouldPersistLayout,
  shouldRenderProjectTerminals,
} from '../utils/terminalLayout';
import { resolveInitialTerminalState } from '../utils/terminalLayoutState';
import { getTabTerminalStatus } from '../utils/terminalActivity';
import { getTerminalTabLabel } from '../utils/terminalTabLabel';
import { getTerminalPaneCwd } from '../utils/terminalPaneCwd';

const IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const DEFAULT_RUNTIME_BLOCKED_MESSAGE = 'Install tmux to enable durable CodeDeck terminals.';

function ShortcutHint({ label, keys, children }) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  return (
    <div
      className="shortcut-hint-wrapper"
      onMouseEnter={() => {
        timerRef.current = setTimeout(() => setVisible(true), 400);
      }}
      onMouseLeave={() => {
        clearTimeout(timerRef.current);
        setVisible(false);
      }}
    >
      {children}
      {visible && (
        <div className="shortcut-tooltip">
          <span className="shortcut-tooltip-label">{label}</span>
          {keys.length > 0 && (
            <span className="shortcut-tooltip-keys">
              {keys.map((key, i) => (
                <kbd key={i} className="shortcut-kbd">{key}</kbd>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

let tabCounter = 0;
let sessionCounter = 0;

function getSessionNumber(projectName, sessionId) {
  if (!projectName || !sessionId) return null;
  const escapedName = projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sessionId.match(new RegExp(`^${escapedName}-(\\d+)$`));
  return match ? Number(match[1]) : null;
}

function createPane(sessionId) {
  return {
    id: `pane-${sessionId}`,
    sessionId,
    widthFraction: 1,
    isConnected: true,
  };
}

function createTab(sessionId) {
  const pane = createPane(sessionId);
  return {
    id: `tab-${++tabCounter}`,
    label: getTerminalTabLabel([pane]),
    panes: [pane],
  };
}

// --- localStorage layout persistence helpers ---
const LAYOUT_KEY_PREFIX = 'codedeck-layout-';
const DELETED_SESSIONS_KEY_PREFIX = 'codedeck-deleted-sessions-';

function readDeletedSessionIds(projectName) {
  if (!projectName) return new Set();

  try {
    const raw = localStorage.getItem(DELETED_SESSIONS_KEY_PREFIX + projectName);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeDeletedSessionIds(projectName, sessionIds) {
  if (!projectName) return;

  try {
    const values = Array.from(new Set(sessionIds.filter(Boolean)));
    if (values.length === 0) {
      localStorage.removeItem(DELETED_SESSIONS_KEY_PREFIX + projectName);
      return;
    }
    localStorage.setItem(DELETED_SESSIONS_KEY_PREFIX + projectName, JSON.stringify(values));
  } catch {
    // non-critical
  }
}

function markDeletedSessionIds(projectName, sessionIds) {
  const next = readDeletedSessionIds(projectName);
  sessionIds.forEach(sessionId => next.add(sessionId));
  writeDeletedSessionIds(projectName, Array.from(next));

  try {
    const rawLayout = localStorage.getItem(LAYOUT_KEY_PREFIX + projectName);
    if (!rawLayout) return;
    const layout = JSON.parse(rawLayout);
    const prunedLayout = pruneLayoutByDeletedSessionIds(layout, next);
    localStorage.setItem(LAYOUT_KEY_PREFIX + projectName, JSON.stringify(prunedLayout));
  } catch {
    // non-critical
  }
}

function unmarkDeletedSessionIds(projectName, sessionIds) {
  const next = readDeletedSessionIds(projectName);
  sessionIds.forEach(sessionId => next.delete(sessionId));
  writeDeletedSessionIds(projectName, Array.from(next));
}

function pruneLayoutByDeletedSessionIds(layout, deletedSessionIds) {
  if (!layout) return null;
  if (!deletedSessionIds || deletedSessionIds.size === 0) return layout;

  const tabs = layout.tabs
    .map(tab => {
      const panes = tab.panes.filter(pane => !deletedSessionIds.has(pane.sessionId));
      if (panes.length === 0) return null;
      return {
        ...tab,
        label: getTerminalTabLabel(panes, tab.label),
        panes,
      };
    })
    .filter(Boolean);

  const activeTabId = tabs.find(tab => tab.id === layout.activeTabId)
    ? layout.activeTabId
    : tabs[tabs.length - 1]?.id ?? null;

  return {
    ...layout,
    tabs,
    activeTabId,
  };
}

function saveLayout(projectName, state) {
  if (!projectName) return;
  try {
    const data = {
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      tabCounter,
      sessionCounter,
    };
    localStorage.setItem(LAYOUT_KEY_PREFIX + projectName, JSON.stringify(data));

    const persistedSessionIds = new Set(
      state.tabs.flatMap(tab => tab.panes.map(pane => pane.sessionId))
    );
    const deletedSessionIds = readDeletedSessionIds(projectName);
    const remainingDeletedSessionIds = Array.from(deletedSessionIds).filter(
      sessionId => persistedSessionIds.has(sessionId)
    );
    writeDeletedSessionIds(projectName, remainingDeletedSessionIds);
  } catch {
    // localStorage full or unavailable — non-critical, skip silently
  }
}

function loadLayout(projectName) {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY_PREFIX + projectName);
    if (!raw) return null;
    const layout = JSON.parse(raw);
    return pruneLayoutByDeletedSessionIds(layout, readDeletedSessionIds(projectName));
  } catch {
    return null;
  }
}

function clearLayout(projectName) {
  try {
    localStorage.removeItem(LAYOUT_KEY_PREFIX + projectName);
    localStorage.removeItem(DELETED_SESSIONS_KEY_PREFIX + projectName);
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

export default function TerminalArea({ project, sessionStatus = [], onSessionStatusRefresh = () => {} }) {
  const [state, setState] = useState({ tabs: [], activeTabId: null });
  const [activePaneId, setActivePaneId] = useState(null);
  const [pendingSessionIds, setPendingSessionIds] = useState([]);
  const [inspectingSessionId, setInspectingSessionId] = useState(null);
  const [terminalRuntimeStatus, setTerminalRuntimeStatus] = useState(null);
  const stateRef = useRef(state);
  const containerRef = useRef(null);
  const terminalRefs = useRef(new Map());
  const prevProjectRef = useRef(null);
  const saveTimerRef = useRef(null);
  const restoringRef = useRef(false);
  const awaitingSessionHydrationRef = useRef(false);
  const layoutPersistenceSuspendedRef = useRef(false);
  const pendingSessionIdsRef = useRef(new Set());
  const { tabs, activeTabId } = state;
  const activeTab = tabs.find(t => t.id === activeTabId);
  const sessionLookup = new Map(sessionStatus.map(session => [session.sessionId, session]));
  const shouldRenderTerminals = shouldRenderProjectTerminals({
    projectName: project.name,
    prevProjectName: prevProjectRef.current,
  });
  const { showToast } = useToast();
  const isTerminalRuntimeBlocked = terminalRuntimeStatus?.terminalCreationAllowed === false;
  const terminalRuntimeBlockedMessage = terminalRuntimeStatus?.terminalRuntimeBlockedMessage || DEFAULT_RUNTIME_BLOCKED_MESSAGE;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const updateTerminalState = useCallback((updater, { persistImmediately = false } = {}) => {
    const nextState = typeof updater === 'function'
      ? updater(stateRef.current)
      : updater;

    stateRef.current = nextState;
    setState(nextState);

    if (persistImmediately) {
      clearTimeout(saveTimerRef.current);
      saveLayout(project.name, nextState);
    }

    return nextState;
  }, [project.name]);

  // Persist layout to localStorage on state changes (debounced).
  // Skips saves while a project-switch restore is in progress to avoid
  // writing the outgoing project's state under the incoming project's key.
  useEffect(() => {
    if (!shouldPersistLayout({
      projectName: project.name,
      prevProjectName: prevProjectRef.current,
      tabsLength: tabs.length,
      isRestoring: restoringRef.current,
      isPersistenceSuspended: layoutPersistenceSuspendedRef.current,
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
    setTerminalRuntimeStatus(null);

    const saved = loadLayout(project.name);
    let cancelled = false;
    (async () => {
      try {
        let nextTerminalRuntimeStatus = null;
        try {
          const healthRes = await fetch('/api/health');
          if (healthRes.ok) {
            nextTerminalRuntimeStatus = await healthRes.json();
          }
        } catch {
          nextTerminalRuntimeStatus = null;
        }

        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error('Failed to fetch sessions');
        const liveSessions = await res.json();

        if (cancelled) return;

        layoutPersistenceSuspendedRef.current = false;
        setTerminalRuntimeStatus(nextTerminalRuntimeStatus);
        onSessionStatusRefresh(liveSessions);

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
        awaitingSessionHydrationRef.current = resolved.state.tabs.length === 0;
        setState(resolved.state);
      } catch {
        if (cancelled) return;
        layoutPersistenceSuspendedRef.current = true;
        tabCounter = saved?.tabCounter ?? 0;
        sessionCounter = saved?.sessionCounter ?? 0;
        awaitingSessionHydrationRef.current = true;
        showToast({ type: 'error', message: 'Server unreachable' });
        setState({ tabs: [], activeTabId: null });
      } finally {
        if (!cancelled) restoringRef.current = false;
      }
    })();

    return () => { cancelled = true; restoringRef.current = false; };
  }, [project.name]);

  useEffect(() => {
    if (restoringRef.current) return;
    if (!awaitingSessionHydrationRef.current) return;
    if (tabs.length > 0) return;

    const resolved = resolveInitialTerminalState({
      projectName: project.name,
      projectPath: project.path,
      savedLayout: {
        tabs: [],
        activeTabId: null,
        tabCounter,
        sessionCounter,
      },
      liveSessions: sessionStatus,
    });

    if (resolved.state.tabs.length === 0) return;

    tabCounter = resolved.tabCounter;
    sessionCounter = resolved.sessionCounter;
    layoutPersistenceSuspendedRef.current = false;
    awaitingSessionHydrationRef.current = false;
    setState(resolved.state);
  }, [project.name, project.path, sessionStatus, tabs.length]);

  const setActiveTabId = useCallback((id) => {
    updateTerminalState(prev => {
      const tab = prev.tabs.find(t => t.id === id);
      setActivePaneId(tab?.panes[0]?.id ?? null);
      return { ...prev, activeTabId: id };
    });
  }, []);

  // Auto-select first pane when active tab changes (project switch, initial load)
  useEffect(() => {
    if (activeTab && (!activePaneId || !activeTab.panes.some(p => p.id === activePaneId))) {
      setActivePaneId(activeTab.panes[0]?.id ?? null);
    }
  }, [activeTab?.id]);

  const setSessionsPending = useCallback((sessionIds, isPending) => {
    if (sessionIds.length === 0) return;

    const nextPending = new Set(pendingSessionIdsRef.current);
    sessionIds.forEach(sessionId => {
      if (isPending) nextPending.add(sessionId);
      else nextPending.delete(sessionId);
    });

    pendingSessionIdsRef.current = nextPending;
    setPendingSessionIds(Array.from(nextPending));
  }, []);

  const deleteTerminalSessions = useCallback(async (sessionIds, actionLabel) => {
    const targetSessionIds = [...new Set(sessionIds.filter(Boolean))].filter(
      sessionId => !pendingSessionIdsRef.current.has(sessionId)
    );

    if (targetSessionIds.length === 0) return new Set();

    setSessionsPending(targetSessionIds, true);

    try {
      const results = await Promise.all(targetSessionIds.map(async (sessionId) => {
        try {
          const res = await fetch(`/api/terminal/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Request failed');
          }
          return { sessionId, ok: true };
        } catch (error) {
          return {
            sessionId,
            ok: false,
            error: error.message || 'Server unreachable',
          };
        }
      }));

      const failed = results.filter(result => !result.ok);
      if (failed.length > 0) {
        const message = failed.length === 1
          ? `Failed to ${actionLabel} ${failed[0].sessionId}: ${failed[0].error}`
          : `Failed to ${actionLabel} ${failed.length} terminals`;
        showToast({ type: 'error', message });
      }

      return new Set(
        results
          .filter(result => result.ok)
          .map(result => result.sessionId)
      );
    } finally {
      setSessionsPending(targetSessionIds, false);
    }
  }, [setSessionsPending, showToast]);

  const requestTerminalSessionId = useCallback(async (successMessage) => {
    if (isTerminalRuntimeBlocked) {
      showToast({ type: 'error', message: terminalRuntimeBlockedMessage });
      return null;
    }

    try {
      const res = await fetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: project.name }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: err.error || 'Failed to create terminal' });
        return null;
      }

      const data = await res.json();
      const sessionNumber = getSessionNumber(project.name, data.sessionId);
      if (sessionNumber !== null) {
        sessionCounter = Math.max(sessionCounter, sessionNumber);
      }
      showToast({ type: 'success', message: successMessage || `Opened ${data.sessionId}` });
      return data.sessionId;
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
      return null;
    }
  }, [project.name, showToast, isTerminalRuntimeBlocked, terminalRuntimeBlockedMessage]);

  // Split right — add pane to active tab, redistribute widths equally
  const splitRight = useCallback(async () => {
    if (!activeTabId) return;
    const sessionId = await requestTerminalSessionId('Opened terminal split');
    if (!sessionId) return;
    const pane = createPane(sessionId);
    setActivePaneId(pane.id);
    updateTerminalState(prev => ({
      ...prev,
      tabs: prev.tabs.map(tab => {
        if (tab.id !== prev.activeTabId) return tab;
        const newPanes = [...tab.panes, pane];
        const fraction = 1 / newPanes.length;
        return { ...tab, label: getTerminalTabLabel(newPanes, tab.label), panes: newPanes.map(p => ({ ...p, widthFraction: fraction })) };
      }),
    }), { persistImmediately: true });
  }, [activeTabId, requestTerminalSessionId, updateTerminalState]);

  // New tab with one pane
  const addTab = useCallback(async () => {
    const sessionId = await requestTerminalSessionId('Opened terminal');
    if (!sessionId) return;
    const tab = createTab(sessionId);
    setActivePaneId(tab.panes[0].id);
    updateTerminalState(prev => ({
      tabs: [...prev.tabs, tab],
      activeTabId: tab.id,
    }), { persistImmediately: true });
  }, [requestTerminalSessionId, updateTerminalState]);

  // Close a single pane — redistribute, or close tab if last pane
  const closePane = useCallback(async (tabId, paneId, sessionId) => {
    markDeletedSessionIds(project.name, [sessionId]);
    const deletedSessionIds = await deleteTerminalSessions([sessionId], 'close');
    if (!deletedSessionIds.has(sessionId)) {
      unmarkDeletedSessionIds(project.name, [sessionId]);
      return;
    }

    updateTerminalState(prev => {
      const tab = prev.tabs.find(t => t.id === tabId);
      if (!tab) return prev;

      const closedIndex = tab.panes.findIndex(p => p.id === paneId);
      const remainingPanes = tab.panes.filter(p => p.id !== paneId);

      if (remainingPanes.length > 0) {
        // Auto-select adjacent pane if the closed pane was active
        if (activePaneId === paneId) {
          const nextIndex = Math.min(closedIndex, remainingPanes.length - 1);
          setActivePaneId(remainingPanes[nextIndex].id);
        }
        const fraction = 1 / remainingPanes.length;
        return {
          ...prev,
          tabs: prev.tabs.map(t => t.id === tabId
            ? {
                ...t,
                label: getTerminalTabLabel(remainingPanes, t.label),
                panes: remainingPanes.map(p => ({ ...p, widthFraction: fraction })),
              }
            : t
          ),
        };
      }

      // Last pane in tab → close the tab
      const remainingTabs = prev.tabs.filter(t => t.id !== tabId);
      const newActiveTabId = prev.activeTabId === tabId
        ? remainingTabs[remainingTabs.length - 1]?.id ?? null
        : prev.activeTabId;
      // Auto-select first pane of new active tab
      if (prev.activeTabId === tabId) {
        const newTab = remainingTabs.find(t => t.id === newActiveTabId);
        setActivePaneId(newTab?.panes[0]?.id ?? null);
      }
      return {
        tabs: remainingTabs,
        activeTabId: newActiveTabId,
      };
    }, { persistImmediately: true });
  }, [deleteTerminalSessions, activePaneId, project.name]);

  // Close entire tab — kill all PTY sessions
  const closeTab = useCallback(async (tabId) => {
    const tab = tabs.find(candidate => candidate.id === tabId);
    if (!tab) return;

    const requestedSessionIds = tab.panes.map(pane => pane.sessionId);
    markDeletedSessionIds(project.name, requestedSessionIds);

    const deletedSessionIds = await deleteTerminalSessions(
      requestedSessionIds,
      'close'
    );

    if (deletedSessionIds.size === 0) {
      unmarkDeletedSessionIds(project.name, requestedSessionIds);
      return;
    }

    const failedSessionIds = requestedSessionIds.filter(sessionId => !deletedSessionIds.has(sessionId));
    if (failedSessionIds.length > 0) {
      unmarkDeletedSessionIds(project.name, failedSessionIds);
    }

    updateTerminalState(prev => {
      const currentTab = prev.tabs.find(candidate => candidate.id === tabId);
      if (!currentTab) return prev;

      const remainingPanes = currentTab.panes.filter(
        pane => !deletedSessionIds.has(pane.sessionId)
      );

      if (remainingPanes.length > 0) {
        const fraction = 1 / remainingPanes.length;
        return {
          ...prev,
          tabs: prev.tabs.map(candidate => candidate.id === tabId
            ? {
                ...candidate,
                label: getTerminalTabLabel(remainingPanes, candidate.label),
                panes: remainingPanes.map(pane => ({ ...pane, widthFraction: fraction })),
              }
            : candidate
          ),
        };
      }

      const remainingTabs = prev.tabs.filter(candidate => candidate.id !== tabId);
      return {
        tabs: remainingTabs,
        activeTabId: prev.activeTabId === tabId
          ? remainingTabs[remainingTabs.length - 1]?.id ?? null
          : prev.activeTabId,
      };
    }, { persistImmediately: true });
  }, [deleteTerminalSessions, tabs, project.name]);

  const clearPane = useCallback((paneId) => {
    const terminal = terminalRefs.current.get(paneId);
    terminal?.clear?.();
  }, []);

  const redrawPane = useCallback((paneId) => {
    const terminal = terminalRefs.current.get(paneId);
    if (!terminal?.redraw) {
      showToast({ type: 'error', message: 'Terminal not ready to redraw yet' });
      return;
    }

    terminal.redraw();
    showToast({ type: 'success', message: 'Re-measuring terminal layout...' });
  }, [showToast]);

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

  // Keyboard shortcuts — capture phase fires before xterm's key handler
  useEffect(() => {
    const handleKeyDown = (e) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (!isCmdOrCtrl) return;

      const key = e.key.toLowerCase();

      // Cmd+Option+1-9 — select pane by number
      if (e.altKey && !e.shiftKey) {
        const digit = parseInt(key, 10) || parseInt(e.code?.replace('Digit', ''), 10);
        if (digit >= 1 && digit <= 9 && activeTab) {
          e.preventDefault();
          e.stopPropagation();
          const targetPane = activeTab.panes[digit - 1];
          if (targetPane) {
            setActivePaneId(targetPane.id);
            const terminal = terminalRefs.current.get(targetPane.id);
            terminal?.focus?.();
          }
        }
        return;
      }

      if (!e.shiftKey || e.altKey) return;

      if (key === 'e' && activeTabId) {
        e.preventDefault();
        e.stopPropagation();
        splitRight();
        return;
      }

      if (key === 't') {
        e.preventDefault();
        e.stopPropagation();
        addTab();
        return;
      }

      // Cmd+Shift+K — clear active pane
      if (key === 'k' && activePaneId) {
        e.preventDefault();
        e.stopPropagation();
        clearPane(activePaneId);
        return;
      }

      // Cmd+Shift+X — close active pane
      if (key === 'x' && activePaneId && activeTab) {
        e.preventDefault();
        e.stopPropagation();
        const pane = activeTab.panes.find(p => p.id === activePaneId);
        if (pane) {
          closePane(activeTab.id, pane.id, pane.sessionId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [splitRight, addTab, activeTabId, activeTab, activePaneId, clearPane, closePane]);

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
            const tabHasPendingClose = tab.panes.some(pane => pendingSessionIds.includes(pane.sessionId));
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
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!tabHasPendingClose) closeTab(tab.id);
                    }}
                    style={{
                      opacity: tabHasPendingClose ? 0.2 : 0.5,
                      display: 'flex',
                      cursor: tabHasPendingClose ? 'wait' : 'pointer',
                    }}
                  >
                    <X size={10} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Actions */}
        <ShortcutHint
          label="Split right"
          keys={IS_MAC ? ['⌘', '⇧', 'E'] : ['Ctrl', '⇧', 'E']}
        >
          <button
            onClick={splitRight}
            aria-label="Split right"
            title={isTerminalRuntimeBlocked ? terminalRuntimeBlockedMessage : undefined}
            disabled={!activeTab || isTerminalRuntimeBlocked}
            style={{
              padding: 4,
              borderRadius: 4,
              color: activeTab && !isTerminalRuntimeBlocked ? 'var(--text-muted)' : 'rgba(138, 146, 166, 0.45)',
              opacity: activeTab && !isTerminalRuntimeBlocked ? 1 : 0.5,
              cursor: activeTab && !isTerminalRuntimeBlocked ? 'pointer' : 'not-allowed',
            }}
          >
            <Columns size={14} />
          </button>
        </ShortcutHint>
        <ShortcutHint
          label="New terminal"
          keys={IS_MAC ? ['⌘', '⇧', 'T'] : ['Ctrl', '⇧', 'T']}
        >
          <button
            onClick={addTab}
            aria-label="New terminal"
            title={isTerminalRuntimeBlocked ? terminalRuntimeBlockedMessage : undefined}
            disabled={isTerminalRuntimeBlocked}
            style={{
              padding: 4,
              borderRadius: 4,
              color: isTerminalRuntimeBlocked ? 'rgba(138, 146, 166, 0.45)' : 'var(--text-muted)',
              opacity: isTerminalRuntimeBlocked ? 0.5 : 1,
              cursor: isTerminalRuntimeBlocked ? 'not-allowed' : 'pointer',
            }}
          >
            <Plus size={14} />
          </button>
        </ShortcutHint>
      </div>

      {isTerminalRuntimeBlocked && (
        <div
          className="terminal-empty-state"
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div className="terminal-empty-card">
            <div className="terminal-empty-icon">
              <TerminalSquare size={18} />
            </div>
            <div className="terminal-empty-label">tmux required</div>
            <div className="terminal-empty-copy">
              {terminalRuntimeBlockedMessage} Restart CodeDeck after installing tmux, then open or reattach your terminals.
            </div>
          </div>
        </div>
      )}

      {!isTerminalRuntimeBlocked && tabs.length === 0 && (
        <div
          className="terminal-empty-state"
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div className="terminal-empty-card">
            <div className="terminal-empty-icon">
              <TerminalSquare size={18} />
            </div>
            <div className="terminal-empty-label">No terminals open</div>
            <div className="terminal-empty-copy">
              This project has no running terminals. Open a new tab when you want to start one.
            </div>
            <button
              onClick={addTab}
              className="terminal-empty-cta"
            >
              <Plus size={14} />
              <span>Open terminal</span>
            </button>
          </div>
        </div>
      )}

      {/* Pane groups — render ALL tabs, hide inactive ones to preserve terminal state */}
      {!isTerminalRuntimeBlocked && shouldRenderTerminals && tabs.map(tab => {
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
            {tab.panes.map((pane, index) => {
              const paneCwd = getTerminalPaneCwd({
                sessionId: pane.sessionId,
                projectPath: project.path,
                sessionLookup,
              });
              const isPending = pendingSessionIds.includes(pane.sessionId);

              return (
                <React.Fragment key={pane.id}>
                {index > 0 && (
                  <PaneDivider
                    onDrag={(delta) => handleDividerDrag(tab.id, index - 1, delta)}
                    onDoubleClick={() => handleDividerReset(tab.id)}
                  />
                )}
                <div
                  className="pane-wrapper"
                  onMouseDown={() => {
                    if (activePaneId !== pane.id) {
                      setActivePaneId(pane.id);
                    }
                  }}
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
                      border: `1px solid ${activePaneId === pane.id ? 'rgba(110, 231, 183, 0.45)' : 'rgba(110, 231, 183, 0.12)'}`,
                      borderRadius: 16,
                      overflow: 'hidden',
                      background: 'radial-gradient(circle at top, rgba(110, 231, 183, 0.06), rgba(14, 14, 16, 0) 42%), #09090b',
                      boxShadow: '0 20px 45px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.03)',
                      transition: 'border-color 0.15s ease',
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
                              background: 'var(--accent)',
                              boxShadow: '0 0 14px rgba(110, 231, 183, 0.55)',
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
                            color: 'var(--text-muted)',
                          }}
                        >
                          Live terminal attached
                        </span>
                        <span
                          title={paneCwd}
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            color: 'rgba(228, 228, 232, 0.58)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {`cwd: ${paneCwd}`}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <ShortcutHint label="Re-measure terminal layout" keys={[]}>
                          <button
                            onClick={() => redrawPane(pane.id)}
                            className="terminal-action-btn"
                            title="Re-measure terminal layout"
                            disabled={isPending}
                          >
                            <Paintbrush size={13} />
                          </button>
                        </ShortcutHint>
                        <ShortcutHint label="Inspect terminal" keys={[]}>
                          <button
                            onClick={() => setInspectingSessionId(pane.sessionId)}
                            className="terminal-action-btn"
                            style={{ opacity: 0.4 }}
                            disabled={isPending}
                          >
                            <Bug size={13} />
                          </button>
                        </ShortcutHint>
                        <ShortcutHint
                          label="Clear terminal"
                          keys={IS_MAC ? ['⌘', '⇧', 'K'] : ['Ctrl', '⇧', 'K']}
                        >
                          <button
                            onClick={() => clearPane(pane.id)}
                            className="terminal-action-btn"
                            disabled={isPending}
                          >
                            <Eraser size={13} />
                          </button>
                        </ShortcutHint>
                        <ShortcutHint
                          label="Close pane"
                          keys={IS_MAC ? ['⌘', '⇧', 'X'] : ['Ctrl', '⇧', 'X']}
                        >
                          <button
                            onClick={() => closePane(tab.id, pane.id, pane.sessionId)}
                            className="terminal-action-btn pane-close-btn"
                            disabled={isPending}
                          >
                            <X size={13} />
                          </button>
                        </ShortcutHint>
                      </div>
                    </div>

                    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                      <Terminal
                        key={pane.sessionId}
                        ref={(instance) => registerTerminalRef(pane.id, instance)}
                        sessionId={pane.sessionId}
                        cwd={project.path}
                        isVisible={isActive}
                        runtimeType={sessionLookup.get(pane.sessionId)?.runtimeType ?? 'pty'}
                      />
                    </div>
                  </div>
                </div>
                </React.Fragment>
              );
            })}
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
