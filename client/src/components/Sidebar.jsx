import React, { useState, useRef, useEffect } from 'react';
import { FolderOpen, Plus, Trash2, FolderTree, Pencil, Settings, FolderSearch, Archive, ArchiveRestore, ChevronRight, ChevronDown, Search, X, Bell, BellOff, PanelLeftClose, PanelLeftOpen, Keyboard } from 'lucide-react';
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
  getAggregateTerminalStatus,
  getTerminalCompletionNotification,
  getTerminalStatus,
  resolveTerminalCompletionNotificationMs,
} from '../utils/terminalActivity';

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

function getProjectStatus(sessions) {
  if (!sessions || sessions.length === 0) return { status: 'none' };
  if (!sessions.some(session => session.alive)) return { status: 'dead' };

  const status = getAggregateTerminalStatus(sessions);
  return {
    status: status === 'busy' ? 'active' : status,
  };
}

const STATUS_COLORS = {
  active: 'var(--accent)',
  idle: 'var(--text-muted)',
  dead: 'var(--danger)',
};

export default function Sidebar({ activeProjects, shelvedProjects, activeProject, isCompact, onSelect, onAdd, onRemove, onRename, onShelve, onUnshelve, onToggleCompact, onToggleFiles, showFileTree, sessionStatus, onBrowseFiles, onShowShortcuts }) {
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

    fetch('/api/config/terminalFinishCooldownSeconds')
      .then(async res => {
        if (res.status === 404) return { value: null };
        if (!res.ok) throw new Error('Failed to load notification cooldown');
        return res.json();
      })
      .then(data => {
        if (cancelled) return;
        notificationCooldownMsRef.current = resolveTerminalCompletionNotificationMs(data.value);
      })
      .catch(() => {});

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
    setMutedProjects(prev => {
      const next = prev.includes(projectName)
        ? prev.filter(n => n !== projectName)
        : [...prev, projectName];
      localStorage.setItem('codedeck-muted-projects', JSON.stringify(next));
      return next;
    });
  };

  const getProjectSessions = (project) => {
    if (!sessionStatus || sessionStatus.length === 0) return [];
    const prefix = `${project.name}-`;
    return sessionStatus.filter(s =>
      s.sessionId.startsWith(prefix) || s.cwd === project.path
    );
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

  const handleBrowseSelect = (selectedPath) => {
    const segments = selectedPath.replace(/\/+$/, '').split('/');
    const projectName = segments[segments.length - 1] || 'project';
    onAdd(projectName, selectedPath);
    setShowBrowser(false);
  };

  const startRename = (e, project) => {
    e.stopPropagation();
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

  const totalProjects = activeProjects.length + shelvedProjects.length;
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
          {activeProjects.length === 0 && shelvedProjects.length === 0 && (
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
            const { status } = getProjectStatus(projSessions);
            return (
              <div
                key={project.name}
                onClick={() => { if (!isRenaming) onSelect(project); }}
                className="project-row"
                title={project.name}
                style={{
                  padding: isCompact ? '10px 12px' : '8px 16px',
                  cursor: isRenaming ? 'default' : 'pointer',
                  background: isActive ? 'var(--bg-active)' : 'transparent',
                  borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                {/* Row 1: status dot + project name (full width) */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: isCompact ? 'center' : 'flex-start' }}>
                  {status !== 'none' ? (
                    <span style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: STATUS_COLORS[status],
                      flexShrink: 0,
                    }} title={`Status: ${status}`} />
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
                </div>

                {/* Row 2: action buttons — revealed on hover */}
                {!isCompact && (
                  <div className="project-actions" style={{
                    display: 'flex',
                    gap: 2,
                    marginLeft: 16,
                  }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); onBrowseFiles(project); }}
                      className="project-action-btn"
                      title="Browse files"
                    >
                      <FolderSearch size={14} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); onShelve(project.name); }}
                      className="project-action-btn"
                      title="Shelve project"
                      aria-label="Shelve project"
                    >
                      <Archive size={14} />
                    </button>
                    <button
                      onClick={(e) => startRename(e, project)}
                      className="project-action-btn"
                      title="Rename project"
                    >
                      <Pencil size={14} />
                    </button>
                    {confirmDelete === project.name ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); onRemove(project.name); setConfirmDelete(null); }}
                        className="project-action-btn"
                        title="Click to confirm removal"
                        style={{ fontSize: '11px', color: 'var(--danger)', fontFamily: 'var(--font-mono)', width: 'auto', padding: '2px 6px' }}
                      >
                        Remove?
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(project.name); }}
                        className="project-action-btn danger"
                        title="Remove project"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                    <button
                      onClick={(e) => toggleMute(e, project.name)}
                      className="project-action-btn"
                      title={mutedProjects.includes(project.name) ? 'Unmute notifications' : 'Mute notifications'}
                      aria-label={mutedProjects.includes(project.name) ? `Unmute notifications for ${project.name}` : `Mute notifications for ${project.name}`}
                    >
                      {mutedProjects.includes(project.name) ? <BellOff size={14} /> : <Bell size={14} />}
                    </button>
                  </div>
                )}

                {/* Per-session details */}
                {!isCompact && projSessions.length > 0 && projSessions.map(session => {
                  const termStatus = getTerminalStatus(session);
                  const timeSince = formatTimeSince(session.lastOutputAt);
                  const dotColor = termStatus === 'busy'
                    ? 'var(--accent)'
                    : termStatus === 'dead'
                    ? 'var(--danger)'
                    : 'var(--text-muted)';
                  return (
                    <div key={session.sessionId} style={{ marginTop: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 16, minWidth: 0 }}>
                        <span
                          className={termStatus === 'busy' ? 'terminal-dot-busy' : undefined}
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: dotColor,
                            flexShrink: 0,
                            display: 'inline-block',
                          }}
                          title={`Terminal ${session.sessionId}: ${termStatus}`}
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

                  {displayedProjects.map(project => (
                    <div
                      key={project.name}
                      className="shelf-row"
                      tabIndex={0}
                      onClick={() => onUnshelve(project.name)}
                      onKeyDown={e => { if (e.key === 'Enter') onUnshelve(project.name); }}
                      style={{
                        padding: '6px 16px',
                        cursor: 'pointer',
                        borderLeft: '2px solid transparent',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                        <button
                          onClick={(e) => { e.stopPropagation(); onUnshelve(project.name); }}
                          className="project-action-btn"
                          title="Restore project"
                          aria-label="Restore project"
                        >
                          <ArchiveRestore size={14} />
                        </button>
                        {confirmDelete === project.name ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); onRemove(project.name); setConfirmDelete(null); }}
                            className="project-action-btn"
                            title="Click to confirm removal"
                            style={{ fontSize: '11px', color: 'var(--danger)', fontFamily: 'var(--font-mono)', width: 'auto', padding: '2px 6px' }}
                          >
                            Remove?
                          </button>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDelete(project.name); }}
                            className="project-action-btn danger"
                            title="Remove project"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

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
