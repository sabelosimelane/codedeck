import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { useToast } from './ToastContext';
import { namingRequest } from '../utils/sessionNamingApi';
import { listAgents } from '../utils/pipelinesApi';
import { parseAgent } from '../utils/pipelineRecords';
import { AGENT_PRESETS, parseLaunchCommand } from '../../../shared/agent-presets.mjs';
import { defaultNamingProviders } from '../../../shared/naming-providers.mjs';
import './session-naming.css';

const empty = { agentId: '', effort: null };
const SessionNamingSettings = forwardRef(function SessionNamingSettings({ onStateChange, active = false }, ref) {
  const [form, setForm] = useState(empty);
  const [savedForm, setSavedForm] = useState(empty);
  const [agents, setAgents] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(null);
  const { showToast } = useToast();
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([namingRequest('settings', { signal: controller.signal }), listAgents({ signal: controller.signal })])
      .then(([settings, records]) => {
        if (controller.signal.aborted) return;
        const loaded = { agentId: settings.agentId, effort: settings.effort };
        setForm(loaded); setSavedForm(loaded); setAgents(records.map(parseAgent));
      })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    listAgents({ signal: controller.signal }).then(records => { if (!controller.signal.aborted) setAgents(records.map(parseAgent)); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [active]);
  const selected = agents.find(agent => agent.id === form.agentId);
  const selection = selected ? parseLaunchCommand(selected.launchCommand) : null;
  const preset = AGENT_PRESETS.find(item => item.id === selection?.provider);
  const profile = defaultNamingProviders.find(item => item.id === selection?.provider);
  const valid = Boolean(selected && selection && preset && profile && (form.effort === null || preset.efforts.includes(form.effort)));
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm);
  useEffect(() => { onStateChange?.({ dirty, busy, valid }); }, [dirty, busy, valid, onStateChange]);
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
    <p>Generate a short title in the background using an agent installed and signed in on the machine running CodeDeck.</p>
    <label>Agent<select aria-label="Naming agent" value={form.agentId} disabled={busy} onChange={event => setForm({ agentId: event.target.value, effort: null })}>
      <option value="">Choose an agent for session naming</option>
      {agents.map(agent => {
        const choice = parseLaunchCommand(agent.launchCommand);
        const supported = defaultNamingProviders.some(profile => profile.id === choice?.provider);
        const reason = !choice ? "custom command: CodeDeck can't run it without a terminal" : !supported ? 'provider cannot run session naming' : null;
        return <option key={agent.id} value={agent.id} disabled={Boolean(reason)}>{agent.name}{reason ? ` — ${reason}` : ''}</option>;
      })}
    </select></label>
    <label>Reasoning effort<select aria-label="Naming effort" value={form.effort ?? ''} disabled={busy || !preset || preset.efforts.length === 0} onChange={event => setForm(old => ({ ...old, effort: event.target.value || null }))}>
      <option value="">CLI default</option>
      {preset?.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
    </select></label>
    <p>A bounded terminal excerpt is sent through the selected agent's CLI. Existing titles stay unchanged.</p>
    {dirty && <p role="status">Unsaved naming settings — Save to apply this selection.</p>}
    {error && <p role="alert" className="session-naming-error">{error}</p>}
    {busy && <p role="status">Loading…</p>}
    <button type="button" disabled={busy || !valid} onClick={save}>Save naming settings</button>
  </section>;
});
export default SessionNamingSettings;
