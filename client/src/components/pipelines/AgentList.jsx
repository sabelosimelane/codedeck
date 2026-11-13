import React, { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { validateAgentBody } from '../../../../shared/pipeline-definitions.mjs';
import { createAgent, deleteAgent, getAgent, updateAgent } from '../../utils/pipelinesApi';
import { parseAgent } from '../../utils/pipelineRecords';
import { useToast } from '../ToastContext';
import { OtherErrors, TextField, diagnoseSaveFailure, errorsByField, failureMessage } from './definitionForm';

const FORM_FIELDS = ['name', 'launchCommand', 'resetCommand'];
const NEW_AGENT = { id: null, revision: null, name: '', launchCommand: '', resetCommand: '/clear' };

const toForm = ({ id, revision, name, launchCommand, resetCommand }) => ({ id, revision, name, launchCommand, resetCommand });

/** Agents list with an inline add/edit form. Every change is saved to the backend, then reloaded from it. */
export default function AgentList({ agents, onChanged, onDirtyChange }) {
  const { showToast } = useToast();
  const [form, setForm] = useState(null);
  const [loaded, setLoaded] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const dirty = form !== null && FORM_FIELDS.some(field => form[field] !== loaded[field]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const openForm = (agent) => {
    const next = toForm(agent);
    setForm(next);
    setLoaded(next);
    setErrors({});
  };
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

  const save = async () => {
    const editing = form.id !== null;
    const fields = { name: form.name, launchCommand: form.launchCommand, resetCommand: form.resetCommand };
    const body = editing ? { ...fields, revision: form.revision } : fields;
    const invalid = validateAgentBody(body, { revisionRequired: editing });
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
        A named CLI a node runs in. The launch command starts it interactively and owns its model, effort and permission flags.
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
        <button type="button" className="pipeline-add" disabled={busy} onClick={() => openForm(NEW_AGENT)}>
          <Plus size={12} /> Add agent
        </button>
      ) : (
        <div className="pipeline-form">
          <h4>{form.id === null ? 'New agent' : 'Edit agent'}</h4>
          <TextField label="Agent name" caption="Name" value={form.name} onChange={setField('name')} error={errors.name} maxLength={64} placeholder="codex-sol-high" />
          <TextField label="Launch command" caption="Launch command" value={form.launchCommand} onChange={setField('launchCommand')} error={errors.launchCommand} maxLength={2048} placeholder={'codex --model gpt-6-sol -c model_reasoning_effort="high"'} />
          <TextField label="Reset command" caption="Reset command (clears context between passes)" value={form.resetCommand} onChange={setField('resetCommand')} error={errors.resetCommand} maxLength={256} />
          <OtherErrors errors={errors} shownFields={FORM_FIELDS} />
          <div className="pipeline-form-actions">
            <button type="button" className="pipeline-primary" disabled={busy} onClick={save}>Save agent</button>
            <button type="button" disabled={busy} onClick={closeForm}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
