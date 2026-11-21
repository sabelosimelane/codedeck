import path from 'node:path';
import { getProjectLocation } from './project-config.js';

export function createWorktreeSessionStarter({ start, loadProjects, store, now }) {
  if (typeof start !== 'function') throw new Error('worktree session start: start must be a function');
  if (typeof loadProjects !== 'function') throw new Error('worktree session start: loadProjects must be a function');
  if (typeof store?.set !== 'function') throw new Error('worktree session start: store.set must be a function');
  if (typeof now !== 'function') throw new Error('worktree session start: now must be a function');
  return async (project, options) => {
    if (typeof project !== 'string' || project.trim() === '') throw new Error('worktree session start: project must be a nonempty string');
    const configured = loadProjects().find(item => item.name === project);
    const location = configured ? getProjectLocation(configured, options?.host) : null;
    const basePath = location?.path ?? configured?.path;
    if (!configured || typeof basePath !== 'string' || !path.isAbsolute(basePath)) throw new Error(`worktree session start: project ${project} has no absolute path`);
    if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) throw new Error('worktree session start: options must be an object');
    const cwd = options?.cwd ?? basePath;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw new Error(`worktree session start: cwd must be an absolute path for ${project}`);
    const started = await start(project, options);
    if (typeof started?.id !== 'string' || started.id.trim() === '') throw new Error(`worktree session start: session id missing for ${project}`);
    if (cwd !== basePath) store.set({ sessionId: started.id, project, worktreePath: cwd, createdAt: now() });
    return started;
  };
}
