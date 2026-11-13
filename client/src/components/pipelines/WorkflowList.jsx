import React, { useCallback, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { deleteWorkflow } from '../../utils/pipelinesApi';
import { useToast } from '../ToastContext';
import WorkflowEditor from './WorkflowEditor';
import { failureMessage } from './definitionForm';

function summary(workflow) {
  const count = workflow.nodes.length;
  return `${count} ${count === 1 ? 'node' : 'nodes'}: ${workflow.nodes.map(node => node.name).join(' → ')}`;
}

/** Workflows list; one workflow at a time is open in the editor. */
export default function WorkflowList({ workflows, agents, onChanged, onDirtyChange }) {
  const { showToast } = useToast();
  // `opened` counts editor openings so each one starts from a fresh draft.
  const [editing, setEditing] = useState(null);
  const [opened, setOpened] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);

  const reportDirty = useCallback((dirty) => {
    setEditorDirty(dirty);
    onDirtyChange(dirty);
  }, [onDirtyChange]);

  // Opening another workflow would replace the editor, so an unsaved draft is only dropped on purpose.
  const open = (workflow) => {
    if (editorDirty && !window.confirm('Discard the unsaved changes to this workflow?')) return;
    setEditing({ workflow });
    setOpened(count => count + 1);
  };
  const close = () => setEditing(null);

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
              <span className="pipeline-item-name">{workflow.name}</span>
              <span className="pipeline-item-meta">{summary(workflow)}</span>
            </div>
            <div className="pipeline-item-actions">
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
          <button type="button" className="pipeline-add" disabled={busy || agents.length === 0} onClick={() => open(null)}>
            <Plus size={12} /> Add workflow
          </button>
          {agents.length === 0 && <p className="pipeline-hint">Add an agent before creating a workflow.</p>}
        </>
      ) : (
        <WorkflowEditor
          key={opened}
          workflow={editing.workflow}
          agents={agents}
          onSaved={async () => { close(); await onChanged(); }}
          onChanged={onChanged}
          onCancel={close}
          onDirtyChange={reportDirty}
        />
      )}
    </section>
  );
}
