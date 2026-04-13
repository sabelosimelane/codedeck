import React, { useEffect, useRef } from 'react';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

const SHORTCUTS = [
  { category: 'Navigation', items: [
    { label: 'Switch project', mac: ['⌘', '⇧', 'P'], other: ['Ctrl', '⇧', 'P'] },
    { label: 'Select pane 1-9', mac: ['⌘', '⌥', '1-9'], other: ['Ctrl', 'Alt', '1-9'] },
  ]},
  { category: 'Terminals', items: [
    { label: 'New terminal', mac: ['⌘', '⇧', 'T'], other: ['Ctrl', '⇧', 'T'] },
    { label: 'Split right', mac: ['⌘', '⇧', 'E'], other: ['Ctrl', '⇧', 'E'] },
    { label: 'Clear terminal', mac: ['⌘', '⇧', 'K'], other: ['Ctrl', '⇧', 'K'] },
    { label: 'Close pane', mac: ['⌘', '⇧', 'X'], other: ['Ctrl', '⇧', 'X'] },
  ]},
  { category: 'Workspace', items: [
    { label: 'Toggle sidebar', mac: ['⌘', 'B'], other: ['Ctrl', 'B'] },
    { label: 'Toggle file tree', mac: ['⌘', '⇧', 'F'], other: ['Ctrl', '⇧', 'F'] },
    { label: 'Keyboard shortcuts', mac: ['⌘', '/'], other: ['Ctrl', '/'] },
  ]},
];

export default function ShortcutsOverlay({ onClose }) {
  const modalRef = useRef(null);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleOverlayClick = (e) => {
    if (modalRef.current && !modalRef.current.contains(e.target)) {
      onClose();
    }
  };

  return (
    <div className="shortcuts-overlay" onClick={handleOverlayClick}>
      <div className="shortcuts-modal" ref={modalRef}>
        <div className="shortcuts-title">Keyboard Shortcuts</div>
        {SHORTCUTS.map(group => (
          <div key={group.category} className="shortcuts-section">
            <div className="shortcuts-category">{group.category}</div>
            {group.items.map(item => (
              <div key={item.label} className="shortcuts-row">
                <span className="shortcuts-label">{item.label}</span>
                <span className="shortcut-tooltip-keys">
                  {(isMac ? item.mac : item.other).map((key, i) => (
                    <kbd key={i} className="shortcut-kbd">{key}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
