import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { useToast } from './ToastContext';
import { namingRequest } from '../utils/sessionNamingApi';
import { defaultNamingProviders, namingProviderErrors } from '../../../shared/naming-providers.mjs';
import './session-naming.css';

const toForm = value => ({ ...value, providers: (value.providers ?? defaultNamingProviders).map(p => ({ ...p, args: JSON.stringify(p.args, null, 2), effortArgs: JSON.stringify(p.effortArgs) })) });
const empty = toForm({ provider: '', model: '', effort: null });
function parseForm(form) {
  try {
    const settings = { ...form, providers: form.providers.map(p => ({ ...p, args: JSON.parse(p.args), effortArgs: JSON.parse(p.effortArgs) })) };
    const errors = namingProviderErrors(settings.providers);
    return { settings, problem: errors[0] ? `${errors[0].field}: ${errors[0].message}` : null };
  } catch { return { settings: null, problem: 'Arguments must be valid JSON arrays of strings.' }; }
}
const SessionNamingSettings = forwardRef(function SessionNamingSettings({ onStateChange }, ref) {
  const [form, setForm] = useState(empty);
  const [savedForm, setSavedForm] = useState(empty);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const { showToast } = useToast();
  useEffect(() => {
    const controller = new AbortController();
    namingRequest('settings', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { const loaded = toForm(value); setForm(loaded); setSavedForm(loaded); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, []);
  const { settings, problem } = parseForm(form);
  const selectedIndex = form.providers.findIndex(p => p.id === form.provider);
  const profile = form.providers[selectedIndex];
  const supportsEffort = settings?.providers[selectedIndex]?.effortArgs?.length > 0;
  const valid = !problem && Boolean(profile) && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(form.model) && (form.effort === null || (supportsEffort && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(form.effort)));
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm);
  useEffect(() => { onStateChange?.({ dirty, busy, valid }); }, [dirty, busy, valid, onStateChange]);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const saved = toForm(await namingRequest('settings', { method: 'PUT', body: settings }));
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
  const updateProfile = patch => setForm(old => ({ ...old,
    ...(Object.hasOwn(patch, 'id') ? { provider: patch.id } : {}),
    providers: old.providers.map((p, index) => index === selectedIndex ? { ...p, ...patch } : p),
  }));
  const addProvider = () => {
    let id = 'custom'; let suffix = 1;
    while (form.providers.some(p => p.id === id)) id = `custom-${suffix++}`;
    setForm(old => ({ ...old, provider: id, model: '', effort: null, providers: [...old.providers, {
      id, command: '', args: '["--model", "{model}"]', effortArgs: '[]', input: 'stdin', output: 'json',
    }] }));
  };
  return <section className="session-naming-settings" aria-label="Session naming">
    <h3>Session naming</h3>
    <p>Generate a short title in the background using a CLI installed and signed in on the machine running CodeDeck.</p>
    <label>Provider<select aria-label="Naming provider" value={form.provider} disabled={busy} onChange={e => setForm(old => ({ ...old, provider: e.target.value, model: '', effort: null }))}>
      <option value="">Choose a provider</option>
      {form.providers.map((p, index) => <option key={index} value={p.id}>{p.id}</option>)}
    </select></label>
    <button type="button" disabled={busy || form.providers.length >= 16} onClick={addProvider}>Add provider</button>
    <button type="button" disabled={busy || !profile} onClick={() => setForm(old => ({ ...old, provider: '', model: '', effort: null, providers: old.providers.filter((_p, index) => index !== selectedIndex) }))}>Remove provider</button>
    <label>Model<input aria-label="Naming model" value={form.model} maxLength={256} disabled={busy || !profile} placeholder="Exact model ID (case-sensitive)" onChange={e => setForm(old => ({ ...old, model: e.target.value }))} /></label>
    <label>Reasoning effort<input aria-label="Naming effort" value={form.effort ?? ''} maxLength={64} disabled={busy || !supportsEffort} placeholder="Leave blank for provider default" onChange={e => setForm(old => ({ ...old, effort: e.target.value || null }))} /></label>
    {profile && <details className="naming-provider-editor" open>
      <summary>Provider command</summary>
      <label>Provider name<input aria-label="Provider name" value={profile.id} maxLength={64} disabled={busy} onChange={e => updateProfile({ id: e.target.value })} /></label>
      <label>CLI executable<input aria-label="CLI executable" value={profile.command} maxLength={1024} disabled={busy} placeholder="e.g. kiro-cli, agent, or /path/to/cli" onChange={e => updateProfile({ command: e.target.value })} /></label>
      <label>CLI arguments (JSON)<textarea aria-label="CLI arguments (JSON)" value={profile.args} rows={5} disabled={busy} onChange={e => updateProfile({ args: e.target.value })} /></label>
      <p>Use a JSON array with one string per argument. {'{model}'} inserts the selected model. For a positional prompt, include {'{prompt}'} once. Arguments are passed directly without a shell.</p>
      <label>Prompt input<select aria-label="Prompt input" value={profile.input} disabled={busy} onChange={e => updateProfile({ input: e.target.value })}>
        <option value="stdin">Standard input</option><option value="argument">Argument using {'{prompt}'}</option>
      </select></label>
      <label>Effort arguments (JSON)<textarea aria-label="Effort arguments (JSON)" value={profile.effortArgs} rows={2} disabled={busy} onChange={e => updateProfile({ effortArgs: e.target.value })} /></label>
      <p>For example: { '["--effort", "{effort}"]' }. Use [] when unsupported. These arguments are omitted when effort is blank.</p>
      <label>Response format<select aria-label="Response format" value={profile.output} disabled={busy} onChange={e => updateProfile({ output: e.target.value })}>
        <option value="json">Title JSON on stdout</option><option value="json-result">JSON result envelope (Cursor / Claude)</option><option value="codex-jsonl">Codex JSON event stream</option>
      </select></label>
      <p>The prompt asks for {'{"title":"Short title"}'}. Configure non-interactive flags and disable tools in your CLI command. Use the CLI’s existing login, not credentials in the arguments.</p>
    </details>}
    <p>A bounded terminal excerpt is sent through the selected CLI. Existing titles stay unchanged.</p>
    {dirty && <p role="status">Unsaved naming settings — Save to apply this selection.</p>}
    {dirty && problem && <p role="alert" className="session-naming-error">{problem}</p>}
    {error && <p role="alert" className="session-naming-error">{error}</p>}
    {busy && <p role="status">Loading…</p>}
    <button type="button" disabled={busy || !valid} onClick={save}>Save naming settings</button>
  </section>;
});
export default SessionNamingSettings;
