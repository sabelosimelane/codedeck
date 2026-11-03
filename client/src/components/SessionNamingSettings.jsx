import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { useToast } from './ToastContext';
import { namingRequest } from '../utils/sessionNamingApi';
import './session-naming.css';

const empty = { provider: '', model: '', effort: null };
const efforts = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['minimal', 'low', 'medium', 'high', 'xhigh'] };
const SessionNamingSettings = forwardRef(function SessionNamingSettings({ onStateChange }, ref) {
  const [form, setForm] = useState(empty);
  const [savedForm, setSavedForm] = useState(empty);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const { showToast } = useToast();
  useEffect(() => {
    const controller = new AbortController();
    namingRequest('settings', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setForm(value); setSavedForm(value); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, []);
  const valid = Object.hasOwn(efforts, form.provider) && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(form.model) && (form.effort === null || efforts[form.provider].includes(form.effort));
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm);
  useEffect(() => { onStateChange?.({ dirty, busy, valid: Boolean(valid) }); }, [dirty, busy, valid, onStateChange]);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const saved = await namingRequest('settings', { method: 'PUT', body: form });
      setForm(saved); setSavedForm(saved);
      showToast({ type: 'success', message: 'Session naming settings saved' });
      return true;
    } catch (failure) { setError(failure.message); showToast({ type: 'error', message: failure.message }); return false; }
    finally { setBusy(false); }
  };
  useImperativeHandle(ref, () => ({
    save: () => !dirty ? Promise.resolve(true) : busy || !valid ? Promise.resolve(false) : save(),
    revert: () => { setForm(savedForm); setError(null); },
  }));
  return <section className="session-naming-settings" aria-label="Session naming">
    <h3>Session naming</h3>
    <p>Generate a short title in the background using a CLI installed and signed in on the machine running CodeDeck.</p>
    <label>Provider<select aria-label="Naming provider" value={form.provider} disabled={busy} onChange={e => setForm({ provider: e.target.value, model: '', effort: null })}>
      <option value="">Choose a provider</option>
      <option value="claude">Claude Code</option>
      <option value="codex">Codex</option>
    </select></label>
    <label>Model<input aria-label="Naming model" value={form.model} maxLength={256} disabled={busy || !form.provider} placeholder="Enter a model ID or CLI model alias" onChange={e => setForm(old => ({ ...old, model: e.target.value }))} /></label>
    <label>Reasoning effort<select aria-label="Naming effort" value={form.effort ?? ''} disabled={busy || !form.provider} onChange={e => setForm(old => ({ ...old, effort: e.target.value || null }))}>
      <option value="">Provider default</option>
      {efforts[form.provider]?.map(effort => <option key={effort} value={effort}>{effort}</option>)}
    </select></label>
    <p>A bounded terminal excerpt is sent through the selected CLI using its existing login. CodeDeck does not save the excerpt. Existing titles stay unchanged.</p>
    {dirty && <p role="status">Unsaved naming settings — Save to apply this selection.</p>}
    {error && <p role="alert" className="session-naming-error">{error}</p>}
    {busy && <p role="status">Loading…</p>}
    <button type="button" disabled={busy || !valid} onClick={save}>Save naming settings</button>
  </section>;
});
export default SessionNamingSettings;
