import { WORKFLOW_TEMPLATES } from '../../shared/workflow-templates.mjs';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { execFile as defaultExecFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateAgentBody,
  validateWorkflowBody,
  validateStepPresetBody,
  validateSettingsBody,
  validateRunStartBody,
  validateRunAnswerBody,
  validateRunApproveBody,
  validateRunSendBackBody,
  composePrompt,
  inputFromProgressFilePath,
  isProgressFilePath,
  isUuid,
  loopTargetIndex,
} from '../../shared/pipeline-definitions.mjs';
import { computeActions } from '../pipelines/run-machine.js';
import { serializeStartParams } from '../pipelines/request-store.js';
import { createRunProgressReader, readRunProgress, isProgressFileInWorktree } from '../pipelines/run-progress.js';
import { notePath, feedbackPath } from '../pipelines/run-notes.js';
import { buildStepGuidance } from '../pipelines/step-guidance.js';
import { buildPrompt as buildPassPrompt } from '../terminal-workflow.js';
import {
  preflight as defaultPreflight,
  planNames as defaultPlanNames,
  resolveHomeRepoPath as defaultResolveHomeRepoPath,
  listWorktrees as defaultListWorktrees,
  readWorktreeChanges as defaultReadWorktreeChanges,
  hasCommittedFile,
  readCommittedFile,
  buildSetupPromptForRepositories,
} from '../pipelines/run-worktree.js';
import { createRunPlaces } from '../pipelines/run-places.js';
import { readStoredRepositories } from '../project-repositories.js';
import { parseTodoRepositories } from '../../shared/todo-repositories.mjs';
import { GUIDANCE_MAX } from '../terminal-workflow.js';
import { parseCollectionQuery as parseQuery, paginate } from './collection-query.js';
import { provisionalTaskTitle } from '../tasks/task-naming.js';

const BASE = '/api/pipelines';
const OPEN_WORKTREE = new Set(['not_created', 'present', 'removal_blocked', 'external']);
const WORKTREE_SORT = ['path'];
const SETUP_AGENT_MISSING = 'setup_agent_missing';
const OPEN_TASK = new Set(['active', 'pr_open']);
const WORKTREE_REASONS = {
  missing: 'The worktree directory is missing.',
  unreadable: 'Git cannot read this worktree.',
  detached: 'No branch is checked out in this worktree.',
  // Shown for a task and for Main alike, so it names neither.
  in_use: 'An open workflow run is already using it.',
};

const AGENT_SORT = ['name', 'updatedAt'];
const WORKFLOW_SORT = ['name', 'updatedAt'];
const RUN_SORT = ['createdAt', 'updatedAt', 'status'];
const DECISION_SORT = ['createdAt'];
const NOTE_SORT = ['createdAt'];
const REVIEW_SORT = ['createdAt'];
const STEP_FILTER = {
  name: 'stepIndex',
  parse: value => {
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 32) throw fieldError('stepIndex', 'Use a non-negative step index');
    return Number(value);
  },
};

class PipelineError extends Error {
  constructor(message, status, errors, extra = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.extra = extra;
  }
}

function fieldError(field, message) {
  return new PipelineError('One or more fields failed validation.', 400, [{ field, message }]);
}

function fieldErrors(errors) {
  return new PipelineError('One or more fields failed validation.', 400, errors);
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function rejectUnknownQuery(query, allowed) {
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) throw fieldError(key, 'Unknown query field');
  }
}

const parseCollectionQuery = (query, spec) => parseQuery(query, spec, fieldError);

/**
 * An open run is one the owner still has in front of them. A complete run is open while its own
 * worktree could not be removed, or while it sits finished in a task or Main waiting to be closed.
 */
function isOpenRun(run) {
  if (run.status === 'complete') return run.worktreeState === 'removal_blocked' || run.worktreeState === 'external';
  return OPEN_WORKTREE.has(run.worktreeState);
}

/** `decisionCount` is how many requests the run's agents settled themselves (see /decisions). */
function buildRunView(run, decisionCount, progress, latestNotes) {
  const currentNote = latestNotes.get(run.currentStepIndex);
  const approvalNote = currentNote === undefined ? null : (({ status, summary, attempt, pass, createdAt }) => ({ status, summary, attempt, pass, createdAt }))(currentNote);
  return {
    id: run.id,
    requestId: run.requestId,
    workflowId: run.workflowId,
    taskId: run.taskId,
    workflowName: run.definition.workflowName,
    // Whether this run's agents settle their own questions, as the workflow said when it started.
    agentsDecide: run.definition.agentsDecide,
    decisionCount,
    notesDir: run.definition.notesDir,
    progress,
    project: run.project,
    input: run.input,
    status: run.status,
    approvalRequest: run.status === 'awaiting_approval' ? { stepIndex: run.currentStepIndex, stepName: run.definition.steps[run.currentStepIndex].name, note: approvalNote } : null,
    stopReason: run.stopReason,
    error: run.error,
    currentStepIndex: run.currentStepIndex,
    steps: run.definition.steps.map((defStep, index) => {
      const progress = run.steps[index];
      return {
        index,
        kind: defStep.kind,
        name: defStep.name,
        role: defStep.role,
        askOwner: defStep.askOwner,
        readOnly: defStep.readOnly,
        approval: defStep.approval,
        agentName: defStep.agent.name,
        notePath: notePath(run.definition, index),
        note: latestNotes.get(index) === undefined ? null : (({ status, summary, attempt, pass, createdAt }) => ({ status, summary, attempt, pass, createdAt }))(latestNotes.get(index)),
        repeat: defStep.repeat,
        status: progress.status,
        sessionId: progress.sessionId,
        priorSessionIds: progress.priorSessionIds,
        attempt: progress.attempt,
        iteration: progress.iteration,
        roundsCompleted: progress.roundsCompleted,
        detail: progress.detail,
        startedAt: progress.startedAt,
        finishedAt: progress.finishedAt,
        elapsedMs: progress.elapsedMs,
      };
    }),
    worktree: {
      path: run.worktreePath,
      branch: run.worktreeBranch,
      baseCommit: run.baseCommit,
      state: run.worktreeState,
      detail: run.worktreeDetail,
    },
    // What an agent that signalled NEEDS_INPUT asked for; null when the run is not waiting on one.
    inputRequest: run.inputRequest === null ? null : {
      questions: run.inputRequest.questions,
      truncated: run.inputRequest.truncated,
    },
    actions: computeActions(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  };
}

function pendingStep() {
  return {
    status: 'pending',
    sessionId: null,
    priorSessionIds: [],
    attempt: 0,
    iteration: 0,
    roundsCompleted: 0,
    detail: null,
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
  };
}

function decisionView(decision) {
  return {
    id: decision.id,
    stepIndex: decision.stepIndex,
    stepName: decision.stepName,
    pass: decision.pass,
    questions: decision.questions,
    truncated: decision.truncated,
    answer: decision.answer,
    createdAt: decision.createdAt,
  };
}

/**
 * Why a worktree cannot take a run, or null when it can. The first reason that applies is reported.
 * `changes` is what git read in the worktree, or null for a missing one, which is never read.
 */
function worktreeRefusal(worktree, changes, runs) {
  const code = worktree.missing ? 'missing'
    : !changes.readable ? 'unreadable'
      : worktree.branch === null ? 'detached'
        // A finished run is still shown there but no longer holds the place.
        : runs.some(run => run.worktreePath === worktree.path && run.status !== 'complete' && isOpenRun(run)) ? 'in_use'
          : null;
  return code === null ? null : { code, message: WORKTREE_REASONS[code] };
}

function mapMutationError(err, entity) {
  const message = String(err?.message || err);
  if (/not found/i.test(message)) {
    throw new PipelineError(`${entity} not found`, 404);
  }
  if (/revision conflict/i.test(message)) {
    throw new PipelineError('revision does not match the stored revision', 409);
  }
  if (/name already exists/i.test(message)) {
    throw new PipelineError(`A ${entity.toLowerCase()} with this name already exists`, 409);
  }
  throw err;
}

function requireExistingAgents(agentStore, nodes) {
  const errors = [];
  nodes.forEach((node, index) => {
    if (!isUuid(node.agentId)) return;
    if (!agentStore.get(node.agentId)) {
      errors.push({ field: `nodes[${index}].agentId`, message: 'Use a UUID of an existing agent' });
    }
  });
  if (errors.length) throw fieldErrors(errors);
}

function agentUsedByWorkflows(workflowStore, agentId) {
  return workflowStore.list().some(workflow => workflow.nodes.some(node => node.agentId === agentId));
}

function agentSnapshot(agent) {
  return {
    id: agent.id,
    name: agent.name,
    launchCommand: agent.launchCommand,
    resetCommand: agent.resetCommand,
  };
}

function buildDefinitionSnapshot({
  workflow,
  agentStore,
  settings,
  input,
  setupPairs,
  checkouts,
  withSetup,
}) {
  const errors = [];
  const needsInput = workflow.nodes.some(node => String(node.prompt).includes('{input}')) || workflow.progressFile?.includes('{input}');
  if (needsInput && (!input || !input.trim())) {
    errors.push({ field: 'input', message: 'input is required when a node prompt contains {input}' });
  }

  // Setup prepares a worktree CodeDeck has just created; an existing worktree is used as it is.
  const setupAgent = withSetup && settings?.setupAgentId ? agentStore.get(settings.setupAgentId) : null;
  if (withSetup && !setupAgent) {
    errors.push({ field: 'setupAgentId', message: 'Choose a setup agent in Settings → Workflows.' });
  }

  // Setup, when the run has one, is step 0; a loop names the step it returns to by its index.
  const firstNodeStep = withSetup ? 1 : 0;
  const repeatSnapshot = (index) => {
    const { repeat } = workflow.nodes[index];
    if (repeat.mode === 'once') return { mode: 'once' };
    if (repeat.mode === 'until_complete') return { mode: 'until_complete', max: repeat.max };
    return { mode: 'loop_back', toStepIndex: firstNodeStep + loopTargetIndex(workflow.nodes, index), max: repeat.max };
  };

  const standardCommit = WORKFLOW_TEMPLATES.find(template => ['bug-fix', 'troubleshoot'].includes(template.id) && template.kind === workflow.kind)?.nodes.at(-1);
  const nodeSteps = workflow.nodes.map((node, index) => {
    const agent = agentStore.get(node.agentId);
    if (!agent) {
      errors.push({ field: 'workflowId', message: 'Workflow references a missing agent' });
      return null;
    }
    const prompt = composePrompt(node.prompt, input, errors, 'input');
    return {
      kind: 'node',
      ...(index > 0 && index === workflow.nodes.length - 1 && node.name === 'Commit' && node.repeat.mode === 'once'
        && !node.readOnly && !node.askOwner && node.prompt === standardCommit?.prompt ? { inspectCleanCommit: true } : {}),
      name: node.name,
      role: node.role,
      askOwner: node.askOwner,
      readOnly: node.readOnly,
      approval: node.approval,
      prompt,
      repeat: repeatSnapshot(index),
      agent: agentSnapshot(agent),
    };
  });

  const progressFile = workflow.progressFile === null ? null : composePrompt(workflow.progressFile, input);
  if (progressFile !== null && !isProgressFilePath(progressFile, 512)) {
    // The owner typed something the template cannot take, often a full path from disk: say what came of it.
    const shown = progressFile.length > 120 ? `${progressFile.slice(0, 120)}…` : progressFile;
    // A full path of a file in one of the project's repositories: say which repository to start in and what to type there.
    const inside = workflow.progressFile === '{input}' && path.isAbsolute(progressFile)
      ? checkouts.map(checkout => ({ repository: checkout.repository, relative: path.relative(checkout.path, progressFile) }))
        .find(candidate => isProgressFilePath(candidate.relative, 512))
      : undefined;
    errors.push({ field: 'input', message: inside
      ? `"${shown}" is a file in ${inside.repository}. Start the run in ${inside.repository} and type its path inside that repository: ${inside.relative}`
      : `This workflow reads its progress from ${workflow.progressFile}. With this input that is "${shown}", which is not the path of a .md file inside the project. Type only the part that replaces {input}.` });
  }

  if (errors.length) throw fieldErrors(errors);

  const setupSteps = withSetup ? [{
    kind: 'setup',
    name: 'Setup',
    role: '',
    askOwner: false,
    readOnly: false,
    approval: false,
    prompt: buildSetupPromptForRepositories(setupPairs),
    repeat: { mode: 'until_complete', max: 3 },
    agent: agentSnapshot(setupAgent),
  }] : [];

  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowRevision: workflow.revision,
    agentsDecide: workflow.agentsDecide,
    progressFile,
    steps: [...setupSteps, ...nodeSteps],
  };
}

function mapEngineActionError(err) {
  if (err?.code === 'ACTION_REFUSED') {
    throw new PipelineError(err.message || 'Action not allowed', 409);
  }
  if (err?.code === 'ANSWER_UNAVAILABLE') {
    throw new PipelineError(err.message || 'The agent is no longer waiting for an answer', 409);
  }
  if (err?.code === 'WORKTREE_MISSING') {
    throw new PipelineError(err.message || 'The worktree directory is missing', 409);
  }
  throw err;
}

/**
 * @param {object} deps
 * @param {object} deps.agentStore
 * @param {object} deps.workflowStore
 * @param {object} deps.settingsStore
 * @param {object} deps.runStore
 * @param {(name: string) => object|null|undefined} deps.findProject
 * @param {{ start: (runId: string) => unknown }} [deps.engine]
 * @param {(run: object, otherOpenRuns: object[]) => Promise<{ closed: string[], notClosed: string[] }>} deps.closeRunTerminals
 *   closes the terminals a run used (see pipelines/run-terminals.js)
 * @param {typeof defaultPreflight} [deps.preflight]
 * @param {typeof defaultPlanNames} [deps.planNames]
 * @param {typeof defaultResolveHomeRepoPath} [deps.resolveHomeRepoPath]
 * @param {typeof defaultExecFile} [deps.execFile]
 * @param {(path: string) => Promise<string>} [deps.realpath]
 * @param {(fn: Function) => void} [deps.scheduleStart] — defaults to setImmediate
 */
export function createPipelinesRouter(deps) {
  const {
    agentStore,
    workflowStore,
    settingsStore,
    runStore,
    requestStore,
    decisionStore,
    noteStore,
    reviewStore,
    answerStore,
    templateStore,
    stepPresetStore,
    taskStore,
    taskService,
    findProject,
    engine,
    closeRunTerminals,
    preflight = defaultPreflight,
    planNames = defaultPlanNames,
    resolveHomeRepoPath = defaultResolveHomeRepoPath,
    listWorktrees = defaultListWorktrees,
    readWorktreeChanges = defaultReadWorktreeChanges,
    execFile = defaultExecFile,
    realpath,
    scheduleStart = setImmediate,
    progressReader = createRunProgressReader(),
  } = deps ?? {};

  if (!agentStore) throw new Error('pipelines router: agentStore is required');
  // Where a run may work and read, for a run in a place that already exists. Built when first asked for, after the dependencies are checked.
  let readRunPlaces = null;
  const runPlaces = (run) => {
    readRunPlaces ??= createRunPlaces({ taskStore, findProject, execFile, resolveHomeRepoPath });
    return readRunPlaces(run);
  };
  if (!workflowStore) throw new Error('pipelines router: workflowStore is required');
  if (!settingsStore) throw new Error('pipelines router: settingsStore is required');
  if (!runStore) throw new Error('pipelines router: runStore is required');
  if (!decisionStore) throw new Error('pipelines router: decisionStore is required');
  if (!noteStore) throw new Error('pipelines router: noteStore is required');
  if (typeof reviewStore?.list !== 'function') throw new Error('pipelines router: reviewStore is required');
  if (typeof answerStore?.list !== 'function') throw new Error('pipelines router: answerStore is required');
  if (typeof templateStore?.list !== 'function') throw new Error('pipelines router: templateStore is required');
  if (typeof stepPresetStore?.list !== 'function') throw new Error('pipelines router: stepPresetStore is required');
  if (typeof taskStore?.get !== 'function') throw new Error('pipelines router: taskStore is required');
  if (typeof taskService?.plan !== 'function' || typeof taskService?.createPlanned !== 'function') throw new Error('pipelines router: taskService is required');
  if (['get', 'reserve', 'setTaskId', 'release'].some(method => typeof requestStore?.[method] !== 'function')) {
    throw new Error('pipelines router: requestStore is required');
  }
  if (typeof closeRunTerminals !== 'function') throw new Error('pipelines router: closeRunTerminals must be a function');
  if (typeof findProject !== 'function') throw new Error('pipelines router: findProject must be a function');

  const asRunView = async run => {
    const inspected = await readRunProgress({ run, workflowProgressFile: workflowStore.get(run.workflowId)?.progressFile ?? null, progressReader });
    // `tasksDone`/`tasksTotal` count every phase; `phase` is the first one with work left.
    const progress = inspected === null ? null : { file: inspected.file, status: inspected.status, phaseCount: inspected.phaseCount, phase: inspected.phase, tasksDone: inspected.tasksDone, tasksTotal: inspected.tasksTotal };
    return buildRunView(run, decisionStore.count(run.id), progress, noteStore.latestByStep(run.id));
  };

  const router = express.Router();
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  router.use(BASE, (req, res, next) => {
    req.pipelinesTraceId = randomUUID();
    res.set('X-Trace-Id', req.pipelinesTraceId);
    next();
  });
  router.use(BASE, express.json({ limit: '512kb' }));

  // --- Agents ---

  router.get(`${BASE}/agents`, route((req, res) => {
    const query = parseCollectionQuery(req.query, {
      sortFields: AGENT_SORT,
      defaultSort: 'name,asc',
      filters: [{
        name: 'name',
        parse: value => {
          if (!isText(value)) throw fieldError('name', 'A name filter is required');
          return value;
        },
      }],
    });
    let records = agentStore.list();
    if (query.filters.name !== undefined) {
      records = records.filter(record => record.name === query.filters.name);
    }
    res.json(paginate(records, query));
  }));

  router.post(`${BASE}/agents`, route((req, res) => {
    const errors = validateAgentBody(req.body, { revisionRequired: false });
    if (errors.length) throw fieldErrors(errors);
    try {
      const created = agentStore.create(req.body);
      res.status(201).json(created);
    } catch (err) {
      mapMutationError(err, 'Agent');
    }
  }));

  router.get(`${BASE}/agents/:id`, route((req, res) => {
    if (!isUuid(req.params.id)) throw new PipelineError('Agent not found', 404);
    const agent = agentStore.get(req.params.id);
    if (!agent) throw new PipelineError('Agent not found', 404);
    res.json(agent);
  }));

  router.put(`${BASE}/agents/:id`, route((req, res) => {
    if (!isUuid(req.params.id)) throw new PipelineError('Agent not found', 404);
    const errors = validateAgentBody(req.body, { revisionRequired: true });
    if (errors.length) throw fieldErrors(errors);
    try {
      res.json(agentStore.update(req.params.id, req.body));
    } catch (err) {
      mapMutationError(err, 'Agent');
    }
  }));

  router.delete(`${BASE}/agents/:id`, route((req, res) => {
    if (!isUuid(req.params.id)) throw new PipelineError('Agent not found', 404);
    const agent = agentStore.get(req.params.id);
    if (!agent) throw new PipelineError('Agent not found', 404);
    const settings = settingsStore.get();
    if (settings.setupAgentId === agent.id) {
      throw new PipelineError('Cannot delete the current setup agent', 409);
    }
    if (agentUsedByWorkflows(workflowStore, agent.id)) {
      throw new PipelineError('Cannot delete an agent used by a workflow', 409);
    }
    agentStore.remove(agent.id);
    res.status(204).end();
  }));

  // --- Workflows ---

  router.get(`${BASE}/workflows`, route((req, res) => {
    const query = parseCollectionQuery(req.query, {
      sortFields: WORKFLOW_SORT,
      defaultSort: 'name,asc',
      filters: [{
        name: 'name',
        parse: value => {
          if (!isText(value)) throw fieldError('name', 'A name filter is required');
          return value;
        },
      }],
    });
    let records = workflowStore.list();
    if (query.filters.name !== undefined) {
      records = records.filter(record => record.name === query.filters.name);
    }
    res.json(paginate(records, query));
  }));

  router.post(`${BASE}/workflows`, route((req, res) => {
    const errors = validateWorkflowBody(req.body, { revisionRequired: false });
    if (errors.length) throw fieldErrors(errors);
    requireExistingAgents(agentStore, req.body.nodes);
    try {
      const created = workflowStore.create(req.body);
      res.status(201).json(created);
    } catch (err) {
      mapMutationError(err, 'Workflow');
    }
  }));

  router.get(`${BASE}/workflows/:id`, route((req, res) => {
    if (!isUuid(req.params.id)) throw new PipelineError('Workflow not found', 404);
    const workflow = workflowStore.get(req.params.id);
    if (!workflow) throw new PipelineError('Workflow not found', 404);
    res.json(workflow);
  }));

  router.put(`${BASE}/workflows/:id`, route((req, res) => {
    if (!isUuid(req.params.id)) throw new PipelineError('Workflow not found', 404);
    const errors = validateWorkflowBody(req.body, { revisionRequired: true });
    if (errors.length) throw fieldErrors(errors);
    requireExistingAgents(agentStore, req.body.nodes);
    try {
      res.json(workflowStore.update(req.params.id, req.body));
    } catch (err) {
      mapMutationError(err, 'Workflow');
    }
  }));

  router.delete(`${BASE}/workflows/:id`, route((req, res) => {
    if (!isUuid(req.params.id)) throw new PipelineError('Workflow not found', 404);
    const workflow = workflowStore.get(req.params.id);
    if (!workflow) throw new PipelineError('Workflow not found', 404);
    workflowStore.remove(workflow.id);
    res.status(204).end();
  }));

  // --- What the owner saved for reuse: workflow templates and steps ---
  // Both are copied when used, so removing one never affects a workflow or a run.

  function mountLibrary(segment, store, entity, validate) {
    const notFound = () => new PipelineError(`${entity} not found`, 404);
    router.get(`${BASE}/${segment}`, route((req, res) => {
      const query = parseCollectionQuery(req.query, { sortFields: WORKFLOW_SORT, defaultSort: 'name,asc' });
      res.json(paginate(store.list(), query));
    }));
    router.post(`${BASE}/${segment}`, route((req, res) => {
      const errors = validate(req.body, { revisionRequired: false });
      if (errors.length) throw fieldErrors(errors);
      try { res.status(201).json(store.create(req.body)); }
      catch (err) { mapMutationError(err, entity); }
    }));
    router.get(`${BASE}/${segment}/:id`, route((req, res) => {
      const record = isUuid(req.params.id) ? store.get(req.params.id) : null;
      if (!record) throw notFound();
      res.json(record);
    }));
    router.put(`${BASE}/${segment}/:id`, route((req, res) => {
      if (!isUuid(req.params.id)) throw notFound();
      const errors = validate(req.body, { revisionRequired: true });
      if (errors.length) throw fieldErrors(errors);
      try { res.json(store.update(req.params.id, req.body)); }
      catch (err) { mapMutationError(err, entity); }
    }));
    router.delete(`${BASE}/${segment}/:id`, route((req, res) => {
      const record = isUuid(req.params.id) ? store.get(req.params.id) : null;
      if (!record) throw notFound();
      store.remove(record.id);
      res.status(204).end();
    }));
  }
  mountLibrary('templates', templateStore, 'Template', (body, options) => validateWorkflowBody(body, { ...options, template: true }));
  mountLibrary('step-presets', stepPresetStore, 'Saved step', validateStepPresetBody);

  // --- What a step's agent is sent, for a workflow that may not be saved yet ---
  // Built with the same functions a run uses. What only a real run knows is shown as a
  // placeholder: the task's folder, the run notes folder and the pass identifier.
  const PREVIEW = { worktreePath: '/path/to/the/task', notesDir: '.codedeck/runs/00000000', identifier: '<pass identifier>' };

  router.post(`${BASE}/prompt-previews`, route((req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw fieldError('body', 'A JSON object is required');
    const unknown = Object.keys(body).filter(field => !['workflow', 'nodeIndex', 'input'].includes(field));
    if (unknown.length) throw fieldErrors(unknown.map(field => ({ field, message: 'Unknown field' })));
    const errors = validateWorkflowBody(body.workflow, { template: true }).map(error => ({ field: `workflow.${error.field}`, message: error.message }));
    if (typeof body.input !== 'string' || body.input.length > 4096 || /[\x00-\x1f\x7f]/.test(body.input)) {
      errors.push({ field: 'input', message: 'Use 0–4096 characters on one line without control characters' });
    }
    const nodes = Array.isArray(body.workflow?.nodes) ? body.workflow.nodes : [];
    if (!Number.isInteger(body.nodeIndex) || body.nodeIndex < 0 || body.nodeIndex >= Math.max(nodes.length, 1)) {
      errors.push({ field: 'nodeIndex', message: 'Use the position of one of the workflow nodes, counting from 0' });
    }
    if (errors.length) throw fieldErrors(errors);

    const definition = {
      agentsDecide: body.workflow.agentsDecide,
      notesDir: PREVIEW.notesDir,
      steps: nodes.map((node, index) => ({
        kind: 'node',
        name: node.name.trim(),
        // The note path helper wants every step to name its agent; the name is not part of what is sent.
        agent: { name: 'not chosen yet' },
        readOnly: node.readOnly === true,
        askOwner: node.askOwner === true,
        repeat: node.repeat.mode === 'loop_back' ? { mode: 'loop_back', toStepIndex: loopTargetIndex(nodes, index), max: node.repeat.max } : node.repeat,
      })),
    };
    const node = nodes[body.nodeIndex];
    // An empty example input leaves the placeholder visible instead of an empty gap.
    const command = composePrompt(node.prompt, body.input === '' ? '{input}' : body.input, errors, 'input');
    if (errors.length) throw fieldErrors(errors);
    const guidance = buildStepGuidance(definition, body.nodeIndex, { worktreePath: PREVIEW.worktreePath });
    res.json({
      stepName: definition.steps[body.nodeIndex].name,
      prompt: buildPassPrompt(command, PREVIEW.identifier, guidance),
      placeholders: PREVIEW,
      // A leading /skill is written $skill for Codex; which CLI runs the step is only known in a run.
      skillRewrite: /^\/(?=[A-Za-z0-9][A-Za-z0-9_-]*(?:\s|$))/.test(command),
    });
  }));

  // --- Settings ---

  router.get(`${BASE}/settings`, route((_req, res) => {
    res.json(settingsStore.get());
  }));

  router.put(`${BASE}/settings`, route((req, res) => {
    const errors = validateSettingsBody(req.body);
    if (errors.length) throw fieldErrors(errors);
    if (req.body.setupAgentId !== null && !agentStore.get(req.body.setupAgentId)) {
      throw fieldError('setupAgentId', 'Use null or a UUID of an existing agent');
    }
    try {
      res.json(settingsStore.update(req.body));
    } catch (err) {
      mapMutationError(err, 'Settings');
    }
  }));

  // --- Preflight ---

  router.get(`${BASE}/preflight`, route(async (req, res) => {
    rejectUnknownQuery(req.query, ['project']);
    if (!isText(req.query.project)) throw fieldError('project', 'A project name is required');
    const project = findProject(req.query.project);
    if (!project) throw new PipelineError('Project not found', 404);
    const settings = settingsStore.get();
    const result = await preflight({
      projectPath: project.path,
      projectHost: project.host,
      setupAgentId: settings.setupAgentId,
      execFile,
      realpath,
    });
    res.json({
      project: project.name,
      eligible: result.eligible,
      reasons: result.reasons,
      branch: result.branch,
      head: result.head,
      dirty: result.dirty,
    });
  }));

  // --- Worktrees ---

  /** Preflight for a project, refusing with 409 unless the only thing missing is `ignoredCode`. */
  async function requireRunnableProject(project, ignoredCode) {
    const settings = settingsStore.get();
    const check = await preflight({
      projectPath: project.path,
      projectHost: project.host,
      setupAgentId: settings.setupAgentId,
      execFile,
      realpath,
    });
    const blocking = check.reasons.filter(reason => reason.code !== ignoredCode);
    if (blocking.length > 0) {
      throw new PipelineError(
        blocking[0]?.message || 'Run start preconditions failed',
        409,
        undefined,
        { reasons: blocking },
      );
    }
    return settings;
  }

  /**
   * What a run of this workflow with this input would work from, before anything is started:
   * which of the project's repositories holds the progress file at its current commit, and what
   * that file's Repositories line says about the others. Reads only; saves nothing.
   */
  router.post(`${BASE}/run-plans`, route(async (req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw fieldError('body', 'A JSON object is required');
    const errors = Object.keys(body).filter(field => !['workflowId', 'project', 'input'].includes(field)).map(field => ({ field, message: 'Unknown field' }));
    if (!isUuid(body.workflowId)) errors.push({ field: 'workflowId', message: 'Use a workflow UUID' });
    if (!isText(body.project) || body.project.length > 200) errors.push({ field: 'project', message: 'Use the name of a project' });
    if (typeof body.input !== 'string' || body.input.length < 1 || body.input.length > 4096 || /[\x00-\x1f\x7f]/.test(body.input)) {
      errors.push({ field: 'input', message: 'Use 1–4096 characters on one line without control characters' });
    }
    if (errors.length) throw fieldErrors(errors);

    const workflow = workflowStore.get(body.workflowId);
    if (!workflow) throw new PipelineError('Workflow not found', 404);
    const project = findProject(body.project);
    if (!project) throw new PipelineError('Project not found', 404);

    const nothing = { progressFile: null, input: body.input, foundIn: null, problem: null, repositories: null };
    const template = workflow.progressFile;
    if (template === null) return res.json(nothing);
    // The two ways an input names the progress file: as the part that replaces {input}, or as the file's whole path.
    const part = inputFromProgressFilePath(template, body.input);
    const readings = [{ file: composePrompt(template, body.input), input: body.input }, ...(part === null ? [] : [{ file: body.input, input: part }])]
      .filter(reading => isProgressFilePath(reading.file, 512));
    if (readings.length === 0) return res.json(nothing);

    await requireRunnableProject(project, SETUP_AGENT_MISSING);
    const ownName = path.basename(await resolveHomeRepoPath({ projectPath: project.path, execFile }));
    const checkouts = [{ repository: ownName, path: project.path }, ...readStoredRepositories(project).map(entry => ({ repository: entry.name, path: entry.path }))];

    let found = null;
    for (const reading of readings) {
      for (const checkout of checkouts) {
        if (await hasCommittedFile({ repoPath: checkout.path, progressFile: reading.file, execFile })) { found = { ...reading, checkout }; break; }
      }
      if (found) break;
    }
    if (!found) return res.json({ ...nothing, progressFile: readings[0].file, input: readings[0].input });

    const plan = { progressFile: found.file, input: found.input, foundIn: found.checkout.repository, problem: null, repositories: null };
    const header = parseTodoRepositories(await readCommittedFile({ repoPath: found.checkout.path, file: found.file, execFile }));
    if (!header.found) return res.json(plan);
    if (header.problem !== null) return res.json({ ...plan, problem: header.problem });
    const claimed = header.entries.find(entry => entry.role === 'this');
    if (claimed && claimed.repository !== found.checkout.repository) {
      return res.json({ ...plan, problem: `The Repositories line says this todo belongs to ${claimed.repository}, but it is in ${found.checkout.repository}.` });
    }

    const repositories = [];
    for (const entry of header.entries) {
      const checkout = checkouts.find(candidate => candidate.repository === entry.repository) ?? null;
      // The input a run of this workflow takes for another repository's todo; null when its path does not fit the Progress file.
      const input = entry.role !== 'todo' ? null : template === '{input}' ? entry.todo : inputFromProgressFilePath(template, entry.todo);
      const present = entry.role === 'todo' && checkout ? await hasCommittedFile({ repoPath: checkout.path, progressFile: entry.todo, execFile }) : null;
      repositories.push({ repository: entry.repository, role: entry.role, todo: entry.todo, input, listed: checkout !== null, present });
    }
    res.json({ ...plan, repositories });
  }));

  router.get(`${BASE}/worktrees`, route(async (req, res) => {
    const query = parseCollectionQuery(req.query, {
      sortFields: WORKTREE_SORT,
      defaultSort: 'path,asc',
      filters: [{
        name: 'project',
        parse: (value) => {
          if (!isText(value)) throw fieldError('project', 'A project name is required');
          return value;
        },
      }],
    });
    if (query.filters.project === undefined) throw fieldError('project', 'A project name is required');
    const project = findProject(query.filters.project);
    if (!project) throw new PipelineError('Project not found', 404);
    // Listing worktrees needs a local git repository, not a setup agent.
    await requireRunnableProject(project, SETUP_AGENT_MISSING);

    const worktrees = await listWorktrees({ projectPath: project.path, execFile });
    const projectPath = await (realpath ?? fs.promises.realpath)(project.path);
    const runs = runStore.list();
    const page = paginate(worktrees.map(worktree => ({ ...worktree, id: worktree.path })), query);
    const data = await Promise.all(page.data.map(async (worktree) => {
      const changes = worktree.missing ? null : await readWorktreeChanges({ worktreePath: worktree.path, execFile });
      const reason = worktreeRefusal(worktree, changes, runs);
      return {
        path: worktree.path,
        name: path.basename(worktree.path),
        branch: worktree.branch,
        head: worktree.head,
        current: worktree.path === projectPath,
        dirty: changes?.readable ? changes.dirty : null,
        selectable: reason === null,
        reason,
      };
    }));
    res.json({ data, page: page.page });
  }));

  // --- Runs ---

  router.get(`${BASE}/runs`, route(async (req, res) => {
    const query = parseCollectionQuery(req.query, {
      sortFields: RUN_SORT,
      defaultSort: 'createdAt,desc',
      filters: [
        {
          name: 'status',
          parse: value => {
            if (!isText(value)) throw fieldError('status', 'A status filter is required');
            return value;
          },
        },
        {
          name: 'project',
          parse: value => {
            if (!isText(value)) throw fieldError('project', 'A project filter is required');
            return value;
          },
        },
        {
          name: 'workflowId',
          parse: value => {
            if (!isUuid(value)) throw fieldError('workflowId', 'Use a workflow UUID');
            return value;
          },
        },
        {
          name: 'open',
          parse: value => {
            if (value !== 'true' && value !== 'false') {
              throw fieldError('open', 'Use true or false');
            }
            return value === 'true';
          },
        },
        {
          name: 'taskId',
          parse: value => {
            if (!isUuid(value)) throw fieldError('taskId', 'Use a task UUID');
            return value;
          },
        },
      ],
    });

    let records = runStore.list();
    const { status, project, workflowId, open } = query.filters;
    if (status !== undefined) records = records.filter(run => run.status === status);
    if (project !== undefined) records = records.filter(run => run.project === project);
    if (workflowId !== undefined) records = records.filter(run => run.workflowId === workflowId);
    if (open !== undefined) records = records.filter(run => isOpenRun(run) === open);
    if (query.filters.taskId !== undefined) records = records.filter(run => run.taskId === query.filters.taskId);

    const page = paginate(records, query);
    res.json({
      data: await Promise.all(page.data.map(run => asRunView(run))),
      page: page.page,
    });
  }));

  const startsInFlight = new Map();
  const reusedRequest = () => new PipelineError('This requestId was already used with a different body', 409);

  async function provisionRun(body, reservation) {
    // A run works in a new worktree of its own, in a worktree named by path, in an existing
    // task, or in a task created for it. Only a worktree CodeDeck has just created gets Setup.
    const inTask = body.taskId !== undefined;
    const forNewTask = body.newTask !== undefined;
    const useExisting = body.worktreePath !== undefined || inTask;
    const workflow = workflowStore.get(body.workflowId);
    if (!workflow) throw new PipelineError('Workflow not found', 404);

    const project = findProject(body.project);
    if (!project) throw new PipelineError('Project not found', 404);

    // A new worktree is prepared by the Setup step, so only that case needs a setup agent.
    const settings = await requireRunnableProject(project, useExisting ? SETUP_AGENT_MISSING : null);

    // The project's repositories: its own, at its path, and the others it lists.
    const ownHome = await resolveHomeRepoPath({ projectPath: project.path, execFile });
    const ownName = path.basename(ownHome);
    const otherRepositories = readStoredRepositories(project);
    const checkouts = [{ repository: ownName, path: project.path }, ...otherRepositories.map(entry => ({ repository: entry.name, path: entry.path }))];
    const several = otherRepositories.length > 0;

    // Where the run works: `checkoutPath` is the checkout of the repository it starts in, `homePath` that repository's home.
    let homePath = ownHome;
    let checkoutPath = project.path;
    let startRepository = ownName;
    const runId = randomUUID();
    let names;
    let worktree = null;
    let task = null;
    let taskPlan = null;
    // What a step is told about where it may work and read, for the instructions' length check.
    let places;
    if (inTask) {
      task = taskStore.get(body.taskId);
      if (!task) throw new PipelineError('Task not found', 404);
      if (task.project !== project.name) throw fieldError('taskId', 'This task belongs to another project');
    } else if (forNewTask && reservation.taskId !== null) {
      task = taskStore.get(reservation.taskId);
    }
    if (task && !OPEN_TASK.has(task.state)) throw new PipelineError('This task is finished.', 409);
    // Setup prepares every worktree of a task created for the run, the one it works in first.
    let setupPairs = null;
    // The repository the run starts in is the one a new task starts in: its worktree comes first.
    const asked = forNewTask ? body.newTask.repositories : undefined;
    if (forNewTask && !task) {
      const repositories = body.startIn === undefined ? asked : [body.startIn, ...(asked ?? []).filter(name => name !== body.startIn)];
      try {
        const typed = body.newTask.title !== undefined;
        taskPlan = await taskService.plan({
          project: project.name,
          title: typed ? body.newTask.title : provisionalTaskTitle(body.input, workflow.name),
          titleSource: typed ? 'owner' : 'input',
          ...(repositories === undefined ? {} : { repositories }),
        });
      } catch (err) {
        if (!Number.isInteger(err?.status)) throw err;
        if (err.status === 400) {
          throw fieldErrors((err.errors ?? []).map(item => ({
            field: item.field === 'title' ? 'newTask.title' : item.field === 'repositories' ? (asked === undefined ? 'startIn' : 'newTask.repositories') : item.field,
            message: item.message,
          })));
        }
        throw new PipelineError(err.message, err.status);
      }
      names = { worktreePath: taskPlan.worktreePath, branch: taskPlan.branch };
      const first = taskPlan.worktrees[0];
      homePath = first.homePath;
      checkoutPath = first.checkoutPath;
      startRepository = first.repository;
      setupPairs = taskPlan.worktrees.map(entry => ({ repository: entry.repository, homePath: entry.homePath, worktreePath: entry.worktreePath }));
      const included = new Set(taskPlan.worktrees.map(entry => entry.repository));
      places = {
        current: first.repository,
        worktrees: taskPlan.worktrees.map(entry => ({ repository: entry.repository, path: entry.worktreePath })),
        readOnly: checkouts.filter(entry => !included.has(entry.repository)),
      };
    } else if (useExisting || task) {
      let wantedPath;
      if (task) {
        // The run starts in the repository named, or where a terminal of the task would open. A task
        // recorded for an earlier attempt of this request is used the same way.
        const open = task.worktrees.filter(candidate => OPEN_TASK.has(candidate.state));
        const target = body.startIn === undefined ? open[0] : open.find(candidate => candidate.repository === body.startIn);
        if (!target) throw fieldError('startIn', 'Use the name of a repository of this task that is still open');
        wantedPath = target.worktreePath;
        const checkoutOf = candidate => (candidate.own ? project.path : candidate.repositoryPath);
        checkoutPath = checkoutOf(target);
        startRepository = target.repository;
        if (forNewTask) {
          setupPairs = [];
          for (const entry of [target, ...open.filter(candidate => candidate !== target)]) {
            setupPairs.push({ repository: entry.repository, homePath: await resolveHomeRepoPath({ projectPath: checkoutOf(entry), execFile }), worktreePath: entry.worktreePath });
          }
        }
      } else {
        wantedPath = body.worktreePath;
        // Main reaches every repository of the project: the path may be the own checkout of one of the others.
        const other = otherRepositories.find(entry => entry.path === wantedPath);
        if (other) { checkoutPath = other.path; startRepository = other.name; }
      }
      if (checkoutPath !== project.path) homePath = await resolveHomeRepoPath({ projectPath: checkoutPath, execFile });
      // The path is only ever one git itself reported for a repository of this project.
      const worktrees = await listWorktrees({ projectPath: checkoutPath, execFile });
      worktree = worktrees.find(candidate => candidate.path === wantedPath) ?? null;
      const taskFilesMissing = () => new PipelineError("This task's files are no longer on disk.", 409);
      if (task && !worktree) throw taskFilesMissing();
      if (!worktree) throw new PipelineError('Worktree not found for this project', 404);
      if (forNewTask) {
        // A locked worktree can still be listed without Git marking it prunable.
        if (worktree.missing) throw taskFilesMissing();
        const directory = await fs.promises.stat(worktree.path).catch(error => {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
          throw error;
        });
        if (!directory?.isDirectory()) throw taskFilesMissing();
      }
      const changes = worktree.missing ? null : await readWorktreeChanges({ worktreePath: worktree.path, execFile });
      const refusal = worktreeRefusal(worktree, changes, runStore.list());
      if (refusal) throw new PipelineError(refusal.message, 409, undefined, { reasons: [refusal] });
      // A task takes one unfinished run at a time: two could change the same worktrees.
      if (inTask && runStore.list().some(run => run.taskId === task.id && run.status !== 'complete' && isOpenRun(run))) {
        const busy = { code: 'task_in_use', message: 'An open workflow run is working in another repository of this task. Stop it or let it finish first.' };
        throw new PipelineError(busy.message, 409, undefined, { reasons: [busy] });
      }
      names = { worktreePath: worktree.path, branch: worktree.branch };
      places = await runPlaces({ project: project.name, taskId: task ? task.id : null, worktreePath: worktree.path });
    } else {
      names = planNames({
        runId,
        workflowName: workflow.name,
        homeRepoPath: homePath,
      });
      places = { current: ownName, worktrees: [{ repository: ownName, path: names.worktreePath }], readOnly: checkouts.slice(1) };
    }

    // The definition a run with this input would have; refuses what cannot be told to its steps.
    const snapshot = (forInput) => {
      const built = buildDefinitionSnapshot({
        workflow,
        agentStore,
        settings,
        input: forInput,
        setupPairs: setupPairs ?? [{ repository: startRepository, homePath, worktreePath: names.worktreePath }],
        checkouts,
        withSetup: !useExisting,
      });
      built.notesDir = `.codedeck/runs/${runId.slice(0, 8)}`;
      for (let index = 0; index < built.steps.length; index++) {
        const guidance = buildStepGuidance(built, index, { worktreePath: names.worktreePath, places,
          ...(built.steps[index].approval ? { feedbackPath: feedbackPath(built, index) } : {}) });
        if (guidance !== undefined && guidance.length > GUIDANCE_MAX) {
          throw fieldError('project', places.worktrees.length + places.readOnly.length > 1
            ? `The paths of this project's repositories are too long for the step instructions: ${[...places.worktrees, ...places.readOnly].map(entry => entry.repository).join(', ')}`
            : 'The worktree path is too long for the step instructions');
        }
      }
      return built;
    };
    // The input the run is recorded with: what was typed, or the part of it that replaces {input} (below).
    let input = body.input;
    let definition = snapshot(input);

    if (definition.progressFile !== null) {
      // The progress file is read in the worktree the run works in: a new one copies the commit of its repository's checkout.
      const present = file => (useExisting
        ? isProgressFileInWorktree({ worktreePath: names.worktreePath, progressFile: file })
        : hasCommittedFile({ repoPath: checkoutPath, progressFile: file, execFile }));
      if (!(await present(definition.progressFile))) {
        // The owner may have typed the file's whole path, not only the part that replaces {input}.
        // Read that way the progress file is the input itself, and the run starts with the part.
        const part = inputFromProgressFilePath(workflow.progressFile, body.input);
        const whole = part !== null && isProgressFilePath(body.input, 512) ? body.input : null;
        if (whole === null || !(await present(whole))) {
          const missing = whole === null ? `${definition.progressFile} is not` : `Neither ${definition.progressFile} nor ${whole} is`;
          const message = useExisting
            ? `${missing} in the chosen worktree. Add it there, or choose the worktree that contains it.`
            : several
              ? `${missing} in ${startRepository} at its current commit. Commit it there, or start the run in the repository that contains it.`
              : `${missing} in this repository at its current commit. Commit it, or start the run from the project that contains it.`;
          throw fieldError('input', message);
        }
        input = part;
        definition = snapshot(input);
        if (definition.progressFile !== whole) throw new Error(`pipelines: progress file ${definition.progressFile} does not match the path typed`);
      }
    }

    // Everything that can refuse the run has been checked; only now is the task's worktree created.
    if (taskPlan) {
      requestStore.setTaskId(body.requestId, taskPlan.id);
      reservation.taskId = taskPlan.id;
      try {
        task = await taskService.createPlanned(taskPlan);
      } catch (err) {
        if (!Number.isInteger(err?.status)) throw err;
        throw new PipelineError(err.message, err.status);
      }
    }

    // The checks above awaited, so another start may have taken this worktree since. This check and
    // the insert below are synchronous, so no other request can run between them.
    if (worktree) {
      const taken = worktreeRefusal(worktree, { readable: true }, runStore.list());
      if (taken) throw new PipelineError(taken.message, 409, undefined, { reasons: [taken] });
    }

    let run;
    try {
      run = runStore.create({
        id: runId,
        requestId: body.requestId,
        workflowId: workflow.id,
        project: project.name,
        input,
        status: 'pending',
        stopReason: null,
        currentStepIndex: 0,
        error: null,
        definition,
        steps: definition.steps.map(() => pendingStep()),
        homePath,
        worktreePath: names.worktreePath,
        worktreeBranch: names.branch,
        // A task owns its worktree, so to the run it is one that already existed: never removed by the run.
        baseCommit: forNewTask ? task.baseCommit : worktree ? worktree.head : null,
        worktreeState: taskPlan || worktree ? 'external' : 'not_created',
        worktreeDetail: null,
        inputRequest: null,
        taskId: task ? task.id : null,
        finishedAt: null,
      });
    } catch (err) {
      if (/requestId already exists/i.test(String(err?.message || err))) {
        const raced = runStore.getByRequestId(body.requestId);
        if (raced) return { run: raced, status: 200 };
      }
      throw err;
    }

    // The new run takes the place of a finished one that was still shown there.
    for (const other of runStore.list()) {
      if (other.id !== run.id && other.status === 'complete' && other.worktreeState === 'external' && other.worktreePath === run.worktreePath) {
        runStore.update(other.id, { worktreeState: 'released', worktreeDetail: null });
      }
    }

    return { run, status: 201 };
  }

  router.post(`${BASE}/runs`, route(async (req, res) => {
    const body = req.body;
    const errors = validateRunStartBody(body);
    if (errors.length) throw fieldErrors(errors);

    const { requestId } = body;
    const params = serializeStartParams(body);
    let reservation = requestStore.get(requestId);
    const existing = runStore.getByRequestId(requestId);
    if (!reservation && existing) throw reusedRequest();
    if (!reservation) reservation = requestStore.reserve(requestId, params);
    if (reservation.params !== params) throw reusedRequest();

    const pending = startsInFlight.get(requestId);
    if (pending) {
      const { view } = await pending;
      return res.status(200).json(view);
    }
    if (existing) return res.status(200).json(await asRunView(existing));

    const start = Promise.resolve().then(async () => {
      try {
        const { run, status } = await provisionRun(body, reservation);
        return { run, status, view: await asRunView(run) };
      } catch (error) {
        const taskExists = reservation.taskId !== null && taskStore.get(reservation.taskId);
        if (!taskExists && !runStore.getByRequestId(requestId)) requestStore.release(requestId);
        throw error;
      } finally {
        startsInFlight.delete(requestId);
      }
    });
    startsInFlight.set(requestId, start);
    const { run, status, view } = await start;
    res.status(status).json(view);

    if (status === 201 && engine && typeof engine.start === 'function') {
      scheduleStart(() => {
        Promise.resolve(engine.start(run.id)).catch(err => {
          console.warn(
            `[pipelines] engine.start failed runId=${run.id} traceId=${req.pipelinesTraceId} error=${err?.message || err}`,
          );
        });
      });
    }
  }));

  router.get(`${BASE}/runs/:id`, route(async (req, res) => {
    if (!isUuid(req.params.id)) throw new PipelineError('Run not found', 404);
    const run = runStore.get(req.params.id);
    if (!run) throw new PipelineError('Run not found', 404);
    res.json(await asRunView(run));
  }));

  function loadRun(id) {
    if (!isUuid(id)) throw new PipelineError('Run not found', 404);
    const run = runStore.get(id);
    if (!run) throw new PipelineError('Run not found', 404);
    return run;
  }

  /** Carries out an owner action and answers the run as it then stands. */
  async function performOwnerAction(req, action, ...args) {
    loadRun(req.params.id);
    if (!engine || typeof engine[action] !== 'function') {
      throw new PipelineError(`Run ${action} is not available`, 500);
    }
    try {
      await engine[action](req.params.id, ...args);
    } catch (err) {
      mapEngineActionError(err);
    }
    const updated = runStore.get(req.params.id);
    if (!updated) throw new PipelineError('Run not found', 404);
    return updated;
  }

  async function runOwnerAction(req, res, action, ...args) {
    res.json(await asRunView(await performOwnerAction(req, action, ...args)));
  }

  /** What the terminal layer says it closed and could not close. */
  function requireClosedTerminals(result) {
    for (const field of ['closed', 'notClosed']) {
      if (!Array.isArray(result?.[field]) || result[field].some(id => typeof id !== 'string' || id.trim() === '')) {
        throw new TypeError(`closeRunTerminals: ${field} must be a list of session ids`);
      }
    }
    return { terminalsClosed: result.closed, terminalsNotClosed: result.notClosed };
  }

  router.post(`${BASE}/runs/:id/stop`, route(async (req, res) => {
    await runOwnerAction(req, res, 'stop');
  }));

  router.post(`${BASE}/runs/:id/resume`, route(async (req, res) => {
    await runOwnerAction(req, res, 'resume');
  }));

  router.post(`${BASE}/runs/:id/continue`, route(async (req, res) => {
    await runOwnerAction(req, res, 'continue');
  }));

  router.post(`${BASE}/runs/:id/answer`, route(async (req, res) => {
    loadRun(req.params.id);
    const errors = validateRunAnswerBody(req.body);
    if (errors.length > 0) throw fieldErrors(errors);
    await runOwnerAction(req, res, 'answer', req.body.answer);
  }));

  router.post(`${BASE}/runs/:id/approve`, route(async (req, res) => {
    loadRun(req.params.id);
    const errors = validateRunApproveBody(req.body);
    if (errors.length) throw fieldErrors(errors);
    await runOwnerAction(req, res, 'approve');
  }));

  router.post(`${BASE}/runs/:id/send-back`, route(async (req, res) => {
    loadRun(req.params.id);
    const errors = validateRunSendBackBody(req.body);
    if (errors.length) throw fieldErrors(errors);
    await runOwnerAction(req, res, 'sendBack', req.body.comment);
  }));

  // Close run. Only this, the owner's own action, closes the terminals the run used: a run closed because
  // another one started in its place, or because its task was finished, is not closed here.
  router.post(`${BASE}/runs/:id/cleanup`, route(async (req, res) => {
    const closed = await performOwnerAction(req, 'cleanup');
    // A run whose own worktree could not be removed is still on screen, and keeps its terminals.
    const terminals = isOpenRun(closed) ? { closed: [], notClosed: [] }
      : await closeRunTerminals(closed, runStore.list().filter(isOpenRun));
    res.json({ ...(await asRunView(closed)), ...requireClosedTerminals(terminals) });
  }));

  // What the run's agents were asked to settle themselves, in the order it happened.
  router.get(`${BASE}/runs/:id/decisions`, route((req, res) => {
    const run = loadRun(req.params.id);
    const query = parseCollectionQuery(req.query, { sortFields: DECISION_SORT, defaultSort: 'createdAt,asc', filters: [STEP_FILTER] });
    const stepIndex = query.filters.stepIndex ?? null;
    const total = decisionStore.count(run.id, stepIndex);
    const records = decisionStore.list(run.id, {
      offset: query.page * query.size,
      limit: query.size,
      direction: query.direction,
      stepIndex,
    });
    res.json({
      data: records.map(decisionView),
      page: {
        currentPage: query.page,
        size: query.size,
        totalElements: total,
        totalPages: Math.ceil(total / query.size),
        hasNextPage: (query.page + 1) * query.size < total,
      },
    });
  }));

  // What the owner answered when an agent asked, in the order the answers were given.
  router.get(`${BASE}/runs/:id/answers`, route((req, res) => {
    const run = loadRun(req.params.id);
    const query = parseCollectionQuery(req.query, { sortFields: REVIEW_SORT, defaultSort: 'createdAt,asc', filters: [STEP_FILTER] });
    // A run has a handful of answers at most; the store returns them oldest first.
    const all = answerStore.list(run.id, { stepIndex: query.filters.stepIndex ?? null });
    const ordered = query.direction === 'desc' ? all.reverse() : all;
    const total = ordered.length;
    res.json({
      data: ordered.slice(query.page * query.size, (query.page + 1) * query.size)
        .map(({ id, stepIndex, stepName, pass, questions, answer, createdAt }) => ({ id, stepIndex, stepName, pass, questions, answer, createdAt })),
      page: { currentPage: query.page, size: query.size, totalElements: total, totalPages: Math.ceil(total / query.size), hasNextPage: (query.page + 1) * query.size < total },
    });
  }));

  // The owner's approvals and send-backs, in the order they were given.
  router.get(`${BASE}/runs/:id/reviews`, route((req, res) => {
    const run = loadRun(req.params.id);
    const query = parseCollectionQuery(req.query, { sortFields: REVIEW_SORT, defaultSort: 'createdAt,asc', filters: [STEP_FILTER] });
    const stepIndex = query.filters.stepIndex;
    // A run has at most a handful of reviews; the store returns them oldest first.
    const all = reviewStore.list(run.id).filter(review => stepIndex === undefined || review.stepIndex === stepIndex);
    const ordered = query.direction === 'desc' ? all.reverse() : all;
    const total = ordered.length;
    res.json({
      data: ordered.slice(query.page * query.size, (query.page + 1) * query.size)
        .map(({ id, stepIndex: index, stepName, attempt, verdict, comment, createdAt }) => ({ id, stepIndex: index, stepName, attempt, verdict, comment, createdAt })),
      page: { currentPage: query.page, size: query.size, totalElements: total, totalPages: Math.ceil(total / query.size), hasNextPage: (query.page + 1) * query.size < total },
    });
  }));

  router.get(`${BASE}/runs/:id/notes`, route((req, res) => {
    const run = loadRun(req.params.id);
    const query = parseCollectionQuery(req.query, { sortFields: NOTE_SORT, defaultSort: 'createdAt,asc', filters: [{
      name: 'stepIndex',
      parse: value => {
        if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 32) throw fieldError('stepIndex', 'Use a non-negative step index');
        return Number(value);
      },
    }] });
    const stepIndex = query.filters.stepIndex ?? null;
    const total = noteStore.count(run.id, stepIndex);
    const records = noteStore.list(run.id, { offset: query.page * query.size, limit: query.size, direction: query.direction, stepIndex });
    res.json({
      data: records.map(({ id, stepIndex: index, stepName, attempt, pass, status, summary, content, createdAt }) => ({ id, stepIndex: index, stepName, attempt, pass, status, summary, content, createdAt })),
      page: { currentPage: query.page, size: query.size, totalElements: total, totalPages: Math.ceil(total / query.size), hasNextPage: (query.page + 1) * query.size < total },
    });
  }));

  router.use(BASE, (_req, _res, next) => next(new PipelineError('Pipelines endpoint not found', 404)));

  router.use((error, req, res, next) => {
    if (!req.originalUrl.startsWith(BASE)) return next(error);
    const status = error instanceof PipelineError
      ? error.status
      : error.type === 'entity.parse.failed' ? 400
        : error.type === 'entity.too.large' ? 413
          : 500;
    const isValidation = status === 400;
    const message = error instanceof PipelineError
      ? error.message
      : isValidation ? 'Malformed JSON body'
        : status === 413 ? 'Request body too large'
          : 'Pipelines request failed';
    const traceId = req.pipelinesTraceId ?? randomUUID();
    if (status >= 500) {
      console.error(`[pipelines] request failed status=${status} traceId=${traceId}`, error);
    } else {
      console.warn(`[pipelines] request failed status=${status} traceId=${traceId}`);
    }
    res.status(status).type('application/problem+json').json({
      type: 'about:blank',
      title: isValidation ? 'Validation Error' : 'Pipelines Error',
      status,
      detail: message,
      error: isValidation ? 'Validation Error' : 'Pipelines Error',
      message,
      timestamp: new Date().toISOString(),
      path: req.originalUrl.split('?')[0],
      traceId,
      ...(isValidation ? { errors: error.errors?.length ? error.errors : [{ field: 'body', message }] } : {}),
      ...(error instanceof PipelineError && error.extra ? error.extra : {}),
    });
  });

  return router;
}
