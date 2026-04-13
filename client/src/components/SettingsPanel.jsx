import React, { useState, useEffect } from 'react';
import { X, Settings, FolderOpen, RotateCcw, Save } from 'lucide-react';
import DirectoryBrowser from './DirectoryBrowser';
import { useToast } from './ToastContext';

const DEFAULT_NOTIFICATION_COOLDOWN_SECONDS = 30;

export default function SettingsPanel({ onClose, onSaved }) {
  const [defaultPath, setDefaultPath] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [editorCommand, setEditorCommand] = useState('');
  const [savedEditorCommand, setSavedEditorCommand] = useState('');
  const [terminalFinishCooldownSeconds, setTerminalFinishCooldownSeconds] = useState('');
  const [savedTerminalFinishCooldownSeconds, setSavedTerminalFinishCooldownSeconds] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    fetch('/api/config')
      .then(res => res.ok ? res.json() : Promise.reject(new Error('Failed to load settings')))
      .then(data => {
        const nextDefaultPath = data.defaultPath || '';
        const nextEditorCommand = data.editorCommand || '';
        const nextCooldown = data.terminalFinishCooldownSeconds === undefined || data.terminalFinishCooldownSeconds === null
          ? ''
          : String(data.terminalFinishCooldownSeconds);
        setDefaultPath(nextDefaultPath);
        setSavedPath(nextDefaultPath);
        setEditorCommand(nextEditorCommand);
        setSavedEditorCommand(nextEditorCommand);
        setTerminalFinishCooldownSeconds(nextCooldown);
        setSavedTerminalFinishCooldownSeconds(nextCooldown);
      })
      .catch(() => {
        showToast({ type: 'error', message: 'Failed to load settings' });
      });
  }, [showToast]);

  useEffect(() => {
    setDirty(
      defaultPath !== savedPath ||
      editorCommand !== savedEditorCommand ||
      terminalFinishCooldownSeconds !== savedTerminalFinishCooldownSeconds
    );
  }, [
    defaultPath,
    savedPath,
    editorCommand,
    savedEditorCommand,
    terminalFinishCooldownSeconds,
    savedTerminalFinishCooldownSeconds,
  ]);

  const handleSave = async () => {
    const trimmedCooldown = terminalFinishCooldownSeconds.trim();
    let normalizedCooldown = null;

    if (trimmedCooldown) {
      const parsedCooldown = Number.parseFloat(trimmedCooldown);
      if (!Number.isFinite(parsedCooldown) || parsedCooldown <= 0) {
        showToast({ type: 'error', message: 'Finish cooldown must be a positive number of seconds' });
        return;
      }
      normalizedCooldown = parsedCooldown;
    }

    setSaving(true);
    try {
      const requests = [
        defaultPath
          ? fetch('/api/config/defaultPath', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: defaultPath }),
            })
          : fetch('/api/config/defaultPath', { method: 'DELETE' }),
        editorCommand
          ? fetch('/api/config/editorCommand', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: editorCommand }),
            })
          : fetch('/api/config/editorCommand', { method: 'DELETE' }),
        normalizedCooldown !== null
          ? fetch('/api/config/terminalFinishCooldownSeconds', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: normalizedCooldown }),
            })
          : fetch('/api/config/terminalFinishCooldownSeconds', { method: 'DELETE' }),
      ];
      const responses = await Promise.all(requests);
      if (responses.some(res => !res.ok)) {
        showToast({ type: 'error', message: 'Failed to save settings' });
        setSaving(false);
        return;
      }
      setSavedPath(defaultPath);
      setSavedEditorCommand(editorCommand);
      setSavedTerminalFinishCooldownSeconds(trimmedCooldown);
      onSaved?.({
        terminalFinishCooldownSeconds: normalizedCooldown,
      });
      showToast({ type: 'success', message: 'Settings saved' });
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
    setSaving(false);
  };

  const handleBrowseSelect = (selectedPath) => {
    setDefaultPath(selectedPath);
    setShowBrowser(false);
  };

  return (
    <>
      <div style={overlayStyle} onClick={onClose}>
        <div style={panelStyle} onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div style={headerStyle}>
            <div style={headerLeftStyle}>
              <Settings size={15} style={{ color: 'var(--accent)' }} />
              <span style={headerTitleStyle}>settings</span>
            </div>
            <button onClick={onClose} style={closeBtnStyle}>
              <X size={14} />
            </button>
          </div>

          {/* Content */}
          <div style={contentStyle}>
            {/* Section: Paths */}
            <div style={sectionStyle}>
              <div style={sectionLabelStyle}>
                <span style={sectionDotStyle} />
                paths
              </div>

              {/* Default Path Row */}
              <div style={rowStyle}>
                <div style={rowHeaderStyle}>
                  <span style={keyStyle}>defaultPath</span>
                  <span style={descStyle}>
                    Starting directory when adding projects
                  </span>
                </div>
                <div style={valueRowStyle}>
                  <input
                    value={defaultPath}
                    onChange={e => setDefaultPath(e.target.value)}
                    placeholder="~ (home directory)"
                    spellCheck={false}
                    style={inputStyle}
                  />
                  <button
                    onClick={() => setShowBrowser(true)}
                    style={browseBtnStyle}
                    title="Browse"
                  >
                    <FolderOpen size={13} />
                  </button>
                </div>
              </div>

              <div style={{ ...rowStyle, marginTop: 12 }}>
                <div style={rowHeaderStyle}>
                  <span style={keyStyle}>editorCommand</span>
                  <span style={descStyle}>
                    Command used when opening clicked files. Leave blank for VS Code.
                  </span>
                </div>
                <div style={valueColumnStyle}>
                  <input
                    value={editorCommand}
                    onChange={e => setEditorCommand(e.target.value)}
                    placeholder="code -r"
                    spellCheck={false}
                    style={inputStyle}
                  />
                  <span style={hintStyle}>
                    Examples: <code style={inlineCodeStyle}>code -r</code>, <code style={inlineCodeStyle}>cursor -r</code>, <code style={inlineCodeStyle}>windsurf -r</code>
                  </span>
                </div>
              </div>

              <div style={{ ...rowStyle, marginTop: 12 }}>
                <div style={rowHeaderStyle}>
                  <span style={keyStyle}>terminalFinishCooldownSeconds</span>
                  <span style={descStyle}>
                    Seconds of continuous activity before a session is treated as finished and alerts can fire.
                  </span>
                </div>
                <div style={valueColumnStyle}>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={terminalFinishCooldownSeconds}
                    onChange={e => setTerminalFinishCooldownSeconds(e.target.value)}
                    placeholder={String(DEFAULT_NOTIFICATION_COOLDOWN_SECONDS)}
                    spellCheck={false}
                    style={inputStyle}
                  />
                  <span style={hintStyle}>
                    Leave blank for the default of <code style={inlineCodeStyle}>{DEFAULT_NOTIFICATION_COOLDOWN_SECONDS}</code> seconds.
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={footerStyle}>
            <div style={footerLeftStyle}>
              {dirty && (
                <span style={unsavedStyle}>unsaved changes</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => {
                    setDefaultPath(savedPath);
                    setEditorCommand(savedEditorCommand);
                    setTerminalFinishCooldownSeconds(savedTerminalFinishCooldownSeconds);
                  }}
                disabled={!dirty}
                style={{
                  ...actionBtnStyle,
                  opacity: dirty ? 1 : 0.3,
                  cursor: dirty ? 'pointer' : 'default',
                }}
                title="Revert"
              >
                <RotateCcw size={12} />
                Revert
              </button>
              <button
                onClick={handleSave}
                disabled={!dirty || saving}
                style={{
                  ...saveBtnStyle,
                  opacity: dirty && !saving ? 1 : 0.4,
                  cursor: dirty && !saving ? 'pointer' : 'default',
                }}
              >
                <Save size={12} />
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Nested DirectoryBrowser */}
      {showBrowser && (
        <DirectoryBrowser
          initialPath={defaultPath || undefined}
          onSelect={handleBrowseSelect}
          onCancel={() => setShowBrowser(false)}
        />
      )}
    </>
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
  zIndex: 999,
  animation: 'fadeIn 0.15s ease-out',
};

const panelStyle = {
  width: 480,
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
  padding: '14px 16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  borderBottom: '1px solid var(--border)',
};

const headerLeftStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const headerTitleStyle = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 600,
  fontSize: '13px',
  letterSpacing: '0.3px',
  color: 'var(--text-primary)',
};

const closeBtnStyle = {
  padding: 6,
  borderRadius: 6,
  color: 'var(--text-muted)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const contentStyle = {
  flex: 1,
  overflowY: 'auto',
  padding: '16px',
};

const sectionStyle = {
  marginBottom: 16,
};

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

const valueRowStyle = {
  display: 'flex',
  gap: 6,
};

const valueColumnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

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

const hintStyle = {
  fontSize: '11px',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  lineHeight: 1.5,
};

const inlineCodeStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'var(--text-secondary)',
};

const browseBtnStyle = {
  padding: '7px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-base)',
  color: 'var(--text-secondary)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
};

const footerStyle = {
  padding: '12px 16px',
  borderTop: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const footerLeftStyle = {
  display: 'flex',
  alignItems: 'center',
};

const unsavedStyle = {
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  color: '#fbbf24',
  letterSpacing: '0.2px',
};

const actionBtnStyle = {
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

const saveBtnStyle = {
  padding: '6px 14px',
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
