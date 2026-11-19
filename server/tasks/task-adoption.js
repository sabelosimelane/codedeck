/**
 * Worktrees CodeDeck was already using before tasks existed become tasks: the worktree of
 * an open workflow run, and a worktree a terminal was opened in. From then on the task owns
 * the worktree, so the run that created it lets go of it. Runs once at startup; running it
 * again changes nothing.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TASK_TITLE_MAX } from './task-store.js';

const RUN_HOLDS_WORKTREE = new Set(['present', 'removal_blocked', 'external']);

function titleFrom(text) {
  const oneLine = String(text ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  return oneLine.slice(0, TASK_TITLE_MAX).trim();
}

export async function adoptWorktrees({ taskStore, runStore, worktreeStore, findProject, listWorktrees, newId = randomUUID, warn = console.warn } = {}) {
  if (typeof taskStore?.create !== 'function' || typeof taskStore?.findOpenByWorktreePath !== 'function') throw new TypeError('taskStore is required');
  if (typeof runStore?.list !== 'function' || typeof runStore?.update !== 'function') throw new TypeError('runStore is required');
  if (typeof worktreeStore?.all !== 'function') throw new TypeError('worktreeStore is required');
  for (const [name, value] of Object.entries({ findProject, listWorktrees, newId, warn })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  // project name → worktree path → { runs, title }
  const wanted = new Map();
  const want = (projectName, worktreePath) => {
    if (!wanted.has(projectName)) wanted.set(projectName, new Map());
    const paths = wanted.get(projectName);
    if (!paths.has(worktreePath)) paths.set(worktreePath, { runs: [], title: '' });
    return paths.get(worktreePath);
  };

  for (const run of runStore.list()) {
    if (run.taskId !== null || !RUN_HOLDS_WORKTREE.has(run.worktreeState)) continue;
    const entry = want(run.project, run.worktreePath);
    entry.runs.push(run);
    // Runs are listed newest first, so the newest run names the task.
    if (!entry.title) entry.title = titleFrom(run.input) || titleFrom(run.definition.workflowName);
  }
  for (const row of worktreeStore.all()) want(row.project, row.worktreePath);

  const adopted = [];
  for (const [projectName, paths] of wanted) {
    const project = findProject(projectName);
    if (!project || typeof project.path !== 'string' || !path.isAbsolute(project.path) || (project.host && project.host !== 'local')) continue;
    paths.delete(project.path);
    if (paths.size === 0) continue;

    let worktrees;
    try {
      worktrees = await listWorktrees({ projectPath: project.path });
    } catch (error) {
      warn(`[tasks] worktrees of ${projectName} could not be read; none adopted: ${error?.message ?? error}`);
      continue;
    }
    if (!Array.isArray(worktrees)) throw new Error('listWorktrees must return an array');
    const home = worktrees.find(worktree => worktree.path === project.path) ?? null;

    for (const [worktreePath, entry] of paths) {
      const worktree = worktrees.find(candidate => candidate.path === worktreePath);
      // A folder git no longer lists, or one with no branch, cannot be a task.
      if (!worktree || worktree.missing || worktree.branch === null) continue;
      let task = taskStore.findOpenByWorktreePath(worktreePath);
      if (!task) {
        task = taskStore.create({
          id: newId(),
          project: projectName,
          title: entry.title || titleFrom(worktree.branch),
          // An adopted worktree keeps the name it is given here; nothing renames it later.
          titleSource: 'owner',
          folder: null,
          // Adoption only looks at the project's own repository.
          repository: path.basename(project.path),
          repositoryPath: null,
          worktreePath,
          branch: worktree.branch,
          baseBranch: home?.branch ?? null,
          baseCommit: entry.runs.find(run => run.baseCommit !== null)?.baseCommit ?? worktree.head,
        });
        adopted.push(task);
      }
      for (const run of entry.runs) {
        runStore.update(run.id, {
          taskId: task.id,
          ...(run.worktreeState === 'present' ? { worktreeState: 'external' } : {}),
          ...(run.worktreeState === 'removal_blocked' ? { worktreeState: 'released', worktreeDetail: null } : {}),
        });
      }
    }
  }
  return adopted;
}
