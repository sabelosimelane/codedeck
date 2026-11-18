import React, { useCallback, useState } from 'react';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { deleteStepPreset, deleteTemplate, deleteWorkflow } from '../../utils/pipelinesApi';
import { WORKFLOW_KIND_LABELS } from '../../../../shared/pipeline-definitions.mjs';
import { WORKFLOW_TEMPLATES, buildTemplateDraft } from '../../../../shared/workflow-templates.mjs';
import { useToast } from '../ToastContext';
import WorkflowEditor from './WorkflowEditor';
import { failureMessage } from './definitionForm';

function summary(workflow) {
  const count = workflow.nodes.length;
  // A node that loops back is followed by the node its loop returns to.
  const names = workflow.nodes.map(node => (node.repeat.mode === 'loop_back' ? `${node.name} ↺ ${node.repeat.to}` : node.name));
  return `${count} ${count === 1 ? 'node' : 'nodes'}: ${names.join(' → ')}${workflow.agentsDecide ? ' · agents decide' : ''}`;
}

function uniqueName(name, workflows) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('name must be a non-empty string');
  if (!Array.isArray(workflows)) throw new TypeError('workflows must be an array');
  const taken = new Set(workflows.map(workflow => workflow.name.trim().toLowerCase()));
  const base = name.slice(0, 64);
  if (!taken.has(base.toLowerCase())) return base;
  for (let number = 2; number <= workflows.length + 2; number++) {
    const suffix = ` ${number}`;
    const candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('Could not choose a unique workflow name');
}

/** Workflows list; one workflow at a time is open in the editor. */
export default function WorkflowList({ workflows, agents, templates = [], stepPresets = [], onChanged, onDirtyChange }) {
  const { showToast } = useToast();
  // `opened` counts editor openings so each one starts from a fresh draft.
  const [editing, setEditing] = useState(null);
  const [opened, setOpened] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const reportDirty = useCallback((dirty) => {
    setEditorDirty(dirty);
    onDirtyChange(dirty);
  }, [onDirtyChange]);

  // Opening another workflow would replace the editor, so an unsaved draft is only dropped on purpose.
  const open = (workflow, roleHints = null, prefilled = false) => {
    if (editorDirty && !window.confirm('Discard the unsaved changes to this workflow?')) return;
    setChoosing(false);
    setEditing({ workflow, roleHints, prefilled });
    setOpened(count => count + 1);
  };
  const close = () => setEditing(null);
  const chooseTemplate = (template) => {
    const draft = buildTemplateDraft(template.id);
    open({ ...draft, id: null, revision: null, name: uniqueName(draft.name, workflows) }, template.nodes.map(node => node.role), true);
  };
  // A saved template is the owner's own: the same definition without agents.
  const chooseSaved = template => open({
    id: null, revision: null, name: uniqueName(template.name, workflows), kind: template.kind, description: template.description,
    agentsDecide: template.agentsDecide, progressFile: template.progressFile,
    nodes: template.nodes.map(node => ({ ...node, agentId: '', repeat: { ...node.repeat } })),
  }, null, true);
  const removeSaved = async (label, name, action) => {
    if (!window.confirm(`Delete the saved ${label} "${name}"? Workflows already made from it are not affected.`)) return;
    setBusy(true);
    try {
      await action();
      showToast({ type: 'success', message: `Saved ${label} "${name}" deleted` });
      await onChanged();
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
    } finally {
      setBusy(false);
    }
  };
  const duplicate = (workflow) => open({
    id: null, revision: null, name: uniqueName(`Copy of ${workflow.name}`, workflows), kind: workflow.kind, description: workflow.description,
    agentsDecide: workflow.agentsDecide, progressFile: workflow.progressFile,
    nodes: workflow.nodes.map(node => ({ ...node, repeat: { ...node.repeat } })),
  }, null, true);

  const remove = async (workflow) => {
    if (!window.confirm(`Delete workflow "${workflow.name}"?`)) return;
    setBusy(true);
    try {
      await deleteWorkflow(workflow.id);
      showToast({ type: 'success', message: `Workflow "${workflow.name}" deleted` });
      if (editing?.workflow?.id === workflow.id) close();
      await onChanged();
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pipeline-section" aria-label="Workflows">
      <h3>Workflows</h3>
      <p className="pipeline-hint">
        An ordered line of nodes. Each node runs in its own terminal with its agent; a run starts from Run workflow in the terminal tab bar.
      </p>

      {workflows.length === 0 && <p className="pipeline-empty">No workflows yet.</p>}
      <ul className="pipeline-list">
        {workflows.map(workflow => (
          <li key={workflow.id} className="pipeline-item">
            <div className="pipeline-item-text">
              <span className="pipeline-item-name">{workflow.name}{workflow.kind !== 'other' && <span className="pipeline-kind">{WORKFLOW_KIND_LABELS[workflow.kind]}</span>}</span>
              {workflow.description && <span className="pipeline-item-meta">{workflow.description}</span>}
              <span className="pipeline-item-meta">{summary(workflow)}</span>
            </div>
            <div className="pipeline-item-actions">
              <button type="button" aria-label={`Duplicate workflow ${workflow.name}`} title="Duplicate" disabled={busy} onClick={() => duplicate(workflow)}><Copy size={13} /></button>
              <button type="button" aria-label={`Edit workflow ${workflow.name}`} title="Edit" disabled={busy} onClick={() => open(workflow)}>
                <Pencil size={13} />
              </button>
              <button type="button" className="pipeline-danger" aria-label={`Delete workflow ${workflow.name}`} title="Delete" disabled={busy} onClick={() => remove(workflow)}>
                <Trash2 size={13} />
              </button>
            </div>
          </li>
        ))}
      </ul>

      {editing === null ? (
        <>
          <button type="button" className="pipeline-add" disabled={busy || agents.length === 0} aria-expanded={choosing} onClick={() => setChoosing(value => !value)}>
            <Plus size={12} /> Add workflow
          </button>
          {choosing && <div className="pipeline-template-chooser" aria-label="Workflow starting point">
            <button type="button" onClick={() => open(null)}>Blank</button>
            {WORKFLOW_TEMPLATES.map(template => <button type="button" key={template.id} onClick={() => chooseTemplate(template)}>
              <strong>{template.name}</strong><span>{template.description}</span>
            </button>)}
            {templates.map(template => <span key={template.id} className="pipeline-saved-template">
              <button type="button" onClick={() => chooseSaved(template)}>
                <strong>{template.name}</strong><span>{template.description || 'Saved by you'}</span>
              </button>
              <button type="button" className="pipeline-danger" aria-label={`Delete saved template ${template.name}`} title="Delete this saved template" disabled={busy} onClick={() => removeSaved('template', template.name, () => deleteTemplate(template.id))}><Trash2 size={13} /></button>
            </span>)}
          </div>}
          {stepPresets.length > 0 && (
            <details className="pipeline-saved-steps">
              <summary>{`Saved steps (${stepPresets.length})`}</summary>
              <ul className="pipeline-list">
                {stepPresets.map(preset => (
                  <li key={preset.id} className="pipeline-item">
                    <div className="pipeline-item-text">
                      <span className="pipeline-item-name">{preset.name}{preset.role && <span className="pipeline-kind">{preset.role}</span>}</span>
                      <span className="pipeline-item-meta">{preset.prompt.length > 120 ? `${preset.prompt.slice(0, 120)}…` : preset.prompt}</span>
                    </div>
                    <div className="pipeline-item-actions">
                      <button type="button" className="pipeline-danger" aria-label={`Delete saved step ${preset.name}`} title="Delete this saved step" disabled={busy} onClick={() => removeSaved('step', preset.name, () => deleteStepPreset(preset.id))}><Trash2 size={13} /></button>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {agents.length === 0 && <p className="pipeline-hint">Add an agent before creating a workflow.</p>}
        </>
      ) : (
        <WorkflowEditor
          key={opened}
          workflow={editing.workflow}
          roleHints={editing.roleHints}
          prefilled={editing.prefilled}
          agents={agents}
          stepPresets={stepPresets}
          onLibraryChanged={onChanged}
          onSaved={async () => { close(); await onChanged(); }}
          onChanged={onChanged}
          onCancel={close}
          onDirtyChange={reportDirty}
        />
      )}
    </section>
  );
}
