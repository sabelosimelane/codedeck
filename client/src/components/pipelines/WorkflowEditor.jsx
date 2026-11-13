import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { validateWorkflowBody } from '../../../../shared/pipeline-definitions.mjs';
import { createWorkflow, getWorkflow, updateWorkflow } from '../../utils/pipelinesApi';
import { parseWorkflow } from '../../utils/pipelineRecords';
import { useToast } from '../ToastContext';
import { OtherErrors, SelectField, TextField, diagnoseSaveFailure, errorsByField, failureMessage } from './definitionForm';

const MAX_NODES = 32;

// Keys only keep a node's inputs attached to it while nodes are moved; they are never sent.
let lastNodeKey = 0;
const nextNodeKey = () => `node-${++lastNodeKey}`;

const blankNode = () => ({ key: nextNodeKey(), name: '', agentId: '', prompt: '', mode: 'once', max: '' });

function toDraft(workflow) {
  if (workflow === null) return { id: null, revision: null, name: '', nodes: [blankNode()] };
  return {
    id: workflow.id,
    revision: workflow.revision,
    name: workflow.name,
    nodes: workflow.nodes.map(node => ({
      key: nextNodeKey(),
      name: node.name,
      agentId: node.agentId,
      prompt: node.prompt,
      mode: node.repeat.mode,
      max: node.repeat.mode === 'until_complete' ? String(node.repeat.max) : '',
    })),
  };
}

function toFields(draft) {
  return {
    name: draft.name,
    nodes: draft.nodes.map(node => ({
      name: node.name,
      agentId: node.agentId,
      prompt: node.prompt,
      // An empty maximum is not a number; the validator reports it rather than a 0 being sent.
      repeat: node.mode === 'until_complete'
        ? { mode: node.mode, max: node.max.trim() === '' ? Number.NaN : Number(node.max) }
        : { mode: node.mode },
    })),
  };
}

function shownFields(nodeCount) {
  const fields = ['name'];
  for (let index = 0; index < nodeCount; index++) {
    const prefix = `nodes[${index}]`;
    fields.push(`${prefix}.name`, `${prefix}.agentId`, `${prefix}.prompt`, `${prefix}.repeat.mode`, `${prefix}.repeat.max`);
  }
  return fields;
}

/** Editor for one workflow: a draft of its name and ordered nodes, saved as a whole. */
export default function WorkflowEditor({ workflow, agents, onSaved, onChanged, onCancel, onDirtyChange }) {
  const { showToast } = useToast();
  const [draft, setDraft] = useState(() => toDraft(workflow));
  const [loaded, setLoaded] = useState(draft);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const dirty = JSON.stringify(toFields(draft)) !== JSON.stringify(toFields(loaded));
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  // An editor that goes away takes its unsaved draft with it.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const setNodes = update => setDraft(current => ({ ...current, nodes: update(current.nodes) }));
  // Field errors are keyed by node position, so they are dropped when positions change.
  const restructureNodes = (update) => {
    setErrors({});
    setNodes(update);
  };
  const setNodeField = (index, field) => value => setNodes(nodes => nodes.map((node, at) => (at === index ? { ...node, [field]: value } : node)));
  const moveNode = (index, offset) => restructureNodes((nodes) => {
    const next = [...nodes];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    return next;
  });

  const save = async () => {
    const editing = draft.id !== null;
    const fields = toFields(draft);
    const body = editing ? { ...fields, revision: draft.revision } : fields;
    const invalid = validateWorkflowBody(body, { revisionRequired: editing });
    if (invalid.length > 0) {
      setErrors(errorsByField(invalid));
      return;
    }

    setBusy(true);
    setErrors({});
    try {
      const saved = parseWorkflow(editing ? await updateWorkflow(draft.id, body) : await createWorkflow(body));
      showToast({ type: 'success', message: `Workflow "${saved.name}" ${editing ? 'saved' : 'added'}` });
      await onSaved();
    } catch (failure) {
      const outcome = editing
        ? await diagnoseSaveFailure(failure, draft.revision, async () => parseWorkflow(await getWorkflow(draft.id)))
        : { kind: 'rejected' };
      if (outcome.kind === 'stale') {
        showToast({ type: 'error', message: 'This workflow was changed elsewhere. The latest version has been loaded.' });
        const latest = toDraft(outcome.latest);
        setDraft(latest);
        setLoaded(latest);
        await onChanged();
      } else if (outcome.kind === 'gone') {
        showToast({ type: 'error', message: failureMessage(failure) });
        await onSaved();
      } else {
        showToast({ type: 'error', message: failureMessage(failure) });
        setErrors(errorsByField(failure.errors ?? []));
      }
      setBusy(false);
    }
  };

  return (
    <section className="pipeline-form" aria-label="Workflow editor">
      <h4>{draft.id === null ? 'New workflow' : 'Edit workflow'}</h4>
      <TextField label="Workflow name" caption="Name" value={draft.name} onChange={name => setDraft(current => ({ ...current, name }))} error={errors.name} maxLength={64} placeholder="Feature" />

      <ol className="pipeline-nodes">
        {draft.nodes.map((node, index) => {
          const number = index + 1;
          const prefix = `nodes[${index}]`;
          return (
            <li key={node.key} className="pipeline-node" aria-label={`Node ${number}`}>
              <div className="pipeline-node-heading">
                <span>Node {number}</span>
                <div className="pipeline-item-actions">
                  <button type="button" aria-label={`Move node ${number} up`} title="Move up" disabled={busy || index === 0} onClick={() => moveNode(index, -1)}>
                    <ArrowUp size={13} />
                  </button>
                  <button type="button" aria-label={`Move node ${number} down`} title="Move down" disabled={busy || index === draft.nodes.length - 1} onClick={() => moveNode(index, 1)}>
                    <ArrowDown size={13} />
                  </button>
                  <button type="button" className="pipeline-danger" aria-label={`Remove node ${number}`} title="Remove" disabled={busy || draft.nodes.length === 1} onClick={() => restructureNodes(nodes => nodes.filter((_node, at) => at !== index))}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div className="pipeline-node-row">
                <TextField label={`Node ${number} name`} caption="Name" value={node.name} onChange={setNodeField(index, 'name')} error={errors[`${prefix}.name`]} maxLength={64} placeholder="Develop" />
                <SelectField label={`Node ${number} agent`} caption="Agent" value={node.agentId} onChange={setNodeField(index, 'agentId')} error={errors[`${prefix}.agentId`]}>
                  <option value="">Choose an agent</option>
                  {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </SelectField>
              </div>
              <TextField multiline rows={3} label={`Node ${number} prompt`} caption="Prompt — {input} is replaced with the run's input" value={node.prompt} onChange={setNodeField(index, 'prompt')} error={errors[`${prefix}.prompt`]} maxLength={8192} placeholder="/feature-dev {input}" />
              <div className="pipeline-node-row">
                <SelectField label={`Node ${number} repeat`} caption="Repeat" value={node.mode} onChange={setNodeField(index, 'mode')} error={errors[`${prefix}.repeat.mode`]}>
                  <option value="once">Run once</option>
                  <option value="until_complete">Repeat until the agent reports COMPLETE</option>
                </SelectField>
                {node.mode === 'until_complete' && (
                  <TextField type="number" min="1" max="100" step="1" inputMode="numeric" label={`Node ${number} maximum passes`} caption="Maximum passes, then pause for me" value={node.max} onChange={setNodeField(index, 'max')} error={errors[`${prefix}.repeat.max`]} placeholder="1–100" />
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <OtherErrors errors={errors} shownFields={shownFields(draft.nodes.length)} />

      <div className="pipeline-form-actions">
        <button type="button" disabled={busy || draft.nodes.length >= MAX_NODES} onClick={() => setNodes(nodes => [...nodes, blankNode()])}>
          <Plus size={12} /> Add node
        </button>
        <span className="pipeline-spacer" />
        <button type="button" className="pipeline-primary" disabled={busy} onClick={save}>Save workflow</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
