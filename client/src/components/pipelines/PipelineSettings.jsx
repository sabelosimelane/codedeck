import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/index.jsx';
import { updatePipelineSettings } from '../../utils/pipelinesApi';
import { loadDefinitions, parseSettings } from '../../utils/pipelineRecords';
import { useToast } from '../ToastContext';
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
  const [agentsDirty, setAgentsDirty] = useState(false);
  const [workflowsDirty, setWorkflowsDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      setDefinitions(await loadDefinitions());
      setLoadError(null);
    } catch (failure) {
      const message = failureMessage(failure);
      setLoadError(message);
      showToast({ type: 'error', message });
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { onDirtyChange(agentsDirty || workflowsDirty); }, [agentsDirty, workflowsDirty, onDirtyChange]);

  const changeSetupAgent = async (value) => {
    setSavingSetupAgent(true);
    try {
      const settings = parseSettings(await updatePipelineSettings({
        setupAgentId: value === '' ? null : value,
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
