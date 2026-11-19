/**
 * Where a workflow run may work and read. A run has one working directory; in a task with
 * several repositories it may also change the task's other worktrees, and the project's
 * remaining repositories are named so that it reads them at their own checkouts and never
 * changes them. Read when a step starts, so a worktree added to or closed in the task since
 * the run began is told as it is now.
 */

import path from 'node:path';
import { resolveHomeRepoPath as defaultResolveHomeRepoPath } from './run-worktree.js';
import { readStoredRepositories } from '../project-repositories.js';

const OPEN_STATES = ['active', 'pr_open'];

export function createRunPlaces({ taskStore, findProject, execFile, resolveHomeRepoPath = defaultResolveHomeRepoPath } = {}) {
  if (typeof taskStore?.get !== 'function') throw new TypeError('taskStore is required');
  // `execFile` is only handed on to Git; the Git helper checks it.
  for (const [name, value] of Object.entries({ findProject, resolveHomeRepoPath })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  /**
   * @returns {Promise<{ current: string, worktrees: Array<{ repository: string, path: string }>, readOnly: Array<{ repository: string, path: string }> }>}
   */
  return async function runPlaces(run, { includeGit = false } = {}) {
    if (typeof run?.project !== 'string' || !run.project) throw new TypeError('run.project must be a project name');
    if (typeof run.worktreePath !== 'string' || !path.isAbsolute(run.worktreePath)) throw new TypeError('run.worktreePath must be an absolute path');
    if (run.taskId !== null && typeof run.taskId !== 'string') throw new TypeError('run.taskId must be a task id or null');
    const project = await findProject(run.project);
    if (!project) throw new Error(`Project ${run.project} of this run no longer exists`);
    if (typeof project.path !== 'string' || !path.isAbsolute(project.path)) throw new Error(`Stored project ${run.project} has no absolute path`);
    const ownName = path.basename(await resolveHomeRepoPath({ projectPath: project.path, execFile }));
    const repositories = [{ repository: ownName, path: project.path }, ...readStoredRepositories(project).map(entry => ({ repository: entry.name, path: entry.path }))];

    const task = run.taskId === null ? null : taskStore.get(run.taskId);
    if (includeGit && run.taskId !== null && !task) throw new Error(`Run task ${run.taskId} no longer exists`);
    if (task) {
      const current = task.worktrees.find(worktree => worktree.worktreePath === run.worktreePath);
      if (!current) throw new Error(`Run worktree ${run.worktreePath} is not a worktree of its task ${task.id}`);
      // The worktree the run works in is always one of its places; the task's other worktrees while they are open.
      const worktrees = task.worktrees.filter(worktree => worktree.id === current.id || OPEN_STATES.includes(worktree.state))
        .map(worktree => ({
          repository: worktree.repository, path: worktree.worktreePath,
          ...(includeGit ? { branch: worktree.branch, baseCommit: worktree.baseCommit, repositoryPath: worktree.own ? project.path : worktree.repositoryPath } : {}),
        }));
      const inTask = new Set(worktrees.map(worktree => worktree.repository));
      return { current: current.repository, worktrees, readOnly: repositories.filter(entry => !inTask.has(entry.repository)) };
    }

    // Outside a task a run works in one place: the own checkout of one of the project's repositories, or a worktree named by path.
    const here = repositories.find(entry => entry.path === run.worktreePath) ?? { repository: ownName, path: run.worktreePath };
    return { current: here.repository, worktrees: [includeGit ? { ...here, branch: run.worktreeBranch, baseCommit: run.baseCommit, repositoryPath: run.homePath } : here], readOnly: repositories.filter(entry => entry.repository !== here.repository) };
  };
}
