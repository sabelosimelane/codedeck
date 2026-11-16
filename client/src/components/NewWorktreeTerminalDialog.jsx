import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import './session-search.css';

export default function NewWorktreeTerminalDialog({ projectName, onCreate, onClose }) {
  const [branch, setBranch] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async event => {
    event.preventDefault();
    if (!branch || pending) return;
    setPending(true);
    setError(null);
    try {
      await onCreate({ project: projectName, branch });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  };

  return <div className="session-search-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="session-search-modal" role="dialog" aria-modal="true" aria-label="New terminal in a new worktree" style={{ width: 'min(480px, 100%)' }}>
      <div className="session-search-heading"><span>New terminal in a new worktree</span><button type="button" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
      <form onSubmit={submit} style={{ padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, color: 'var(--text-primary)' }}>Branch name
          <input autoFocus aria-label="Branch name" value={branch} onChange={event => setBranch(event.target.value)} style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)' }} />
        </label>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 12 }}>A worktree is created beside the repository in worktrees/ from the project&apos;s current commit. Uncommitted changes and git-ignored files are not carried over.</p>
        {error && <div role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={!branch || pending} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: branch && !pending ? 'var(--bg-active)' : 'var(--bg-surface)', color: branch && !pending ? 'var(--accent)' : 'var(--text-muted)', cursor: branch && !pending ? 'pointer' : 'not-allowed' }}>{pending ? 'Creating…' : 'Create worktree'}</button>
        </div>
      </form>
    </div>
  </div>;
}
