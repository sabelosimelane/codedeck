import React from 'react';
import { getDisplayTerminalStatus, getVisualTerminalStatus } from '../utils/terminalActivity';

function formatTimeSince(isoString) {
  if (!isoString) return '';
  const secs = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export default function SidebarSessionRows({ sessions, finishedSessionIds, quietStatusSessionIds, mutedStatusSessionIds, waitingSessionIds }) {
  return <>
                {sessions.map(session => {
                  const termStatus = getDisplayTerminalStatus(session, finishedSessionIds);
                  const visualStatus = getVisualTerminalStatus(session, finishedSessionIds, quietStatusSessionIds);
                  const isStatusMuted = mutedStatusSessionIds.has(session.sessionId);
                  const timeSince = formatTimeSince(session.lastOutputAt);
                  const dotColor = visualStatus === 'busy'
                    ? 'var(--accent)'
                    : visualStatus === 'finished'
                    ? 'var(--warning)'
                    : visualStatus === 'dead'
                    ? 'var(--danger)'
                    : 'var(--text-muted)';
                  return (
                    <div key={session.sessionId} style={{ marginTop: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 16, minWidth: 0 }}>
                        <span
                          className={visualStatus === 'busy' ? 'terminal-dot-busy' : visualStatus === 'finished' ? 'terminal-dot-finished' : undefined}
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: dotColor,
                            flexShrink: 0,
                            display: 'inline-block',
                          }}
                          title={`Terminal ${session.sessionId}: ${termStatus === 'finished' ? 'finished — needs attention' : termStatus}${isStatusMuted ? ' (status colors muted)' : ''}${waitingSessionIds.has(session.sessionId) ? ' (waiting)' : ''}`}
                        />
                        <span title={session.sessionId} style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                          {session.title || session.sessionId}
                        </span>
                        <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                          · {timeSince}
                        </span>
                      </div>
                      {session.lastOutputLine && (
                        <div style={{
                          marginLeft: 28,
                          marginTop: 2,
                          fontSize: '11px',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-muted)',
                          opacity: 0.6,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: 'calc(100% - 28px)',
                        }}>
                          {session.lastOutputLine}
                        </div>
                      )}
                    </div>
                  );
                })}
  </>;
}
