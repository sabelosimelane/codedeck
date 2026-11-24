import React, { useCallback, useEffect, useState } from 'react';
import { Button, Field, TextInput } from '../ui/index.jsx';
import { BRANCH_NAME_RULE, isBranchName } from '../../../../shared/pipeline-definitions.mjs';
import { listTeams, updatePipelineSettings } from '../../utils/pipelinesApi';
import { loadDefinitions, parseTeam, parseSettings } from '../../utils/pipelineRecords';
import { useToast } from '../ToastContext';
import TeamList from './TeamList';
import AgentList from './AgentList';
import WorkflowList from './WorkflowList';
import { failureMessage } from './definitionForm';
import { openWorkflowBuilder } from '../../utils/workflowBuilder';
import './pipeline-settings.css';

/**
 * Settings → Workflows: agents, the setup agent and workflows. Nothing here is authoritative;
 * every change is sent to the backend and the lists are read back from it.
 */
export default function PipelineSettings({ onDirtyChange }) {
  const { showToast } = useToast();
  const [definitions, setDefinitions] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [savingSetupAgent, setSavingSetupAgent] = useState(false);
  // What the owner is typing as the default base branch; null while it is the saved value.
  const [baseDraft, setBaseDraft] = useState(null);
  const [savingBase, setSavingBase] = useState(false);
  const [teamDirty, setTeamDirty] = useState(false);
  const [agentsDirty, setAgentsDirty] = useState(false);
  const [workflowsDirty, setWorkflowsDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const [loaded, teams] = await Promise.all([loadDefinitions(), listTeams()]);
      setDefinitions({ ...loaded, teams: teams.map(parseTeam) });
      setLoadError(null);
    } catch (failure) {
      const message = failureMessage(failure);
      setLoadError(message);
      showToast({ type: 'error', message });
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { onDirtyChange(agentsDirty || workflowsDirty || teamDirty); }, [agentsDirty, workflowsDirty, teamDirty, onDirtyChange]);

  const changeSetupAgent = async (value) => {
    setSavingSetupAgent(true);
    try {
      const settings = parseSettings(await updatePipelineSettings({
        setupAgentId: value === '' ? null : value,
        defaultBaseBranch: definitions.settings.defaultBaseBranch,
        revision: definitions.settings.revision,
      }));
      setDefinitions(current => ({ ...current, settings }));
      showToast({ type: 'success', message: 'Setup agent saved' });
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      // The select shows the backend's value, so read it (and its revision) again.
      await load();
    } finally {
      setSavingSetupAgent(false);
    }
  };

  const savedBase = definitions?.settings.defaultBaseBranch ?? '';
  const typedBase = (baseDraft ?? savedBase).trim();
  const baseError = typedBase !== '' && !isBranchName(typedBase) ? BRANCH_NAME_RULE : null;
  const baseChanged = baseDraft !== null && typedBase !== savedBase;

  const saveDefaultBase = async () => {
    setSavingBase(true);
    try {
      const settings = parseSettings(await updatePipelineSettings({
        setupAgentId: definitions.settings.setupAgentId,
        defaultBaseBranch: typedBase === '' ? null : typedBase,
        revision: definitions.settings.revision,
      }));
      setDefinitions(current => ({ ...current, settings }));
      setBaseDraft(null);
      showToast({ type: 'success', message: settings.defaultBaseBranch === null ? 'Default base branch cleared' : 'Default base branch saved' });
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      await load();
    } finally {
      setSavingBase(false);
    }
  };

  return (
    <div className="pipeline-settings">
      {loadError && (
        <div className="pipeline-load-error">
          <span role="alert">{loadError}</span>
          <Button onClick={load}>Retry</Button>
        </div>
      )}
      {definitions === null && !loadError && <p className="pipeline-empty" role="status">Loading…</p>}

      {definitions !== null && (
        <>
          <TeamList definitions={definitions} onChanged={load} onDirtyChange={setTeamDirty} />
          <AgentList agents={definitions.agents} onChanged={load} onDirtyChange={setAgentsDirty} />

          <section className="pipeline-section">
            <h3>Setup agent</h3>
            <p className="pipeline-hint">
              Runs first in every run&apos;s new worktree: installs dependencies and copies the local files the project needs.
              A small, fast model is enough. A run cannot start until one is chosen.
            </p>
            <select
              className="ui-input"
              aria-label="Setup agent"
              value={definitions.settings.setupAgentId ?? ''}
              disabled={savingSetupAgent}
              onChange={event => changeSetupAgent(event.target.value)}
            >
              <option value="">No setup agent</option>
              {definitions.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </section>

          <section className="pipeline-section">
            <h3>Default base branch</h3>
            <p className="pipeline-hint">
              The branch a run&apos;s new task is cut from and merged back into, in every repository the task includes. Main is not
              switched: the task starts from that branch&apos;s latest local commit. The Run workflow dialog can name another for one run.
              Leave it empty to start from the branch Main is on.
            </p>
            <Field label="Default base branch" error={baseError}>
              <TextInput label="Default base branch" value={baseDraft ?? savedBase} onChange={setBaseDraft} maxLength={200}
                disabled={savingBase} invalid={Boolean(baseError)} placeholder="The branch Main is on" />
            </Field>
            <Button onClick={saveDefaultBase} disabled={!baseChanged || Boolean(baseError) || savingBase}
              aria-label="Save default base branch">{savingBase ? 'Saving…' : 'Save'}</Button>
          </section>

          <section className="pipeline-section">
            <h3>Workflow builder</h3>
            <p className="pipeline-hint">A full screen for building workflows: the steps side by side with the one you are editing, a large prompt editor, and a preview of exactly what the agent is sent.</p>
            <Button variant="accent" onClick={openWorkflowBuilder}>Open the workflow builder</Button>
          </section>

          <WorkflowList workflows={definitions.workflows} agents={definitions.agents} templates={definitions.templates} stepPresets={definitions.stepPresets} onChanged={load} onDirtyChange={setWorkflowsDirty} />
        </>
      )}
    </div>
  );
}
