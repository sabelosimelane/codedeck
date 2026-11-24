import React, { useEffect, useState } from 'react';
import { firstReassignableStep, missingTeamRoles } from '../../../../shared/pipeline-definitions.mjs';
import { changeRunTeam, listAgents, listTeams } from '../../utils/pipelinesApi';
import { parseAgent, parseTeam } from '../../utils/pipelineRecords';
import { Button, Dialog, Field, Note, Select } from '../ui/index.jsx';

function AssignmentDialog({ run, onClose }) {
  const [choices, setChoices] = useState(null);
  const [teamId, setTeamId] = useState('');
  const [overrides, setOverrides] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    Promise.all([listTeams(options), listAgents(options)]).then(([teams, agents]) => {
      if (!controller.signal.aborted) setChoices({ teams: teams.map(parseTeam), agents: agents.map(parseAgent) });
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, []);

  const steps = run.steps.slice(firstReassignableStep(run.steps, run.currentStepIndex)).filter(step => step.kind === 'node');
  const team = choices?.teams.find(item => item.id === teamId);
  const teamMissing = choices ? new Map(choices.teams.map(item => [item.id, missingTeamRoles(steps, item)])) : new Map();
  const teamCompatible = !team || (teamMissing.get(team.id)?.length ?? 0) === 0;
  const assignedName = step => {
    if (!team || !step.role) return step.nextAgentName ?? step.agentName;
    const member = team.members.find(item => item.role.toLowerCase() === step.role.toLowerCase());
    return choices.agents.find(agent => agent.id === member?.agentId)?.name;
  };
  const ready = choices && teamCompatible && (team || Object.keys(overrides).length > 0)
    && steps.every(step => Object.hasOwn(overrides, step.name) || assignedName(step));
  async function apply() {
    setBusy(true);
    setError('');
    try {
      await changeRunTeam(run.id, {
        expectedUpdatedAt: run.updatedAt,
        ...(teamId && { teamId }),
        ...(Object.keys(overrides).length > 0 && { stepOverrides: overrides }),
      });
      onClose();
    } catch (failure) {
      setError(failure.errors?.map(item => item.message).join('. ') || failure.message);
      setBusy(false);
    }
  }
  return <Dialog title="Change team" onClose={onClose} busy={busy}
    subtitle="Choose agents for the remaining work, including repeat rounds. Resume when you’re ready."
    footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button>
      <Button variant="primary" disabled={!ready || busy} onClick={apply}>Apply to run</Button></>}>
    {error && <Note tone="danger" role="alert">{error}</Note>}
    {!choices && !error && <span role="status">Loading teams…</span>}
    {choices && <>
      <Field label="Team"><Select label="Team" value={teamId} disabled={busy} onChange={id => { setTeamId(id); setOverrides({}); }}>
        <option value="">Current run assignments</option>
        {choices.teams.map(item => {
          const missing = teamMissing.get(item.id) ?? [];
          const incompatible = missing.length > 0;
          return <option key={item.id} value={item.id} disabled={incompatible}>
            {incompatible ? `${item.name} — missing: ${missing.join(', ')}` : item.name}
          </option>;
        })}
      </Select></Field>
      {choices.teams.length === 0 && <Note>Create a team in Settings → Workflows, or choose an agent for a step below.</Note>}
      {steps.map(step => <Field key={step.index} label={[step.name, step.role, step.index < run.currentStepIndex && 'next round'].filter(Boolean).join(' · ')}>
        <Select label={`${step.name} agent`} disabled={busy} value={Object.hasOwn(overrides, step.name) ? overrides[step.name] : ''}
          onChange={value => setOverrides(current => {
            const next = { ...current, [step.name]: value };
            if (!value) delete next[step.name];
            return next;
          })}>
          <option value="">{assignedName(step) || 'Choose an agent'}</option>
          {choices.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </Select>
      </Field>)}
    </>}
  </Dialog>;
}

/** `disabledReason`: why the team cannot be changed now (the run is working); the button stays in view with it as its title. */
export default function ChangeRunTeam({ run, disabledReason = null }) {
  const [editing, setEditing] = useState(null);
  return <>
    <button type="button" onClick={() => setEditing(run)} disabled={disabledReason !== null} title={disabledReason ?? undefined}>Change team</button>
    {editing && <AssignmentDialog run={editing} onClose={() => setEditing(null)} />}
  </>;
}
