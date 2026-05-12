import React, { useEffect, useState, useRef } from 'react';
import { ChevronRight, ChevronDown, ExternalLink, File, Folder, FolderOpen, X } from 'lucide-react';
import { useToast } from './ToastContext';
import FileContextMenu from './FileContextMenu';

function collectDirectoryPaths(nodes) {
  const paths = [];

  for (const node of nodes) {
    if (node.type !== 'dir') continue;
    paths.push(node.path);
    if (node.children?.length) {
      paths.push(...collectDirectoryPaths(node.children));
    }
  }

  return paths;
}

function TreeNode({ node, expandedPaths, onOpenFile, onPreviewFile, onToggleDir, onContextMenu, depth = 0 }) {
  const expanded = expandedPaths.has(node.path);

  const handleContextMenu = (e) => {
    e.preventDefault();
    onContextMenu({ x: e.clientX, y: e.clientY, path: node.path });
  };

  if (node.type === 'file') {
    return (
      <div
        className="file-tree-file-row"
        onClick={() => onPreviewFile(node.path)}
        onContextMenu={handleContextMenu}
        style={{
          padding: '3px 8px 3px ' + (16 + depth * 16) + 'px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          fontSize: '12px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-secondary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        title={`Preview: ${node.path}`}
      >
        <File size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
        <button
          type="button"
          className="file-tree-row-action"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFile(node.path);
          }}
          title="Open in editor"
          style={rowActionBtnStyle}
        >
          <ExternalLink size={12} />
        </button>
      </div>
    );
  }

  return (
    <div>
      <div
        onClick={() => onToggleDir(node.path)}
        onContextMenu={handleContextMenu}
        style={{
          padding: '3px 8px 3px ' + (8 + depth * 16) + 'px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          cursor: 'pointer',
          fontSize: '12px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
          fontWeight: 500,
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Folder size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span>{node.name}</span>
      </div>
      {expanded && node.children?.map(child => (
        <TreeNode
          key={child.path}
          node={child}
          expandedPaths={expandedPaths}
          onOpenFile={onOpenFile}
          onPreviewFile={onPreviewFile}
          onToggleDir={onToggleDir}
          onContextMenu={onContextMenu}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export default function FileBrowserPanel({ project, onPreviewFile, onClose }) {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedPaths, setExpandedPaths] = useState(() => new Set());
  const [contextMenu, setContextMenu] = useState(null);
  const panelRef = useRef(null);
  const { showToast } = useToast();

  useEffect(() => {
    setLoading(true);
    fetch(`/api/files?root=${encodeURIComponent(project.path)}`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load files');
        return r.json();
      })
      .then(data => {
        setTree(data);
        setExpandedPaths(new Set());
        setLoading(false);
      })
      .catch(() => {
        showToast({ type: 'error', message: 'Failed to load file tree' });
        setLoading(false);
      });
  }, [project.path, showToast]);

  // Escape key dismisses
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Click outside panel dismisses
  const handleOverlayClick = (e) => {
    if (panelRef.current && !panelRef.current.contains(e.target)) {
      onClose();
    }
  };

  const handleFileClick = async (filePath) => {
    try {
      const res = await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: err.error || 'Failed to open file' });
      }
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const handleToggleDir = (dirPath) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const handleExpandAll = () => {
    setExpandedPaths(new Set(collectDirectoryPaths(tree)));
  };

  const handleFoldAll = () => {
    setExpandedPaths(new Set());
  };

  return (
    <div style={overlayStyle} onClick={handleOverlayClick}>
      <div ref={panelRef} style={modalStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FolderOpen size={18} style={{ color: 'var(--accent)' }} />
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              fontSize: '14px',
              letterSpacing: '0.3px',
            }}>
              {project.name}
            </span>
          </div>
          <button onClick={onClose} style={iconBtnStyle} title="Close">
            <X size={16} />
          </button>
        </div>

        {/* Path bar */}
        <div style={pathBarStyle}>
          <FolderOpen size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {project.path}
          </span>
          <div style={treeControlsStyle}>
            <button type="button" style={treeControlBtnStyle} onClick={handleExpandAll} title="Expand all folders">
              Expand all
            </button>
            <button type="button" style={treeControlBtnStyle} onClick={handleFoldAll} title="Fold all folders">
              Fold all
            </button>
          </div>
        </div>

        {/* Tree content */}
        <div style={contentStyle}>
          {loading ? (
            <div style={emptyStyle}>
              <div style={spinnerStyle} />
              <span>Loading...</span>
            </div>
          ) : tree.length === 0 ? (
            <div style={emptyStyle}>No files found</div>
          ) : (
            tree.map(node => (
              <TreeNode
                key={node.path}
                node={node}
                expandedPaths={expandedPaths}
                onOpenFile={handleFileClick}
                onPreviewFile={onPreviewFile}
                onToggleDir={handleToggleDir}
                onContextMenu={setContextMenu}
              />
            ))
          )}
        </div>

        {contextMenu && (
          <FileContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            path={contextMenu.path}
            root={project.path}
            onClose={() => setContextMenu(null)}
          />
        )}

        {/* Footer */}
        <div style={footerStyle}>
          <span style={{
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
          }}>
            Click a file to preview in browser. Use the arrow button to open in editor.
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.65)',
  backdropFilter: 'blur(4px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  animation: 'fadeIn 0.15s ease-out',
};

const modalStyle = {
  width: 400,
  maxWidth: '90vw',
  maxHeight: '80vh',
  background: 'var(--bg-sidebar)',
  borderRadius: 12,
  border: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxShadow: '0 24px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(110, 231, 183, 0.05)',
  animation: 'slideUp 0.2s ease-out',
};

const headerStyle = {
  padding: '16px 20px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: '1px solid var(--border)',
};

const pathBarStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 16px',
  background: 'var(--accent-dim)',
  borderBottom: '1px solid var(--border)',
};

const treeControlsStyle = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const contentStyle = {
  flex: 1,
  overflowY: 'auto',
  minHeight: 200,
  maxHeight: 400,
};

const emptyStyle = {
  padding: '40px 20px',
  textAlign: 'center',
  color: 'var(--text-muted)',
  fontSize: '13px',
  fontFamily: 'var(--font-mono)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
};

const footerStyle = {
  padding: '10px 16px',
  borderTop: '1px solid var(--border)',
  background: 'var(--bg-sidebar)',
};

const iconBtnStyle = {
  padding: 6,
  borderRadius: 6,
  color: 'var(--text-muted)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'color 0.1s, background 0.1s',
};

const treeControlBtnStyle = {
  border: '1px solid var(--border)',
  background: 'rgba(0, 0, 0, 0.12)',
  color: 'var(--text-secondary)',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const spinnerStyle = {
  width: 20,
  height: 20,
  border: '2px solid var(--border)',
  borderTopColor: 'var(--accent)',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};

const rowActionBtnStyle = {
  width: 24,
  height: 24,
  borderRadius: 7,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-muted)',
  background: 'rgba(255, 255, 255, 0.03)',
  border: '1px solid rgba(255, 255, 255, 0.04)',
};
