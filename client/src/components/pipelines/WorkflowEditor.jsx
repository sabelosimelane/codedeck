import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, BookmarkPlus, Plus, Trash2 } from 'lucide-react';
import { loopTargetIndex, validateWorkflowBody, validateStepPresetBody, WORKFLOW_KINDS, WORKFLOW_KIND_LABELS } from '../../../../shared/pipeline-definitions.mjs';
import { createStepPreset, createTemplate, createWorkflow, getWorkflow, updateWorkflow } from '../../utils/pipelinesApi';
import { parseWorkflow } from '../../utils/pipelineRecords';
import { useToast } from '../ToastContext';
import { OtherErrors, SelectField, TextField, diagnoseSaveFailure, errorsByField, failureMessage } from './definitionForm';

const MAX_NODES = 32;

// Keys only keep a node's inputs attached to it while nodes are moved; they are never sent.
let lastNodeKey = 0;
const nextNodeKey = () => `node-${++lastNodeKey}`;

// `loopTo` is the key of the node a loop returns to, so the loop follows that node when it is
// renamed or moved; the name is filled in when the workflow is saved.
const blankNode = () => ({ key: nextNodeKey(), name: '', role: '', agentId: '', prompt: '', mode: 'once', max: '', loopTo: '', readOnly: false, approval: false });

// A saved step becomes a node of its own: a copy, so editing it here never changes the saved one.
const nodeFromPreset = preset => ({ ...blankNode(), name: preset.name, role: preset.role, prompt: preset.prompt, mode: preset.repeat.mode, max: preset.repeat.mode === 'once' ? '' : String(preset.repeat.max), readOnly: preset.readOnly, approval: preset.approval });

function toDraft(workflow, roleHints = null) {
  if (workflow === null) return { id: null, revision: null, name: '', kind: 'other', description: '', agentsDecide: false, progressFile: '', nodes: [blankNode()] };
  const keys = workflow.nodes.map(nextNodeKey);
  return {
    id: workflow.id,
    revision: workflow.revision,
    name: workflow.name,
    kind: workflow.kind ?? 'other',
    description: workflow.description ?? '',
    agentsDecide: workflow.agentsDecide,
    progressFile: workflow.progressFile ?? '',
    nodes: workflow.nodes.map((node, index) => ({
      key: keys[index],
      name: node.name,
      agentId: node.agentId,
      prompt: node.prompt,
      role: node.role ?? roleHints?.[index] ?? '',
      readOnly: node.readOnly,
      approval: node.approval,
      mode: node.repeat.mode,
      max: node.repeat.mode === 'once' ? '' : String(node.repeat.max),
      loopTo: node.repeat.mode === 'loop_back' ? keys[loopTargetIndex(workflow.nodes, index)] : '',
    })),
  };
}

// An empty maximum is not a number; the validator reports it rather than a 0 being sent.
const maximum = node => (node.max.trim() === '' ? Number.NaN : Number(node.max));

function toRepeat(nodes, node) {
  if (node.mode === 'once') return { mode: node.mode };
  if (node.mode === 'until_complete') return { mode: node.mode, max: maximum(node) };
  // A node that was removed leaves no name; the validator then asks for an earlier node.
  return { mode: node.mode, to: nodes.find(candidate => candidate.key === node.loopTo)?.name ?? '', max: maximum(node) };
}

function toFields(draft) {
  return {
    name: draft.name,
    kind: draft.kind,
    description: draft.description,
    agentsDecide: draft.agentsDecide,
    progressFile: draft.progressFile.trim() || null,
    nodes: draft.nodes.map(node => ({
      name: node.name,
      role: node.role,
      agentId: node.agentId,
      prompt: node.prompt,
      readOnly: node.readOnly,
      approval: node.mode === 'loop_back' ? false : node.approval,
      repeat: toRepeat(draft.nodes, node),
    })),
  };
}

function shownFields(nodeCount) {
  const fields = ['name', 'kind', 'description', 'agentsDecide', 'progressFile'];
  for (let index = 0; index < nodeCount; index++) {
    const prefix = `nodes[${index}]`;
    fields.push(`${prefix}.name`, `${prefix}.role`, `${prefix}.agentId`, `${prefix}.prompt`, `${prefix}.readOnly`, `${prefix}.approval`, `${prefix}.repeat.mode`, `${prefix}.repeat.max`, `${prefix}.repeat.to`);
  }
  return fields;
}

/** Editor for one workflow: a draft of its name and ordered nodes, saved as a whole. */
export default function WorkflowEditor({ workflow, agents, stepPresets = [], roleHints = null, prefilled = false, onSaved, onChanged, onCancel, onDirtyChange, onLibraryChanged = async () => {} }) {
  const { showToast } = useToast();
  const [draft, setDraft] = useState(() => toDraft(workflow, roleHints));
  const [loaded, setLoaded] = useState(() => prefilled ? toDraft(null) : toDraft(workflow, roleHints));
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

  /** Saves the definition without its agents, to start other workflows from. */
  const saveAsTemplate = async () => {
    const fields = toFields(draft);
    const body = { ...fields, nodes: fields.nodes.map(({ agentId: _agentId, ...node }) => node) };
    const invalid = validateWorkflowBody(body, { template: true });
    if (invalid.length > 0) {
      setErrors(errorsByField(invalid));
      showToast({ type: 'error', message: 'Fix the marked fields before saving this as a template.' });
      return;
    }
    setBusy(true);
    try {
      await createTemplate(body);
      showToast({ type: 'success', message: `Template "${body.name.trim()}" saved` });
      await onLibraryChanged();
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  /** Saves one step for reuse. A loop names another step of this workflow, so it cannot be saved alone. */
  const saveStep = async (node) => {
    const body = { name: node.name, role: node.role, prompt: node.prompt, repeat: node.mode === 'until_complete' ? { mode: node.mode, max: maximum(node) } : { mode: 'once' }, readOnly: node.readOnly, approval: node.approval };
    const invalid = validateStepPresetBody(body);
    if (invalid.length > 0) {
      showToast({ type: 'error', message: `This step cannot be saved yet: ${invalid[0].message}` });
      return;
    }
    setBusy(true);
    try {
      await createStepPreset(body);
      showToast({ type: 'success', message: `Step "${body.name.trim()}" saved` });
      await onLibraryChanged();
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pipeline-form" aria-label="Workflow editor">
      <h4>{draft.id === null ? 'New workflow' : 'Edit workflow'}</h4>
      <TextField label="Workflow name" caption="Name" value={draft.name} onChange={name => setDraft(current => ({ ...current, name }))} error={errors.name} maxLength={64} placeholder="e.g. Bug fix" />
      <div className="pipeline-node-row">
        <SelectField label="Workflow kind" caption="Kind — what it is for; it only groups workflows" value={draft.kind} onChange={kind => setDraft(current => ({ ...current, kind }))} error={errors.kind}>
          {WORKFLOW_KINDS.map(kind => <option key={kind} value={kind}>{WORKFLOW_KIND_LABELS[kind]}</option>)}
        </SelectField>
        <TextField label="Workflow description" caption="Description (optional)" value={draft.description} onChange={description => setDraft(current => ({ ...current, description }))} error={errors.description} maxLength={280} placeholder="One line on what this workflow does" />
      </div>
      <label className="pipeline-check">
        <input type="checkbox" aria-label="Let agents decide" checked={draft.agentsDecide} disabled={busy} onChange={event => setDraft(current => ({ ...current, agentsDecide: event.target.checked }))} />
        <span>Let agents decide — an agent that asks a question is told to go with its own recommendation instead of pausing the run; each one is recorded on the run. Setup still asks you.</span>
      </label>
      {errors.agentsDecide && <span className="pipeline-field-error">{errors.agentsDecide}</span>}
      <TextField label="Progress file" caption="Progress file (optional)" value={draft.progressFile} onChange={progressFile => setDraft(current => ({ ...current, progressFile }))} error={errors.progressFile} maxLength={300} />
      <span>A Markdown todo inside the run's worktree, for example docs/{'{input}'}. The runs bar shows the first "## Phase N" section that still has unticked boxes.</span>

      <ol className="pipeline-nodes">
        {draft.nodes.map((node, index) => {
          const number = index + 1;
          const prefix = `nodes[${index}]`;
          const loops = node.mode === 'loop_back';
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
                  <button type="button" aria-label={`Save node ${number} as a reusable step`} title={loops ? 'A step that loops back cannot be saved on its own' : 'Save as a reusable step'} disabled={busy || loops} onClick={() => saveStep(node)}>
                    <BookmarkPlus size={13} />
                  </button>
                  <button type="button" className="pipeline-danger" aria-label={`Remove node ${number}`} title="Remove" disabled={busy || draft.nodes.length === 1} onClick={() => restructureNodes(nodes => nodes.filter((_node, at) => at !== index))}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div className="pipeline-node-row">
                <TextField label={`Node ${number} name`} caption="Name" value={node.name} onChange={setNodeField(index, 'name')} error={errors[`${prefix}.name`]} maxLength={64} placeholder="e.g. Analyse" />
                <SelectField label={`Node ${number} agent`} caption="Agent" value={node.agentId} onChange={setNodeField(index, 'agentId')} error={errors[`${prefix}.agentId`]}>
                  <option value="">Choose an agent</option>
                  {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </SelectField>
                <TextField label={`Node ${number} role`} caption="Role (optional)" value={node.role} onChange={setNodeField(index, 'role')} error={errors[`${prefix}.role`]} maxLength={32} placeholder="e.g. Reviewer" />
              </div>
              <TextField multiline rows={3} label={`Node ${number} prompt`} caption="Prompt — {input} is replaced with the run's input; a leading /skill is sent to Codex as $skill" value={node.prompt} onChange={setNodeField(index, 'prompt')} error={errors[`${prefix}.prompt`]} maxLength={8192} placeholder="What this step should do. {input} is replaced with what you type when starting a run." />
              <label className="pipeline-check">
                <input type="checkbox" aria-label={`Node ${number} read-only step`} checked={node.readOnly} disabled={busy} onChange={event => setNodeField(index, 'readOnly')(event.target.checked)} />
                <span>Read-only step — The agent is told to change nothing except files in its run notes folder.</span>
              </label>
              {errors[`${prefix}.readOnly`] && <span className="pipeline-field-error">{errors[`${prefix}.readOnly`]}</span>}
              <label className="pipeline-check">
                <input type="checkbox" aria-label={`Node ${number} wait for my approval`} checked={!loops && node.approval} disabled={busy || loops} onChange={event => setNodeField(index, 'approval')(event.target.checked)} />
                <span>Wait for my approval — The run pauses when this step finishes until you approve it or send it back.</span>
              </label>
              {loops && <span>A step that closes a loop cannot wait for approval.</span>}
              {errors[`${prefix}.approval`] && <span className="pipeline-field-error">{errors[`${prefix}.approval`]}</span>}
              <div className="pipeline-node-row">
                <SelectField label={`Node ${number} repeat`} caption="Repeat" value={node.mode} onChange={setNodeField(index, 'mode')} error={errors[`${prefix}.repeat.mode`]}>
                  <option value="once">Run once</option>
                  <option value="until_complete">Repeat until the agent reports COMPLETE</option>
                  {/* The first node has nothing before it; a loop left on it by a move or removal still shows. */}
                  {(index > 0 || loops) && <option value="loop_back">Loop back to an earlier node until the agent reports COMPLETE</option>}
                </SelectField>
                {node.mode === 'until_complete' && (
                  <TextField type="number" min="1" max="100" step="1" inputMode="numeric" label={`Node ${number} maximum passes`} caption="Maximum passes, then pause for me" value={node.max} onChange={setNodeField(index, 'max')} error={errors[`${prefix}.repeat.max`]} placeholder="1–100" />
                )}
              </div>
              {loops && (
                <div className="pipeline-node-row">
                  <SelectField label={`Node ${number} loops back to`} caption="Loop back to — the nodes from there to this one run again" value={draft.nodes.slice(0, index).some(candidate => candidate.key === node.loopTo) ? node.loopTo : ''} onChange={setNodeField(index, 'loopTo')} error={errors[`${prefix}.repeat.to`]}>
                    <option value="">Choose a node</option>
                    {draft.nodes.slice(0, index).map((candidate, at) => (
                      <option key={candidate.key} value={candidate.key}>{`Node ${at + 1}: ${candidate.name.trim() || '(no name yet)'}`}</option>
                    ))}
                  </SelectField>
                  <TextField type="number" min="1" max="100" step="1" inputMode="numeric" label={`Node ${number} maximum rounds`} caption="Maximum rounds, then pause for me" value={node.max} onChange={setNodeField(index, 'max')} error={errors[`${prefix}.repeat.max`]} placeholder="1–100" />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <OtherErrors errors={errors} shownFields={shownFields(draft.nodes.length)} />

      <div className="pipeline-form-actions">
        <button type="button" disabled={busy || draft.nodes.length >= MAX_NODES} onClick={() => setNodes(nodes => [...nodes, blankNode()])}>
          <Plus size={12} /> Add node
        </button>
        {stepPresets.length > 0 && (
          <select aria-label="Insert a saved step" value="" disabled={busy || draft.nodes.length >= MAX_NODES} onChange={(event) => {
            const preset = stepPresets.find(candidate => candidate.id === event.target.value);
            if (preset) setNodes(nodes => [...nodes, nodeFromPreset(preset)]);
          }}>
            <option value="">Insert a saved step…</option>
            {stepPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.role ? `${preset.name} (${preset.role})` : preset.name}</option>)}
          </select>
        )}
        <span className="pipeline-spacer" />
        <button type="button" disabled={busy} onClick={saveAsTemplate} title="Save this workflow without its agents, to start others from">Save as template</button>
        <button type="button" className="pipeline-primary" disabled={busy} onClick={save}>Save workflow</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
