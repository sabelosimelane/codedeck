import React, { useState } from 'react';
import { launchCommandEfforts } from '../../../../shared/agent-presets.mjs';
import { missingTeamRoles, requiredWorkflowRoles, teamMemberForRole, validateTeamBody } from '../../../../shared/pipeline-definitions.mjs';
import { deleteTeam, saveTeam } from '../../utils/pipelinesApi';
import { Button } from '../ui/index.jsx';
import { failureMessage, SelectField, TextField } from './definitionForm';

const blankMember = (role = '') => ({ role, agentId: '' });

function EffortField({ label, caption, value, agent, onChange }) {
  const efforts = agent ? launchCommandEfforts(agent.launchCommand) : [];
  return <SelectField label={label} caption={caption} value={value ?? ''} onChange={onChange}
    disabled={efforts.length === 0}
    title={agent ? (efforts.length ? undefined : 'Effort overrides require a preset with effort options') : 'Choose an agent first'}>
    <option value="">Agent's default</option>
    {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
  </SelectField>;
}

function teamCoverageSummary(team, workflows) {
  if (!workflows.length) return null;
  const covered = [];
  const uncovered = [];
  for (const workflow of workflows) {
    const enabledNodes = workflow.nodes.filter(node => node.enabled !== false);
    const missing = missingTeamRoles(enabledNodes, team);
    if (missing.length === 0) covered.push(workflow.name);
    else uncovered.push(`${workflow.name} (missing: ${missing.join(', ')})`);
  }
  if (uncovered.length === 0) return `Covers all ${covered.length} ${covered.length === 1 ? 'workflow' : 'workflows'}`;
  return `Covers ${covered.length}/${workflows.length} workflows · Needs roles for: ${uncovered.join('; ')}`;
}

export default function TeamList({ definitions: { teams, agents, workflows, roles = [] }, onChanged, onDirtyChange }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const roleNames = roles.map(role => role.name);
  const agentById = new Map(agents.map(agent => [agent.id, agent]));
  const agentLabel = (id, effort) => [agentById.get(id)?.name ?? 'Missing agent', effort].filter(Boolean).join(' · ');

  function edit(team) {
    setError('');
    setDraft(team);
    onDirtyChange(team !== null);
  }

  function changeMember(index, patch) {
    setDraft({ ...draft, members: draft.members.map((member, at) => at === index ? { ...member, ...patch } : member) });
  }

  function changeAgent(index, agentKey, effortKey, id) {
    const agent = agentById.get(id);
    const effort = draft.members[index][effortKey];
    const keepEffort = agent && launchCommandEfforts(agent.launchCommand).includes(effort);
    changeMember(index, { [agentKey]: id, [effortKey]: keepEffort ? effort : '' });
  }

  async function save() {
    // Every member states its fallback: the server keeps an omitted one for older clients,
    // which would bring back the fallback of a role removed and added again here.
    const previous = teams.find(team => team.id === draft.id);
    const members = draft.members.map(({ effort, fallbackEffort, ...member }) => {
      const saved = teamMemberForRole(previous, member.role);
      return {
        ...member, fallbackAgentId: member.fallbackAgentId ?? null,
        ...((effort || saved?.effort) && { effort: effort || null }),
        ...((fallbackEffort || saved?.fallbackEffort) && { fallbackEffort: fallbackEffort || null }),
      };
    });
    const body = { name: draft.name, members, ...(draft.id && { revision: draft.revision }) };
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

  const draftUsedRoles = new Set((draft?.members ?? []).map(member => member.role.trim().toLowerCase()).filter(Boolean));
  const workflowRoles = requiredWorkflowRoles(workflows.flatMap(workflow => workflow.nodes));
  const unstaffedWorkflowRoles = draft ? workflowRoles.filter(role => !draftUsedRoles.has(role.toLowerCase())) : [];

  return <section className="pipeline-section" aria-label="Teams">
    <h3>Teams</h3>
    <p className="pipeline-hint">Assign saved agents to structured workflow roles, then choose a compatible team when you start a run.</p>
    {draft ? <fieldset className="pipeline-section" disabled={busy}>
      <TextField label="Team name" caption="Team name" maxLength={64} value={draft.name} onChange={name => setDraft({ ...draft, name })} />
      {draft.members.map((member, index) => {
        const otherRoles = new Set(draft.members.filter((_, at) => at !== index).map(item => item.role.trim().toLowerCase()).filter(Boolean));
        const options = roleNames.includes(member.role) || !member.role ? roleNames : [member.role, ...roleNames];
        return <div className="pipeline-node-row pipeline-team-member" key={index}>
          <SelectField label={`Member ${index + 1} role`} caption="Role" value={member.role} onChange={role => changeMember(index, { role })}>
            <option value="">Choose a role</option>
            {options.map(role => <option key={role} value={role} disabled={otherRoles.has(role.toLowerCase())}>{role}</option>)}
          </SelectField>
          <div className="pipeline-node-row pipeline-team-agent">
            <SelectField label={`Member ${index + 1} agent`} caption="Agent" value={member.agentId}
              onChange={agentId => changeAgent(index, 'agentId', 'effort', agentId)}>
              <option value="">Choose an agent</option>
              {agents.map(agent => <option key={agent.id} value={agent.id} disabled={agent.id === member.fallbackAgentId}>{agent.name}</option>)}
            </SelectField>
            <EffortField label={`Member ${index + 1} effort`} caption="Effort" value={member.effort}
              agent={agentById.get(member.agentId)} onChange={effort => changeMember(index, { effort })} />
          </div>
          <div className="pipeline-node-row pipeline-team-agent">
            <SelectField label={`Member ${index + 1} fallback agent`} caption="Fallback agent" value={member.fallbackAgentId ?? ''}
              onChange={id => changeAgent(index, 'fallbackAgentId', 'fallbackEffort', id || null)}>
              <option value="">None</option>
              {agents.filter(agent => agent.id !== member.agentId).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </SelectField>
            <EffortField label={`Member ${index + 1} fallback effort`} caption="Fallback effort" value={member.fallbackEffort}
              agent={agentById.get(member.fallbackAgentId)} onChange={fallbackEffort => changeMember(index, { fallbackEffort })} />
          </div>
          <Button aria-label={`Remove member ${index + 1}`} disabled={draft.members.length === 1}
            onClick={() => setDraft({ ...draft, members: draft.members.filter((_, at) => at !== index) })}>Remove</Button>
        </div>;
      })}
      {unstaffedWorkflowRoles.length > 0 && <p className="pipeline-hint">
        Roles used by saved workflows not yet in this team: {unstaffedWorkflowRoles.join(', ')}.
      </p>}
      <div className="pipeline-item-actions">
        <Button disabled={draft.members.length >= 32} onClick={() => setDraft({ ...draft, members: [...draft.members, blankMember(unstaffedWorkflowRoles[0] ?? '')] })}>Add role</Button>
        <Button variant="accent" onClick={save}>Save team</Button>
        <Button onClick={() => edit(null)}>Cancel</Button>
      </div>
    </fieldset> : <>
      <ul className="pipeline-list">{teams.map(team => {
        const coverage = teamCoverageSummary(team, workflows);
        return <li className="pipeline-item" key={team.id}>
          <div className="pipeline-item-text">
            <strong>{team.name}</strong>
            <span className="pipeline-item-meta">{team.members.map(member => {
              const primary = `${member.role}: ${agentLabel(member.agentId, member.effort)}`;
              return member.fallbackAgentId ? `${primary} · Fallback: ${agentLabel(member.fallbackAgentId, member.fallbackEffort)}` : primary;
            }).join(' · ')}</span>
            {coverage && <span className="pipeline-item-meta">{coverage}</span>}
          </div>
          <div className="pipeline-item-actions">
            <Button aria-label={`Edit ${team.name}`} disabled={busy} onClick={() => edit(team)}>Edit</Button>
            <Button aria-label={`Delete ${team.name}`} disabled={busy} onClick={() => remove(team)}>Delete</Button>
          </div>
        </li>;
      })}</ul>
      <Button disabled={busy || agents.length === 0 || roles.length === 0} onClick={() => edit({ id: null, name: '', members: [blankMember()] })}>Add team</Button>
      {agents.length === 0 && <p className="pipeline-hint">Add an agent to create a team.</p>}
      {roles.length === 0 && <p className="pipeline-hint">Add a role to create a team.</p>}
    </>}
    {error && <p className="pipeline-field-error" role="alert">{error}</p>}
  </section>;
}
