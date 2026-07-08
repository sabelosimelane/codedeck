import React, { useState, useEffect, useCallback } from 'react';
import { Server, Plus, Trash2, Pencil, Check, X, Wifi } from 'lucide-react';
import { useToast } from './ToastContext';

const GENERIC_ERROR = 'Something went wrong. Please try again.';

async function readError(res) {
  try {
    const body = await res.json();
    return body?.error || GENERIC_ERROR;
  } catch {
    return GENERIC_ERROR;
  }
}

const REACHABILITY_COLORS = {
  reachable: 'var(--accent)',
  unreachable: '#f87171',
  failing: '#fbbf24',
  unknown: 'var(--text-muted)',
};

/**
 * Hosts management section for the settings panel. Lists the built-in local
 * host plus configured remote hosts, and supports add / rename / delete /
 * test-connection. Every mutating call round-trips through the backend and
 * surfaces both success and failure as toasts (backend is source of truth).
 */
export default function HostsSection() {
  const { showToast } = useToast();
  const [hosts, setHosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null); // { name, sshTarget }
  const [testResults, setTestResults] = useState({}); // name -> result | { testing: true }

  const loadHosts = useCallback(async () => {
    try {
      const res = await fetch('/api/hosts');
      if (!res.ok) {
        showToast({ type: 'error', message: 'Failed to load hosts' });
        return;
      }
      setHosts(await res.json());
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadHosts();
  }, [loadHosts]);

  const handleAdd = async () => {
    const name = newName.trim();
    const sshTarget = newTarget.trim();
    if (!name || !sshTarget) {
      showToast({ type: 'error', message: 'Host name and SSH target are required' });
      return;
    }
    setAdding(true);
    try {
      const res = await fetch('/api/hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sshTarget }),
      });
      if (!res.ok) {
        showToast({ type: 'error', message: await readError(res) });
        return;
      }
      setNewName('');
      setNewTarget('');
      showToast({ type: 'success', message: `Host "${name}" added` });
      await loadHosts();
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    } finally {
      setAdding(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    const original = editing.original;
    const name = editing.name.trim();
    const sshTarget = editing.sshTarget.trim();
    if (!name || !sshTarget) {
      showToast({ type: 'error', message: 'Host name and SSH target are required' });
      return;
    }
    try {
      const res = await fetch(`/api/hosts/${encodeURIComponent(original)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sshTarget }),
      });
      if (!res.ok) {
        showToast({ type: 'error', message: await readError(res) });
        return;
      }
      setEditing(null);
      showToast({ type: 'success', message: `Host "${name}" updated` });
      await loadHosts();
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const handleDelete = async (name) => {
    try {
      const res = await fetch(`/api/hosts/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) {
        showToast({ type: 'error', message: await readError(res) });
        return;
      }
      showToast({ type: 'success', message: `Host "${name}" deleted` });
      await loadHosts();
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const handleTest = async (name) => {
    setTestResults(prev => ({ ...prev, [name]: { testing: true } }));
    try {
      const res = await fetch(`/api/hosts/${encodeURIComponent(name)}/test`, { method: 'POST' });
      if (!res.ok) {
        setTestResults(prev => ({ ...prev, [name]: null }));
        showToast({ type: 'error', message: await readError(res) });
        return;
      }
      const result = await res.json();
      setTestResults(prev => ({ ...prev, [name]: result }));
      if (result.sshOk && result.tmuxOk) {
        showToast({ type: 'success', message: `${name} reachable (${result.latencyMs}ms)` });
      } else if (result.sshOk) {
        showToast({ type: 'error', message: result.tmuxDetail || `${name}: tmux missing` });
      } else {
        showToast({ type: 'error', message: result.sshDetail || `${name} unreachable` });
      }
    } catch {
      setTestResults(prev => ({ ...prev, [name]: null }));
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  return (
    <div style={sectionStyle}>
      <div style={sectionLabelStyle}>
        <span style={sectionDotStyle} />
        hosts
      </div>

      {/* Existing hosts */}
      {loading ? (
        <div style={emptyStyle}>loading hosts…</div>
      ) : (
        hosts.map(host => {
          const isEditing = editing && editing.original === host.name;
          const result = testResults[host.name];
          return (
            <div key={host.name} style={{ ...rowStyle, marginBottom: 8 }}>
              {isEditing ? (
                <div style={valueColumnStyle}>
                  <input
                    value={editing.name}
                    onChange={e => setEditing({ ...editing, name: e.target.value })}
                    placeholder="host name"
                    spellCheck={false}
                    style={inputStyle}
                  />
                  <input
                    value={editing.sshTarget}
                    onChange={e => setEditing({ ...editing, sshTarget: e.target.value })}
                    placeholder="ssh target (alias or user@host)"
                    spellCheck={false}
                    style={inputStyle}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={handleSaveEdit} style={primaryBtnStyle} title="Save">
                      <Check size={12} /> Save
                    </button>
                    <button onClick={() => setEditing(null)} style={ghostBtnStyle} title="Cancel">
                      <X size={12} /> Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={hostHeaderStyle}>
                    <div style={hostIdentStyle}>
                      <Server size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                      <span style={hostNameStyle}>{host.name}</span>
                      {host.builtIn && <span style={badgeStyle}>built-in</span>}
                      <span
                        style={{ ...reachabilityStyle, color: REACHABILITY_COLORS[host.reachability] || 'var(--text-muted)' }}
                        title={`reachability: ${host.reachability}`}
                      >
                        ● {host.reachability}
                      </span>
                    </div>
                    {!host.builtIn && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          onClick={() => handleTest(host.name)}
                          style={iconBtnStyle}
                          title="Test connection"
                          disabled={result?.testing}
                        >
                          <Wifi size={13} />
                        </button>
                        <button
                          onClick={() => setEditing({ original: host.name, name: host.name, sshTarget: host.sshTarget })}
                          style={iconBtnStyle}
                          title="Rename / edit"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(host.name)}
                          style={{ ...iconBtnStyle, color: '#f87171' }}
                          title="Delete host"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div style={hostTargetStyle}>
                    {host.builtIn ? 'this machine' : host.sshTarget}
                  </div>
                  {result && !result.testing && (
                    <div style={testResultStyle}>
                      <span style={{ color: result.sshOk ? 'var(--accent)' : '#f87171' }}>
                        ssh {result.sshOk ? 'ok' : 'failed'}
                      </span>
                      {' · '}
                      <span style={{ color: result.tmuxOk ? 'var(--accent)' : '#f87171' }}>
                        tmux {result.tmuxOk ? 'ok' : 'missing'}
                      </span>
                      {typeof result.latencyMs === 'number' && ` · ${result.latencyMs}ms`}
                    </div>
                  )}
                  {result?.testing && <div style={testResultStyle}>testing…</div>}
                </>
              )}
            </div>
          );
        })
      )}

      {/* Add host */}
      <div style={{ ...rowStyle, marginTop: 4 }}>
        <div style={rowHeaderStyle}>
          <span style={keyStyle}>add host</span>
          <span style={descStyle}>SSH key auth must already work (ssh &lt;target&gt; true)</span>
        </div>
        <div style={valueColumnStyle}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="name (e.g. devbox)"
            spellCheck={false}
            style={inputStyle}
          />
          <input
            value={newTarget}
            onChange={e => setNewTarget(e.target.value)}
            placeholder="ssh target (~/.ssh/config alias or user@host)"
            spellCheck={false}
            style={inputStyle}
          />
          <button
            onClick={handleAdd}
            disabled={adding}
            style={{ ...primaryBtnStyle, opacity: adding ? 0.4 : 1, alignSelf: 'flex-start' }}
            title="Add host"
          >
            <Plus size={12} /> {adding ? 'Adding…' : 'Add host'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────

const sectionStyle = { marginBottom: 16 };

const sectionLabelStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: '10px',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase',
  letterSpacing: '1px',
  color: 'var(--text-muted)',
  marginBottom: 12,
  paddingBottom: 8,
  borderBottom: '1px solid var(--border)',
};

const sectionDotStyle = {
  width: 4,
  height: 4,
  borderRadius: '50%',
  background: 'var(--accent)',
  flexShrink: 0,
};

const rowStyle = {
  padding: '12px 14px',
  background: 'var(--bg-surface)',
  borderRadius: 8,
  border: '1px solid var(--border)',
};

const rowHeaderStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  marginBottom: 10,
};

const keyStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--accent)',
};

const descStyle = {
  fontSize: '11px',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
};

const valueColumnStyle = { display: 'flex', flexDirection: 'column', gap: 6 };

const inputStyle = {
  flex: 1,
  background: 'var(--bg-base)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '7px 10px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-primary)',
  outline: 'none',
};

const hostHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const hostIdentStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
};

const hostNameStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const badgeStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: '9px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: 'var(--text-muted)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '1px 5px',
};

const reachabilityStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  letterSpacing: '0.3px',
};

const hostTargetStyle = {
  marginTop: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'var(--text-secondary)',
  wordBreak: 'break-all',
};

const testResultStyle = {
  marginTop: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'var(--text-muted)',
};

const iconBtnStyle = {
  padding: 5,
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-base)',
  color: 'var(--text-secondary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const primaryBtnStyle = {
  padding: '6px 12px',
  borderRadius: 6,
  fontSize: '11px',
  fontWeight: 600,
  fontFamily: 'var(--font-mono)',
  color: '#000',
  background: 'var(--accent)',
  display: 'flex',
  alignItems: 'center',
  gap: 5,
};

const ghostBtnStyle = {
  padding: '6px 12px',
  borderRadius: 6,
  fontSize: '11px',
  fontWeight: 500,
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-secondary)',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  gap: 5,
};

const emptyStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'var(--text-muted)',
  padding: '8px 4px',
};
