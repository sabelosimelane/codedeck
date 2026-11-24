import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, IconButton, TextInput } from '../ui/index.jsx';
import { Copy, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { addBuiltinWorkflow, createWorkflow, deleteStepPreset, deleteTemplate, deleteWorkflow, dismissBuiltinWorkflow, importWorkflow, listBuiltinWorkflows, previewImport } from '../../utils/pipelinesApi';
import { parseWorkflow } from '../../utils/pipelineRecords';
import { requiredWorkflowRoles, WORKFLOW_KIND_LABELS } from '../../../../shared/pipeline-definitions.mjs';
import { WORKFLOW_TEMPLATES, buildTemplateDraft } from '../../../../shared/workflow-templates.mjs';
import { useToast } from '../ToastContext';
import WorkflowEditor from './WorkflowEditor';
import { failureMessage } from './definitionForm';

/** Where a workflow came from; local workflows carry no badge. */
function sourceBadge(workflow) {
  const source = workflow.source;
  if (!source || source.kind === 'local') return null;
  if (source.kind === 'imported') return <span className="pipeline-kind">Imported, version {source.version}</span>;
  if (source.shipped === false) return <span className="pipeline-kind">Built-in no longer shipped</span>;
  if (source.updatedToVersionAt) return <span className="pipeline-kind">Updated to version {source.version}</span>;
  return null;
}

const EXPORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The package export timestamp (§3), shown in the preview; null when it does not parse. */
function formatExportDate(value) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  const date = new Date(time);
  return `${date.getUTCDate()} ${EXPORT_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Preview of a package file: new / copy in Phase 1; update and up-to-date are informational until Phase 3. */
function ImportPreviewDialog({ importing, existingNames, onClose, onNameChange, onApply }) {
  const mode = importing.preview.target.mode;
  const canApply = mode === 'new' || mode === 'name-clash';
  // Spec §5.6: the copy name is checked for clashes as the owner types.
  const copyName = importing.name.trim();
  const copyClash = mode === 'name-clash' && copyName !== ''
    && existingNames.some(name => name.toLowerCase() === copyName.toLowerCase());
  const copyEmpty = mode === 'name-clash' && copyName === '';
  const exportDate = formatExportDate(importing.pkg?.exportedAt);
  return (
    <Dialog title={`Import ${importing.preview.workflow.name}`} onClose={() => { if (!importing.busy) onClose(); }} footer={
      <>
        <Button disabled={importing.busy} onClick={onClose}>{canApply ? 'Cancel' : 'Close'}</Button>
        {canApply && (
          <Button
            variant={mode === 'name-clash' ? 'primary' : 'accent'}
            disabled={importing.busy || copyEmpty || copyClash}
            onClick={onApply}
          >
            {mode === 'name-clash' ? 'Import as a copy' : 'Import'}
          </Button>
        )}
      </>
    }>
      {exportDate !== null && (
        <p className="pipeline-hint">File exported {exportDate} · version {importing.pkg.source.version}.</p>
      )}
      {mode === 'name-clash' && (
        <p>A workflow with this name already exists. Import the file as a copy with another name.</p>
      )}
      {mode === 'new' && (
        <p>Import the file as a new workflow. Every step keeps its role and is assigned by team role.</p>
      )}
      {mode === 'up-to-date' && (
        <p>Already up to date. Nothing to apply.</p>
      )}
      {mode === 'update' && (
        <p>
          {`An update from version ${importing.preview.target.fromVersion} to version ${importing.pkg.source.version} is available; applying it is not offered in this release.`}
        </p>
      )}
      {mode === 'name-clash' && (
        <>
          <TextInput label="Copy name" value={importing.name} onChange={onNameChange} maxLength={64} invalid={copyClash} />
          {copyClash && <p role="alert">This name is already taken. Choose another.</p>}
        </>
      )}
      {(importing.preview.newRoles ?? []).length > 0 && canApply && (
        <p className="pipeline-hint">New roles that will be added: {importing.preview.newRoles.join(', ')}.</p>
      )}
      {importing.preview.missingRoles.length > 0 && canApply && (
        <p className="pipeline-hint">No team gives these roles an agent yet: {importing.preview.missingRoles.join(', ')}.</p>
      )}
    </Dialog>
  );
}

function summary(workflow) {
  const count = workflow.nodes.length;
  // A node that loops back is followed by the node its loop returns to.
  const names = workflow.nodes.map((node) => {
    const label = node.repeat.mode === 'loop_back' ? `${node.name} ↺ ${node.repeat.to}` : node.name;
    return node.enabled === false ? `${label} (disabled)` : label;
  });
  const roles = requiredWorkflowRoles(workflow.nodes);
  return `${count} ${count === 1 ? 'node' : 'nodes'}: ${names.join(' → ')}${roles.length ? ` · Roles: ${roles.join(', ')}` : ''}${workflow.agentsDecide ? ' · agents decide' : ''}`;
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
export default function WorkflowList({ workflows, roles = [], templates = [], stepPresets = [], variant = 'form', onChanged, onDirtyChange }) {
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

  // Shipped built-ins this install has not linked or dismissed (§5.3). Reads only;
  // when the read fails the owner's workflows still list, just without the offers.
  const [builtIns, setBuiltIns] = useState([]);
  const refreshBuiltIns = useCallback(async () => {
    try {
      setBuiltIns(await listBuiltinWorkflows());
    } catch (failure) {
      // The owner's workflows still list; the new-built-in offers are just missing.
      setBuiltIns([]);
      showToast({ type: 'error', message: failureMessage(failure) });
    }
  }, [showToast]);
  useEffect(() => { void refreshBuiltIns(); }, [refreshBuiltIns]);
  const newBuiltIns = builtIns.filter(item => item.status === 'new');

  // A built-in template is added linked (§5.1): the first one links, a second one
  // is an unlinked local copy with its toast (the unique source index refuses two).
  const addBuiltin = async (template) => {
    setBusy(true);
    try {
      const linked = workflows.find(item => item.source?.kind === 'builtin' && item.source?.id === template.id);
      if (linked) {
        const draft = buildTemplateDraft(template.id);
        const name = uniqueName(template.name, workflows);
        parseWorkflow(await createWorkflow({
          ...draft,
          name,
        }));
        showToast({ type: 'success', message: `Added as a copy: ${template.name} is already linked to the built-in.` });
      } else {
        const created = parseWorkflow(await addBuiltinWorkflow(template.id));
        showToast({ type: 'success', message: `Workflow "${created.name}" added` });
      }
      await refreshBuiltIns();
      await onChanged();
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  const dismissBuiltin = async (row) => {
    setBusy(true);
    try {
      await dismissBuiltinWorkflow(row.id);
      showToast({ type: 'success', message: `Built-in "${row.name}" dismissed` });
      await refreshBuiltIns();
      await onChanged();
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  // Importing a package file: pick it, preview what it would do, then apply the choice.
  const fileRef = useRef(null);
  const [importing, setImporting] = useState(null);

  const readPackageFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error('This is not a workflow package file.');
      }
      const preview = await previewImport(parsed);
      setImporting({
        pkg: parsed,
        preview,
        name: preview.target.mode === 'name-clash' ? preview.target.suggestedName : preview.workflow.name,
      });
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  const applyImport = async () => {
    if (!importing || importing.busy) return;
    const { pkg, preview } = importing;
    // Phase 1 only applies a new workflow or a renamed copy; update/replace arrive in Phase 3.
    if (preview.target.mode !== 'new' && preview.target.mode !== 'name-clash') return;
    const target = preview.target.mode === 'name-clash' ? { mode: 'new', name: importing.name.trim() } : { mode: 'new' };
    setImporting(current => ({ ...current, busy: true }));
    try {
      const created = parseWorkflow(await importWorkflow(pkg, target));
      showToast({ type: 'success', message: `Workflow "${created.name}" imported` });
      setImporting(null);
      await onChanged();
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      setImporting(current => (current === null ? current : { ...current, busy: false }));
    }
  };

  // Opening another workflow would replace the editor, so an unsaved draft is only dropped on purpose.
  const open = (workflow, roleHints = null, prefilled = false) => {
    if (editorDirty && !window.confirm('Discard the unsaved changes to this workflow?')) return;
    setChoosing(false);
    setEditing({ workflow, roleHints, prefilled });
    setOpened(count => count + 1);
  };
  const close = () => setEditing(null);
  // A built-in template is added linked, not opened as a draft: the saved workflow
  // must carry the template's source (§5.1). Blank and saved templates still open drafts.
  const chooseTemplate = (template) => {
    setChoosing(false);
    void addBuiltin(template);
  };
  // A saved template is the owner's own: a role-based workflow definition.
  const chooseSaved = template => open({
    id: null, revision: null, name: uniqueName(template.name, workflows), kind: template.kind, description: template.description,
    agentsDecide: template.agentsDecide, progressFile: template.progressFile,
    nodes: template.nodes.map(node => ({ ...node, repeat: { ...node.repeat } })),
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
      // Deleting a linked built-in dismisses it, so the offers change too.
      await refreshBuiltIns();
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

      {newBuiltIns.length > 0 && (
        <div className="pipeline-builtins" aria-label="New built-in workflows">
          <ul className="pipeline-list">
            {newBuiltIns.map(item => (
              <li key={item.id} className="pipeline-item">
                <div className="pipeline-item-text">
                  <span className="pipeline-item-name">New built-in workflow: {item.name}</span>
                  {item.description && <span className="pipeline-item-meta">{item.description}</span>}
                </div>
                <div className="pipeline-item-actions ui-item-actions">
                  <Button disabled={busy} aria-label={`Add built-in workflow ${item.name}`} onClick={() => {
                    const template = WORKFLOW_TEMPLATES.find(candidate => candidate.id === item.id);
                    if (!template) showToast({ type: 'error', message: `Built-in "${item.name}" is not shipped in this CodeDeck.` });
                    else void addBuiltin(template);
                  }}>Add</Button>
                  <Button disabled={busy} aria-label={`Dismiss built-in ${item.name}`} onClick={() => void dismissBuiltin(item)}>Dismiss</Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {workflows.length === 0 && <p className="pipeline-empty">No workflows yet.</p>}
      <ul className="pipeline-list">
        {workflows.map(workflow => (
          <li key={workflow.id} className="pipeline-item">
            <div className="pipeline-item-text">
              <span className="pipeline-item-name">{workflow.name}{workflow.kind !== 'other' && <span className="pipeline-kind">{WORKFLOW_KIND_LABELS[workflow.kind]}</span>}{sourceBadge(workflow)}</span>
              {workflow.description && <span className="pipeline-item-meta">{workflow.description}</span>}
              <span className="pipeline-item-meta">{summary(workflow)}</span>
            </div>
            <div className="pipeline-item-actions ui-item-actions">
              <IconButton aria-label={`Duplicate workflow ${workflow.name}`} title="Duplicate" disabled={busy} onClick={() => duplicate(workflow)}><Copy size={13} /></IconButton>
              <IconButton aria-label={`Edit workflow ${workflow.name}`} title="Edit" disabled={busy} onClick={() => open(workflow)}>
                <Pencil size={13} />
              </IconButton>
              <IconButton tone="danger" aria-label={`Delete workflow ${workflow.name}`} title="Delete" disabled={busy} onClick={() => remove(workflow)}>
                <Trash2 size={13} />
              </IconButton>
            </div>
          </li>
        ))}
      </ul>

      {editing === null ? (
        <>
          <Button variant="accent" disabled={busy} aria-expanded={choosing} onClick={() => setChoosing(value => !value)}>
            <Plus size={12} /> Add workflow
          </Button>
          <Button disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload size={12} /> Import…
          </Button>
          <input ref={fileRef} type="file" accept=".json,application/json" aria-label="Package file" hidden onChange={readPackageFile} />
          {choosing && <div className="pipeline-template-chooser" aria-label="Workflow starting point">
            <Button onClick={() => open(null)}>Blank</Button>
            {WORKFLOW_TEMPLATES.map(template => <Button key={template.id} onClick={() => chooseTemplate(template)}>
              <strong>{template.name}</strong><span>{template.description}</span>
            </Button>)}
            {templates.map(template => <span key={template.id} className="pipeline-saved-template">
              <Button onClick={() => chooseSaved(template)}>
                <strong>{template.name}</strong><span>{template.description || 'Saved by you'}</span>
              </Button>
              <IconButton tone="danger" aria-label={`Delete saved template ${template.name}`} title="Delete this saved template" disabled={busy} onClick={() => removeSaved('template', template.name, () => deleteTemplate(template.id))}><Trash2 size={13} /></IconButton>
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
                    <div className="pipeline-item-actions ui-item-actions">
                      <IconButton tone="danger" aria-label={`Delete saved step ${preset.name}`} title="Delete this saved step" disabled={busy} onClick={() => removeSaved('step', preset.name, () => deleteStepPreset(preset.id))}><Trash2 size={13} /></IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <WorkflowEditor
          key={opened}
          workflow={editing.workflow}
          roleHints={editing.roleHints}
          prefilled={editing.prefilled}
          roles={roles}
          variant={variant}
          stepPresets={stepPresets}
          onLibraryChanged={onChanged}
          onSaved={async () => { close(); await onChanged(); }}
          onChanged={onChanged}
          onCancel={close}
          onDirtyChange={reportDirty}
        />
      )}
      {importing !== null && (
        <ImportPreviewDialog
          importing={importing}
          existingNames={workflows.map(workflow => workflow.name)}
          onClose={() => setImporting(null)}
          onNameChange={name => setImporting(current => ({ ...current, name }))}
          onApply={applyImport}
        />
      )}
    </section>
  );
}
