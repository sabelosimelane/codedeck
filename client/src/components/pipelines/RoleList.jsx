import React, { useState } from 'react';
import { validateRoleBody } from '../../../../shared/pipeline-definitions.mjs';
import { deleteRole, saveRole } from '../../utils/pipelinesApi';
import { Button } from '../ui/index.jsx';
import { failureMessage, TextField } from './definitionForm';

function roleUsage(roleName, { workflows = [], teams = [], templates = [], stepPresets = [] }) {
  const key = roleName.trim().toLowerCase();
  const parts = [];
  const wfCount = workflows.filter(w => w.nodes.some(n => n.role.toLowerCase() === key)).length;
  if (wfCount) parts.push(`${wfCount} ${wfCount === 1 ? 'workflow' : 'workflows'}`);
  const teamCount = teams.filter(t => t.members.some(m => m.role.toLowerCase() === key)).length;
  if (teamCount) parts.push(`${teamCount} ${teamCount === 1 ? 'team' : 'teams'}`);
  const tplCount = templates.filter(t => t.nodes.some(n => n.role.toLowerCase() === key)).length;
  if (tplCount) parts.push(`${tplCount} ${tplCount === 1 ? 'template' : 'templates'}`);
  const presetCount = stepPresets.filter(p => p.role.toLowerCase() === key).length;
  if (presetCount) parts.push(`${presetCount} ${presetCount === 1 ? 'saved step' : 'saved steps'}`);
  return parts;
}

export default function RoleList({ definitions: { roles = [], workflows = [], teams = [], templates = [], stepPresets = [] }, onChanged, onDirtyChange }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function edit(role) {
    setError('');
    setDraft(role ? { id: role.id, name: role.name, description: role.description ?? '', revision: role.revision } : null);
    onDirtyChange(role !== null);
  }

  async function save() {
    const body = {
      name: draft.name,
      description: draft.description,
      ...(draft.id && { revision: draft.revision }),
    };
    const errors = validateRoleBody(body, { revisionRequired: draft.id !== null });
    if (errors.length) {
      setError(errors.map(item => `${item.field}: ${item.message}`).join('. '));
      return;
    }
    setBusy(true);
    try {
      await saveRole(draft.id, body);
      await onChanged();
      edit(null);
    } catch (failure) {
      setError(failureMessage(failure));
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove(role) {
    if (!window.confirm(`Delete role “${role.name}”?`)) return;
    setBusy(true);
    setError('');
    try {
      await deleteRole(role.id);
      await onChanged();
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <section className="pipeline-section" aria-label="Roles">
    <h3>Roles</h3>
    <p className="pipeline-hint">Structured roles define what each workflow step requires and what a team must staff to run it.</p>
    {draft ? <fieldset className="pipeline-section" disabled={busy}>
      <TextField label="Role name" caption="Role name" maxLength={32} value={draft.name} onChange={name => setDraft({ ...draft, name })} placeholder="e.g. Architect" />
      <TextField label="Role description" caption="Description (optional)" maxLength={280} value={draft.description} onChange={description => setDraft({ ...draft, description })} placeholder="What this role is responsible for" />
      <div className="pipeline-item-actions">
        <Button variant="accent" onClick={save}>Save role</Button>
        <Button onClick={() => edit(null)}>Cancel</Button>
      </div>
    </fieldset> : <>
      <ul className="pipeline-list">{roles.map(role => {
        const usedBy = roleUsage(role.name, { workflows, teams, templates, stepPresets });
        return <li className="pipeline-item" key={role.id}>
          <div className="pipeline-item-text">
            <strong>{role.name}</strong>
            {role.description && <span className="pipeline-item-meta">{role.description}</span>}
            <span className="pipeline-item-meta">{usedBy.length ? `Used by ${usedBy.join(' · ')}` : 'Not used yet'}</span>
          </div>
          <div className="pipeline-item-actions">
            <Button aria-label={`Edit role ${role.name}`} disabled={busy} onClick={() => edit(role)}>Edit</Button>
            <Button aria-label={`Delete role ${role.name}`} disabled={busy || usedBy.length > 0}
              title={usedBy.length > 0 ? `Used by ${usedBy.join(', ')}` : undefined}
              onClick={() => remove(role)}>Delete</Button>
          </div>
        </li>;
      })}</ul>
      <Button disabled={busy} onClick={() => edit({ id: null, name: '', description: '' })}>New role</Button>
    </>}
    {error && <p className="pipeline-field-error" role="alert">{error}</p>}
  </section>;
}
