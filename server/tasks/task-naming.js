/**
 * Names a task from the work of the run it was created for. A task started with a run and no
 * title is first called after the run's input, which is often only a dropped file. Once a step
 * of the run writes its note there is something to describe, and the CLI configured for session
 * naming is asked for a title. A title the owner gave or changed is never replaced.
 */

import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { TASK_TITLE_MAX } from './task-store.js';

const CONTEXT_MAX = 12000;
const OPEN_STATES = ['active', 'pr_open'];

/** What a task is called until it is named: whitespace-collapsed input, or the workflow. */
export function provisionalTaskTitle(input, workflowName) {
  if (typeof input !== 'string') throw new Error('task naming: input must be text');
  if (typeof workflowName !== 'string' || workflowName.trim() === '') throw new Error('task naming: workflowName must be nonempty text');
  // Collapse every Unicode whitespace run (including newlines) so a multiline brief fits one title line.
  const collapsed = input.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? workflowName.trim() : collapsed.slice(0, TASK_TITLE_MAX).trim();
}

export function createTaskNaming({ taskStore, readSettings, generate, warn } = {}) {
  if (!taskStore || typeof taskStore.get !== 'function' || typeof taskStore.applyGeneratedTitle !== 'function') throw new Error('task naming: taskStore is required');
  for (const [name, value] of Object.entries({ readSettings, generate, warn })) {
    if (typeof value !== 'function') throw new Error(`task naming: ${name} is required`);
  }
  const working = new Set();
  const warned = new Set();

  return {
    /**
     * A step of a run wrote its note. Resolves to the renamed task, or null when there was
     * nothing to do or no title came of it; a later note tries again. A failure of the naming
     * CLI is reported once per task and reason and never reaches the run.
     */
    async noteWritten({ taskId, input, content } = {}) {
      if (taskId !== null && !isUuid(taskId)) throw new Error('task naming: taskId must be a task identity or null');
      if (typeof input !== 'string') throw new Error('task naming: input must be text');
      if (typeof content !== 'string' || content.trim() === '') throw new Error('task naming: content must be nonempty text');
      if (taskId === null || working.has(taskId)) return null;
      const task = taskStore.get(taskId);
      if (!task || task.titleSource !== 'input' || !OPEN_STATES.includes(task.state)) return null;
      // Naming uses the CLI chosen under Settings → Session naming; without one, titles stay as they are.
      const settings = readSettings();
      if (settings === null) return null;

      const asked = input.trim() === '' ? '' : `What the owner asked for:\n${input.trim()}\n\n`;
      const context = `${asked}What the run reported so far:\n${content}`.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, CONTEXT_MAX);
      working.add(taskId);
      try {
        const title = await generate(settings, context);
        return title === null ? null : taskStore.applyGeneratedTitle(taskId, title);
      } catch (error) {
        const reason = String(error?.message || error);
        const key = `${taskId}:${reason}`;
        if (!warned.has(key)) {
          warned.add(key);
          warn(`[task-naming] task=${taskId} error=${reason}`);
        }
        return null;
      } finally {
        working.delete(taskId);
      }
    },
  };
}
