import React, { useEffect, useRef, useState } from 'react';
import { cleanupRun, getPipelineSettings, listTeams, listAgents, listWorkflows, listWorktrees, planRun, preflightProject } from '../../utils/pipelinesApi';
import { listProjectRepositories } from '../../utils/projectRepositoriesApi.js';
import { listWorktreeCandidates, makeTaskFromWorktree } from '../../utils/tasksApi.js';
import { useToast } from '../ToastContext';
import { parseTeam, parseAgent, parseWorkflow, parsePreflight, parseRunPlan, parseSettings, parseWorktree } from '../../utils/pipelineRecords';
import { openWorkflowBuilder } from '../../utils/workflowBuilder';
import { assignedAgentId, BRANCH_NAME_RULE, composePrompt, isBranchName, isProgressFilePath, isTeamCompatible, loopTargetIndex, missingTeamRoles, requiredWorkflowRoles, runInputMode, teamMemberForRole, validateRunInputField, WORKFLOW_KIND_LABELS } from '../../../../shared/pipeline-definitions.mjs';
import { Button, Dialog, Field, Note, SegmentedControl, Select, TextArea, TextInput } from '../ui/index.jsx';
import { TASK_TITLE_MAX, TaskRepositories, TaskTitleInput } from '../tasks/NewTaskFields.jsx';
import WorktreeCandidatePicker from '../tasks/WorktreeCandidatePicker.jsx';
import WorkflowAttachments from './WorkflowAttachments';
import SyncConflictDialog from '../SyncConflictDialog.jsx';
import { EffortField } from './definitionForm';
import { launchCommandEfforts } from '../../../../shared/agent-presets.mjs';

function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Where a run works: a task created for it, an open task, or directly in Main.
const NEW_TASK = 'new';
const OPEN_TASK = 'task';
const EXISTING_WORKTREE = 'existing-worktree';
const MAIN = 'main';
// Setup prepares the copy of the project a new task gets, so only a new task needs a setup agent.
const SETUP_AGENT_MISSING = 'setup_agent_missing';

function placeLabel(name, worktree) {
  if (!worktree) return `${name} — its files are no longer on disk`;
  const parts = [name];
  if (worktree.dirty) parts.push('uncommitted changes');
  return worktree.reason ? `${parts.join(' · ')} — ${worktree.reason.message}` : parts.join(' · ');
}

const OPEN_STATES = ['active', 'pr_open'];
// How long the owner stops typing before the todo is looked up.
const PLAN_DELAY_MS = 400;

/** Another repository's own todo can be started as a run when it is committed in a repository of the project and fits the workflow. */
const startable = entry => entry.role === 'todo' && entry.listed && entry.input !== null && entry.present === true;

function failureText(error) {
  const details = Array.isArray(error?.errors) ? error.errors.map(field => field?.message).filter(Boolean) : [];
  return details.length ? details.join(' ') : error?.message || 'The server did not confirm the start.';
}

function requireStarted(run) {
  if (typeof run?.id !== 'string' || !run.id) throw new Error('The server did not confirm the start. Retry the same submission.');
}

/**
 * `repositories`: the other repositories the project lists, beside its own. With any, the
 * owner also says which repository the run starts in, and which ones a new task includes. The todo
 * a new task works from can say this itself in its Repositories line; what it says is filled in
 * for the owner to change, and nothing starts before Start.
 */
export default function RunWorkflowDialog({ projectName, host = 'local', locations = [], repositories = [], tasks = [], defaultTaskId = null, initialInput = '', initialRequestId, planDelay = PLAN_DELAY_MS, onClose, onStart }) {
  const { showToast } = useToast();
  const [selectedHost, setSelectedHost] = useState(host || 'local');
  const explicitHost = selectedHost && (selectedHost !== 'local' || locations.length > 1) ? selectedHost : undefined;
  const hostOption = explicitHost ? { host: explicitHost } : undefined;
  const [syncConflict, setSyncConflict] = useState(null);
  const [syncProceeding, setSyncProceeding] = useState(false);
  const [workflows, setWorkflows] = useState([]);
  const [teams, setTeams] = useState([]);
  const [agents, setAgents] = useState([]);
  const [teamId, setTeamId] = useState('');
  const [overrides, setOverrides] = useState({});
  const [stepEnabledOverrides, setStepEnabledOverrides] = useState({});
  const [workflowId, setWorkflowId] = useState('');
  const [input, setInput] = useState(initialInput);
  const [preflight, setPreflight] = useState(null);
  const [worktrees, setWorktrees] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [candidatePath, setCandidatePath] = useState(null);
  const [adoptedTask, setAdoptedTask] = useState(null);
  // Where the owner chose to work and in which task; null until they choose, and the dialog then
  // opens on the task they are looking at when it can take a run, or on a new task.
  const [place, setPlace] = useState(null);
  const [taskId, setTaskId] = useState(null);
  const [title, setTitle] = useState('');
  // The branch a new task is cut from, when the owner names one for this run; empty takes the default.
  const [baseBranch, setBaseBranch] = useState('');
  const [defaultBaseBranch, setDefaultBaseBranch] = useState(null);
  // The project's repositories as Git sees them now; empty for a project with only its own.
  const [projectRepositories, setProjectRepositories] = useState([]);
  // The repository the run starts in, when the owner picked one; the ones a new task also includes.
  const [startChoice, setStartChoice] = useState(null);
  const [included, setIncluded] = useState(new Set());
  // What the todo's Repositories line asks for, as the backend read it; the repositories whose own todo also gets a run.
  const [plan, setPlan] = useState(null);
  const [planFailure, setPlanFailure] = useState(null);
  const [extras, setExtras] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [checkingFiles, setCheckingFiles] = useState(false);
  const [submission, setSubmission] = useState(null);
  const [startFailure, setStartFailure] = useState(null);
  const [reservation, setReservation] = useState(null);
  const nextRequestId = useRef(initialRequestId);
  const busy = useRef(false);
  const selectedWorkflow = workflows.find(workflow => workflow.id === workflowId);

  const nodes = selectedWorkflow?.nodes ?? [];
  const isStepEnabled = node => (Object.hasOwn(stepEnabledOverrides, node.name) ? stepEnabledOverrides[node.name] : node.enabled !== false);
  const activeNodes = nodes.filter(isStepEnabled);
  const disabledStepNames = nodes.filter(node => !isStepEnabled(node)).map(node => node.name);
  const brokenLoop = activeNodes.find((node, index) => node.repeat.mode === 'loop_back' && loopTargetIndex(activeNodes, index) < 0) ?? null;
  const requiredRoles = requiredWorkflowRoles(activeNodes);
  const teamMissing = new Map(teams.map(item => [item.id, missingTeamRoles(activeNodes, item)]));
  const compatibleTeams = teams.filter(item => (teamMissing.get(item.id)?.length ?? 0) === 0);
  const selectedTeam = teams.find(item => item.id === teamId) ?? null;
  const team = selectedTeam && isTeamCompatible(activeNodes, selectedTeam) ? selectedTeam : null;
  const agentById = new Map(agents.map(agent => [agent.id, agent]));
  const missing = team ? activeNodes.filter(node => !agentById.has(assignedAgentId(node, team, overrides))) : activeNodes;
  const assignment = {
    ...(team && { teamId: team.id }),
    ...(Object.keys(overrides).length > 0 && { stepOverrides: overrides }),
    ...(Object.keys(stepEnabledOverrides).length > 0 && { disabledSteps: disabledStepNames }),
  };

  // Auto-select the first compatible team when loading, switching workflows, or toggling steps
  // makes the previous choice incompatible.
  const compatibleTeamKey = compatibleTeams.map(item => item.id).join(',');
  useEffect(() => {
    if (!selectedWorkflow) return;
    if (teamId && compatibleTeams.some(item => item.id === teamId)) return;
    setTeamId(compatibleTeams[0]?.id ?? '');
    setOverrides({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, compatibleTeamKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [nextWorkflows, preflightResponse, nextTeams, nextAgents, settingsResponse] = await Promise.all([
          listWorkflows(),
          preflightProject(projectName, { host: selectedHost }), listTeams(), listAgents(), getPipelineSettings(),
        ]);
        const nextSettings = parseSettings(settingsResponse);
        const nextPreflight = parsePreflight(preflightResponse);
        // Worktrees exist only for a local git project; a missing setup agent does not change that.
        const listable = nextPreflight.reasons.every(reason => reason.code === SETUP_AGENT_MISSING);
        const nextWorktrees = listable ? (await listWorktrees(projectName, hostOption)).map(parseWorktree) : [];
        const [nextRepositories, nextCandidates] = listable ? await Promise.all([
          repositories.length > 0 ? listProjectRepositories(projectName, hostOption) : [], listWorktreeCandidates(projectName, hostOption),
        ]) : [[], []];
        if (cancelled) return;
        setDefaultBaseBranch(nextSettings.defaultBaseBranch);
        setWorkflows(nextWorkflows.map(parseWorkflow));
        setTeams(nextTeams.map(parseTeam));
        setAgents(nextAgents.map(parseAgent));
        setPreflight(nextPreflight);
        setWorktrees(nextWorktrees);
        setProjectRepositories(nextRepositories);
        setCandidates(nextCandidates);
        if (nextWorkflows.length > 0) setWorkflowId(nextWorkflows[0].id);
      } catch (failure) {
        if (!cancelled) setError(failure.message || 'Failed to load workflows');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectName, selectedHost, repositories.length]);

  const projectTasks = [...tasks.filter(task => task.project === projectName), ...(adoptedTask ? [adoptedTask] : [])];
  const candidate = candidates.find(entry => entry.path === candidatePath && entry.selectable) ?? candidates.find(entry => entry.selectable) ?? null;
  const home = worktrees.find(worktree => worktree.current) ?? null;
  const several = projectRepositories.length > 1;
  const ownRepository = projectRepositories.find(entry => entry.own) ?? null;
  // The worktrees this dialog knows are those of the project's own repository. A task that started in
  // another repository is not among them: the backend says whether it can take a run.
  const startsElsewhere = task => task.worktrees.find(worktree => worktree.first).own === false;
  const worktreeOf = task => (task.id === adoptedTask?.id
    ? { path: task.worktreePath, dirty: candidate?.uncommittedCount > 0, selectable: true, reason: null }
    : startsElsewhere(task)
    ? { path: task.worktreePath, dirty: false, selectable: true, reason: null }
    : worktrees.find(worktree => worktree.path === task.worktreePath) ?? null);
  const takesRun = task => worktreeOf(task)?.selectable === true;
  // The task the owner is looking at is offered first only when a run can start in it.
  const viewedTask = projectTasks.find(task => task.id === defaultTaskId && takesRun(task)) ?? null;
  const asked = place ?? (viewedTask ? OPEN_TASK : NEW_TASK);
  // A task that was open when the dialog opened may have been finished since; then the run goes to a new one.
  const chosenTask = asked === OPEN_TASK ? projectTasks.find(task => task.id === taskId) ?? viewedTask ?? projectTasks.find(takesRun)
    ?? projectTasks.find(task => task.id === defaultTaskId) ?? projectTasks[0] ?? null : null;
  const where = asked === OPEN_TASK ? (chosenTask ? OPEN_TASK : NEW_TASK) : asked;
  // Where the run can start: the repositories of the project for a new task and for Main, the open ones of the task for an open task.
  const openParts = where === OPEN_TASK ? chosenTask.worktrees.filter(worktree => OPEN_STATES.includes(worktree.state)) : [];
  const startOptions = where === OPEN_TASK
    ? (openParts.length > 1 ? openParts.map(worktree => ({ name: worktree.repository, usable: true, label: worktree.repository })) : [])
    : where === EXISTING_WORKTREE ? [] : several ? projectRepositories.map(entry => ({
      name: entry.name, usable: entry.usable, path: entry.path, own: entry.own,
      // Where a new task's copy starts from is said in its list of repositories, below.
      label: entry.usable ? entry.name : `${entry.name} — ${entry.reason.message}`,
    })) : [];
  // A new task starts where its todo is, when the backend found it in one of the project's repositories.
  const plannedStart = where === NEW_TASK && plan?.foundIn ? startOptions.find(option => option.name === plan.foundIn && option.usable) : undefined;
  const startDefault = where === OPEN_TASK ? startOptions[0] : plannedStart ?? startOptions.find(option => option.own && option.usable) ?? startOptions.find(option => option.usable);
  const start = startOptions.find(option => option.name === startChoice && option.usable) ?? startDefault ?? null;
  // In Main a run works in the own checkout of the repository chosen; the project's own is what Main always was.
  const mainElsewhere = where === MAIN && start !== null && !start.own;
  const chosenWorktree = where === OPEN_TASK ? worktreeOf(chosenTask)
    : where === EXISTING_WORKTREE ? candidate
      : where === MAIN ? (mainElsewhere ? { path: start.path, dirty: false, selectable: true, reason: null } : home) : null;
  const alsoIncluded = where === NEW_TASK && start ? projectRepositories.filter(entry => entry.name !== start.name && entry.usable && included.has(entry.name)).map(entry => entry.name) : [];
  // A title is sent only when the owner typed one. Without it the backend calls the task after
  // the input and names it from the run's work, with the CLI chosen for session naming.
  const typedTitle = title.trim().slice(0, TASK_TITLE_MAX).trim();
  // A base branch is sent only when the owner typed one; the backend applies the default otherwise.
  const typedBase = where === NEW_TASK ? baseBranch.trim() : '';
  const baseError = typedBase !== '' && !isBranchName(typedBase) ? BRANCH_NAME_RULE : null;
  const effectiveBase = typedBase || defaultBaseBranch || preflight?.branch || null;
  const reasons = (preflight?.reasons ?? []).filter(reason => !(where !== NEW_TASK && reason.code === SETUP_AGENT_MISSING));
  const listable = (preflight?.reasons ?? []).every(reason => reason.code === SETUP_AGENT_MISSING);
  const placeUsable = where === NEW_TASK ? typedTitle.length > 0 || input.trim().length > 0 : Boolean(chosenWorktree?.selectable);
  const eligible = preflight !== null && reasons.length === 0 && placeUsable;
  const pathInput = runInputMode(selectedWorkflow?.progressFile) === 'path';
  const invalidPath = pathInput && input.trim().length > 0
    && !isProgressFilePath(composePrompt(selectedWorkflow.progressFile, input), 512);
  const inputError = validateRunInputField(input, { mode: pathInput ? 'path' : 'descriptive' })
    ?? (invalidPath ? 'Enter the part of the Markdown path that replaces {input} in the Progress file.' : null);
  const inputRequired = pathInput || activeNodes.some(node => node.prompt.includes('{input}'));
  const locked = starting || submission !== null;
  const canStart = !starting && !checkingFiles && (submission !== null
    || (!loading && eligible && Boolean(workflowId) && Boolean(team) && activeNodes.length > 0 && !brokenLoop && missing.length === 0 && !inputError && !baseError && (!inputRequired || input.trim().length > 0)));

  // The todo is looked up for a new task of a workflow that reads a Progress file, in a project with several repositories.
  const wantsPlan = !loading && !error && !inputError && several && where === NEW_TASK && Boolean(selectedWorkflow?.progressFile) && input.trim().length > 0;
  useEffect(() => {
    setPlan(null);
    setPlanFailure(null);
    if (!wantsPlan) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const next = parseRunPlan(await planRun({
          workflowId,
          project: projectName,
          input,
          ...(explicitHost ? { host: explicitHost } : {}),
        }, { signal: controller.signal }));
        if (controller.signal.aborted) return;
        setPlan(next);
        if (next.repositories !== null) {
          setIncluded(new Set(next.repositories.filter(entry => entry.role === 'minor' && entry.listed).map(entry => entry.repository)));
          setExtras(new Set(next.repositories.filter(startable).map(entry => entry.repository)));
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        setPlanFailure(failure.message || 'Something went wrong. Please try again.');
      }
    }, planDelay);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [wantsPlan, workflowId, input, projectName, planDelay]);

  const planned = where === NEW_TASK && plan?.repositories ? plan.repositories : [];
  // The other repositories that have a todo of their own, and the ones of them that get a run when Start is pressed.
  const otherTodos = planned.filter(entry => entry.role === 'todo' && entry.repository !== start?.name);
  const extraRuns = otherTodos.filter(entry => startable(entry) && extras.has(entry.repository));
  const unlistedMinor = planned.filter(entry => entry.role === 'minor' && !entry.listed);
  const whyNot = entry => (!entry.listed ? `${entry.repository} is not one of this project's repositories.`
    : entry.input === null ? `${entry.todo} does not fit this workflow's Progress file, ${selectedWorkflow.progressFile}.`
      : `${entry.todo} is not committed in ${entry.repository}.`);

  function draftSubmission() {
    const requestId = nextRequestId.current ?? newRequestId();
    nextRequestId.current = undefined;
    return {
      primary: {
        ...assignment,
        requestId,
        workflowId,
        input,
        ...(attachments.length > 0 ? { files: attachments.map(entry => entry.file) } : {}),
        ...(where === EXISTING_WORKTREE ? {} : where === NEW_TASK ? {
          newTask: { ...(typedTitle ? { title: typedTitle } : {}), ...(start ? { repositories: [start.name, ...alsoIncluded] } : {}), ...(typedBase ? { baseBranch: typedBase } : {}) },
          ...(start ? { startIn: start.name } : {}),
        }
          : where === OPEN_TASK ? { taskId: chosenTask.id, ...(start ? { startIn: start.name } : {}) }
            : { worktreePath: chosenWorktree.path }),
        ...(explicitHost ? { host: explicitHost } : {}),
      },
      extras: extraRuns.map(entry => ({ ...assignment, requestId: newRequestId(), workflowId, input: entry.input,
        ...(explicitHost ? { host: explicitHost } : {}),
        newTask: { repositories: [entry.repository], ...(typedBase ? { baseBranch: typedBase } : {}) }, startIn: entry.repository })),
    };
  }

  const handleStart = async () => {
    if (!canStart || busy.current) return;
    busy.current = true;
    let attempt = submission ?? draftSubmission();
    setStarting(true);
    setStartFailure(null);
    try {
      if (where === EXISTING_WORKTREE && submission === null) {
        try {
          const made = await makeTaskFromWorktree({ project: projectName, worktreePath: candidate.path,
            ...(typedTitle ? { title: typedTitle } : {}),
            ...(explicitHost ? { host: explicitHost } : {}) });
          setAdoptedTask(made);
          showToast({ type: 'success', message: `Task “${made.title}” made from ${candidate.name}` });
          attempt = { ...attempt, primary: { ...attempt.primary, taskId: made.id,
            ...(several ? { startIn: candidate.repository } : {}) } };
        } catch (failure) {
          const message = failureText(failure);
          setStartFailure(message);
          showToast({ type: 'error', message });
          return;
        }
      }
      if (attempt.primary) {
        try {
          requireStarted(await onStart(attempt.primary));
        } catch (failure) {
          if (failure?.status === 409 && failure?.code === 'sync_blocked' && !attempt.primary.skipSync) {
            setSyncConflict({
              conflict: { host: failure.host || selectedHost, message: failure.message, results: failure.results },
              attempt,
            });
            return;
          }
          const reserved = failure?.reservation;
          const failedReservation = reserved?.requestId === attempt.primary.requestId && reserved.provisioningState === 'failed'
            && typeof reserved.runId === 'string' && reserved.runId.length > 0;
          setReservation(failedReservation ? reserved : null);
          const definitive = failure?.status >= 400 && failure.status < 500 && failure.status !== 408 && !failedReservation;
          setSubmission(definitive ? null : attempt);
          setStartFailure(failureText(failure));
          // The worktree is a task now: a retry or a corrected draft goes to that open task, never makes it again.
          if ((attempt.primary.taskId && adoptedTask?.id === attempt.primary.taskId) || where === EXISTING_WORKTREE) {
            setPlace(OPEN_TASK);
            setTaskId(attempt.primary.taskId);
          }
          showToast({ type: 'error', message: failureText(failure) });
          return;
        }
        setReservation(null);
      }
      const remaining = [];
      const errors = [];
      for (const extra of attempt.extras) {
        try {
          requireStarted(await onStart(extra, { follow: false }));
        } catch (failure) {
          remaining.push(extra);
          errors.push(`${extra.startIn}: ${failureText(failure)}`);
        }
      }
      if (remaining.length > 0) {
        setSubmission({ primary: null, extras: remaining });
        setStartFailure(errors.join(' '));
      } else {
        setSubmission(null);
        onClose();
      }
    } finally {
      busy.current = false;
      setStarting(false);
    }
  };

  const closeReservation = async () => {
    if (!reservation || busy.current) return;
    busy.current = true;
    setStarting(true);
    try {
      const closed = await cleanupRun(reservation.runId);
      if (closed?.provisioningState !== 'closed' || closed.runId !== reservation.runId) throw new Error('The server did not confirm that the start was closed.');
      setSubmission(null);
      setReservation(null);
      setStartFailure(closed.worktree?.state === 'removal_blocked' ? closed.worktree.detail : null);
    } catch (failure) {
      setStartFailure(failureText(failure));
    } finally {
      busy.current = false;
      setStarting(false);
    }
  };

  const inputHint = selectedWorkflow?.progressFile?.includes('{input}')
    ? `This workflow reads its progress from ${selectedWorkflow.progressFile}. Type the part that replaces {input}, or the file's whole path inside the project. A full path from your disk is not accepted.`
    : 'A description of the work, or the path of a file its steps should work from.';
  const ready = !loading && !error;

  return (
    <Dialog title="Run workflow" closeLabel="Close run workflow" onClose={onClose} busy={starting || Boolean(submission?.primary)}
      footer={ready && <>
        <Button onClick={onClose} disabled={starting || Boolean(submission?.primary)}>{submission && !submission.primary ? 'Done' : 'Cancel'}</Button>
        {reservation && <Button onClick={closeReservation} disabled={starting}>Close failed start</Button>}
        <Button variant="primary" onClick={handleStart} disabled={!canStart}>{starting ? 'Starting…' : submission?.primary ? 'Retry start' : submission ? 'Retry remaining runs' : 'Start'}</Button>
      </>}>
      {loading && <span className="ui-field-hint" role="status">Loading…</span>}
      {error && <Note tone="danger" role="alert">{error}</Note>}
      {startFailure && <Note tone="danger" role="alert">{startFailure}</Note>}

      {ready && (
        <fieldset className="workflow-launch-fields" disabled={locked} aria-busy={starting} aria-label="Workflow launch settings">
          {locations.length > 1 && (
            <Field label="Host" hint="Which host runs this workflow and holds its worktree.">
              <Select label="Host" value={selectedHost} onChange={setSelectedHost}>
                {locations.map(loc => (
                  <option key={loc.host} value={loc.host}>{loc.host === 'local' ? 'local (This Mac)' : loc.host} — {loc.path}</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Workflow"
            action={<Button variant="link" onClick={() => { onClose(); openWorkflowBuilder(); }}>Edit workflows…</Button>}
            hint={selectedWorkflow?.description || null}>
            <Select label="Workflow" value={workflowId} onChange={id => { setWorkflowId(id); setOverrides({}); setStepEnabledOverrides({}); }}>
              {workflows.map(workflow => (
                <option key={workflow.id} value={workflow.id}>{workflow.kind && workflow.kind !== 'other' ? `${workflow.name} — ${WORKFLOW_KIND_LABELS[workflow.kind]}` : workflow.name}</option>
              ))}
            </Select>
          </Field>

          {selectedWorkflow && <Field label="Team"
            hint={requiredRoles.length > 0 ? `Required roles: ${requiredRoles.join(', ')}` : null}>
            <Select label="Team" value={team?.id ?? ''} onChange={id => { setTeamId(id); setOverrides({}); }} disabled={compatibleTeams.length === 0}>
              {compatibleTeams.length === 0 && <option value="">No compatible team</option>}
              {teams.map(item => {
                const missingForTeam = teamMissing.get(item.id) ?? [];
                const incompatible = missingForTeam.length > 0;
                return <option key={item.id} value={item.id} disabled={incompatible}>
                  {incompatible ? `${item.name} — missing: ${missingForTeam.join(', ')}` : item.name}
                </option>;
              })}
            </Select>
            {compatibleTeams.length === 0 && activeNodes.length > 0 && (
              <Note tone="warning">
                {teams.length === 0
                  ? `Create a team in Settings → Workflows covering: ${requiredRoles.join(', ')}.`
                  : `No team covers all required roles (${requiredRoles.join(', ')}). Update a team in Settings → Workflows, or disable steps you do not need.`}
              </Note>
            )}
            <details key={workflowId + (team?.id ?? '')}>
              <summary>Step assignments</summary>
              {nodes.map(node => {
                const member = teamMemberForRole(team, node.role);
                const inherited = agentById.get(member?.agentId);
                const enabled = isStepEnabled(node);
                return <Field key={node.name} label={node.role ? `${node.name} · ${node.role}` : node.name}
                  action={<label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <input type="checkbox" aria-label={`Run ${node.name}`} checked={enabled} onChange={event => {
                      const checked = event.target.checked;
                      setStepEnabledOverrides(current => {
                        const next = { ...current, [node.name]: checked };
                        if (checked === (node.enabled !== false)) delete next[node.name];
                        return next;
                      });
                    }} />
                    <span>{enabled ? 'Enabled' : 'Disabled'}</span>
                  </label>}>
                  <Select label={`${node.name} agent`} disabled={!enabled || !team} value={overrides[node.name]?.agentId ?? ''} onChange={value => {
                    setOverrides(current => {
                      // An effort the newly chosen agent's CLI does not offer is dropped, not carried over.
                      const previousEffort = current[node.name]?.effort;
                      const agent = agentById.get(value);
                      const effort = agent && launchCommandEfforts(agent.launchCommand).includes(previousEffort) ? previousEffort : null;
                      const next = { ...current, [node.name]: { agentId: value, effort } };
                      if (!value) delete next[node.name];
                      return next;
                    });
                  }}>
                    <option value="">{inherited ? `Use ${[inherited.name, member.effort].filter(Boolean).join(' · ')}` : 'Select a compatible team first'}</option>
                    {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </Select>
                  <EffortField label={`${node.name} effort`} caption="Effort" value={overrides[node.name]?.effort}
                    agent={agentById.get(overrides[node.name]?.agentId)} disabled={!enabled || !team}
                    onChange={effort => setOverrides(current => ({ ...current, [node.name]: { ...current[node.name], effort: effort || null } }))} />
                </Field>;
              })}
            </details>
            {activeNodes.length === 0 && <Note tone="warning">Keep at least one step enabled for this run.</Note>}
            {brokenLoop && <Note tone="warning">{`${brokenLoop.name} loops back to ${brokenLoop.repeat.to}, which is disabled.`}</Note>}
            {team && missing.length > 0 && <Note tone="warning">Choose an agent for {missing.map(node => node.name).join(', ')}.</Note>}
          </Field>}

          <Field label={inputRequired ? 'What is this run about? (required)' : 'What is this run about?'} hint={inputHint} error={inputError}>
            {pathInput && !/[\r\n]/.test(input)
              ? <TextInput label="Input" value={input} onChange={setInput} maxLength={4096} disabled={locked} required={inputRequired} invalid={Boolean(inputError)} placeholder="e.g. docs/todos/replies.md" />
              : <TextArea label="Input" value={input} onChange={setInput} maxLength={4096} rows={6} disabled={locked} required={inputRequired} invalid={Boolean(inputError)} placeholder="Describe what the workflow should do" />}
          </Field>
          <WorkflowAttachments entries={attachments} onChange={setAttachments} onChecking={setCheckingFiles} disabled={locked} primaryOnly={extraRuns.length > 0} />

          {listable && (
            <Field label="Where to work">
              <SegmentedControl label="Where to work" value={where} onChange={setPlace} options={[
                { value: NEW_TASK, label: 'A new task' },
                { value: OPEN_TASK, label: 'An open task', disabled: projectTasks.length === 0, title: projectTasks.length === 0 ? 'This project has no open tasks' : undefined },
                ...(candidates.length > 0 ? [{ value: EXISTING_WORKTREE, label: 'An existing worktree' }] : []),
                { value: MAIN, label: 'Main', disabled: !home?.selectable && !several, title: home?.reason?.message },
              ]} />
              {where === NEW_TASK && <TaskTitleInput value={title} onChange={setTitle} optional />}
              {where === NEW_TASK && <>
                <span aria-hidden="true" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Base branch</span>
                <TextInput label="Base branch" value={baseBranch} onChange={setBaseBranch} maxLength={200} disabled={locked} invalid={Boolean(baseError)}
                  placeholder={defaultBaseBranch ? `${defaultBaseBranch} (the default)` : preflight?.branch ? `${preflight.branch} (the branch Main is on)` : 'The branch Main is on'} />
                {baseError
                  ? <span className="ui-field-error" role="alert">{baseError}</span>
                  : <span className="ui-field-hint">The task is cut from this branch&apos;s latest local commit and merges back into it. Main is not switched.</span>}
              </>}
              {where === EXISTING_WORKTREE && <>
                <WorktreeCandidatePicker candidates={candidates} value={candidate?.path ?? ''} onChange={setCandidatePath} />
                <TaskTitleInput value={title} onChange={setTitle} optional placeholder={candidate?.branch ? candidate.branch.split('/').at(-1).replace(/[-_]/g, ' ').slice(0, TASK_TITLE_MAX) : 'Task title'} />
              </>}
              {where === OPEN_TASK && (
                <Select label="Task" value={chosenTask.id} onChange={(next) => { setTaskId(next); setStartChoice(null); }}>
                  {projectTasks.map(task => (
                    <option key={task.id} value={task.id} disabled={!worktreeOf(task)?.selectable}>{placeLabel(task.title, worktreeOf(task))}</option>
                  ))}
                </Select>
              )}
              {startOptions.length > 0 && start && (
                <>
                  <span aria-hidden="true" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Start in</span>
                  <Select label="Start in" value={start.name} onChange={setStartChoice}>
                    {startOptions.map(option => <option key={option.name} value={option.name} disabled={!option.usable}>{option.label}</option>)}
                  </Select>
                </>
              )}
              {where === NEW_TASK && several && start && (
                <TaskRepositories repositories={projectRepositories} ticked={included} startsIn={start.name} disabled={starting}
                  onToggle={name => setIncluded((current) => { const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next; })} />
              )}
              {otherTodos.map(entry => (
                <React.Fragment key={entry.repository}>
                  <label style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, color: startable(entry) ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    <input type="checkbox" aria-label={`Also start a run in ${entry.repository} with ${entry.todo}`} checked={startable(entry) && extras.has(entry.repository)} disabled={!startable(entry)}
                      onChange={() => setExtras((current) => { const next = new Set(current); if (next.has(entry.repository)) next.delete(entry.repository); else next.add(entry.repository); return next; })} />
                    <span>{`Also start a run in ${entry.repository} with ${entry.todo}`}</span>
                  </label>
                  {!startable(entry) && <span className="ui-field-hint">{whyNot(entry)}</span>}
                </React.Fragment>
              ))}
              {where === NEW_TASK && plan?.repositories && <span className="ui-field-hint">{`From the Repositories line of ${plan.progressFile}.`}</span>}
              {where === NEW_TASK && plan && plan.repositories === null && plan.problem === null && plan.foundIn !== null && <span className="ui-field-hint">{`${plan.progressFile} is in ${plan.foundIn}.`}</span>}
              {where === NEW_TASK && plan?.problem && <Note tone="warning">{`The Repositories line of ${plan.progressFile} was not used: ${plan.problem}`}</Note>}
              {where === NEW_TASK && planFailure && <Note tone="warning">{`The todo could not be looked up: ${planFailure}`}</Note>}
              {unlistedMinor.map(entry => <Note key={entry.repository} tone="warning">{`The todo names ${entry.repository}, which is not one of this project's repositories.`}</Note>)}
              <Note>
                {where === NEW_TASK && !several && <span>The task gets its own copy of the project{effectiveBase ? ` from ${effectiveBase}` : ''}, prepared by a Setup step, so other work can carry on beside it.</span>}
                {where === NEW_TASK && several && <span>{`A Setup step prepares each copy${typedBase || defaultBaseBranch ? `, each cut from ${typedBase || defaultBaseBranch}` : ''}, and the run starts in the repository chosen under Start in.`}</span>}
                {where === OPEN_TASK && <span>Runs in this task as it is, with no Setup step.</span>}
                {where === EXISTING_WORKTREE && <span>Makes this worktree a task, keeping its uncommitted files, then runs in it with no Setup step.</span>}
                {where === MAIN && !mainElsewhere && <span>Runs directly in Main, with no copy of its own and no Setup step.</span>}
                {mainElsewhere && <span>{`Runs directly in the checkout of ${start.name}, with no copy of its own and no Setup step. It changes that repository only.`}</span>}
              </Note>
              {where === NEW_TASK && preflight?.dirty && <Note tone="warning">Uncommitted changes in Main will not be in the task.</Note>}
              {where !== NEW_TASK && chosenWorktree?.dirty && <Note tone="warning">There are uncommitted changes here.</Note>}
              {where === OPEN_TASK && chosenWorktree && !chosenWorktree.selectable && chosenWorktree.reason && <Note tone="warning">{chosenWorktree.reason.message}</Note>}
            </Field>
          )}

          {reasons.length > 0 && (
            <Note tone="danger" role="alert">
              {reasons.map(reason => <span key={reason.code || reason.message}>{reason.message}</span>)}
            </Note>
          )}
        </fieldset>
      )}
      {syncConflict && (
        <SyncConflictDialog
          conflict={syncConflict.conflict}
          actionLabel="start this workflow"
          busy={syncProceeding}
          onCancel={() => setSyncConflict(null)}
          onProceed={async () => {
            const pendingAttempt = syncConflict.attempt;
            setSyncProceeding(true);
            try {
              const retried = { ...pendingAttempt.primary, requestId: newRequestId(), skipSync: true };
              setSyncConflict(null);
              requireStarted(await onStart(retried));
              onClose();
            } catch (failure) {
              setStartFailure(failureText(failure));
              showToast({ type: 'error', message: failureText(failure) });
            } finally {
              setSyncProceeding(false);
            }
          }}
        />
      )}
    </Dialog>
  );
}
