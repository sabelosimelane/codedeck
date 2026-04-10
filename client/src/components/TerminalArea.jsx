import React, { useState, useEffect, useCallback } from 'react';
import Terminal from './Terminal';
import { Plus, X, SplitSquareHorizontal } from 'lucide-react';

let terminalCounter = 0;

export default function TerminalArea({ project }) {
  const [terminals, setTerminals] = useState([]);
  const [activeTerminal, setActiveTerminal] = useState(null);
  const [splitMode, setSplitMode] = useState(false);

  // Reset terminals when project changes
  useEffect(() => {
    terminalCounter = 0;
    const id = `${project.name}-${++terminalCounter}`;
    setTerminals([{ id, label: 'Terminal 1' }]);
    setActiveTerminal(id);
    setSplitMode(false);
  }, [project.name]);

  const addTerminal = useCallback(() => {
    const id = `${project.name}-${++terminalCounter}`;
    const label = `Terminal ${terminalCounter}`;
    setTerminals(prev => [...prev, { id, label }]);
    setActiveTerminal(id);
  }, [project.name]);

  const closeTerminal = useCallback(async (id) => {
    await fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setTerminals(prev => {
      const next = prev.filter(t => t.id !== id);
      if (activeTerminal === id && next.length > 0) {
        setActiveTerminal(next[next.length - 1].id);
      }
      if (next.length === 0) {
        // Always keep at least one
        const newId = `${project.name}-${++terminalCounter}`;
        setActiveTerminal(newId);
        return [{ id: newId, label: `Terminal ${terminalCounter}` }];
      }
      return next;
    });
  }, [activeTerminal, project.name]);

  const visibleTerminals = splitMode
    ? terminals.slice(-2) // Show last two in split mode
    : terminals.filter(t => t.id === activeTerminal);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Terminal tabs bar */}
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
          {terminals.map(t => {
            const isActive = t.id === activeTerminal;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTerminal(t.id)}
                style={{
                  padding: '4px 10px',
                  fontSize: '12px',
                  fontFamily: 'var(--font-mono)',
                  borderRadius: 4,
                  background: isActive ? 'var(--bg-active)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {t.label}
                {terminals.length > 1 && (
                  <span
                    onClick={(e) => { e.stopPropagation(); closeTerminal(t.id); }}
                    style={{ opacity: 0.5, display: 'flex' }}
                  >
                    <X size={10} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Actions */}
        <button
          onClick={() => setSplitMode(!splitMode)}
          title="Toggle split"
          style={{
            padding: 4,
            borderRadius: 4,
            color: splitMode ? 'var(--accent)' : 'var(--text-muted)',
          }}
        >
          <SplitSquareHorizontal size={14} />
        </button>
        <button
          onClick={addTerminal}
          title="New terminal"
          style={{ padding: 4, borderRadius: 4, color: 'var(--text-muted)' }}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Terminal panels */}
      <div style={{
        flex: 1,
        display: 'flex',
        minHeight: 0,
        gap: splitMode ? 1 : 0,
        background: splitMode ? 'var(--border)' : 'transparent',
      }}>
        {visibleTerminals.map(t => (
          <div key={t.id} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            <Terminal
              sessionId={t.id}
              cwd={project.path}
              isVisible={true}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
