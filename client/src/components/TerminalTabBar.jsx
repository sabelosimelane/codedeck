import React from 'react';

export default function TerminalTabBar({ tabs, renderTab, children }) {
  return (
    <div data-testid="terminal-tab-row" style={{ display: 'flex', alignItems: 'center', height: 38, background: 'var(--bg-sidebar)', borderBottom: '1px solid var(--border)', padding: '0 8px', gap: 2, flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 2, flex: 1, overflow: 'hidden' }}>
        {tabs.map(renderTab)}
      </div>
      {children}
    </div>
  );
}
