import React, { useEffect, useState } from 'react';
import { ChevronRight, ChevronDown, File, Folder } from 'lucide-react';

function TreeNode({ node, onOpenFile, depth = 0 }) {
  const [expanded, setExpanded] = useState(depth < 1);

  if (node.type === 'file') {
    return (
      <div
        onClick={() => onOpenFile(node.path)}
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
        title={`Open: ${node.path}`}
      >
        <File size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
      </div>
    );
  }

  return (
    <div>
      <div
        onClick={() => setExpanded(!expanded)}
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
        <TreeNode key={child.path} node={child} onOpenFile={onOpenFile} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function FileTree({ root, onOpenFile }) {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/files?root=${encodeURIComponent(root)}`)
      .then(r => r.json())
      .then(data => { setTree(data); setLoading(false); })
      .catch(() => { setTree([]); setLoading(false); });
  }, [root]);

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
        fontSize: '10px',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.8px',
      }}>
        Files
      </div>
      {loading ? (
        <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>
      ) : (
        tree.map(node => <TreeNode key={node.path} node={node} onOpenFile={onOpenFile} />)
      )}
    </div>
  );
}
