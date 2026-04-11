import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Copy, Check, RefreshCw, Wifi, ArrowDownToLine, Paintbrush } from 'lucide-react';
import { useToast } from './ToastContext';

const HEALTH_COLORS = {
  healthy: 'var(--accent)',
  detached: 'var(--text-muted)',
  reconnecting: '#fbbf24',
  stalled: '#f87171',
  replaying: '#60a5fa',
  dead: 'var(--danger)',
};

const HEALTH_DESCRIPTIONS = {
  healthy: 'PTY alive, transport attached, client view current',
  detached: 'PTY alive, no active browser attachment',
  reconnecting: 'Reconnect flow is active but not yet restored',
  stalled: 'Backend output suggests the pane should be changing but the client view is stale',
  replaying: 'Missed output is being replayed to catch the client up',
  dead: 'PTY has exited and cannot be resumed',
};

function formatTimestamp(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatEventType(type) {
  return type.replace(/_/g, ' ');
}

export default function TerminalInspector({ sessionId, onClose, onAction }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);
  const { showToast } = useToast();

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/debug/terminal-health');
      if (!res.ok) {
        showToast({ type: 'error', message: 'Failed to fetch terminal health' });
        return;
      }
      const json = await res.json();
      const session = json.sessions.find(s => s.sessionId === sessionId);
      setData(session || null);
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    } finally {
      setLoading(false);
    }
  }, [sessionId, showToast]);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 3000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Cleanup copied timer on unmount
  useEffect(() => {
    return () => clearTimeout(copiedTimerRef.current);
  }, []);

  const copySnapshot = useCallback(async () => {
    if (!data) return;
    const snapshot = JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(snapshot);
      setCopied(true);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast({ type: 'error', message: 'Failed to copy to clipboard' });
    }
  }, [data, showToast]);

  const health = data?.health || 'unknown';
  const healthColor = HEALTH_COLORS[health] || 'var(--text-muted)';

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              Inspect: {sessionId}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={fetchHealth} title="Refresh" style={actionBtnStyle}>
              <RefreshCw size={13} />
            </button>
            <button onClick={onClose} title="Close" style={actionBtnStyle}>
              <X size={14} />
            </button>
          </div>
        </div>

        {loading && !data ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            Loading diagnostics...
          </div>
        ) : !data ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            No session data found for {sessionId}
          </div>
        ) : (
          <div style={{ overflow: 'auto', flex: 1 }}>
            {/* Health Status */}
            <div style={sectionStyle}>
              <div style={sectionHeaderStyle}>Health</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: healthColor,
                  boxShadow: health === 'healthy' ? `0 0 10px ${healthColor}` : 'none',
                }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: healthColor }}>
                  {health}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {HEALTH_DESCRIPTIONS[health] || 'Unknown health state'}
              </div>
              {data.stallReason && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#f87171', fontFamily: 'var(--font-mono)' }}>
                  Stall reason: {data.stallReason}
                </div>
              )}
            </div>

            {/* State Snapshot */}
            <div style={sectionStyle}>
              <div style={sectionHeaderStyle}>State Snapshot</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {[
                    ['PTY Alive', data.ptyAlive ? 'Yes' : 'No'],
                    ['Runtime', data.runtimeType || 'pty'],
                    ['WS Attached', data.wsAttached ? 'Yes' : 'No'],
                    ['Doc Visibility', data.documentVisibility || '--'],
                    ['CWD', data.cwd],
                    ['Started At', formatTimestamp(data.startedAt)],
                    ['Last Output', formatTimestamp(data.lastOutputAt)],
                    ['Last Attach', formatTimestamp(data.lastAttachAt)],
                    ['Last Detach', formatTimestamp(data.lastDetachAt)],
                    ['Last Client Ack', formatTimestamp(data.lastClientAckAt)],
                    ['Last Message', formatTimestamp(data.clientLastMessageAt)],
                    ['Last Paint', formatTimestamp(data.clientLastPaintAt)],
                    ['Last Resize', formatTimestamp(data.clientLastResizeAt)],
                    ['Last Seq', String(data.lastSeq)],
                    ['Client Last Seq', String(data.clientLastSeenSeq ?? 0)],
                    ['Replay Buffer Size', String(data.replayBufferSize ?? 0)],
                    ['Last Replay', formatTimestamp(data.lastReplayAt)],
                    ['Reconnect Count', String(data.clientReconnectCount ?? 0)],
                  ].map(([label, value]) => (
                    <tr key={label}>
                      <td style={labelCellStyle}>{label}</td>
                      <td style={valueCellStyle}>{value}</td>
                    </tr>
                  ))}
                  {data.lastOutputLine && (
                    <tr>
                      <td style={labelCellStyle}>Last Output Line</td>
                      <td style={{ ...valueCellStyle, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {data.lastOutputLine}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Event Timeline */}
            <div style={sectionStyle}>
              <div style={sectionHeaderStyle}>Recent Events ({data.events?.length || 0})</div>
              {(!data.events || data.events.length === 0) ? (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No events recorded</div>
              ) : (
                <div style={{ maxHeight: 180, overflow: 'auto' }}>
                  {[...data.events].reverse().map((evt, i) => (
                    <div key={i} style={eventRowStyle}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)', minWidth: 70 }}>
                        {formatTimestamp(evt.at)}
                      </span>
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                        {formatEventType(evt.type)}
                      </span>
                      {evt.detail && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {evt.detail}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Recovery Actions */}
        <div style={recoverySectionStyle}>
          <div style={sectionHeaderStyle}>Recovery Actions</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => { onAction?.('reconnect'); showToast({ type: 'success', message: 'Reconnecting...' }); }}
              style={recoveryBtnStyle}
              title="Drop and re-establish the socket attachment"
            >
              <Wifi size={12} />
              <span>Reconnect</span>
            </button>
            <button
              onClick={() => { onAction?.('resync'); showToast({ type: 'success', message: 'Resyncing...' }); }}
              style={recoveryBtnStyle}
              title="Request replay without full teardown"
            >
              <ArrowDownToLine size={12} />
              <span>Resync</span>
            </button>
            <button
              onClick={() => { onAction?.('redraw'); showToast({ type: 'success', message: 'Redrawing...' }); }}
              style={recoveryBtnStyle}
              title="Force xterm repaint and resize sync"
            >
              <Paintbrush size={12} />
              <span>Redraw</span>
            </button>
          </div>
        </div>

        {/* Footer Actions */}
        <div style={footerStyle}>
          <button onClick={copySnapshot} style={copyBtnStyle} disabled={!data}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span>{copied ? 'Copied' : 'Copy debug snapshot'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: 'rgba(0, 0, 0, 0.5)',
  backdropFilter: 'blur(4px)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  animation: 'fadeIn 0.15s ease',
};

const panelStyle = {
  width: 420,
  maxHeight: '80vh',
  background: 'var(--bg-sidebar)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
  animation: 'slideUp 0.2s ease',
};

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 16px',
  borderBottom: '1px solid var(--border)',
};

const sectionStyle = {
  padding: '12px 16px',
  borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
};

const sectionHeaderStyle = {
  fontSize: 10,
  fontFamily: 'var(--font-sans)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--text-muted)',
  marginBottom: 8,
};

const labelCellStyle = {
  fontSize: 11,
  fontFamily: 'var(--font-sans)',
  color: 'var(--text-muted)',
  padding: '2px 8px 2px 0',
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
};

const valueCellStyle = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-primary)',
  padding: '2px 0',
};

const eventRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '3px 0',
  borderBottom: '1px solid rgba(255, 255, 255, 0.02)',
};

const footerStyle = {
  padding: '10px 16px',
  borderTop: '1px solid var(--border)',
  display: 'flex',
  justifyContent: 'flex-end',
};

const actionBtnStyle = {
  padding: 4,
  borderRadius: 4,
  color: 'var(--text-muted)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
};

const recoverySectionStyle = {
  padding: '10px 16px',
  borderTop: '1px solid var(--border)',
};

const recoveryBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  padding: '5px 10px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  background: 'rgba(255, 255, 255, 0.04)',
  color: 'var(--text-primary)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: 5,
  cursor: 'pointer',
};

const copyBtnStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  background: 'rgba(110, 231, 183, 0.1)',
  color: 'var(--accent)',
  border: '1px solid rgba(110, 231, 183, 0.2)',
  borderRadius: 6,
  cursor: 'pointer',
};
