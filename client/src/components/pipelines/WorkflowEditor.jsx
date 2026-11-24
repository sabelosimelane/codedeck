import React, { useEffect, useRef, useState } from 'react';
import { Button, IconButton } from '../ui/index.jsx';
import { ArrowDown, ArrowUp, BookmarkPlus, Plus, Trash2 } from 'lucide-react';
import { BUILT_IN_STEPS } from '../../../../shared/workflow-templates.mjs';
import { loopTargetIndex, validateWorkflowBody, validateStepPresetBody, WORKFLOW_KINDS, WORKFLOW_KIND_LABELS } from '../../../../shared/pipeline-definitions.mjs';
import { createStepPreset, createTemplate, createWorkflow, exportWorkflow, getWorkflow, previewPrompt, updateWorkflow } from '../../utils/pipelinesApi';
import { packageFileName } from '../../../../shared/workflow-package.mjs';
import { parseWorkflow } from '../../utils/pipelineRecords';
import { useToast } from '../ToastContext';
import { OtherErrors, SelectField, TextField, diagnoseSaveFailure, errorsByField, failureMessage } from './definitionForm';

const MAX_NODES = 32;

// Keys only keep a node's inputs attached to it while nodes are moved; they are never sent.
let lastNodeKey = 0;
const nextNodeKey = () => `node-${++lastNodeKey}`;

// `loopTo` is the key of the node a loop returns to, so the loop follows that node when it is
// renamed or moved; the name is filled in when the workflow is saved.
const blankNode = () => ({ key: nextNodeKey(), name: '', role: '', prompt: '', mode: 'once', max: '', loopTo: '', readOnly: false, approval: false, askOwner: false, enabled: true });

// A saved step becomes a node of its own: a copy, so editing it here never changes the saved one.
const nodeFromPreset = preset => ({ ...blankNode(), name: preset.name, role: preset.role, prompt: preset.prompt, mode: preset.repeat.mode, max: preset.repeat.mode === 'once' ? '' : String(preset.repeat.max), readOnly: preset.readOnly, approval: preset.approval, askOwner: preset.askOwner, enabled: preset.enabled !== false });

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
      prompt: node.prompt,
      role: node.role ?? roleHints?.[index] ?? '',
      readOnly: node.readOnly,
      approval: node.approval,
      askOwner: node.askOwner ?? false,
      enabled: node.enabled !== false,
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
      prompt: node.prompt,
      readOnly: node.readOnly,
      approval: node.mode === 'loop_back' ? false : node.approval,
      askOwner: node.askOwner,
      ...(node.enabled === false ? { enabled: false } : {}),
      repeat: toRepeat(draft.nodes, node),
    })),
  };
}

function shownFields(nodeCount) {
  const fields = ['name', 'kind', 'description', 'agentsDecide', 'progressFile'];
  for (let index = 0; index < nodeCount; index++) {
    const prefix = `nodes[${index}]`;
    fields.push(`${prefix}.name`, `${prefix}.role`, `${prefix}.prompt`, `${prefix}.readOnly`, `${prefix}.approval`, `${prefix}.askOwner`, `${prefix}.enabled`, `${prefix}.repeat.mode`, `${prefix}.repeat.max`, `${prefix}.repeat.to`);
  }
  return fields;
}

/**
 * What the selected step's agent would be sent, asked of the backend a moment after the
 * draft stops changing. Nothing is saved; the backend composes it as a run would.
 */
function PromptPreview({ fields, nodeIndex }) {
  const [input, setInput] = useState('');
  const [state, setState] = useState({ status: 'idle', prompt: null, message: null, skillRewrite: false });
  const latest = useRef(0);
  const workflow = fields;
  const key = JSON.stringify([workflow, nodeIndex, input]);
  useEffect(() => {
    const request = ++latest.current;
    const timer = setTimeout(async () => {
      setState(current => ({ ...current, status: 'loading' }));
      try {
        const result = await previewPrompt({ workflow, nodeIndex, input });
        if (request !== latest.current) return;
        if (typeof result?.prompt !== 'string') throw new Error('Invalid preview from the pipelines API: prompt');
        setState({ status: 'ready', prompt: result.prompt, message: null, skillRewrite: result.skillRewrite === true });
      } catch (failure) {
        if (request !== latest.current) return;
        const field = Array.isArray(failure?.errors) && failure.errors[0]?.message ? `${failure.errors[0].field.replace(/^workflow\./, '')}: ${failure.errors[0].message}` : null;
        setState({ status: 'failed', prompt: null, message: field ?? failureMessage(failure), skillRewrite: false });
      }
    }, 400);
    return () => clearTimeout(timer);
    // `key` is the draft, the step and the example input; `workflow` is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <section className="workflow-preview" aria-label="What the agent is sent">
      <h5>What the agent is sent</h5>
      <TextField label="Example input" caption="Example input — stands in for what you type when starting a run" value={input} onChange={setInput} maxLength={4096} placeholder="e.g. docs/todos/replies.md" />
      {state.status === 'failed' && <span className="pipeline-field-error" role="status">{`No preview yet — ${state.message}`}</span>}
      {state.prompt !== null && <pre className="workflow-preview-text">{state.prompt}</pre>}
      {state.prompt !== null && (
        <span className="pipeline-hint">
          The task&apos;s folder, the run notes folder and the pass identifier are filled in when a run starts.
          {state.skillRewrite && ' The leading /skill is written $skill when Codex runs the step.'}
        </span>
      )}
    </section>
  );
}

/** Editor for one workflow: a draft of its name and ordered nodes, saved as a whole. */
export default function WorkflowEditor({ workflow, roles = [], stepPresets = [], roleHints = null, prefilled = false, variant = 'form', onSaved, onChanged, onCancel, onDirtyChange, onLibraryChanged = async () => {} }) {
  const roleNames = roles.map(role => role.name);
  if (variant !== 'form' && variant !== 'builder') throw new Error('workflow editor: variant must be form or builder');
  const builder = variant === 'builder';
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
  // Builder: one step is open at a time; the rail picks it and reorders by drag.
  const [selectedKey, setSelectedKey] = useState(() => draft.nodes[0]?.key ?? null);
  const dragFrom = useRef(null);
  const selectedIndex = Math.max(0, draft.nodes.findIndex(node => node.key === selectedKey));
  const dropNode = (to) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to) return;
    restructureNodes((nodes) => {
      const next = [...nodes];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const addNode = (node) => {
    setNodes(nodes => [...nodes, node]);
    setSelectedKey(node.key);
  };

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

  /** Saves the definition as a template, to start other workflows from. */
  const saveAsTemplate = async () => {
    const body = toFields(draft);
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
    const body = { name: node.name, role: node.role, prompt: node.prompt, repeat: node.mode === 'until_complete' ? { mode: node.mode, max: maximum(node) } : { mode: 'once' }, readOnly: node.readOnly, approval: node.approval, askOwner: node.askOwner };
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

  const renderNode = (node, index) => {
          const number = index + 1;
          const prefix = `nodes[${index}]`;
          const loops = node.mode === 'loop_back';
          return (
            <li key={node.key} className="pipeline-node" aria-label={`Node ${number}`}>
              <div className="pipeline-node-heading">
                <span>Node {number}</span>
                <div className="pipeline-item-actions ui-item-actions">
                  <IconButton aria-label={`Move node ${number} up`} title="Move up" disabled={busy || index === 0} onClick={() => moveNode(index, -1)}>
                    <ArrowUp size={13} />
                  </IconButton>
                  <IconButton aria-label={`Move node ${number} down`} title="Move down" disabled={busy || index === draft.nodes.length - 1} onClick={() => moveNode(index, 1)}>
                    <ArrowDown size={13} />
                  </IconButton>
                  <IconButton aria-label={`Save node ${number} as a reusable step`} title={loops ? 'A step that loops back cannot be saved on its own' : 'Save as a reusable step'} disabled={busy || loops} onClick={() => saveStep(node)}>
                    <BookmarkPlus size={13} />
                  </IconButton>
                  <IconButton tone="danger" aria-label={`Remove node ${number}`} title="Remove" disabled={busy || draft.nodes.length === 1} onClick={() => restructureNodes(nodes => nodes.filter((_node, at) => at !== index))}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </div>
              <div className="pipeline-node-row">
                <TextField label={`Node ${number} name`} caption="Name" value={node.name} onChange={setNodeField(index, 'name')} error={errors[`${prefix}.name`]} maxLength={64} placeholder="e.g. Analyse" />
                <SelectField label={`Node ${number} role`} caption="Role" value={node.role} onChange={setNodeField(index, 'role')} error={errors[`${prefix}.role`]}>
                  <option value="">Choose a role</option>
                  {(roleNames.includes(node.role) || !node.role ? roleNames : [node.role, ...roleNames]).map(role => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </SelectField>
              </div>
              <TextField multiline rows={builder ? 14 : 3} label={`Node ${number} prompt`} caption="Prompt — {input} is replaced with the run's input; a leading /skill is sent to Codex as $skill" value={node.prompt} onChange={setNodeField(index, 'prompt')} error={errors[`${prefix}.prompt`]} maxLength={8192} placeholder="What this step should do. {input} is replaced with what you type when starting a run." />
              <label className="pipeline-check">
                <input type="checkbox" aria-label={`Node ${number} enabled`} checked={node.enabled} disabled={busy} onChange={event => setNodeField(index, 'enabled')(event.target.checked)} />
                <span>Enable this step — Uncheck to skip this step in new runs while keeping it in the workflow.</span>
              </label>
              {errors[`${prefix}.enabled`] && <span className="pipeline-field-error">{errors[`${prefix}.enabled`]}</span>}
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
              <label className="pipeline-check">
                <input type="checkbox" aria-label={`Node ${number} always ask me`} checked={node.askOwner} disabled={busy} onChange={event => setNodeField(index, 'askOwner')(event.target.checked)} />
                <span>Always ask me — This step&apos;s questions come to you even when the workflow lets agents decide.</span>
              </label>
              {errors[`${prefix}.askOwner`] && <span className="pipeline-field-error">{errors[`${prefix}.askOwner`]}</span>}
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
  };

  // Exporting writes the saved workflow to a package file; refuse a stale draft.
  const exportReason = dirty ? 'Save before exporting' : null;

  const downloadExport = async () => {
    if (exportReason !== null) return;
    setBusy(true);
    try {
      const pkg = await exportWorkflow(draft.id);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = packageFileName(pkg.workflow.name);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast({ type: 'success', message: `Workflow "${draft.name.trim() || 'Untitled'}" exported` });
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={builder ? 'pipeline-form workflow-builder' : 'pipeline-form'} aria-label="Workflow editor">
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

      {builder && (
        <nav className="workflow-rail" aria-label="Steps of this workflow">
          {draft.nodes.map((node, index) => (
            <button key={node.key} type="button" draggable={!busy} className="workflow-rail-step" aria-current={index === selectedIndex ? 'step' : undefined}
              aria-label={`Step ${index + 1}: ${node.name.trim() || 'no name yet'}`}
              title="Drag to reorder"
              onClick={() => setSelectedKey(node.key)}
              onDragStart={() => { dragFrom.current = index; }}
              onDragOver={event => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); dropNode(index); }}>
              <span className="workflow-rail-number">{index + 1}</span>
              <span className="workflow-rail-text">
                <span className="workflow-rail-name">{node.name.trim() || '(no name yet)'}</span>
                <span className="workflow-rail-meta">{[node.role.trim() || 'No role', node.mode === 'loop_back' ? `↺ ${draft.nodes.find(candidate => candidate.key === node.loopTo)?.name.trim() || '?'}` : null, node.approval && node.mode !== 'loop_back' ? 'approval' : null, !node.enabled ? 'disabled' : null].filter(Boolean).join(' · ')}</span>
              </span>
              {Object.keys(errors).some(field => field.startsWith(`nodes[${index}].`)) && <span className="pipeline-field-error" aria-label="This step has an invalid field">!</span>}
            </button>
          ))}
          <Button variant="accent" size="small" disabled={busy || draft.nodes.length >= MAX_NODES} onClick={() => addNode(blankNode())}><Plus size={12} /> Add step</Button>
        </nav>
      )}
      <ol className="pipeline-nodes">
        {builder ? renderNode(draft.nodes[selectedIndex], selectedIndex) : draft.nodes.map(renderNode)}
      </ol>
      {builder && <PromptPreview fields={toFields(draft)} nodeIndex={selectedIndex} />}
      <OtherErrors errors={errors} shownFields={shownFields(draft.nodes.length)} />

      <div className="pipeline-form-actions">
        {!builder && (
          <Button disabled={busy || draft.nodes.length >= MAX_NODES} onClick={() => addNode(blankNode())}>
            <Plus size={12} /> Add node
          </Button>
        )}
        {(
          <select className="ui-input workflow-insert-step" aria-label="Insert a saved step" value="" disabled={busy || draft.nodes.length >= MAX_NODES} onChange={(event) => {
            const preset = [...BUILT_IN_STEPS, ...stepPresets].find(candidate => candidate.id === event.target.value);
            if (preset) addNode(nodeFromPreset(preset));
          }}>
            <option value="">Insert a saved step…</option>
            {BUILT_IN_STEPS.map(step => <option key={step.id} value={step.id}>{`${step.name} (built in)`}</option>)}
            {stepPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.role ? `${preset.name} (${preset.role})` : preset.name}</option>)}
          </select>
        )}
        <span className="pipeline-spacer" />
        <Button disabled={busy} onClick={saveAsTemplate} title="Save this workflow without its agents, to start others from">Save as template</Button>
        {draft.id !== null && (
          <>
            <Button disabled={busy || exportReason !== null} title={exportReason ?? 'Download this workflow as a package file'} onClick={downloadExport}>Export</Button>
            {exportReason !== null && <span className="pipeline-hint">{exportReason}</span>}
          </>
        )}
        <Button variant="primary" disabled={busy} onClick={save}>Save workflow</Button>
        <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </section>
  );
}
