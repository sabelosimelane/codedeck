import express from 'express';
import { randomUUID } from 'node:crypto';
import { execFile as defaultExecFile } from 'node:child_process';
import {
  validateAgentBody,
  validateWorkflowBody,
  validateSettingsBody,
  validateRunStartBody,
  composePrompt,
  isUuid,
} from '../../shared/pipeline-definitions.mjs';
import { computeActions } from '../pipelines/run-machine.js';
import {
  preflight as defaultPreflight,
  planNames as defaultPlanNames,
  resolveHomeRepoPath as defaultResolveHomeRepoPath,
  buildSetupPrompt,
} from '../pipelines/run-worktree.js';

const BASE = '/api/pipelines';
const DEFAULT_SIZE = 20;
const MAX_SIZE = 100;
const OPEN_WORKTREE = new Set(['not_created', 'present', 'removal_blocked']);

const AGENT_SORT = ['name', 'updatedAt'];
const WORKFLOW_SORT = ['name', 'updatedAt'];
const RUN_SORT = ['createdAt', 'updatedAt', 'status'];

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

function parseCollectionQuery(query, { sortFields, defaultSort, filters = [] }) {
  rejectUnknownQuery(query, ['page', 'size', 'sort', ...filters.map(f => f.name)]);

  const page = query.page === undefined ? 0 : Number(query.page);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000) {
    throw fieldError('page', 'Use an integer from 0 to 100000');
  }
  const size = query.size === undefined ? DEFAULT_SIZE : Number(query.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SIZE) {
    throw fieldError('size', `Use an integer from 1 to ${MAX_SIZE}`);
  }

  const sort = query.sort ?? defaultSort;
  if (typeof sort !== 'string') throw fieldError('sort', 'Use field,asc or field,desc');
  const [field, direction, extra] = sort.split(',');
  if (!sortFields.includes(field) || !['asc', 'desc'].includes(direction) || extra !== undefined) {
    throw fieldError('sort', `Sort by ${sortFields.join(' or ')} with asc or desc`);
  }

  const filterValues = {};
  for (const filter of filters) {
    const raw = query[filter.name];
    if (raw === undefined) continue;
    filterValues[filter.name] = filter.parse(raw);
  }

  return { page, size, field, direction, filters: filterValues };
}

function paginate(records, { page, size, field, direction }) {
  const sorted = [...records].sort((a, b) => {
    const left = a[field] ?? '';
    const right = b[field] ?? '';
    const compared = String(left).localeCompare(String(right));
    return (direction === 'desc' ? -compared : compared)
      || String(a.id).localeCompare(String(b.id));
  });
  return {
    data: sorted.slice(page * size, (page + 1) * size),
    page: {
      currentPage: page,
      size,
      totalElements: records.length,
      totalPages: Math.ceil(records.length / size) || 0,
      hasNextPage: (page + 1) * size < records.length,
    },
  };
}

function isOpenRun(run) {
  if (run.status === 'complete') return run.worktreeState === 'removal_blocked';
  return OPEN_WORKTREE.has(run.worktreeState);
}

function asRunView(run) {
  return {
    id: run.id,
    requestId: run.requestId,
    workflowId: run.workflowId,
    workflowName: run.definition.workflowName,
    project: run.project,
    input: run.input,
    status: run.status,
    stopReason: run.stopReason,
    error: run.error,
    currentStepIndex: run.currentStepIndex,
    steps: run.definition.steps.map((defStep, index) => {
      const progress = run.steps[index];
      return {
        index,
        kind: defStep.kind,
        name: defStep.name,
        agentName: defStep.agent.name,
        repeat: defStep.repeat,
        status: progress.status,
        sessionId: progress.sessionId,
        priorSessionIds: progress.priorSessionIds,
        attempt: progress.attempt,
        iteration: progress.iteration,
        detail: progress.detail,
        startedAt: progress.startedAt,
        finishedAt: progress.finishedAt,
      };
    }),
    worktree: {
      path: run.worktreePath,
      branch: run.worktreeBranch,
      baseCommit: run.baseCommit,
      state: run.worktreeState,
      detail: run.worktreeDetail,
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
    detail: null,
    startedAt: null,
    finishedAt: null,
  };
}

function sameStartBody(existing, body) {
  return existing.workflowId === body.workflowId
    && existing.project === body.project
    && existing.input === body.input;
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
  homePath,
  worktreePath,
}) {
  const errors = [];
  const needsInput = workflow.nodes.some(node => String(node.prompt).includes('{input}'));
  if (needsInput && (!input || !input.trim())) {
    errors.push({ field: 'input', message: 'input is required when a node prompt contains {input}' });
  }

  const setupAgent = settings?.setupAgentId ? agentStore.get(settings.setupAgentId) : null;
  if (!setupAgent) {
    errors.push({ field: 'setupAgentId', message: 'Choose a setup agent in Settings → Workflows.' });
  }

  const nodeSteps = workflow.nodes.map(node => {
    const agent = agentStore.get(node.agentId);
    if (!agent) {
      errors.push({ field: 'workflowId', message: 'Workflow references a missing agent' });
      return null;
    }
    const prompt = composePrompt(node.prompt, input, errors, 'input');
    return {
      kind: 'node',
      name: node.name,
      prompt,
      repeat: node.repeat.mode === 'once'
        ? { mode: 'once' }
        : { mode: 'until_complete', max: node.repeat.max },
      agent: agentSnapshot(agent),
    };
  });

  if (errors.length) throw fieldErrors(errors);

  const setupStep = {
    kind: 'setup',
    name: 'Setup',
    prompt: buildSetupPrompt(homePath, worktreePath),
    repeat: { mode: 'until_complete', max: 3 },
    agent: agentSnapshot(setupAgent),
  };

  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowRevision: workflow.revision,
    steps: [setupStep, ...nodeSteps],
  };
}

function mapEngineActionError(err) {
  if (err?.code === 'ACTION_REFUSED') {
    throw new PipelineError(err.message || 'Action not allowed', 409);
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
    findProject,
    engine,
    preflight = defaultPreflight,
    planNames = defaultPlanNames,
    resolveHomeRepoPath = defaultResolveHomeRepoPath,
    execFile = defaultExecFile,
    realpath,
    scheduleStart = setImmediate,
  } = deps ?? {};

  if (!agentStore) throw new Error('pipelines router: agentStore is required');
  if (!workflowStore) throw new Error('pipelines router: workflowStore is required');
  if (!settingsStore) throw new Error('pipelines router: settingsStore is required');
  if (!runStore) throw new Error('pipelines router: runStore is required');
  if (typeof findProject !== 'function') throw new Error('pipelines router: findProject must be a function');

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

  // --- Runs ---

  router.get(`${BASE}/runs`, route((req, res) => {
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
      ],
    });

    let records = runStore.list();
    const { status, project, workflowId, open } = query.filters;
    if (status !== undefined) records = records.filter(run => run.status === status);
    if (project !== undefined) records = records.filter(run => run.project === project);
    if (workflowId !== undefined) records = records.filter(run => run.workflowId === workflowId);
    if (open !== undefined) records = records.filter(run => isOpenRun(run) === open);

    const page = paginate(records, query);
    res.json({
      data: page.data.map(asRunView),
      page: page.page,
    });
  }));

  router.post(`${BASE}/runs`, route(async (req, res) => {
    const errors = validateRunStartBody(req.body);
    if (errors.length) throw fieldErrors(errors);

    const body = {
      requestId: req.body.requestId,
      workflowId: req.body.workflowId,
      project: req.body.project,
      input: req.body.input,
    };

    const existing = runStore.getByRequestId(body.requestId);
    if (existing) {
      if (sameStartBody(existing, body)) {
        return res.status(200).json(asRunView(existing));
      }
      throw new PipelineError('This requestId was already used with a different body', 409);
    }

    const workflow = workflowStore.get(body.workflowId);
    if (!workflow) throw new PipelineError('Workflow not found', 404);

    const project = findProject(body.project);
    if (!project) throw new PipelineError('Project not found', 404);

    const settings = settingsStore.get();
    const check = await preflight({
      projectPath: project.path,
      projectHost: project.host,
      setupAgentId: settings.setupAgentId,
      execFile,
      realpath,
    });
    if (!check.eligible) {
      const first = check.reasons[0];
      throw new PipelineError(
        first?.message || 'Run start preconditions failed',
        409,
        undefined,
        { reasons: check.reasons },
      );
    }

    const homePath = await resolveHomeRepoPath({
      projectPath: project.path,
      execFile,
    });
    const runId = randomUUID();
    const names = planNames({
      runId,
      workflowName: workflow.name,
      homeRepoPath: homePath,
    });

    const definition = buildDefinitionSnapshot({
      workflow,
      agentStore,
      settings,
      input: body.input,
      homePath,
      worktreePath: names.worktreePath,
    });

    let run;
    try {
      run = runStore.create({
        id: runId,
        requestId: body.requestId,
        workflowId: workflow.id,
        project: project.name,
        input: body.input,
        status: 'pending',
        stopReason: null,
        currentStepIndex: 0,
        error: null,
        definition,
        steps: definition.steps.map(() => pendingStep()),
        homePath,
        worktreePath: names.worktreePath,
        worktreeBranch: names.branch,
        baseCommit: null,
        worktreeState: 'not_created',
        worktreeDetail: null,
        finishedAt: null,
      });
    } catch (err) {
      if (/requestId already exists/i.test(String(err?.message || err))) {
        const raced = runStore.getByRequestId(body.requestId);
        if (raced && sameStartBody(raced, body)) {
          return res.status(200).json(asRunView(raced));
        }
        throw new PipelineError('This requestId was already used with a different body', 409);
      }
      throw err;
    }

    res.status(201).json(asRunView(run));

    if (engine && typeof engine.start === 'function') {
      scheduleStart(() => {
        Promise.resolve(engine.start(run.id)).catch(err => {
          console.warn(
            `[pipelines] engine.start failed runId=${run.id} traceId=${req.pipelinesTraceId} error=${err?.message || err}`,
          );
        });
      });
    }
  }));

  router.get(`${BASE}/runs/:id`, route((req, res) => {
    if (!isUuid(req.params.id)) throw new PipelineError('Run not found', 404);
    const run = runStore.get(req.params.id);
    if (!run) throw new PipelineError('Run not found', 404);
    res.json(asRunView(run));
  }));

  function loadRun(id) {
    if (!isUuid(id)) throw new PipelineError('Run not found', 404);
    const run = runStore.get(id);
    if (!run) throw new PipelineError('Run not found', 404);
    return run;
  }

  async function runOwnerAction(req, res, action) {
    loadRun(req.params.id);
    if (!engine || typeof engine[action] !== 'function') {
      throw new PipelineError(`Run ${action} is not available`, 500);
    }
    try {
      await engine[action](req.params.id);
    } catch (err) {
      mapEngineActionError(err);
    }
    const updated = runStore.get(req.params.id);
    if (!updated) throw new PipelineError('Run not found', 404);
    res.json(asRunView(updated));
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

  router.post(`${BASE}/runs/:id/cleanup`, route(async (req, res) => {
    await runOwnerAction(req, res, 'cleanup');
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
