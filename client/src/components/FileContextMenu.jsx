import React, { useEffect, useRef } from 'react';
import { Copy, FileText } from 'lucide-react';
import { useToast } from './ToastContext';

export default function FileContextMenu({ x, y, path, root, onClose }) {
  const ref = useRef(null);
  const { showToast } = useToast();

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const relativePath = path === root
    ? '.'
    : path.startsWith(root + '/') ? path.slice(root.length + 1) : path;

  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast({ type: 'success', message: 'Path copied' });
    } catch {
      showToast({ type: 'error', message: 'Failed to copy' });
    }
    onClose();
  };

  return (
    <div ref={ref} style={{
      position: 'fixed',
      left: x,
      top: y,
      zIndex: 2000,
      background: 'var(--bg-sidebar)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      padding: '4px 0',
      minWidth: 180,
    }}>
      <button
        type="button"
        onClick={() => handleCopy(relativePath)}
        style={menuItemStyle}
        title="Copy relative path"
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <Copy size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        Copy relative path
      </button>
      <button
        type="button"
        onClick={() => handleCopy(path)}
        style={menuItemStyle}
        title="Copy path"
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <FileText size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        Copy path
      </button>
    </div>
  );
}

const menuItemStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 12px',
  border: 'none',
  background: 'transparent',
  color: 'var(--text-secondary)',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  textAlign: 'left',
};
