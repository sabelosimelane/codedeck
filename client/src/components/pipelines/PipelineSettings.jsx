import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Field, TextInput } from '../ui/index.jsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { BRANCH_NAME_RULE, isBranchName, RUN_TIMEOUT_LIMITS, DEFAULT_RUN_TIMEOUTS } from '../../../../shared/pipeline-definitions.mjs';
import { listTeams, updatePipelineSettings } from '../../utils/pipelinesApi';
import { loadDefinitions, parseTeam, parseSettings } from '../../utils/pipelineRecords';
import { useToast } from '../ToastContext';
import RoleList from './RoleList';
import TeamList from './TeamList';
import AgentList from './AgentList';
import WorkflowList from './WorkflowList';
import { failureMessage } from './definitionForm';
import { openWorkflowBuilder } from '../../utils/workflowBuilder';
import './pipeline-settings.css';

/** The sections of Settings → Workflows, each behind its own tab, in the order they are shown. */
export const WORKFLOW_SUBTABS = [
  { id: 'workflows', label: 'Workflows' },
  { id: 'teams', label: 'Teams' },
  { id: 'roles', label: 'Roles' },
  { id: 'agents', label: 'Agents' },
  { id: 'defaults', label: 'Defaults' },
];
const subtabId = id => `pipeline-subtab-${id}`;
const subpanelId = id => `pipeline-subtabpanel-${id}`;
const NEXT_TAB_KEYS = { ArrowRight: 1, ArrowLeft: -1 };
const TIMEOUT_FIELDS = [
  ['agentReadySeconds', 'Agent ready (seconds)', 'Wait for the agent to reach its prompt before failing the step.', 's'],
  ['resetSettleSeconds', 'Reset settle (seconds)', 'Wait for a reset command to settle before failing the step.', 's'],
  ['finalSignalIdleSeconds', 'Final signal idle (seconds)', 'Wait while the agent is idle after being asked for its final signal.', 's'],
  ['lostPromptSeconds', 'Lost prompt (seconds)', 'Resend a prompt left idle and unchanged; then restart the terminal.', 's'],
  ['stallWarningMinutes', 'Stall warning (minutes)', 'Log a warning when a running step’s screen stays unchanged.', 'min'],
];

/**
 * Settings → Workflows: workflows, teams, roles, agents and the defaults, each on its own tab. Nothing here is authoritative;
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [timeoutDraft, setTimeoutDraft] = useState(null);
  const [savingTimeouts, setSavingTimeouts] = useState(false);
  const [rolesDirty, setRolesDirty] = useState(false);
  const [teamDirty, setTeamDirty] = useState(false);
  const [agentsDirty, setAgentsDirty] = useState(false);
  const [workflowsDirty, setWorkflowsDirty] = useState(false);
  // Every panel stays mounted while hidden, so a draft in one section survives a visit to another.
  const [activeTab, setActiveTab] = useState('workflows');
  const tabRefs = useRef({});

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

  const changeSetupAgent = async (value) => {
    setSavingSetupAgent(true);
    try {
      const settings = parseSettings(await updatePipelineSettings({
        setupAgentId: value === '' ? null : value,
        defaultBaseBranch: definitions.settings.defaultBaseBranch,
        timeouts: definitions.settings.timeouts,
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
  const savedTimeouts = definitions?.settings.timeouts;
  const displayedTimeouts = timeoutDraft ?? savedTimeouts;
  const timeoutErrors = Object.fromEntries(TIMEOUT_FIELDS.map(([field]) => {
    const { min, max } = RUN_TIMEOUT_LIMITS[field];
    const value = Number(displayedTimeouts?.[field]);
    return [field, displayedTimeouts?.[field] === '' || !Number.isInteger(value) || value < min || value > max
      ? `Use an integer from ${min} to ${max}` : null];
  }));
  const timeoutsChanged = timeoutDraft !== null && TIMEOUT_FIELDS.some(([field]) =>
    String(timeoutDraft[field]) !== String(savedTimeouts[field]));
  const timeoutsValid = Object.values(timeoutErrors).every(error => error === null);

  useEffect(() => {
    onDirtyChange(rolesDirty || agentsDirty || workflowsDirty || teamDirty || baseChanged || timeoutsChanged);
  }, [rolesDirty, agentsDirty, workflowsDirty, teamDirty, baseChanged, timeoutsChanged, onDirtyChange]);

  const tabDirty = { workflows: workflowsDirty, teams: teamDirty, roles: rolesDirty, agents: agentsDirty, defaults: baseChanged || timeoutsChanged };
  const tabCount = {
    workflows: definitions?.workflows.length,
    teams: definitions?.teams.length,
    roles: definitions?.roles.length,
    agents: definitions?.agents.length,
  };

  const selectTab = (id) => {
    setActiveTab(id);
    tabRefs.current[id]?.focus();
  };

  const onTabKeyDown = (event) => {
    const index = WORKFLOW_SUBTABS.findIndex(tab => tab.id === activeTab);
    let next = null;
    if (event.key in NEXT_TAB_KEYS) next = (index + NEXT_TAB_KEYS[event.key] + WORKFLOW_SUBTABS.length) % WORKFLOW_SUBTABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = WORKFLOW_SUBTABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    selectTab(WORKFLOW_SUBTABS[next].id);
  };

  const panelProps = id => ({
    role: 'tabpanel',
    id: subpanelId(id),
    'aria-labelledby': subtabId(id),
    hidden: activeTab !== id,
    className: 'pipeline-tabpanel',
  });

  const saveDefaultBase = async () => {
    setSavingBase(true);
    try {
      const settings = parseSettings(await updatePipelineSettings({
        setupAgentId: definitions.settings.setupAgentId,
        defaultBaseBranch: typedBase === '' ? null : typedBase,
        timeouts: definitions.settings.timeouts,
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

  const saveTimeouts = async () => {
    setSavingTimeouts(true);
    try {
      const settings = parseSettings(await updatePipelineSettings({
        setupAgentId: definitions.settings.setupAgentId,
        defaultBaseBranch: definitions.settings.defaultBaseBranch,
        timeouts: Object.fromEntries(TIMEOUT_FIELDS.map(([field]) => [field, Number(displayedTimeouts[field])])),
        revision: definitions.settings.revision,
      }));
      setDefinitions(current => ({ ...current, settings }));
      setTimeoutDraft(null);
      showToast({ type: 'success', message: 'Workflow timeouts saved' });
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      await load();
    } finally {
      setSavingTimeouts(false);
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
          <div className="pipeline-subtabs" role="tablist" aria-label="Workflow settings sections">
            {WORKFLOW_SUBTABS.map(tab => (
              <button
                key={tab.id}
                ref={element => { tabRefs.current[tab.id] = element; }}
                type="button"
                role="tab"
                id={subtabId(tab.id)}
                aria-selected={activeTab === tab.id}
                aria-controls={subpanelId(tab.id)}
                tabIndex={activeTab === tab.id ? 0 : -1}
                className="pipeline-subtab"
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={onTabKeyDown}
              >
                {tab.label}
                {tabCount[tab.id] !== undefined && <span className="pipeline-subtab-count">{tabCount[tab.id]}</span>}
                {tabDirty[tab.id] && <span className="pipeline-subtab-dirty" title="Unsaved changes" />}
              </button>
            ))}
          </div>

          <div {...panelProps('workflows')}>
            <section className="pipeline-section">
              <h3>Workflow builder</h3>
              <p className="pipeline-hint">A full screen for building workflows: the steps side by side with the one you are editing, a large prompt editor, and a preview of exactly what the agent is sent.</p>
              <Button variant="accent" onClick={openWorkflowBuilder}>Open the workflow builder</Button>
            </section>
            <WorkflowList workflows={definitions.workflows} roles={definitions.roles} templates={definitions.templates} stepPresets={definitions.stepPresets} onChanged={load} onDirtyChange={setWorkflowsDirty} />
          </div>

          <div {...panelProps('teams')}>
            <TeamList definitions={definitions} onChanged={load} onDirtyChange={setTeamDirty} />
          </div>
          <div {...panelProps('roles')}>
            <RoleList definitions={definitions} onChanged={load} onDirtyChange={setRolesDirty} />
          </div>
          <div {...panelProps('agents')}>
            <AgentList agents={definitions.agents} onChanged={load} onDirtyChange={setAgentsDirty} />
          </div>

          <div {...panelProps('defaults')}>
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
              <button type="button" className="pipeline-advanced-toggle" aria-expanded={advancedOpen}
                aria-controls="pipeline-timeout-settings" onClick={() => setAdvancedOpen(open => !open)}>
                {advancedOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}Advanced</button>
              {advancedOpen && <div id="pipeline-timeout-settings" className="pipeline-timeout-settings">
                <p className="pipeline-hint">Workflow run timing</p>
                {TIMEOUT_FIELDS.map(([field, label, help, unit]) => (
                  <div className="pipeline-timeout-field" key={field}>
                    <label htmlFor={`pipeline-timeout-${field}`}>{label}</label>
                    <input id={`pipeline-timeout-${field}`} type="number" className="ui-input"
                      min={RUN_TIMEOUT_LIMITS[field].min} max={RUN_TIMEOUT_LIMITS[field].max} step="1"
                      value={displayedTimeouts[field]} aria-invalid={Boolean(timeoutErrors[field])}
                      aria-describedby={`pipeline-timeout-help-${field}`}
                      onChange={event => setTimeoutDraft(current => ({ ...(current ?? savedTimeouts), [field]: event.target.value }))} />
                    <span id={`pipeline-timeout-help-${field}`} className="pipeline-hint">{help} Default: {RUN_TIMEOUT_LIMITS[field].default} {unit}.</span>
                    {timeoutErrors[field] && <span role="alert" className="pipeline-timeout-error">{timeoutErrors[field]}</span>}
                  </div>
                ))}
                <div className="pipeline-timeout-actions">
                  <Button onClick={() => setTimeoutDraft({ ...DEFAULT_RUN_TIMEOUTS })} disabled={savingTimeouts}>Restore defaults</Button>
                  <Button onClick={saveTimeouts} disabled={!timeoutsChanged || !timeoutsValid || savingTimeouts}
                    aria-label="Save timeouts">{savingTimeouts ? 'Saving…' : 'Save'}</Button>
                </div>
              </div>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
