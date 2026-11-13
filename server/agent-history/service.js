import path from 'node:path';
import { buildResumeCommand } from './command.js';
import { CLIS, UUID } from './index.js';
export class SessionError extends Error {
  constructor(message, status, errors) { super(message); this.status = status; this.errors = errors; }
}
const invalid = (errors) => new SessionError('One or more fields failed validation.', 400, errors);
const field = (field, message) => ({ field, message });
const local = project => !project.host || project.host === 'local';
function projectFor(projects, name) {
  const project = projects.find(p => p.name === name);
  if (!project) throw new SessionError('Project not found', 404);
  if (!local(project)) throw new SessionError('Session search covers local projects only', 409);
  if (typeof project.path !== 'string' || !path.isAbsolute(project.path)) throw new Error(`Project ${name}: invalid path`);
  return project;
}
function validateGet(query) {
  const errors = [];
  for (const key of Object.keys(query)) if (!['project', 'cli', 'q', 'page', 'size', 'sort'].includes(key)) errors.push(field(key, 'Unknown query field'));
  if (query.project !== undefined && (typeof query.project !== 'string' || !query.project.trim())) errors.push(field('project', 'Use a project name'));
  if (query.cli !== undefined && !CLIS.includes(query.cli)) errors.push(field('cli', 'Use claude, codex, cursor or agy'));
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 200)) errors.push(field('q', 'Use text up to 200 characters'));
  const page = query.page === undefined ? 0 : Number(query.page);
  const size = query.size === undefined ? 20 : Number(query.size);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000 || (query.page !== undefined && !/^\d+$/.test(query.page))) errors.push(field('page', 'Use an integer from 0 to 100000'));
  if (!Number.isSafeInteger(size) || size < 1 || size > 100 || (query.size !== undefined && !/^\d+$/.test(query.size))) errors.push(field('size', 'Use an integer from 1 to 100'));
  if (query.sort !== undefined && query.sort !== '-updatedAt') errors.push(field('sort', 'Use -updatedAt'));
  if (errors.length) throw invalid(errors);
  return { project: query.project, cli: query.cli, q: query.q, page, size };
}
function validatePost(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid([field('body', 'Use an object')]);
  for (const key of Object.keys(body)) if (!['cli', 'conversationId', 'project'].includes(key)) errors.push(field(key, 'Unknown body field'));
  if (!CLIS.includes(body.cli)) errors.push(field('cli', 'Use claude, codex, cursor or agy'));
  if (typeof body.conversationId !== 'string' || !UUID.test(body.conversationId)) errors.push(field('conversationId', 'Use a UUID'));
  if (typeof body.project !== 'string' || !body.project.trim()) errors.push(field('project', 'Use a project name'));
  if (errors.length) throw invalid(errors);
  return body;
}
export function createAgentSessionsService({ loadProjects, history, startSession, submitCommand }) {
  for (const [name, value] of Object.entries({ loadProjects, startSession, submitCommand })) if (typeof value !== 'function') throw new Error(`Agent sessions requires ${name}`);
  if (typeof history?.search !== 'function') throw new Error('Agent sessions requires history.search');
  const inFlight = new Set();
  return {
    list(rawQuery) {
      const query = validateGet(rawQuery);
      const projects = loadProjects();
      const selected = query.project ? [projectFor(projects, query.project)] : projects.filter(local);
      const byPath = new Map(selected.map(p => [p.path, p.name]));
      const result = history.search([...byPath.keys()], query);
      return { ...result, data: result.data.map(record => ({ ...record, project: byPath.get(record.cwd) })) };
    },
    async resume(rawBody) {
      const body = validatePost(rawBody);
      const project = projectFor(loadProjects(), body.project);
      const key = `${body.project}:${body.cli}:${body.conversationId}`;
      if (inFlight.has(key)) throw new SessionError('Resume already in progress', 409);
      inFlight.add(key);
      try {
        const result = history.search([project.path], { cli: body.cli, size: Number.MAX_SAFE_INTEGER });
        const match = result.data.find(r => r.cli === body.cli && r.conversationId === body.conversationId && r.cwd === project.path);
        if (!match) throw new SessionError('Conversation not found', 404);
        const command = buildResumeCommand(body.cli, body.conversationId);
        const session = await startSession(project.name);
        if (typeof session?.id !== 'string' || !session.id.startsWith(`${project.name}-`)) throw new Error('Session starter returned invalid id');
        await submitCommand(session.id, command);
        return { sessionId: session.id, project: project.name, cli: body.cli, conversationId: body.conversationId };
      } finally { inFlight.delete(key); }
    },
  };
}
