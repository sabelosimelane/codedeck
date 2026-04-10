import React, { useState, useRef, useEffect } from 'react';
import { FolderOpen, Plus, Trash2, FolderTree, Pencil, Settings, FolderSearch } from 'lucide-react';
import DirectoryBrowser from './DirectoryBrowser';
import SettingsPanel from './SettingsPanel';
import { useToast } from './ToastContext';

function formatElapsed(timestamp) {
  if (!timestamp || isNaN(timestamp)) return null;
  const mins = Math.floor((Date.now() - timestamp) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function getProjectStatus(sessions) {
  if (!sessions || sessions.length === 0) return { status: 'none', count: 0, elapsed: null };
  const alive = sessions.filter(s => s.alive);
  const count = alive.length;
  if (count === 0) return { status: 'dead', count: 0, elapsed: null };

  const now = Date.now();
  const anyActive = alive.some(s => now - new Date(s.lastOutputAt).getTime() < 10000);
  const earliest = alive.reduce((min, s) => {
    const t = new Date(s.startedAt).getTime();
    return t < min ? t : min;
  }, Infinity);

  return {
    status: anyActive ? 'active' : 'idle',
    count,
    elapsed: formatElapsed(earliest),
  };
}

const STATUS_COLORS = {
  active: 'var(--accent)',
  idle: 'var(--text-muted)',
  dead: 'var(--danger)',
};

export default function Sidebar({ projects, activeProject, onSelect, onAdd, onRemove, onRename, onToggleFiles, showFileTree, sessionStatus, onBrowseFiles }) {
  const [showBrowser, setShowBrowser] = useState(false);
  const [defaultPath, setDefaultPath] = useState(null);
  const [renamingProject, setRenamingProject] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const renameInputRef = useRef(null);
  const { showToast } = useToast();

  // Map sessions to projects by sessionId prefix or cwd match
  const getProjectSessions = (project) => {
    if (!sessionStatus || sessionStatus.length === 0) return [];
    const prefix = `${project.name}-`;
    return sessionStatus.filter(s =>
      s.sessionId.startsWith(prefix) || s.cwd === project.path
    );
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

  return (
    <>
      <div style={{
        width: 220,
        minWidth: 220,
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        userSelect: 'none',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 16px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 600,
            fontSize: '13px',
            letterSpacing: '0.5px',
            color: 'var(--accent)',
          }}>
            CODEDECK
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={onToggleFiles}
              title="Toggle file tree"
              style={{
                padding: 4,
                borderRadius: 4,
                color: showFileTree ? 'var(--accent)' : 'var(--text-muted)',
                background: showFileTree ? 'var(--accent-dim)' : 'transparent',
              }}
            >
              <FolderTree size={16} />
            </button>
            <button
              onClick={handleAddClick}
              title="Add project"
              style={{
                padding: 4,
                borderRadius: 4,
                color: 'var(--text-muted)',
              }}
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* Project list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {projects.length === 0 && (
            <div style={{
              padding: '24px 16px',
              color: 'var(--text-muted)',
              fontSize: '12px',
              textAlign: 'center',
              fontFamily: 'var(--font-mono)',
            }}>
              No projects yet.
              <br />Click + to add one.
            </div>
          )}
          {projects.map(project => {
            const isActive = activeProject?.name === project.name;
            const isRenaming = renamingProject === project.name;
            const projSessions = getProjectSessions(project);
            const { status, count, elapsed } = getProjectStatus(projSessions);
            return (
              <div
                key={project.name}
                onClick={() => { if (!isRenaming) onSelect(project); }}
                style={{
                  padding: '8px 16px',
                  cursor: isRenaming ? 'default' : 'pointer',
                  background: isActive ? 'var(--bg-active)' : 'transparent',
                  borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                      fontWeight: isActive ? 500 : 400,
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {project.name}
                    </span>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); onBrowseFiles(project); }}
                    style={{
                      padding: 2,
                      color: 'var(--text-muted)',
                      opacity: 0.5,
                      borderRadius: 3,
                    }}
                    title="Browse files"
                  >
                    <FolderSearch size={12} />
                  </button>
                  <button
                    onClick={(e) => startRename(e, project)}
                    style={{
                      padding: 2,
                      color: 'var(--text-muted)',
                      opacity: 0.5,
                      borderRadius: 3,
                    }}
                    title="Rename project"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRemove(project.name); }}
                    style={{
                      padding: 2,
                      color: 'var(--text-muted)',
                      opacity: 0.5,
                      borderRadius: 3,
                    }}
                    title="Remove project"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                {count > 0 && (
                  <div style={{
                    marginTop: 3,
                    marginLeft: 22,
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)',
                  }}>
                    {count} terminal{count !== 1 ? 's' : ''}{elapsed ? ` · ${elapsed}` : ''}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--border)',
          fontSize: '11px',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{projects.length} project{projects.length !== 1 ? 's' : ''}</span>
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

      {/* Directory Browser Modal — Add project */}
      {showBrowser && (
        <DirectoryBrowser
          initialPath={defaultPath}
          onSelect={handleBrowseSelect}
          onCancel={() => setShowBrowser(false)}
        />
      )}

      {/* Settings Panel */}
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}
