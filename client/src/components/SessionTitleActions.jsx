import React, { useState } from 'react';
import { Pencil, RotateCcw } from 'lucide-react';
import { useToast } from './ToastContext';
import { namingRequest } from '../utils/sessionNamingApi';
import './session-naming.css';

export default function SessionTitleActions({ sessionId, metadata, onChanged = () => {} }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { showToast } = useToast();
  const submit = async (retry = false) => {
    setBusy(true); setError(null);
    try {
      await namingRequest(`titles/${encodeURIComponent(sessionId)}${retry ? '/retry' : ''}`, { method: retry ? 'POST' : 'PUT', body: retry ? {} : { title: title.trim() } });
      setEditing(false); await onChanged();
      showToast({ type: 'success', message: retry ? 'Naming queued' : 'Session renamed' });
    } catch (failure) { setError(failure.message); showToast({ type: 'error', message: failure.message }); }
    finally { setBusy(false); }
  };
  return <div className="session-title-actions" onClick={e => e.stopPropagation()}>
    <button type="button" aria-label={`Rename session ${sessionId}`} title="Rename session" disabled={busy} onClick={() => { setTitle(metadata?.title || ''); setEditing(true); }}><Pencil size={12} /></button>
    {['queued', 'generating'].includes(metadata?.state) && <span role="status">{metadata.state === 'queued' && metadata.error ? 'Retrying automatically every 10 seconds…' : 'Naming…'}</span>}
    {metadata?.error && <span className="session-naming-error" title={metadata.error}>{metadata.error}</span>}
    {metadata?.state === 'failed' && <button type="button" aria-label={`Retry naming ${sessionId}`} title={metadata.error} disabled={busy} onClick={() => submit(true)}><RotateCcw size={12} /> Retry naming</button>}
    {error && !editing && <span role="alert" className="session-naming-error">{error}</span>}
    {editing && <div className="session-title-overlay" onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' && !busy) setEditing(false); }}>
      <form className="session-title-dialog" role="dialog" aria-modal="true" aria-label={`Rename ${sessionId}`} onSubmit={e => { e.preventDefault(); submit(); }}>
        <h3>Rename session</h3><p>{sessionId}</p>
        <label>Session title<input aria-label="Session title" autoFocus maxLength={60} value={title} onChange={e => setTitle(e.target.value)} disabled={busy} /></label>
        {error && <p role="alert" className="session-naming-error">{error}</p>}
        <div><button type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button><button type="submit" disabled={busy || !title.trim()}>Save title</button></div>
      </form>
    </div>}
  </div>;
}
