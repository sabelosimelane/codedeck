import React, { useState } from 'react';
import { FolderOpen, Plus, Trash2, FolderTree, Pencil } from 'lucide-react';
import DirectoryBrowser from './DirectoryBrowser';

export default function Sidebar({ projects, activeProject, onSelect, onAdd, onRemove, onEdit, onToggleFiles, showFileTree }) {
  const [showBrowser, setShowBrowser] = useState(false);
  const [editingProject, setEditingProject] = useState(null);

  const handleBrowseSelect = (selectedPath) => {
    const segments = selectedPath.replace(/\/+$/, '').split('/');
    const projectName = segments[segments.length - 1] || 'project';
    onAdd(projectName, selectedPath);
    setShowBrowser(false);
  };

  const handleEditClick = (e, project) => {
    e.stopPropagation();
    setEditingProject(project);
  };

  const handleEditSelect = (selectedPath) => {
    if (editingProject) {
      const segments = selectedPath.replace(/\/+$/, '').split('/');
      const newName = segments[segments.length - 1] || editingProject.name;
      onEdit(editingProject.name, newName, selectedPath);
    }
    setEditingProject(null);
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
              onClick={() => setShowBrowser(true)}
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
            return (
              <div
                key={project.name}
                onClick={() => onSelect(project)}
                style={{
                  padding: '8px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  background: isActive ? 'var(--bg-active)' : 'transparent',
                  borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                <FolderOpen size={14} style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0 }} />
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
                <button
                  onClick={(e) => handleEditClick(e, project)}
                  style={{
                    padding: 2,
                    color: 'var(--text-muted)',
                    opacity: 0.5,
                    borderRadius: 3,
                  }}
                  title="Edit project path"
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
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--border)',
          fontSize: '11px',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
        }}>
          {projects.length} project{projects.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Directory Browser Modal — Add project */}
      {showBrowser && (
        <DirectoryBrowser
          onSelect={handleBrowseSelect}
          onCancel={() => setShowBrowser(false)}
        />
      )}

      {/* Directory Browser Modal — Edit project */}
      {editingProject && (
        <DirectoryBrowser
          initialPath={editingProject.path}
          onSelect={handleEditSelect}
          onCancel={() => setEditingProject(null)}
        />
      )}
    </>
  );
}
