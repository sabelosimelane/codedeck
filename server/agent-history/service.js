import path from 'node:path';
import { buildResumeCommand } from './command.js';
import { CLIS, UUID, mergeMultiHostHistory } from './index.js';
import { LOCAL_HOST, getProjectLocation, normalizeHostName, normalizeProjects } from '../project-config.js';

export class SessionError extends Error {
  constructor(message, status, errors) { super(message); this.status = status; this.errors = errors; }
}
const invalid = (errors) => new SessionError('One or more fields failed validation.', 400, errors);
const field = (field, message) => ({ field, message });

function projectFor(projects, name) {
  const project = projects.find(p => p.name === name);
  if (!project) throw new SessionError('Project not found', 404);
  if (!project.locations.length || project.locations.some(loc => typeof loc.path !== 'string' || !path.isAbsolute(loc.path))) {
    throw new Error(`Project ${name}: invalid path`);
  }
  return project;
}

function validateGet(query) {
  const errors = [];
  for (const key of Object.keys(query)) if (!['project', 'host', 'cli', 'q', 'page', 'size', 'sort', 'refresh'].includes(key)) errors.push(field(key, 'Unknown query field'));
  if (query.project !== undefined && (typeof query.project !== 'string' || !query.project.trim())) errors.push(field('project', 'Use a project name'));
  if (query.host !== undefined && (typeof query.host !== 'string' || !query.host.trim())) errors.push(field('host', 'Use a host name'));
  if (query.cli !== undefined && !CLIS.includes(query.cli)) errors.push(field('cli', 'Use claude, codex, cursor or agy'));
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 200)) errors.push(field('q', 'Use text up to 200 characters'));
  const page = query.page === undefined ? 0 : Number(query.page);
  const size = query.size === undefined ? 20 : Number(query.size);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000 || (query.page !== undefined && !/^\d+$/.test(query.page))) errors.push(field('page', 'Use an integer from 0 to 100000'));
  if (!Number.isSafeInteger(size) || size < 1 || size > 100 || (query.size !== undefined && !/^\d+$/.test(query.size))) errors.push(field('size', 'Use an integer from 1 to 100'));
  if (query.sort !== undefined && query.sort !== '-updatedAt') errors.push(field('sort', 'Use -updatedAt'));
  if (query.refresh !== undefined && query.refresh !== '1' && query.refresh !== 'true') errors.push(field('refresh', 'Use 1 or true'));
  if (errors.length) throw invalid(errors);
  return {
    project: query.project,
    host: query.host ? normalizeHostName(query.host) : undefined,
    cli: query.cli,
    q: query.q,
    page,
    size,
    refresh: query.refresh === '1' || query.refresh === 'true',
  };
}

function validatePost(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid([field('body', 'Use an object')]);
  for (const key of Object.keys(body)) if (!['cli', 'conversationId', 'project', 'host'].includes(key)) errors.push(field(key, 'Unknown body field'));
  if (!CLIS.includes(body.cli)) errors.push(field('cli', 'Use claude, codex, cursor or agy'));
  if (typeof body.conversationId !== 'string' || !UUID.test(body.conversationId)) errors.push(field('conversationId', 'Use a UUID'));
  if (typeof body.project !== 'string' || !body.project.trim()) errors.push(field('project', 'Use a project name'));
  if (body.host !== undefined && (typeof body.host !== 'string' || !body.host.trim())) errors.push(field('host', 'Use a host name'));
  if (errors.length) throw invalid(errors);
  return body;
}

function groupLocationsByHost(projects) {
  const byHost = new Map();
  for (const project of projects) {
    for (const loc of project.locations) {
      if (typeof loc.path !== 'string' || !path.isAbsolute(loc.path)) continue;
      let pathMap = byHost.get(loc.host);
      if (!pathMap) {
        pathMap = new Map();
        byHost.set(loc.host, pathMap);
      }
      if (!pathMap.has(loc.path)) pathMap.set(loc.path, project.name);
    }
  }
  return byHost;
}

export function createAgentSessionsService({
  loadProjects,
  history,
  remoteHistory = null,
  materializeSession = null,
  startSession,
  submitCommand,
}) {
  for (const [name, value] of Object.entries({ loadProjects, startSession, submitCommand })) {
    if (typeof value !== 'function') throw new Error(`Agent sessions requires ${name}`);
  }
  if (typeof history?.search !== 'function') throw new Error('Agent sessions requires history.search');
  const inFlight = new Set();

  async function collectAcrossHosts(byHost, { refresh = false } = {}) {
    const entries = [...byHost.entries()];
    const results = await Promise.all(entries.map(async ([hostName, pathMap]) => {
      const cwds = [...pathMap.keys()];
      if (hostName === LOCAL_HOST) {
        const res = history.search(cwds, { size: Number.MAX_SAFE_INTEGER });
        return {
          host: LOCAL_HOST,
          available: true,
          error: null,
          sources: res.sources,
          records: res.data.map(r => ({ ...r, host: LOCAL_HOST, project: pathMap.get(r.cwd) })),
        };
      }
      if (!remoteHistory) {
        return {
          host: hostName,
          available: false,
          error: 'Remote history reader is not configured',
          sources: [],
          records: [],
        };
      }
      try {
        const res = await remoteHistory.listHost(hostName, cwds, { refresh });
        return {
          host: hostName,
          available: true,
          error: null,
          sources: res.sources,
          records: res.records.map(r => ({ ...r, host: hostName, project: pathMap.get(r.cwd) })),
        };
      } catch (err) {
        return {
          host: hostName,
          available: false,
          error: err?.message || `Unable to reach ${hostName}`,
          sources: [],
          records: [],
        };
      }
    }));
    return results;
  }

  return {
    async list(rawQuery) {
      const query = validateGet(rawQuery);
      const projects = normalizeProjects(loadProjects());
      const selected = query.project ? [projectFor(projects, query.project)] : projects;
      const byHost = groupLocationsByHost(selected);
      const hostResults = await collectAcrossHosts(byHost, { refresh: query.refresh });

      if (query.project && hostResults.length > 0 && hostResults.every(h => !h.available)) {
        throw new SessionError(hostResults[0].error || 'Host unreachable', 503);
      }

      return mergeMultiHostHistory(hostResults, query);
    },

    async resume(rawBody) {
      const body = validatePost(rawBody);
      const projects = normalizeProjects(loadProjects());
      const project = projectFor(projects, body.project);
      const targetHost = body.host ? normalizeHostName(body.host) : project.defaultHost;
      const targetLocation = getProjectLocation(project, targetHost);
      if (!targetLocation || typeof targetLocation.path !== 'string' || !path.isAbsolute(targetLocation.path)) {
        throw new SessionError(`Project ${project.name} has no location on host ${targetHost}`, 404);
      }

      const key = `${project.name}:${body.cli}:${body.conversationId}`;
      if (inFlight.has(key)) throw new SessionError('Resume already in progress', 409);
      inFlight.add(key);

      try {
        const byHost = groupLocationsByHost([project]);
        const hostResults = await collectAcrossHosts(byHost);
        const merged = mergeMultiHostHistory(hostResults, { cli: body.cli, size: Number.MAX_SAFE_INTEGER });
        const match = merged.data.find(r => r.cli === body.cli && r.conversationId === body.conversationId);
        if (!match) {
          if (hostResults.every(h => !h.available)) {
            throw new SessionError(hostResults[0]?.error || 'Host unreachable', 503);
          }
          throw new SessionError('Conversation not found', 404);
        }

        const sourceHost = match.host ?? LOCAL_HOST;
        const sourceCwd = match.cwd;
        let synced = false;

        if (sourceHost !== targetHost || sourceCwd !== targetLocation.path) {
          if (typeof materializeSession !== 'function') {
            throw new SessionError(`Cross-host session sync from ${sourceHost} to ${targetHost} is not configured`, 501);
          }
          await materializeSession({
            cli: body.cli,
            conversationId: body.conversationId,
            sourceHost,
            sourceCwd,
            targetHost,
            targetCwd: targetLocation.path,
          });
          synced = true;
          remoteHistory?.invalidate?.(targetHost);
        }

        const command = buildResumeCommand(body.cli, body.conversationId);
        const session = await startSession(project.name, { host: targetHost });
        if (typeof session?.id !== 'string' || !session.id.startsWith(`${project.name}-`)) {
          throw new Error('Session starter returned invalid id');
        }
        await submitCommand(session.id, command, { host: targetHost });
        return {
          sessionId: session.id,
          project: project.name,
          host: targetHost,
          cli: body.cli,
          conversationId: body.conversationId,
          synced,
        };
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
