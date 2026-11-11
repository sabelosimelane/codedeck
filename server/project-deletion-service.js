import { isTransportFailure } from './command-runner.js';
import { sessionIdForTmuxName } from './mobile-integration.js';

const hostOf = project => project.host || 'local';
const safeName = name => name.replace(/[^a-zA-Z0-9_-]/g, '_');
const belongsTo = (id, name) => id.startsWith(`${name}-`) && /^\d+$/.test(id.slice(name.length + 1));

export function createProjectDeletionService({ loadProjects, saveProjects, sessions, listSessionIds, deleteTerminalSession }) {
  if (typeof loadProjects !== 'function') throw new Error('loadProjects function required');
  if (typeof saveProjects !== 'function') throw new Error('saveProjects function required');
  if (!(sessions instanceof Map)) throw new Error('sessions map required');
  if (typeof listSessionIds !== 'function') throw new Error('listSessionIds function required');
  if (typeof deleteTerminalSession !== 'function') throw new Error('deleteTerminalSession function required');
  return async name => {
    if (typeof name !== 'string' || !name) throw new Error('project name required');
    const projects = loadProjects();
    if (!Array.isArray(projects)) throw new Error('projects array required');
    const project = projects.find(item => item.name === name);
    if (!project) return { status: 404, title: 'Project Not Found', detail: `Project ${name} was not found.` };
    const hostProjects = projects.filter(item => hostOf(item) === hostOf(project));
    let listed;
    try { listed = await listSessionIds(project); }
    catch (error) {
      return { status: isTransportFailure(error) ? 503 : 500, title: 'Project Remove Failed', detail: `Could not list terminal sessions for project ${name}.` };
    }
    if (!Array.isArray(listed) || listed.some(id => typeof id !== 'string' || !id)) throw new Error('tmux session list must contain non-empty names');
    for (const tmuxName of listed) {
      const match = tmuxName.match(/^(.*)-(\d+)$/);
      if (!match) continue;
      const owners = hostProjects.filter(item => safeName(item.name) === match[1]);
      if (owners.length > 1 && owners.some(item => item.name === project.name)) {
        return { status: 409, title: 'Ambiguous Terminal Session', detail: `Terminal session ${tmuxName} could belong to multiple projects; project ${name} was kept.` };
      }
    }
    const ids = new Set(listed.map(id => sessionIdForTmuxName(id, hostProjects)).filter(id => belongsTo(id, name)));
    for (const id of sessions.keys()) if (belongsTo(id, name)) ids.add(id);
    const failures = [];
    let closed = 0;
    let transport = false;
    for (const id of ids) {
      try { await deleteTerminalSession(id); closed++;
      } catch (error) { failures.push(id); transport ||= isTransportFailure(error); }
    }
    if (failures.length) {
      return {
        status: transport ? 503 : 500, title: 'Project Remove Failed',
        detail: `Closed ${closed} terminal session(s); could not close ${failures.length}: ${failures.join(', ')}. Project ${name} was kept.`,
      };
    }
    saveProjects(projects.filter(item => item.name !== name));
    return { ok: true };
  };
}
