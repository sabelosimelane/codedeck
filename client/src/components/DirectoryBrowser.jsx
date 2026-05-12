import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Folder,
  File,
  ChevronLeft,
  Home,
  Check,
  X,
  ArrowUp,
  HardDrive,
  FolderOpen,
} from 'lucide-react';

export default function DirectoryBrowser({ onSelect, onCancel, initialPath }) {
  const [current, setCurrent] = useState('');
  const [parent, setParent] = useState(null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pathInput, setPathInput] = useState('');
  const [hoveredEntry, setHoveredEntry] = useState(null);
  const debounceRef = useRef(null);

  // Fetch entries from backend — never touches pathInput
  const fetchEntries = useCallback(async (dir, filter) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dir) params.set('path', dir);
      if (filter) params.set('filter', filter);
      const qs = params.toString();
      const url = qs ? `/api/browse?${qs}` : '/api/browse';
      const res = await fetch(url);
      const text = await res.text();
      if (!text) return;
      const data = JSON.parse(text);
      if (!res.ok) throw new Error(data.error || 'Failed to browse');
      setCurrent(data.current);
      setParent(data.parent);
      setEntries(data.entries);
      return data;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Full navigation — updates pathInput (used by buttons, Enter, init)
  const browse = useCallback(async (dir) => {
    const data = await fetchEntries(dir);
    if (data) setPathInput(data.current);
  }, [fetchEntries]);

  useEffect(() => {
    browse(initialPath || undefined);
  }, [browse, initialPath]);

  // Debounced handler — reacts to typing, never overwrites the input
  const handlePathInputChange = (value) => {
    setPathInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const lastSlash = value.lastIndexOf('/');
      if (lastSlash === -1) return;
      const dir = value.slice(0, lastSlash) || '/';
      const filter = value.slice(lastSlash + 1);
      fetchEntries(dir, filter);
    }, 250);
  };

  const handlePathSubmit = (e) => {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (pathInput.trim()) browse(pathInput.trim());
  };

  const dirs = entries.filter(e => e.type === 'dir');
  const files = entries.filter(e => e.type === 'file');

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <HardDrive size={18} style={{ color: 'var(--accent)' }} />
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              fontSize: '14px',
              letterSpacing: '0.3px',
            }}>
              Browse Filesystem
            </span>
          </div>
          <button onClick={onCancel} style={iconBtnStyle} title="Cancel">
            <X size={16} />
          </button>
        </div>

        {/* Path bar */}
        <div style={pathBarStyle}>
          <button
            onClick={() => parent && browse(parent)}
            disabled={!parent}
            style={{
              ...iconBtnStyle,
              opacity: parent ? 1 : 0.3,
              cursor: parent ? 'pointer' : 'default',
            }}
            title="Go up"
          >
            <ArrowUp size={14} />
          </button>
          <button
            onClick={() => browse()}
            style={iconBtnStyle}
            title="Go home"
          >
            <Home size={14} />
          </button>
          <form onSubmit={handlePathSubmit} style={{ flex: 1, display: 'flex' }}>
            <input
              value={pathInput}
              onChange={e => handlePathInputChange(e.target.value)}
              style={pathInputStyle}
              spellCheck={false}
            />
          </form>
        </div>

        {/* Current selection indicator */}
        <div style={selectionBarStyle}>
          <FolderOpen size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span style={{
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {current}
          </span>
        </div>

        {/* Content area */}
        <div style={contentStyle}>
          {loading && (
            <div style={emptyStyle}>
              <div style={spinnerStyle} />
              <span>Loading…</span>
            </div>
          )}

          {error && (
            <div style={{ ...emptyStyle, color: 'var(--danger)' }}>
              {error}
            </div>
          )}

          {!loading && !error && entries.length === 0 && (
            <div style={emptyStyle}>No matches</div>
          )}

          {!loading && !error && (
            <>
              {/* Directories */}
              {dirs.length > 0 && (
                <div style={sectionStyle}>
                  <div style={sectionHeaderStyle}>
                    Folders ({dirs.length})
                  </div>
                  {dirs.map(entry => (
                    <div
                      key={entry.path}
                      onDoubleClick={() => browse(entry.path)}
                      onClick={() => {
                        setCurrent(entry.path);
                        setPathInput(entry.path);
                      }}
                      onMouseEnter={() => setHoveredEntry(entry.path)}
                      onMouseLeave={() => setHoveredEntry(null)}
                      style={{
                        ...entryStyle,
                        background: current === entry.path
                          ? 'var(--accent-dim)'
                          : hoveredEntry === entry.path
                            ? 'var(--bg-hover)'
                            : 'transparent',
                        borderLeft: current === entry.path
                          ? '2px solid var(--accent)'
                          : '2px solid transparent',
                      }}
                    >
                      <Folder size={14} style={{
                        color: current === entry.path ? 'var(--accent)' : '#fbbf24',
                        flexShrink: 0,
                      }} />
                      <span style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: current === entry.path
                          ? 'var(--text-primary)'
                          : 'var(--text-secondary)',
                        fontWeight: current === entry.path ? 500 : 400,
                      }}>
                        {entry.name}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Files (read-only, dimmed) */}
              {files.length > 0 && (
                <div style={sectionStyle}>
                  <div style={sectionHeaderStyle}>
                    Files ({files.length})
                  </div>
                  {files.map(entry => (
                    <div
                      key={entry.path}
                      style={{
                        ...entryStyle,
                        opacity: 0.4,
                        cursor: 'default',
                      }}
                    >
                      <File size={14} style={{
                        color: 'var(--text-muted)',
                        flexShrink: 0,
                      }} />
                      <span style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {entry.name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer with actions */}
        <div style={footerStyle}>
          <span style={{
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
          }}>
            Double-click to navigate • Select a folder
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onCancel} style={cancelBtnStyle} title="Cancel folder selection">
              Cancel
            </button>
            <button
              onClick={() => onSelect(current)}
              style={selectBtnStyle}
              title="Select folder"
            >
              <Check size={14} />
              Select Folder
            </button>
          </div>
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
  width: 580,
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
  gap: 6,
  padding: '10px 14px',
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg-base)',
};

const pathInputStyle = {
  flex: 1,
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '5px 10px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-primary)',
  outline: 'none',
};

const selectionBarStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 16px',
  background: 'var(--accent-dim)',
  borderBottom: '1px solid var(--border)',
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

const sectionStyle = {
  padding: '4px 0',
};

const sectionHeaderStyle = {
  padding: '8px 16px 4px',
  fontSize: '10px',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase',
  letterSpacing: '0.8px',
  color: 'var(--text-muted)',
  userSelect: 'none',
};

const entryStyle = {
  padding: '6px 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  fontSize: '13px',
  fontFamily: 'var(--font-mono)',
  transition: 'background 0.1s',
  userSelect: 'none',
};

const footerStyle = {
  padding: '12px 16px',
  borderTop: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
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

const cancelBtnStyle = {
  padding: '6px 16px',
  borderRadius: 6,
  fontSize: '12px',
  fontWeight: 500,
  color: 'var(--text-secondary)',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
};

const selectBtnStyle = {
  padding: '6px 16px',
  borderRadius: 6,
  fontSize: '12px',
  fontWeight: 600,
  color: '#000',
  background: 'var(--accent)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const spinnerStyle = {
  width: 20,
  height: 20,
  border: '2px solid var(--border)',
  borderTopColor: 'var(--accent)',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};
