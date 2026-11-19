/**
 * Changes: what has been merged, one entry per task with at least one merged repository. A
 * change is read from what is already stored: the task and its merged worktrees, and the note
 * the last step of the task's most recent run wrote, which that step is asked to open with a
 * summary of what the run changed (see step-guidance.js). Nothing is stored for a change itself.
 */
import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { summaryStepIndex } from '../pipelines/step-guidance.js';

/** A run as far as a change reads it; every field read is checked, because a wrong one would name the wrong summary. */
function requireRun(run) {
  const identity = typeof run?.id === 'string' ? run.id : 'unknown';
  const fail = field => { throw new Error(`task changes: run ${identity} field ${field}`); };
  if (run === null || typeof run !== 'object' || Array.isArray(run)) fail('run');
  if (!isUuid(run.id)) fail('id');
  if (run.taskId !== null && !isUuid(run.taskId)) fail('taskId');
  if (typeof run.createdAt !== 'string' || Number.isNaN(Date.parse(run.createdAt))) fail('createdAt');
  const definition = run.definition;
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) fail('definition');
  if (typeof definition.workflowName !== 'string' || !definition.workflowName.trim()) fail('definition.workflowName');
  if (!Array.isArray(definition.steps)) fail('definition.steps');
  if (definition.notesDir !== null && typeof definition.notesDir !== 'string') fail('definition.notesDir');
  return run;
}

export function createTaskChanges({ taskStore, noteStore, listRuns } = {}) {
  if (typeof taskStore?.list !== 'function') throw new TypeError('task changes: taskStore is required');
  if (typeof noteStore?.lastWritten !== 'function') throw new TypeError('task changes: noteStore is required');
  if (typeof listRuns !== 'function') throw new TypeError('task changes: listRuns is required');

  return {
    /** Every change, the most recently merged first. */
    list() {
      const merged = taskStore.list()
        .map(task => ({ task, worktrees: task.worktrees.filter(worktree => worktree.state === 'merged') }))
        .filter(entry => entry.worktrees.length > 0);
      if (merged.length === 0) return [];
      const runs = listRuns();
      if (!Array.isArray(runs)) throw new Error('task changes: runs must be a list');
      // The most recent run of each task: it is the one whose work was merged.
      const latest = new Map();
      for (const run of runs) {
        requireRun(run);
        if (run.taskId === null) continue;
        const known = latest.get(run.taskId);
        if (!known || run.createdAt > known.createdAt || (run.createdAt === known.createdAt && run.id > known.id)) latest.set(run.taskId, run);
      }
      return merged.map(({ task, worktrees }) => {
        const run = latest.get(task.id) ?? null;
        const stepIndex = run === null ? null : summaryStepIndex(run.definition);
        const note = stepIndex === null ? null : noteStore.lastWritten(run.id, stepIndex);
        return {
          id: task.id,
          project: task.project,
          title: task.title,
          mergedAt: worktrees.map(worktree => worktree.finishedAt).sort().at(-1),
          workflow: run === null ? null : run.definition.workflowName,
          summary: note === null ? null : note.summary,
          detail: note === null ? null : note.content,
          repositories: worktrees.map(worktree => ({
            repository: worktree.repository, branch: worktree.branch, baseBranch: worktree.baseBranch, commit: worktree.mergedCommit, mergedAt: worktree.finishedAt,
          })),
        };
      }).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || a.id.localeCompare(b.id));
    },
  };
}
