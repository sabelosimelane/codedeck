import React, { useEffect, useState } from 'react';
import { ChevronRight, ChevronDown, ExternalLink, File, Folder } from 'lucide-react';
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

export default function FileTree({ root, onOpenFile, onPreviewFile }) {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedPaths, setExpandedPaths] = useState(() => new Set());
  const [contextMenu, setContextMenu] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/files?root=${encodeURIComponent(root)}`)
      .then(r => r.json())
      .then(data => {
        setTree(data);
        setExpandedPaths(new Set());
        setLoading(false);
      })
      .catch(() => { setTree([]); setLoading(false); });
  }, [root]);

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
    <div style={{
      width: 240,
      minWidth: 240,
      background: 'var(--bg-sidebar)',
      borderRight: '1px solid var(--border)',
      overflowY: 'auto',
      overflowX: 'hidden',
    }}>
      <div style={{
        padding: '12px 12px 8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
      }}>
        <div style={{
          fontSize: '10px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.8px',
        }}>
          Files
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={treeControlBtnStyle} onClick={handleExpandAll}>
            Expand
          </button>
          <button type="button" style={treeControlBtnStyle} onClick={handleFoldAll}>
            Fold
          </button>
        </div>
      </div>
      {loading ? (
        <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>
      ) : (
        tree.map(node => (
          <TreeNode
            key={node.path}
            node={node}
            expandedPaths={expandedPaths}
            onOpenFile={onOpenFile}
            onPreviewFile={onPreviewFile}
            onToggleDir={handleToggleDir}
            onContextMenu={setContextMenu}
          />
        ))
      )}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={contextMenu.path}
          root={root}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

const treeControlBtnStyle = {
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  borderRadius: 6,
  padding: '2px 6px',
  fontSize: '10px',
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
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
