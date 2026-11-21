import React from 'react';
import { Button, Dialog, Note } from './ui/index.jsx';

const REASON_LABELS = {
  dirty: 'Uncommitted changes',
  diverged: 'Branch diverged from upstream',
  detached_head: 'Detached HEAD',
  no_upstream: 'No upstream tracking branch',
  network_or_auth: 'Remote fetch/auth failed',
  host_unreachable: 'Host unreachable',
};

/**
 * Warn-and-confirm dialog shown when automatic `git pull --ff-only` is blocked
 * (dirty working tree, diverged branch, no upstream, or offline).
 */
export default function SyncConflictDialog({
  conflict,
  actionLabel = 'continue',
  busy = false,
  onProceed,
  onCancel,
}) {
  if (!conflict) return null;
  const blocked = Array.isArray(conflict.results)
    ? conflict.results.filter(r => r.status === 'blocked')
    : [];

  return (
    <Dialog
      title="Could not sync latest changes"
      subtitle={`Automatic git pull (--ff-only) on "${conflict.host || 'local'}" could not complete before trying to ${actionLabel}.`}
      onClose={onCancel}
      busy={busy}
      footer={(
        <>
          <Button onClick={onCancel} disabled={busy}>Abort</Button>
          <Button variant="primary" onClick={onProceed} disabled={busy}>
            {busy ? 'Proceeding…' : 'Proceed without syncing'}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {blocked.length > 0 ? blocked.map((entry, idx) => (
          <div
            key={`${entry.repoPath || entry.repository}-${idx}`}
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border)',
              background: 'var(--bg-elevated)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <strong style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                {entry.repository || entry.repoPath}
              </strong>
              <span style={{ fontSize: 11, color: 'var(--warning)', fontFamily: 'var(--font-mono)' }}>
                {REASON_LABELS[entry.code] || entry.code || 'Sync blocked'}
              </span>
            </div>
            {entry.branch && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                branch: {entry.branch}
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {entry.message}
            </div>
            {entry.detail && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>
                {entry.detail}
              </div>
            )}
          </div>
        )) : (
          <Note tone="warning">{conflict.message || 'Git pull could not complete.'}</Note>
        )}
        <Note>
          Proceeding will use the current checkout on <strong>{conflict.host || 'local'}</strong> as-is without pulling upstream changes.
        </Note>
      </div>
    </Dialog>
  );
}
