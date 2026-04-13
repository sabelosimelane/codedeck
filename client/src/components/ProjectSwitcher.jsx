import React, { useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';

export default function ProjectSwitcher({ projects, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const filtered = projects.filter(p =>
    p.name.toLowerCase().includes(query.toLowerCase())
  );

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  // Scroll highlighted item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[highlightIndex];
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlightIndex]) {
        onSelect(filtered[highlightIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  // Truncate path for display: ~/... suffix
  const displayPath = (path) => {
    const home = path.replace(/^\/Users\/[^/]+/, '~');
    if (home.length <= 40) return home;
    return '...' + home.slice(-37);
  };

  return (
    <div className="project-switcher-overlay" onClick={handleOverlayClick} onKeyDown={handleKeyDown}>
      <div className="project-switcher-modal">
        <div className="project-switcher-input-wrap">
          <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search projects..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="project-switcher-input"
          />
        </div>
        <div className="project-switcher-list" ref={listRef}>
          {filtered.length === 0 && (
            <div style={{
              padding: '12px 16px',
              color: 'var(--text-muted)',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
            }}>
              No projects found
            </div>
          )}
          {filtered.map((project, i) => (
            <div
              key={project.name}
              className={`project-switcher-row ${i === highlightIndex ? 'highlighted' : ''}`}
              onClick={() => onSelect(project)}
              onMouseEnter={() => setHighlightIndex(i)}
            >
              <span className="project-switcher-name">{project.name}</span>
              <span className="project-switcher-path">{displayPath(project.path)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
