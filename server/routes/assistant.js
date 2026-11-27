import express from 'express';
import { randomUUID } from 'node:crypto';
import { parseCollectionQuery, paginate } from './collection-query.js';
import { validConversationId } from '../assistant/conversation-store.js';
import { isLocalProject } from '../assistant/project.js';
import { readScopedDoc } from '../assistant/session-reads.js';
import { PROPOSAL_STATES, validateProposalCreateBody } from '../assistant/proposal-payloads.js';
import { validProposalId } from '../assistant/proposal-store.js';
import { isUuid } from '../../shared/pipeline-definitions.mjs';

export const ASSISTANT_PATH = /^(?:\/api\/projects\/[^/]+\/situation|\/api\/assistant\/(?:conversations|sessions|proposals|settings))(?:\/|$)/;

export function createAssistantRouter({
  compose,
  store,
  proposalStore,
  proposalExecutor,
  findProject,
  sessionTokens,
  repositoryService,
  taskStore,
  landing,
  runStore,
  noteStore,
  runView,
  onProposal,
  onSituationFlags,
  settingsStore,
} = {}) {
  if (typeof compose !== 'function') throw new TypeError('assistant router requires compose');
  const router = express.Router();
  const serves = req => ASSISTANT_PATH.test(req.path);
  router.use((req, res, next) => {
    if (!serves(req)) return next();
    req.assistantTraceId = randomUUID();
    res.set('X-Trace-Id', req.assistantTraceId);
    return next();
  });
  const bad = (field, message) => Object.assign(new Error('One or more fields failed validation.'), { status: 400, errors: [{ field, message }] });
  const validProject = project => typeof project === 'string' && /^[^<>/\\\x00-\x1f]{1,100}$/.test(project) && project !== '.' && project !== '..' && !project.includes('..');
  const checkProject = project => {
    if (!validProject(project)) throw bad('project', 'Use a valid project name');
    const found = findProject(project);
    if (!found) throw Object.assign(new Error('Project not found'), { status: 404 });
    if (!isLocalProject(found)) throw Object.assign(new Error('Assistant is only available for local projects.'), { status: 409 });
  };
  const checkFields = (source, allowed) => {
    const errors = Object.keys(source).filter(field => !allowed.includes(field)).map(field => ({ field, message: 'Unknown field' }));
    if (errors.length) throw Object.assign(new Error('One or more fields failed validation.'), { status: 400, errors });
  };
  router.use('/api/assistant/conversations', express.json({ limit: '4kb' }));
  router.use('/api/assistant/proposals', express.json({ limit: '4kb' }));
  router.use('/api/assistant/sessions', express.json({ limit: '16kb' }));
  router.use('/api/assistant/settings', express.json({ limit: '4kb' }));
  router.get('/api/assistant/settings', (req, res, next) => {
    try { checkFields(req.query, []); res.json(settingsStore.settings()); } catch (error) { next(error); }
  });
  router.put('/api/assistant/settings', (req, res, next) => {
    try {
      checkFields(req.query, []);
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw bad('body', 'Use a JSON object');
      res.json(settingsStore.saveSettings(req.body));
    } catch (error) {
      if (error?.errors) return next(Object.assign(error, { status: 400 }));
      next(error);
    }
  });
  router.get('/api/assistant/conversations/current', (req, res, next) => {
    try { checkFields(req.query, ['project']); checkProject(req.query.project); res.json(store.current(req.query.project)); }
    catch (error) { next(error); }
  });
  router.post('/api/assistant/conversations', (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw bad('body', 'Use a JSON object');
      checkFields(req.body, ['project']); checkFields(req.query, []); checkProject(req.body.project);
      const previous = store.findCurrent?.(req.body.project) ?? null;
      const created = store.startNew(req.body.project);
      if (previous) {
        proposalStore?.expireForConversation(previous.id);
        sessionTokens?.endConversation(previous.id);
      }
      res.status(201).json(created);
    } catch (error) { next(error); }
  });
  router.get('/api/assistant/conversations/:id/messages', (req, res, next) => {
    try {
      if (!validConversationId(req.params.id)) throw bad('id', 'Use a conversation id');
      const query = parseCollectionQuery(req.query, { sortFields: ['createdAt'], defaultSort: 'createdAt,asc' }, bad);
      const conversation = store.get(req.params.id);
      if (!conversation) throw Object.assign(new Error('Conversation not found'), { status: 404 });
      checkProject(conversation.project);
      res.json(store.messages(req.params.id, query));
    } catch (error) { next(error); }
  });
  router.get('/api/projects/:name/situation', async (req, res, next) => {
    try {
      checkFields(req.query, []);
      if (!validProject(req.params.name)) throw bad('name', 'Use a valid project name');
      res.json(await compose(req.params.name));
    } catch (error) { next(error); }
  });

  const requireSession = req => {
    const session = sessionTokens?.verify(req.params.token) ?? null;
    if (!session) throw Object.assign(new Error('Invalid or expired assistant session token.'), { status: 401 });
    return session;
  };

  router.get('/api/assistant/sessions/:token/situation', async (req, res, next) => {
    try {
      const session = requireSession(req);
      checkFields(req.query, []);
      const situation = await compose(session.project);
      res.json({
        project: situation.project,
        generatedAt: situation.generatedAt,
        flags: situation.flags,
        markdown: situation.markdown,
        truncated: situation.truncated,
        skipped: situation.skipped,
      });
    } catch (error) { next(error); }
  });

  router.get('/api/assistant/sessions/:token/tasks/:taskId/landing', async (req, res, next) => {
    try {
      const session = requireSession(req);
      checkFields(req.query, []);
      if (!isUuid(req.params.taskId)) throw bad('taskId', 'Use a valid task id');
      const task = taskStore?.get(req.params.taskId) ?? null;
      if (!task || task.project !== session.project) throw Object.assign(new Error('Task not found'), { status: 404 });
      const worktrees = await landing.worktrees(req.params.taskId);
      res.json({ taskId: task.id, project: session.project, worktrees });
    } catch (error) { next(error); }
  });

  router.get('/api/assistant/sessions/:token/todo', async (req, res, next) => {
    try {
      const session = requireSession(req);
      checkFields(req.query, ['location', 'path']);
      const doc = await readScopedDoc({
        project: session.project,
        location: req.query.location,
        relPath: req.query.path,
        repositoryService,
        taskStore,
      });
      res.json(doc);
    } catch (error) { next(error); }
  });

  router.get('/api/assistant/sessions/:token/runs/:runId/notes', (req, res, next) => {
    try {
      const session = requireSession(req);
      checkFields(req.query, ['stepIndex']);
      if (!isUuid(req.params.runId)) throw bad('runId', 'Use a valid run id');
      const rawStep = req.query.stepIndex;
      if (typeof rawStep !== 'string' || !/^\d+$/.test(rawStep)) throw bad('stepIndex', 'Use an integer from 0 to 32');
      const stepIndex = Number(rawStep);
      if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32) throw bad('stepIndex', 'Use an integer from 0 to 32');
      const run = runStore?.get(req.params.runId) ?? null;
      if (!run || run.project !== session.project) throw Object.assign(new Error('Run not found'), { status: 404 });
      const note = noteStore.lastWritten(run.id, stepIndex);
      res.json({ runId: run.id, stepIndex, note });
    } catch (error) { next(error); }
  });

  router.get('/api/assistant/sessions/:token/runs', async (req, res, next) => {
    try {
      const session = requireSession(req);
      const query = parseCollectionQuery(req.query, {
        sortFields: ['createdAt'],
        defaultSort: 'createdAt,desc',
        filters: [{
          name: 'taskId',
          parse: value => {
            if (!isUuid(value)) throw bad('taskId', 'Use a valid task id');
            return value;
          },
        }],
      }, bad);
      const matching = (runStore?.list() ?? []).filter(run =>
        run.project === session.project && (query.filters.taskId === undefined || run.taskId === query.filters.taskId),
      );
      const sliced = paginate(matching, query);
      const data = await Promise.all(sliced.data.map(run => runView(run)));
      res.json({ data, page: sliced.page });
    } catch (error) { next(error); }
  });

  const requireEmptyDecisionBody = req => {
    checkFields(req.query, []);
    if (req.body === undefined) return;
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw bad('body', 'No request body is accepted');
    }
    checkFields(req.body, []);
  };

  const notifyAfterDecision = async proposal => {
    if (!proposal) return;
    onProposal?.(proposal.project, proposal);
    if (typeof onSituationFlags === 'function') {
      try {
        const situation = await compose(proposal.project);
        onSituationFlags(proposal.project, situation.flags);
      } catch (error) {
        console.warn(`[assistant] situation refresh after proposal failed project=${proposal.project} error=${error?.message ?? error}`);
      }
    }
  };

  router.post('/api/assistant/sessions/:token/proposals', (req, res, next) => {
    try {
      const session = requireSession(req);
      checkFields(req.query, []);
      if (!proposalStore) throw new Error('Proposal store is unavailable');
      const errors = validateProposalCreateBody(req.body, { project: session.project, taskStore });
      if (errors.length) throw Object.assign(new Error('One or more fields failed validation.'), { status: 400, errors });
      const created = proposalStore.create({
        conversationId: session.conversationId,
        project: session.project,
        kind: req.body.kind,
        payload: req.body.payload,
        summary: req.body.summary,
        reason: req.body.reason,
      });
      onProposal?.(session.project, created);
      res.status(201).json(created);
    } catch (error) { next(error); }
  });

  router.get('/api/assistant/proposals', (req, res, next) => {
    try {
      if (!proposalStore) throw new Error('Proposal store is unavailable');
      const query = parseCollectionQuery(req.query, {
        sortFields: ['createdAt'],
        defaultSort: 'createdAt,desc',
        filters: [
          {
            name: 'project',
            parse: value => {
              checkProject(value);
              return value;
            },
          },
          {
            name: 'conversationId',
            parse: value => {
              if (!validConversationId(value)) throw bad('conversationId', 'Use a conversation id');
              return value;
            },
          },
          {
            name: 'state',
            parse: value => {
              if (!PROPOSAL_STATES.includes(value)) throw bad('state', `Use one of ${PROPOSAL_STATES.join(', ')}`);
              return value;
            },
          },
        ],
      }, bad);
      if (query.filters.project === undefined) throw bad('project', 'Use a valid project name');
      res.json(proposalStore.list({
        project: query.filters.project,
        conversationId: query.filters.conversationId,
        state: query.filters.state,
        page: query.page,
        size: query.size,
        direction: query.direction,
      }));
    } catch (error) { next(error); }
  });

  router.get('/api/assistant/proposals/:id', (req, res, next) => {
    try {
      checkFields(req.query, []);
      if (!validProposalId(req.params.id)) throw bad('id', 'Use a proposal id');
      if (!proposalStore) throw new Error('Proposal store is unavailable');
      const proposal = proposalStore.get(req.params.id);
      if (!proposal) throw Object.assign(new Error('Proposal not found'), { status: 404 });
      res.json(proposal);
    } catch (error) { next(error); }
  });

  router.post('/api/assistant/proposals/:id/approve', async (req, res, next) => {
    try {
      requireEmptyDecisionBody(req);
      if (!validProposalId(req.params.id)) throw bad('id', 'Use a proposal id');
      if (!proposalExecutor) throw new Error('Proposal executor is unavailable');
      const outcome = await proposalExecutor.approve(req.params.id);
      await notifyAfterDecision(outcome.proposal);
      if (outcome.status === 200) {
        res.json(outcome.proposal);
        return;
      }
      const extra = {
        ...(outcome.problem?.reasons ? { reasons: outcome.problem.reasons } : {}),
        ...(outcome.problem?.conflicts ? { conflicts: outcome.problem.conflicts } : {}),
        proposal: outcome.proposal,
      };
      throw Object.assign(new Error(outcome.problem?.message ?? 'Proposal execution failed.'), { status: outcome.status, extra });
    } catch (error) { next(error); }
  });

  router.post('/api/assistant/proposals/:id/decline', async (req, res, next) => {
    try {
      requireEmptyDecisionBody(req);
      if (!validProposalId(req.params.id)) throw bad('id', 'Use a proposal id');
      if (!proposalExecutor) throw new Error('Proposal executor is unavailable');
      const outcome = proposalExecutor.decline(req.params.id);
      await notifyAfterDecision(outcome.proposal);
      res.json(outcome.proposal);
    } catch (error) { next(error); }
  });

  router.use((req, _res, next) => (serves(req) ? next(Object.assign(new Error('Assistant endpoint not found'), { status: 404 })) : next()));
  router.use((error, req, res, next) => {
    if (!serves(req)) return next(error);
    const invalidName = error instanceof URIError;
    const status = invalidName || error?.type === 'entity.parse.failed' ? 400 : error?.type === 'entity.too.large' ? 413 : [400, 401, 404, 409, 413].includes(error?.status) ? error.status : 500;
    const title = status === 400 ? 'Validation Error' : status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : status === 413 ? 'Payload Too Large' : 'Assistant Error';
    const message = status === 500 ? 'The assistant request failed.' : invalidName ? 'One or more fields failed validation.' : status === 400 && error?.type === 'entity.parse.failed' ? 'Malformed JSON body.' : error?.message ?? title;
    const errors = status === 400 ? invalidName ? [{ field: 'name', message: 'Use a valid project name' }] : error?.errors ?? [{ field: 'body', message: 'Use valid JSON' }] : undefined;
    const extra = error?.extra && typeof error.extra === 'object' ? error.extra : undefined;
    const traceId = req.assistantTraceId ?? randomUUID();
    const route = `${req.method} ${req.route?.path ?? 'unmatched'}`;
    if (status >= 500) console.error(`[assistant] request failed status=${status} route=${route} traceId=${traceId}`, error);
    else console.warn(`[assistant] request refused status=${status} route=${route} traceId=${traceId}${errors ? ` fields=${errors.map(item => item.field).join(',')}` : ''}`);
    res.status(status).type('application/problem+json').json({ type: 'about:blank', title, status, detail: message, error: title, message, timestamp: new Date().toISOString(), path: req.originalUrl.split('?')[0], traceId, ...(errors ? { errors } : {}), ...(extra ?? {}) });
  });
  return router;
}
