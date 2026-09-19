import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useToast } from './ToastContext';
import { namingPages, namingRequest } from '../utils/sessionNamingApi';
import './session-naming.css';

const empty = { baseUrl: '', provider: '', model: '', effort: null };
const SessionNamingSettings = forwardRef(function SessionNamingSettings({ onStateChange }, ref) {
  const [form, setForm] = useState(empty);
  const [savedForm, setSavedForm] = useState(empty);
  const [credential, setCredential] = useState('');
  const [hasCredential, setHasCredential] = useState(false);
  const [providers, setProviders] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const generation = useRef(0);
  const { showToast } = useToast();
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const value = await namingRequest('settings', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setForm({ baseUrl: value.baseUrl, provider: value.provider, model: value.model, effort: value.effort }); setHasCredential(value.hasCredential);
        setSavedForm({ baseUrl: value.baseUrl, provider: value.provider, model: value.model, effort: value.effort });
        if (value.baseUrl) {
          const catalog = await namingPages('catalog', controller.signal);
          if (!controller.signal.aborted) { setProviders(catalog); setConnected(true); }
        }
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    })();
    return () => { controller.abort(); generation.current++; };
  }, []);
  const provider = providers.find(p => p.id === form.provider);
  const valid = connected && provider?.available && provider?.enabled && provider.models.includes(form.model) && (form.effort === null || provider.effort.includes(form.effort));
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm) || credential !== '';
  useEffect(() => { onStateChange?.({ dirty, busy, valid: Boolean(valid) }); }, [dirty, busy, valid, onStateChange]);
  const connectionBody = () => ({ baseUrl: form.baseUrl, ...(credential ? { credential } : {}) });
  const connect = async () => {
    const current = ++generation.current; setBusy(true); setError(null); setConnected(false);
    try {
      const { connectionId } = await namingRequest('connection-test', { method: 'POST', body: connectionBody() });
      const catalog = await namingPages(`catalog?connectionId=${encodeURIComponent(connectionId)}`);
      if (generation.current !== current) return;
      setProviders(catalog); setConnected(true);
      showToast({ type: 'success', message: 'Conduit connected. Catalog refreshed.' });
    } catch (failure) {
      if (generation.current !== current) return;
      setError(failure.message); showToast({ type: 'error', message: failure.message });
    } finally { if (generation.current === current) setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const saved = await namingRequest('settings', { method: 'PUT', body: { ...form, ...(credential ? { credential } : {}) } });
      const confirmed = { baseUrl: saved.baseUrl, provider: saved.provider, model: saved.model, effort: saved.effort };
      setForm(confirmed); setSavedForm(confirmed);
      setHasCredential(saved.hasCredential); setCredential('');
      showToast({ type: 'success', message: 'Session naming settings saved' });
      return true;
    } catch (failure) { setError(failure.message); showToast({ type: 'error', message: failure.message }); return false; }
    finally { setBusy(false); }
  };
  useImperativeHandle(ref, () => ({
    save: () => !dirty ? Promise.resolve(true) : busy || !valid ? Promise.resolve(false) : save(),
    revert: () => { setForm(savedForm); setCredential(''); setError(null); },
  }));
  const changeConnection = update => {
    generation.current++; setConnected(false); setProviders([]); setError(null);
    setForm(old => ({ ...old, ...update, provider: '', model: '', effort: null }));
  };
  return <section className="session-naming-settings" aria-label="Session naming">
    <h3>Session naming</h3>
    <p>Generate a short title from terminal context after the first task starts. Naming runs in the background; your terminal keeps working.</p>
    <label>Conduit endpoint<input aria-label="Conduit endpoint" type="url" placeholder="https://conduit.example.com" value={form.baseUrl} disabled={busy} onChange={e => changeConnection({ baseUrl: e.target.value })} /></label>
    <label>API credential<input aria-label="Conduit credential" type="password" autoComplete="new-password" placeholder={hasCredential ? 'Saved securely — leave blank to keep' : 'Conduit project token'} value={credential} disabled={busy} onChange={e => { setCredential(e.target.value); changeConnection({}); }} /></label>
    <button type="button" disabled={busy || !form.baseUrl} onClick={connect}>Test connection / refresh catalog</button>
    <label>Provider<select aria-label="Naming provider" value={form.provider} disabled={busy || !connected} onChange={e => setForm(old => ({ ...old, provider: e.target.value, model: '', effort: null }))}>
      <option value="">Choose a provider</option>
      {form.provider && !provider && <option value={form.provider} disabled>{form.provider} (not in catalog)</option>}
      {providers.map(p => <option key={p.id} value={p.id} disabled={!p.available || !p.enabled}>{p.id}{!p.enabled ? ' (disabled)' : !p.available ? ' (unavailable)' : ''}</option>)}
    </select></label>
    <label>Model<select aria-label="Naming model" value={form.model} disabled={busy || !provider?.available || !provider?.enabled} onChange={e => setForm(old => ({ ...old, model: e.target.value }))}>
      <option value="">Choose a model</option>
      {form.model && !provider?.models.includes(form.model) && <option value={form.model} disabled>{form.model} (not in catalog)</option>}
      {provider?.models.map(model => <option key={model} value={model}>{model}</option>)}
    </select></label>
    <label>Reasoning effort<select aria-label="Naming effort" value={form.effort ?? ''} disabled={busy || !provider?.effort.length} onChange={e => setForm(old => ({ ...old, effort: e.target.value || null }))}>
      <option value="">Provider default</option>
      {form.effort && !provider?.effort.includes(form.effort) && <option value={form.effort} disabled>{form.effort} (not in catalog)</option>}
      {provider?.effort.map(effort => <option key={effort} value={effort}>{effort}</option>)}
    </select></label>
    <p>Only a bounded terminal excerpt is sent to Conduit. CodeDeck does not save the excerpt. Existing titles stay unchanged.</p>
    {dirty && <p role="status">Unsaved naming settings — Save to apply this selection.</p>}
    {error && <p role="alert" className="session-naming-error">{error}</p>}
    {busy && <p role="status">Connecting…</p>}
    <button type="button" disabled={busy || !valid} onClick={save}>Save naming settings</button>
  </section>;
});
export default SessionNamingSettings;
