import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, Plus, Trash2, FolderTree, Pencil, Settings, FolderSearch, Archive, ArchiveRestore, ChevronRight, ChevronDown, Search, X, Bell, BellOff, PanelLeftClose, PanelLeftOpen, Keyboard, Hourglass, Play, Copy, MoreVertical } from 'lucide-react';
import DirectoryBrowser from './DirectoryBrowser';
import SettingsPanel from './SettingsPanel';
import { useToast } from './ToastContext';
import BrandMark from './BrandMark';
import {
  createNotificationAudioContext,
  playCompletionDing,
  requestNotificationPermissionFromGesture,
  showBrowserNotification,
  shouldQueueNotificationPermissionRequest,
  warmNotificationAudioContext,
} from '../utils/browserNotifications';
import {
  DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_MS,
  getVisualAggregateTerminalStatus,
  getVisualTerminalStatus,
  getDisplayTerminalStatus,
  getTerminalCompletionNotification,
  getTerminalStatus,
  resolveTerminalCompletionNotificationMs,
} from '../utils/terminalActivity';
import { doesSessionBelongToProject } from '../utils/terminalProjectMatch';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

function formatTimeSince(isoString) {
  if (!isoString) return '';
  const secs = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function getProjectStatus(sessions, finishedIds, mutedStatusSessionIds) {
  if (!sessions || sessions.length === 0) return { status: 'none' };
  if (!sessions.some(session => session.alive)) return { status: 'dead' };

  const status = getVisualAggregateTerminalStatus(sessions, finishedIds, mutedStatusSessionIds);
  return {
    status: status === 'busy' ? 'active' : status,
  };
}

function getProjectHost(project) {
  return project?.host && project.host !== 'local' ? project.host : null;
}

function getProjectReachability(project, sessions = []) {
  if (project?.reachability) return project.reachability;
  const host = getProjectHost(project);
  if (!host) return 'reachable';
  return sessions.find(session => session.host === host && session.reachability)?.reachability || 'unknown';
}

function getProjectLastError(project, sessions = []) {
  if (project?.lastError) return project.lastError;
  const host = getProjectHost(project);
  return sessions.find(session => session.host === host && session.lastError)?.lastError || null;
}

function getTruthfulProjectStatus(project, sessions, finishedIds, mutedStatusSessionIds) {
  if (getProjectReachability(project, sessions) === 'unreachable') {
    return { status: 'unknown' };
  }
  return getProjectStatus(sessions, finishedIds, mutedStatusSessionIds);
}

function renderHostReachabilityBadges({ hostName, isHostUnreachable, lastError }) {
  if (!hostName) return null;
  return (
    <>
      <span
        title={isHostUnreachable
          ? `Host ${hostName} unreachable${lastError ? `: ${lastError}` : ''}`
          : `Host ${hostName}`}
        style={{
          flexShrink: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          lineHeight: 1,
          padding: '3px 5px',
          borderRadius: 999,
          color: isHostUnreachable ? '#fbbf24' : 'var(--text-muted)',
          background: isHostUnreachable ? 'rgba(251, 191, 36, 0.12)' : 'rgba(154, 165, 184, 0.12)',
          border: isHostUnreachable ? '1px solid rgba(251, 191, 36, 0.32)' : '1px solid rgba(154, 165, 184, 0.18)',
        }}
      >
        {hostName}
      </span>
      {isHostUnreachable && (
        <span style={{
          flexShrink: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: '#fbbf24',
        }}>
          unreachable
        </span>
      )}
    </>
  );
}

const STATUS_COLORS = {
  active: 'var(--accent)',
  finished: 'var(--warning)',
  idle: 'var(--text-muted)',
  unknown: 'var(--text-muted)',
  dead: 'var(--danger)',
};

export default function Sidebar({ activeProjects, waitingProjects = [], shelvedProjects, activeProject, isCompact, onSelect, onAdd, onRemove, onRename, onMarkWaiting, onActivateWaiting, onShelve, onUnshelve, onToggleCompact, onToggleFiles, showFileTree, sessionStatus, finishedSessionIds = new Set(), mutedStatusSessionIds = new Set(), onResetFinishedSession = () => {}, onBrowseFiles, onShowShortcuts }) {
  const [showBrowser, setShowBrowser] = useState(false);
  const [defaultPath, setDefaultPath] = useState(null);
  const [renamingProject, setRenamingProject] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [shelfExpanded, setShelfExpanded] = useState(() => {
    return localStorage.getItem('codedeck-shelf-expanded') === 'true';
  });
  const [shelfSearch, setShelfSearch] = useState('');
  const [mutedProjects, setMutedProjects] = useState(() => {
    try {
      const stored = localStorage.getItem('codedeck-muted-projects');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [openProjectMenu, setOpenProjectMenu] = useState(null);
  const [projectMenuAnchor, setProjectMenuAnchor] = useState(null);
  const renameInputRef = useRef(null);
  const busyTracker = useRef(new Map());
  const prevStatusRef = useRef(new Map());
  const mutedProjectsRef = useRef(mutedProjects);
  const activeProjectsRef = useRef(activeProjects);
  const notificationCooldownMsRef = useRef(DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_MS);
  const notificationAudioRef = useRef(null);
  const notificationPermissionPendingRef = useRef(false);
  const notificationRequestedRef = useRef(false);
  const { showToast } = useToast();

  useEffect(() => { mutedProjectsRef.current = mutedProjects; }, [mutedProjects]);
  useEffect(() => { activeProjectsRef.current = activeProjects; }, [activeProjects]);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/config')
      .then(async res => {
        if (!res.ok) throw new Error('Failed to load notification cooldown');
        return res.json();
      })
      .then(data => {
        if (cancelled) return;
        notificationCooldownMsRef.current = resolveTerminalCompletionNotificationMs(
          data.terminalFinishCooldownSeconds
        );
      })
      .catch((error) => {
        console.warn('Failed to load terminal finish cooldown config', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const primeNotificationAudio = () => {
      if (!notificationAudioRef.current) {
        notificationAudioRef.current = createNotificationAudioContext(window);
      }
      if (notificationAudioRef.current) {
        void warmNotificationAudioContext(notificationAudioRef.current);
      }

      if (notificationPermissionPendingRef.current && !notificationRequestedRef.current) {
        notificationRequestedRef.current = true;
        const pendingRequest = notificationPermissionPendingRef.current;
        notificationPermissionPendingRef.current = false;

        void requestNotificationPermissionFromGesture(window, {
          pendingRequest,
          alreadyRequested: false,
        }).then((requested) => {
          if (!requested) {
            notificationRequestedRef.current = false;
          }
        });
      }
    };

    window.addEventListener('pointerdown', primeNotificationAudio, { passive: true });
    window.addEventListener('keydown', primeNotificationAudio);

    return () => {
      window.removeEventListener('pointerdown', primeNotificationAudio);
      window.removeEventListener('keydown', primeNotificationAudio);

      if (notificationAudioRef.current && typeof notificationAudioRef.current.close === 'function') {
        Promise.resolve(notificationAudioRef.current.close()).catch(() => {});
      }
    };
  }, []);

  // Notification logic: track busy durations, fire on busy→idle/dead after ≥30s
  useEffect(() => {
    if (!sessionStatus || sessionStatus.length === 0) return;

    sessionStatus.forEach(session => {
      const status = getTerminalStatus(session);
      const prevStatus = prevStatusRef.current.get(session.sessionId);

      if (status === 'busy') {
        if (shouldQueueNotificationPermissionRequest({
          status,
          alreadyRequested: notificationRequestedRef.current,
          permission: typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'denied',
          hasNotificationSupport: typeof window !== 'undefined' && 'Notification' in window,
        })) {
          notificationPermissionPendingRef.current = true;
        }
        if (prevStatus !== 'busy') {
          busyTracker.current.set(session.sessionId, { busyStartedAt: Date.now() });
        }
      } else {
        if (prevStatus === 'busy') {
          const completionNotification = getTerminalCompletionNotification(session, {
            activeProjects: activeProjectsRef.current,
            mutedProjects: mutedProjectsRef.current,
            prevStatus,
            busyStartedAt: busyTracker.current.get(session.sessionId)?.busyStartedAt,
            cooldownMs: notificationCooldownMsRef.current,
          });

          if (completionNotification) {
            if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
              void showBrowserNotification(window, {
                title: completionNotification.title,
                body: completionNotification.body,
                tag: `${session.sessionId}-finished`,
                data: { sessionId: session.sessionId, projectName: completionNotification.projectName },
              }).then((method) => {
                if (method !== 'none') {
                  if (!notificationAudioRef.current) {
                    notificationAudioRef.current = createNotificationAudioContext(window);
                  }
                  void playCompletionDing(notificationAudioRef.current);
                  return;
                }

                showToast({
                  type: 'success',
                  message: `${session.sessionId} finished${session.lastOutputLine ? `: ${session.lastOutputLine}` : ''}`,
                });
              });
            } else {
              showToast({
                type: 'success',
                message: `${session.sessionId} finished${session.lastOutputLine ? `: ${session.lastOutputLine}` : ''}`,
              });
            }
          }
        }
        busyTracker.current.delete(session.sessionId);
      }
    });

    const newPrev = new Map();
    sessionStatus.forEach(s => newPrev.set(s.sessionId, getTerminalStatus(s)));
    prevStatusRef.current = newPrev;
  }, [sessionStatus, showToast]);

  const toggleMute = (e, projectName) => {
    e.stopPropagation();
    setOpenProjectMenu(null);
    setMutedProjects(prev => {
      const next = prev.includes(projectName)
        ? prev.filter(n => n !== projectName)
        : [...prev, projectName];
      localStorage.setItem('codedeck-muted-projects', JSON.stringify(next));
      return next;
    });
  };

  const copyProjectPath = async (e, project) => {
    e.stopPropagation();
    try {
      if (!navigator.clipboard?.writeText) {
        showToast({ type: 'error', message: 'Clipboard unavailable' });
        return;
      }
      await navigator.clipboard.writeText(project.path);
      showToast({ type: 'success', message: 'Project path copied' });
    } catch {
      showToast({ type: 'error', message: 'Failed to copy project path' });
    }
  };

  const getProjectSessions = (project) => {
    if (!sessionStatus || sessionStatus.length === 0) return [];
    return sessionStatus.filter(session => doesSessionBelongToProject(session, project));
  };

  const handleSettingsSaved = ({ terminalFinishCooldownSeconds } = {}) => {
    if (terminalFinishCooldownSeconds === undefined) return;
    notificationCooldownMsRef.current = resolveTerminalCompletionNotificationMs(terminalFinishCooldownSeconds);
  };

  const handleAddClick = async () => {
    try {
      const res = await fetch('/api/config/defaultPath');
      if (res.ok) {
        const data = await res.json();
        setDefaultPath(data.value);
      }
    } catch {
      showToast({ type: 'error', message: 'Failed to load default path' });
    }
    setShowBrowser(true);
  };

  const handleBrowseSelect = (selectedPath, selectedHost) => {
    const segments = selectedPath.replace(/\/+$/, '').split('/');
    const projectName = segments[segments.length - 1] || 'project';
    onAdd(projectName, selectedPath, selectedHost);
    setShowBrowser(false);
  };

  const startRename = (e, project) => {
    e.stopPropagation();
    setOpenProjectMenu(null);
    setRenamingProject(project.name);
    setRenameValue(project.name);
  };

  useEffect(() => {
    if (!confirmDelete) return;
    const dismiss = () => setConfirmDelete(null);
    document.addEventListener('click', dismiss);
    return () => document.removeEventListener('click', dismiss);
  }, [confirmDelete]);

  useEffect(() => {
    if (!openProjectMenu) return;
    const dismiss = () => setOpenProjectMenu(null);
    document.addEventListener('click', dismiss);
    return () => document.removeEventListener('click', dismiss);
  }, [openProjectMenu]);

  useEffect(() => {
    if (renamingProject && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingProject]);

  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== renamingProject) {
      onRename(renamingProject, trimmed);
    }
    setRenamingProject(null);
  };

  const cancelRename = () => {
    setRenamingProject(null);
  };

  const toggleShelf = () => {
    setShelfExpanded(prev => {
      const next = !prev;
      localStorage.setItem('codedeck-shelf-expanded', String(next));
      if (!next) setShelfSearch('');
      return next;
    });
  };

  const renderProjectMenu = (project, menuKey, items, placement = 'down') => (
    <div className="project-menu-wrap">
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (openProjectMenu === menuKey) {
            setOpenProjectMenu(null);
            setProjectMenuAnchor(null);
            return;
          }

          const rect = e.currentTarget.getBoundingClientRect();
          setProjectMenuAnchor({
            top: rect.bottom + 4,
            bottom: window.innerHeight - rect.top + 4,
            right: window.innerWidth - rect.right,
          });
          setOpenProjectMenu(menuKey);
        }}
        className="project-action-btn"
        title="Project actions"
        aria-label={`Project actions for ${project.name}`}
      >
        <MoreVertical size={14} />
      </button>
      {openProjectMenu === menuKey && projectMenuAnchor && createPortal(
        <div
          className={`project-menu project-menu-fixed ${placement === 'up' ? 'project-menu-up' : ''}`}
          style={placement === 'up'
            ? { bottom: projectMenuAnchor.bottom, right: projectMenuAnchor.right }
            : { top: projectMenuAnchor.top, right: projectMenuAnchor.right }}
          onClick={e => e.stopPropagation()}
        >
          {items.map(item => (
            <button
              key={item.label}
              className={`project-menu-item ${item.danger ? 'danger' : ''}`}
              title={item.label}
              onClick={(e) => {
                e.stopPropagation();
                item.onClick(e);
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );

  const removeMenuItem = (project) => (
    confirmDelete === project.name
      ? {
          label: 'Confirm remove',
          danger: true,
          icon: <Trash2 size={13} />,
          onClick: () => {
            onRemove(project.name);
            setConfirmDelete(null);
            setOpenProjectMenu(null);
          },
        }
      : {
          label: 'Remove project',
          danger: true,
          icon: <Trash2 size={13} />,
          onClick: () => setConfirmDelete(project.name),
        }
  );

  const totalProjects = activeProjects.length + waitingProjects.length + shelvedProjects.length;
  const sidebarWidth = isCompact ? 72 : 220;

  return (
    <>
      <div style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        userSelect: 'none',
      }}>
        {/* Header */}
        <div style={{
          padding: isCompact ? '14px 10px 12px' : '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: isCompact ? 'center' : 'space-between',
          borderBottom: '1px solid var(--border)',
          gap: 6,
        }}>
          {!isCompact && (
            <div className="brand-lockup">
              <BrandMark size={24} showWordmark showTagline={false} gap={7} />
            </div>
          )}
          {isCompact && <BrandMark size={28} />}
          <div style={{ display: 'flex', gap: 3, flexDirection: isCompact ? 'column' : 'row', flexShrink: 0 }}>
            <button
              onClick={onToggleCompact}
              className="sidebar-header-btn"
              title={isCompact ? `Expand sidebar (${mod}B)` : `Collapse sidebar (${mod}B)`}
              aria-label={isCompact ? 'Expand sidebar' : 'Collapse sidebar'}
              style={{
                color: isCompact ? 'var(--accent)' : undefined,
                background: isCompact ? 'var(--accent-dim)' : undefined,
              }}
            >
              {isCompact ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
            <button
              onClick={onToggleFiles}
              className="sidebar-header-btn"
              title={`Toggle file tree (${mod}⇧F)`}
              style={{
                color: showFileTree ? 'var(--accent)' : undefined,
                background: showFileTree ? 'var(--accent-dim)' : undefined,
              }}
            >
              <FolderTree size={15} />
            </button>
            <button
              onClick={handleAddClick}
              className="sidebar-header-btn"
              title="Add project"
            >
              <Plus size={15} />
            </button>
          </div>
        </div>

        {/* Project list — scrollable */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {activeProjects.length === 0 && waitingProjects.length === 0 && shelvedProjects.length === 0 && (
            <div style={{
              padding: isCompact ? '24px 10px' : '24px 16px',
              color: 'var(--text-muted)',
              fontSize: '12px',
              textAlign: 'center',
              fontFamily: 'var(--font-mono)',
            }}>
              {isCompact ? 'No projects' : (
                <>
                  No projects yet.
                  <br />Click + to add one.
                </>
              )}
            </div>
          )}

          {/* Active project rows */}
          {activeProjects.map(project => {
            const isActive = activeProject?.name === project.name;
            const isRenaming = renamingProject === project.name;
            const projSessions = getProjectSessions(project);
            const hostName = getProjectHost(project);
            const reachability = getProjectReachability(project, projSessions);
            const lastError = getProjectLastError(project, projSessions);
            const isHostUnreachable = reachability === 'unreachable';
            const { status } = getTruthfulProjectStatus(project, projSessions, finishedSessionIds, mutedStatusSessionIds);
            const rowTitle = isHostUnreachable && hostName
              ? `${project.name} — ${hostName} unreachable`
              : project.name;
            return (
              <div
                key={project.name}
                onClick={() => { if (!isRenaming) onSelect(project); }}
                className={`project-row ${openProjectMenu === `active:${project.name}` ? 'project-menu-open' : ''}`}
                title={rowTitle}
                style={{
                  padding: isCompact ? '10px 12px' : '8px 16px',
                  cursor: isRenaming ? 'default' : 'pointer',
                  background: isActive ? 'var(--bg-active)' : 'transparent',
                  borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'background 0.1s',
                  opacity: isHostUnreachable ? 0.62 : undefined,
                  filter: isHostUnreachable ? 'grayscale(0.45)' : undefined,
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                {/* Row 1: status dot + project name */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: isCompact ? 'center' : 'flex-start' }}>
                  {status !== 'none' ? (
                    <span
                      className={status === 'finished' ? 'terminal-dot-finished' : undefined}
                      style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: STATUS_COLORS[status],
                      flexShrink: 0,
                    }} title={`Status: ${status === 'finished' ? 'finished — needs attention' : status}`} />
                  ) : (
                    <FolderOpen size={14} style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0 }} />
                  )}
                  {!isCompact && isRenaming ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') cancelRename();
                      }}
                      onBlur={commitRename}
                      onClick={e => e.stopPropagation()}
                      spellCheck={false}
                      style={{
                        flex: 1,
                        fontSize: '13px',
                        fontFamily: 'var(--font-mono)',
                        padding: '2px 6px',
                        background: 'var(--bg-surface)',
                        border: '1px solid var(--accent)',
                        borderRadius: 4,
                        color: 'var(--text-primary)',
                        outline: 'none',
                        minWidth: 0,
                      }}
                    />
                  ) : !isCompact && (
                    <span style={{
                      flex: 1,
                      fontSize: '13px',
                      fontWeight: isActive ? 500 : 400,
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {project.name}
                    </span>
                  )}
                  {!isCompact && renderHostReachabilityBadges({ hostName, isHostUnreachable, lastError })}
                </div>

                {!isCompact && !isRenaming && (
                  <div className="project-inline-actions">
                    <button
                      onClick={(e) => copyProjectPath(e, project)}
                      className="project-action-btn"
                      title="Copy path"
                      aria-label={`Copy path for ${project.name}`}
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onMarkWaiting(project.name); }}
                      className="project-action-btn"
                      title="Move to Waiting"
                      aria-label={`Move ${project.name} to Waiting`}
                    >
                      <Hourglass size={14} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onShelve(project.name); }}
                      className="project-action-btn"
                      title="Shelve project"
                      aria-label={`Shelve ${project.name}`}
                    >
                      <Archive size={14} />
                    </button>
                    {renderProjectMenu(project, `active:${project.name}`, [
                      {
                        label: 'Browse files',
                        icon: <FolderSearch size={13} />,
                        onClick: () => { onBrowseFiles(project); setOpenProjectMenu(null); },
                      },
                      {
                        label: 'Rename project',
                        icon: <Pencil size={13} />,
                        onClick: (e) => startRename(e, project),
                      },
                      {
                        label: mutedProjects.includes(project.name) ? 'Unmute notifications' : 'Mute notifications',
                        icon: mutedProjects.includes(project.name) ? <BellOff size={13} /> : <Bell size={13} />,
                        onClick: (e) => toggleMute(e, project.name),
                      },
                      removeMenuItem(project),
                    ])}
                  </div>
                )}

                {/* Per-session details */}
                {!isCompact && projSessions.length > 0 && projSessions.map(session => {
                  const termStatus = getDisplayTerminalStatus(session, finishedSessionIds);
                  const visualStatus = getVisualTerminalStatus(session, finishedSessionIds, mutedStatusSessionIds);
                  const isStatusMuted = mutedStatusSessionIds.has(session.sessionId);
                  const timeSince = formatTimeSince(session.lastOutputAt);
                  const dotColor = visualStatus === 'busy'
                    ? 'var(--accent)'
                    : visualStatus === 'finished'
                    ? 'var(--warning)'
                    : visualStatus === 'dead'
                    ? 'var(--danger)'
                    : 'var(--text-muted)';
                  return (
                    <div key={session.sessionId} style={{ marginTop: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 16, minWidth: 0 }}>
                        <span
                          className={visualStatus === 'busy' ? 'terminal-dot-busy' : visualStatus === 'finished' ? 'terminal-dot-finished' : undefined}
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: dotColor,
                            flexShrink: 0,
                            display: 'inline-block',
                          }}
                          title={`Terminal ${session.sessionId}: ${termStatus === 'finished' ? 'finished — needs attention' : termStatus}${isStatusMuted ? ' (status colors muted)' : ''}`}
                        />
                        <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                          {session.sessionId}
                        </span>
                        <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                          · {timeSince}
                        </span>
                      </div>
                      {session.lastOutputLine && (
                        <div style={{
                          marginLeft: 28,
                          marginTop: 2,
                          fontSize: '11px',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-muted)',
                          opacity: 0.6,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: 'calc(100% - 28px)',
                        }}>
                          {session.lastOutputLine}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Waiting — still in the work area, but lower attention */}
        {waitingProjects.length > 0 && (
          <div style={{ flexShrink: 0 }}>
            <div style={{ height: 1, background: 'var(--border)' }} />
            {isCompact ? (
              <div style={{
                padding: '10px 0',
                display: 'flex',
                justifyContent: 'center',
              }}>
                <button
                  title={`Waiting projects (${waitingProjects.length})`}
                  aria-label={`Waiting projects (${waitingProjects.length})`}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    color: 'var(--text-muted)',
                    background: 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.72,
                  }}
                >
                  <Hourglass size={16} />
                </button>
              </div>
            ) : (
              <>
                <div style={{
                  padding: '8px 16px 4px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  color: 'var(--text-muted)',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  opacity: 0.82,
                }}>
                  <Hourglass size={12} />
                  <span>Waiting ({waitingProjects.length})</span>
                </div>

                <div style={{ maxHeight: 180, overflowY: 'auto', paddingBottom: 4 }}>
                  {waitingProjects.map(project => {
                    const isRenaming = renamingProject === project.name;
                    const projSessions = getProjectSessions(project);
                    const hostName = getProjectHost(project);
                    const reachability = getProjectReachability(project, projSessions);
                    const lastError = getProjectLastError(project, projSessions);
                    const isHostUnreachable = reachability === 'unreachable';
                    const { status } = getTruthfulProjectStatus(project, projSessions, finishedSessionIds, mutedStatusSessionIds);
                    const dotColor = status === 'none' ? 'var(--text-muted)' : STATUS_COLORS[status];
                    const waitingOpacity = isHostUnreachable ? 0.62 : 0.68;
                    const waitingHoverOpacity = isHostUnreachable ? '0.72' : '0.86';

                    return (
                      <div
                        key={project.name}
                        className={`waiting-row ${openProjectMenu === `waiting:${project.name}` ? 'project-menu-open' : ''}`}
                        tabIndex={0}
                        onClick={() => { if (!isRenaming) onActivateWaiting(project.name); }}
                        onKeyDown={e => { if (!isRenaming && e.key === 'Enter') onActivateWaiting(project.name); }}
                        title={isHostUnreachable && hostName
                          ? `${project.name} — Waiting — ${hostName} unreachable`
                          : `${project.name} — Waiting`}
                        style={{
                          padding: '6px 16px',
                          cursor: 'pointer',
                          borderLeft: '2px solid transparent',
                          transition: 'background 0.1s',
                          opacity: waitingOpacity,
                          filter: isHostUnreachable ? 'grayscale(0.45)' : undefined,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.opacity = waitingHoverOpacity; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.opacity = String(waitingOpacity); }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: dotColor,
                            flexShrink: 0,
                            opacity: status === 'active' ? 0.65 : 0.5,
                          }} title={`Status: ${status}`} />
                          {isRenaming ? (
                            <input
                              ref={renameInputRef}
                              value={renameValue}
                              onChange={e => setRenameValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') commitRename();
                                if (e.key === 'Escape') cancelRename();
                              }}
                              onBlur={commitRename}
                              onClick={e => e.stopPropagation()}
                              spellCheck={false}
                              style={{
                                flex: 1,
                                fontSize: '13px',
                                fontFamily: 'var(--font-mono)',
                                padding: '2px 6px',
                                background: 'var(--bg-surface)',
                                border: '1px solid var(--accent)',
                                borderRadius: 4,
                                color: 'var(--text-primary)',
                                outline: 'none',
                                minWidth: 0,
                              }}
                            />
                          ) : (
                            <span style={{
                              flex: 1,
                              fontSize: '13px',
                              color: 'var(--text-muted)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {project.name}
                            </span>
                          )}
                          {renderHostReachabilityBadges({ hostName, isHostUnreachable, lastError })}
                        </div>
                        {!isRenaming && (
                          <div className="project-inline-actions">
                          <button
                            onClick={(e) => { e.stopPropagation(); onActivateWaiting(project.name); }}
                            className="project-action-btn"
                            title="Activate project"
                            aria-label="Activate waiting project"
                          >
                            <Play size={13} />
                          </button>
                          <button
                            onClick={(e) => copyProjectPath(e, project)}
                            className="project-action-btn"
                            title="Copy path"
                            aria-label={`Copy path for ${project.name}`}
                          >
                            <Copy size={13} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); onShelve(project.name); }}
                            className="project-action-btn"
                            title="Shelve project"
                            aria-label={`Shelve ${project.name}`}
                          >
                            <Archive size={13} />
                          </button>
                          {renderProjectMenu(project, `waiting:${project.name}`, [
                            {
                              label: 'Rename project',
                              icon: <Pencil size={13} />,
                              onClick: (e) => startRename(e, project),
                            },
                            removeMenuItem(project),
                          ], 'up')}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Shelf — pinned to bottom, above footer */}
        {shelvedProjects.length > 0 && (() => {
          const searchActive = shelfSearch.trim() !== '';
          if (isCompact) {
            return (
              <div style={{ flexShrink: 0 }}>
                <div style={{ height: 1, background: 'var(--border)' }} />
                <div style={{
                  padding: '10px 0',
                  display: 'flex',
                  justifyContent: 'center',
                }}>
                  <button
                    onClick={toggleShelf}
                    title={`Shelved projects (${shelvedProjects.length})`}
                    aria-label={`Shelved projects (${shelvedProjects.length})`}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      color: shelfExpanded ? 'var(--accent)' : 'var(--text-muted)',
                      background: shelfExpanded ? 'var(--accent-dim)' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Archive size={16} />
                  </button>
                </div>
              </div>
            );
          }
          const showSearch = shelfExpanded && shelvedProjects.length > 5;
          const displayedProjects = searchActive
            ? shelvedProjects
                .filter(p => p.name.toLowerCase().includes(shelfSearch.toLowerCase()))
                .sort((a, b) => a.name.localeCompare(b.name))
            : shelvedProjects;
          return (
            <div style={{ flexShrink: 0 }}>
              <div style={{ height: 1, background: 'var(--border)' }} />
              <div
                role="button"
                aria-expanded={shelfExpanded}
                tabIndex={0}
                onClick={toggleShelf}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleShelf(); } }}
                style={{
                  padding: '8px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
              >
                {shelfExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>Shelved ({shelvedProjects.length})</span>
              </div>

              {shelfExpanded && (
                <div className="shelf-content" style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {showSearch && (
                    <div style={{ padding: '0 16px 4px', position: 'relative', display: 'flex', alignItems: 'center' }}>
                      <Search size={12} style={{ position: 'absolute', left: 24, color: 'var(--text-muted)', pointerEvents: 'none' }} />
                      <input
                        type="text"
                        value={shelfSearch}
                        onChange={e => setShelfSearch(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') setShelfSearch(''); }}
                        placeholder="Search shelved..."
                        aria-label="Search shelved projects"
                        style={{
                          width: '100%',
                          height: 28,
                          paddingLeft: 24,
                          paddingRight: shelfSearch ? 22 : 8,
                          fontSize: '12px',
                          fontFamily: 'var(--font-mono)',
                          background: 'var(--bg-surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          color: 'var(--text-primary)',
                          outline: 'none',
                          boxSizing: 'border-box',
                        }}
                      />
                      {shelfSearch && (
                        <button
                          onClick={() => setShelfSearch('')}
                          style={{ position: 'absolute', right: 20, padding: 2, color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
                          title="Clear search"
                        >
                          <X size={10} />
                        </button>
                      )}
                    </div>
                  )}

                  {searchActive && displayedProjects.length === 0 && (
                    <div style={{
                      padding: '8px 16px',
                      fontSize: '11px',
                      color: 'var(--text-muted)',
                      textAlign: 'center',
                      fontFamily: 'var(--font-mono)',
                    }}>
                      No matches
                    </div>
                  )}

                  {displayedProjects.map(project => {
                    const isRenaming = renamingProject === project.name;
                    const projSessions = getProjectSessions(project);
                    const hostName = getProjectHost(project);
                    const reachability = getProjectReachability(project, projSessions);
                    const lastError = getProjectLastError(project, projSessions);
                    const isHostUnreachable = reachability === 'unreachable';

                    return (
                      <div
                        key={project.name}
                        className={`shelf-row ${openProjectMenu === `shelved:${project.name}` ? 'project-menu-open' : ''}`}
                        tabIndex={0}
                        onClick={() => { if (!isRenaming) onUnshelve(project.name); }}
                        onKeyDown={e => { if (!isRenaming && e.key === 'Enter') onUnshelve(project.name); }}
                        title={isHostUnreachable && hostName
                          ? `${project.name} — Shelved — ${hostName} unreachable`
                          : project.name}
                        style={{
                          padding: '6px 16px',
                          cursor: isRenaming ? 'default' : 'pointer',
                          borderLeft: '2px solid transparent',
                          transition: 'background 0.1s',
                          opacity: isHostUnreachable ? 0.62 : undefined,
                          filter: isHostUnreachable ? 'grayscale(0.45)' : undefined,
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {isRenaming ? (
                            <input
                              ref={renameInputRef}
                              value={renameValue}
                              onChange={e => setRenameValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') commitRename();
                                if (e.key === 'Escape') cancelRename();
                              }}
                              onBlur={commitRename}
                              onClick={e => e.stopPropagation()}
                              spellCheck={false}
                              style={{
                                flex: 1,
                                fontSize: '13px',
                                fontFamily: 'var(--font-mono)',
                                padding: '2px 6px',
                                background: 'var(--bg-surface)',
                                border: '1px solid var(--accent)',
                                borderRadius: 4,
                                color: 'var(--text-primary)',
                                outline: 'none',
                                minWidth: 0,
                              }}
                            />
                          ) : (
                            <span style={{
                              flex: 1,
                              fontSize: '13px',
                              color: 'var(--text-muted)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {project.name}
                            </span>
                          )}
                          {renderHostReachabilityBadges({ hostName, isHostUnreachable, lastError })}
                        </div>
                        {!isRenaming && (
                          <div className="project-inline-actions">
                          <button
                            onClick={(e) => { e.stopPropagation(); onUnshelve(project.name); }}
                            className="project-action-btn"
                            title="Restore project"
                            aria-label="Restore project"
                          >
                            <ArchiveRestore size={14} />
                          </button>
                          <button
                            onClick={(e) => copyProjectPath(e, project)}
                            className="project-action-btn"
                            title="Copy path"
                            aria-label={`Copy path for ${project.name}`}
                          >
                            <Copy size={13} />
                          </button>
                          {renderProjectMenu(project, `shelved:${project.name}`, [
                            {
                              label: 'Rename project',
                              icon: <Pencil size={13} />,
                              onClick: (e) => startRename(e, project),
                            },
                            removeMenuItem(project),
                          ])}
                          </div>
                        )}
                      </div>
                    );
                  })}

                </div>
              )}
            </div>
          );
        })()}

        {/* Footer */}
        <div style={{
          padding: isCompact ? '10px 8px' : '10px 16px',
          borderTop: '1px solid var(--border)',
          fontSize: '11px',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          {!isCompact && (
            <span>{totalProjects} project{totalProjects !== 1 ? 's' : ''}</span>
          )}
          <div style={{ display: 'flex', gap: 4, margin: isCompact ? '0 auto' : undefined }}>
            <button
              onClick={onShowShortcuts}
              title="Keyboard shortcuts"
              style={{
                padding: 4,
                borderRadius: 4,
                color: 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Keyboard size={14} />
            </button>
            <button
              onClick={() => setShowSettings(true)}
              title="Settings"
              style={{
                padding: 4,
                borderRadius: 4,
                color: 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Settings size={14} />
            </button>
          </div>
        </div>
      </div>

      {showBrowser && (
        <DirectoryBrowser
          initialPath={defaultPath}
          onSelect={handleBrowseSelect}
          onCancel={() => setShowBrowser(false)}
        />
      )}

      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onSaved={handleSettingsSaved}
        />
      )}
    </>
  );
}
