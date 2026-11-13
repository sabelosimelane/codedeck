import React, { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { AGENT_PRESETS, buildLaunchCommand, parseLaunchCommand } from '../../../../shared/agent-presets.mjs';
import { validateAgentBody } from '../../../../shared/pipeline-definitions.mjs';
import { createAgent, deleteAgent, getAgent, updateAgent } from '../../utils/pipelinesApi';
import { parseAgent } from '../../utils/pipelineRecords';
import { useToast } from '../ToastContext';
import { OtherErrors, SelectField, TextField, diagnoseSaveFailure, errorsByField, failureMessage } from './definitionForm';

const SHOWN_FIELDS = ['name', 'model', 'effort', 'launchCommand', 'resetCommand'];
const CUSTOM = 'custom';
const BLANK_SELECTION = { model: '', effort: '', skipPermissions: false };
const NEW_AGENT = { id: null, revision: null, name: '', resetCommand: '/clear', provider: AGENT_PRESETS[0].id, ...BLANK_SELECTION, customCommand: '' };

/** A saved command a preset builds opens as that preset's choices; any other opens as a custom command. */
function toForm({ id, revision, name, launchCommand, resetCommand }) {
  const selection = parseLaunchCommand(launchCommand);
  return selection === null
    ? { id, revision, name, resetCommand, provider: CUSTOM, ...BLANK_SELECTION, customCommand: launchCommand }
    : { id, revision, name, resetCommand, ...selection, customCommand: '' };
}

/** `{ command, errors }` for the form's launch choice; `command` is null while a preset field is invalid. */
function launchOf(form) {
  return form.provider === CUSTOM ? { command: form.customCommand, errors: [] } : buildLaunchCommand(form);
}

/** Agents list with an inline add/edit form. Every change is saved to the backend, then reloaded from it. */
export default function AgentList({ agents, onChanged, onDirtyChange }) {
  const { showToast } = useToast();
  const [form, setForm] = useState(null);
  const [loaded, setLoaded] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const launch = form === null ? null : launchOf(form);
  const preset = form === null ? undefined : AGENT_PRESETS.find(candidate => candidate.id === form.provider);
  const dirty = form !== null && (
    form.name !== loaded.name || form.resetCommand !== loaded.resetCommand || launch.command !== loaded.launchCommand
  );
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const showForm = (next) => {
    setForm(next);
    setLoaded({ name: next.name, resetCommand: next.resetCommand, launchCommand: launchOf(next).command });
    setErrors({});
  };
  const openForm = agent => showForm(toForm(agent));
  // Opening another agent would replace the form, so an unsaved one is only dropped on purpose.
  const requestForm = (agent) => {
    if (dirty && !window.confirm('Discard the unsaved changes to this agent?')) return;
    openForm(agent);
  };
  const closeForm = () => {
    setForm(null);
    setLoaded(null);
    setErrors({});
  };
  const setField = field => value => setForm(current => ({ ...current, [field]: value }));
  // Model names and efforts belong to one CLI, so they do not carry over to another provider.
  const setProvider = provider => setForm((current) => {
    if (provider === CUSTOM) return { ...current, provider, customCommand: launchOf(current).command ?? current.customCommand };
    return { ...current, provider, model: '', effort: '' };
  });

  const save = async () => {
    const editing = form.id !== null;
    const fields = { name: form.name, launchCommand: launch.command ?? '', resetCommand: form.resetCommand };
    const body = editing ? { ...fields, revision: form.revision } : fields;
    // An invalid preset field is reported on that field, not again as a missing launch command.
    const invalid = [
      ...launch.errors,
      ...validateAgentBody(body, { revisionRequired: editing }).filter(error => launch.errors.length === 0 || error.field !== 'launchCommand'),
    ];
    if (invalid.length > 0) {
      setErrors(errorsByField(invalid));
      return;
    }

    setBusy(true);
    setErrors({});
    try {
      const saved = parseAgent(editing ? await updateAgent(form.id, body) : await createAgent(body));
      showToast({ type: 'success', message: `Agent "${saved.name}" ${editing ? 'saved' : 'added'}` });
      closeForm();
      await onChanged();
    } catch (failure) {
      const outcome = editing
        ? await diagnoseSaveFailure(failure, form.revision, async () => parseAgent(await getAgent(form.id)))
        : { kind: 'rejected' };
      if (outcome.kind === 'stale') {
        showToast({ type: 'error', message: 'This agent was changed elsewhere. The latest version has been loaded.' });
        openForm(outcome.latest);
        await onChanged();
      } else if (outcome.kind === 'gone') {
        showToast({ type: 'error', message: failureMessage(failure) });
        closeForm();
        await onChanged();
      } else {
        showToast({ type: 'error', message: failureMessage(failure) });
        setErrors(errorsByField(failure.errors ?? []));
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (agent) => {
    if (!window.confirm(`Delete agent "${agent.name}"?`)) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await deleteAgent(agent.id);
      showToast({ type: 'success', message: `Agent "${agent.name}" deleted` });
      if (form?.id === agent.id) closeForm();
      await onChanged();
    } catch (failure) {
      const message = failureMessage(failure);
      setDeleteError(message);
      showToast({ type: 'error', message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pipeline-section" aria-label="Agents">
      <h3>Agents</h3>
      <p className="pipeline-hint">
        A named CLI a node runs in. Choose a provider, model and effort, or write the launch command yourself.
      </p>

      {agents.length === 0 && <p className="pipeline-empty">No agents yet.</p>}
      <ul className="pipeline-list">
        {agents.map(agent => (
          <li key={agent.id} className="pipeline-item">
            <div className="pipeline-item-text">
              <span className="pipeline-item-name">{agent.name}</span>
              <code>{agent.launchCommand}</code>
              <span className="pipeline-item-meta">reset with <code>{agent.resetCommand}</code></span>
            </div>
            <div className="pipeline-item-actions">
              <button type="button" aria-label={`Edit agent ${agent.name}`} title="Edit" disabled={busy} onClick={() => requestForm(agent)}>
                <Pencil size={13} />
              </button>
              <button type="button" className="pipeline-danger" aria-label={`Delete agent ${agent.name}`} title="Delete" disabled={busy} onClick={() => remove(agent)}>
                <Trash2 size={13} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      {deleteError && <p role="alert" className="pipeline-field-error">{deleteError}</p>}

      {form === null ? (
        <button type="button" className="pipeline-add" disabled={busy} onClick={() => showForm(NEW_AGENT)}>
          <Plus size={12} /> Add agent
        </button>
      ) : (
        <div className="pipeline-form">
          <h4>{form.id === null ? 'New agent' : 'Edit agent'}</h4>
          <TextField label="Agent name" caption="Name" value={form.name} onChange={setField('name')} error={errors.name} maxLength={64} placeholder="codex-sol-high" />
          <SelectField label="Provider" caption="Provider" value={form.provider} onChange={setProvider}>
            {AGENT_PRESETS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            <option value={CUSTOM}>Custom command</option>
          </SelectField>
          {preset ? (
            <>
              <div className="pipeline-node-row">
                <TextField
                  label="Model"
                  caption={preset.efforts.length > 0 ? "Model (blank uses the CLI's default)" : "Model (blank uses the CLI's default; the name includes the effort)"}
                  value={form.model}
                  onChange={setField('model')}
                  error={errors.model}
                  maxLength={128}
                  placeholder={preset.modelExample}
                />
                {preset.efforts.length > 0 && (
                  <SelectField label="Effort" caption="Effort" value={form.effort} onChange={setField('effort')} error={errors.effort}>
                    <option value="">CLI default</option>
                    {preset.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                  </SelectField>
                )}
              </div>
              <label className="pipeline-check">
                <input type="checkbox" aria-label="Skip permission prompts" checked={form.skipPermissions} onChange={event => setField('skipPermissions')(event.target.checked)} />
                <span>Skip permission prompts <code>{preset.skipPermissionsFlag}</code> — without it a run pauses whenever the agent asks for permission</span>
              </label>
              <TextField label="Launch command" caption="Launch command (built from the choices above)" value={launch.command ?? ''} onChange={() => {}} error={errors.launchCommand} readOnly />
            </>
          ) : (
            <TextField label="Launch command" caption="Launch command" value={form.customCommand} onChange={setField('customCommand')} error={errors.launchCommand} maxLength={2048} placeholder={'codex --model gpt-6-sol -c model_reasoning_effort="high"'} />
          )}
          <TextField label="Reset command" caption="Reset command (clears context between passes)" value={form.resetCommand} onChange={setField('resetCommand')} error={errors.resetCommand} maxLength={256} />
          <OtherErrors errors={errors} shownFields={SHOWN_FIELDS} />
          <div className="pipeline-form-actions">
            <button type="button" className="pipeline-primary" disabled={busy} onClick={save}>Save agent</button>
            <button type="button" disabled={busy} onClick={closeForm}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
