import React, { useState } from 'react';
import { validateTeamBody } from '../../../../shared/pipeline-definitions.mjs';
import { deleteTeam, saveTeam } from '../../utils/pipelinesApi';
import { Button } from '../ui/index.jsx';
import { failureMessage, SelectField, TextField } from './definitionForm';

const blankMember = () => ({ role: '', agentId: '' });

export default function TeamList({ definitions: { teams, agents, workflows }, onChanged, onDirtyChange }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const roles = [...new Set(workflows.flatMap(workflow => workflow.nodes.map(node => node.role)).filter(Boolean))].sort();

  function edit(team) {
    setError('');
    setDraft(team);
    onDirtyChange(team !== null);
  }

  function changeMember(index, patch) {
    setDraft({ ...draft, members: draft.members.map((member, at) => at === index ? { ...member, ...patch } : member) });
  }

  async function save() {
    const body = { name: draft.name, members: draft.members, ...(draft.id && { revision: draft.revision }) };
    const errors = validateTeamBody(body, { revisionRequired: draft.id !== null });
    if (errors.length) {
      setError(errors.map(item => `${item.field}: ${item.message}`).join('. '));
      return;
    }
    setBusy(true);
    try {
      await saveTeam(draft.id, body);
      await onChanged();
      edit(null);
    } catch (failure) {
      setError(failureMessage(failure));
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove(team) {
    if (!window.confirm(`Delete team “${team.name}”?`)) return;
    setBusy(true);
    setError('');
    try {
      await deleteTeam(team.id);
      await onChanged();
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <section className="pipeline-section" aria-label="Teams">
    <h3>Teams</h3>
    <p className="pipeline-hint">Assign saved agents to workflow roles, then choose a team when you start a run.</p>
    {draft ? <fieldset className="pipeline-section" disabled={busy}>
      <TextField label="Team name" caption="Team name" maxLength={64} value={draft.name} onChange={name => setDraft({ ...draft, name })} />
      <datalist id="pipeline-team-roles">{roles.map(role => <option key={role} value={role} />)}</datalist>
      {draft.members.map((member, index) => <div className="pipeline-node-row" key={index}>
        <TextField label={`Member ${index + 1} role`} caption="Workflow role" maxLength={32} list="pipeline-team-roles" placeholder="e.g. Developer"
          value={member.role} onChange={role => changeMember(index, { role })} />
        <SelectField label={`Member ${index + 1} agent`} caption="Agent" value={member.agentId} onChange={agentId => changeMember(index, { agentId })}>
          <option value="">Choose an agent</option>
          {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </SelectField>
        <Button aria-label={`Remove member ${index + 1}`} disabled={draft.members.length === 1}
          onClick={() => setDraft({ ...draft, members: draft.members.filter((_, at) => at !== index) })}>Remove</Button>
      </div>)}
      <div className="pipeline-item-actions">
        <Button disabled={draft.members.length >= 32} onClick={() => setDraft({ ...draft, members: [...draft.members, blankMember()] })}>Add role</Button>
        <Button variant="accent" onClick={save}>Save team</Button>
        <Button onClick={() => edit(null)}>Cancel</Button>
      </div>
    </fieldset> : <>
      <ul className="pipeline-list">{teams.map(team => <li className="pipeline-item" key={team.id}>
        <div className="pipeline-item-text">
          <strong>{team.name}</strong>
          <span className="pipeline-item-meta">{team.members.map(member => `${member.role}: ${agents.find(agent => agent.id === member.agentId)?.name ?? 'Missing agent'}`).join(' · ')}</span>
        </div>
        <div className="pipeline-item-actions">
          <Button aria-label={`Edit ${team.name}`} disabled={busy} onClick={() => edit(team)}>Edit</Button>
          <Button aria-label={`Delete ${team.name}`} disabled={busy} onClick={() => remove(team)}>Delete</Button>
        </div>
      </li>)}</ul>
      <Button disabled={busy || agents.length === 0} onClick={() => edit({ id: null, name: '', members: [blankMember()] })}>Add team</Button>
      {agents.length === 0 && <p className="pipeline-hint">Add an agent to create a team.</p>}
    </>}
    {error && <p className="pipeline-field-error" role="alert">{error}</p>}
  </section>;
}
