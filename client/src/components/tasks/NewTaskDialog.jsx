import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import '../session-search.css';

const TITLE_MAX = 80;

/** A task needs only a title; CodeDeck prepares its own copy of the project to work in. */
export default function NewTaskDialog({ projectName, onCreate, onClose }) {
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const ready = title.trim().length > 0 && !pending;

  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async event => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      await onCreate({ project: projectName, title: title.trim() });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  };

  return <div className="session-search-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="session-search-modal" role="dialog" aria-modal="true" aria-label="New task" style={{ width: 'min(480px, 100%)' }}>
      <div className="session-search-heading"><span>New task</span><button type="button" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
      <form onSubmit={submit} style={{ padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, color: 'var(--text-primary)' }}>What are you working on?
          <input autoFocus aria-label="Task title" value={title} maxLength={TITLE_MAX} placeholder="For example: WhatsApp replies" onChange={event => setTitle(event.target.value)} style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)' }} />
        </label>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 12 }}>The task gets its own copy of the project at its current commit, so several tasks can be worked on at once. Uncommitted changes and files Git ignores are not carried over.</p>
        {error && <div role="alert" style={{ color: 'var(--danger)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={!ready} style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: ready ? 'var(--bg-active)' : 'var(--bg-surface)', color: ready ? 'var(--accent)' : 'var(--text-muted)', cursor: ready ? 'pointer' : 'not-allowed' }}>{pending ? 'Creating…' : 'Create task'}</button>
        </div>
      </form>
    </div>
  </div>;
}
