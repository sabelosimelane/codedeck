const unfinished = todo => todo.phases.find(phase => phase.done < phase.total);
const taskFor = (tasks, location) => tasks.find(task => location.startsWith(`task:${task.id}/`));
const where = fields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
/** Where a todo lives, in words and as `where` fields: Main of a repository, or one task. */
function todoOwner(tasks, todo) {
  if (todo.location.startsWith('main:')) return { label: `in Main (${todo.repository})`, where: { repository: todo.repository, path: todo.path } };
  const task = taskFor(tasks, todo.location);
  if (!task) throw new Error(`${todo.location} ${todo.path}: no open task owns this todo location`);
  return { label: `for task “${task.title}”`, where: { taskId: task.id, path: todo.path } };
}

export function situationFlags(facts) {
  if (!facts || !Array.isArray(facts.tasks) || !Array.isArray(facts.repositories) || !Array.isArray(facts.todos)) throw new TypeError('facts must have tasks, repositories and todos arrays');
  const flags = [];
  const todos = facts.todos;
  const byRepositoryPath = new Map();
  for (const todo of todos) {
    const key = `${todo.repository}\0${todo.path}`;
    byRepositoryPath.set(key, [...(byRepositoryPath.get(key) ?? []), todo]);
  }

  for (const task of facts.tasks) for (const run of task.runs) {
    if (run.status !== 'complete' || (!run.steps.some(step => step.status === 'limit_accepted') && !(run.progress && run.progress.tasksDone < run.progress.tasksTotal))) continue;
    const phase = run.progress?.phase;
    flags.push({ code: 'run_complete_todo_unfinished', message: `Run “${run.workflow}” for task “${task.title}” is complete, but todo ${run.progressFile ?? 'without a progress file'}${phase && phase.tasksDone < phase.tasksTotal ? ` is on Phase ${phase.number} (${phase.tasksDone} of ${phase.tasksTotal})` : ' still needs review'}.`, where: where({ taskId: task.id, runId: run.id, path: run.progressFile ?? undefined }) });
  }
  for (const task of facts.tasks) for (const worktree of task.worktrees) {
    if (worktree.uncommittedCount > 0 && worktree.commitsAhead === 0) flags.push({ code: 'work_uncommitted_no_commits', message: `Task “${task.title}” has ${worktree.uncommittedCount} uncommitted files and no commits in ${worktree.repository}.`, where: { taskId: task.id, worktreeId: worktree.worktreeId, repository: worktree.repository } });
  }
  for (const task of facts.tasks) for (const worktree of task.worktrees) {
    const blockers = worktree.blockers.merge;
    if ((worktree.uncommittedCount > 0 || worktree.commitsAhead > 0) && blockers.length) flags.push({ code: 'merge_blocked', message: `Task “${task.title}” cannot merge ${worktree.repository}: ${blockers.map(blocker => blocker.message.replace(/[.!?]+$/, '')).join('; ')}.`, where: { taskId: task.id, worktreeId: worktree.worktreeId, repository: worktree.repository }, blockers: blockers.map(({ code, message }) => ({ code, message })) });
  }
  for (const todo of todos) {
    if (!todo.phases.length || todo.phases.some(phase => phase.done > 0)) continue;
    const owner = todoOwner(facts.tasks, todo);
    flags.push({ code: 'todo_not_started', message: `Todo ${todo.path} ${owner.label} has not started.`, where: owner.where });
  }
  for (const todo of todos) {
    if (!Array.isArray(todo.dependsOn)) throw new Error(`${todo.path}: dependsOn must be an array`);
    for (const dependency of todo.dependsOn) {
    const copies = byRepositoryPath.get(`${todo.repository}\0${dependency}`) ?? [];
    const target = copies.find(copy => copy.location === todo.location) ?? copies.find(copy => copy.location.startsWith('main:')) ?? copies[0];
    const phase = target && unfinished(target);
    if (!phase) continue;
    const owner = todoOwner(facts.tasks, todo);
    flags.push({ code: 'todo_depends_on_unfinished', message: `Todo ${todo.path} ${owner.label} waits for Phase ${phase.number} of ${dependency}.`, where: owner.where });
    }
  }
  for (const repository of facts.repositories) {
    if (repository.dirtyCount > 0) flags.push({ code: 'other_repository_dirty', message: `Repository ${repository.name} has ${repository.dirtyCount} uncommitted files.`, where: { repository: repository.name } });
  }
  for (const repository of facts.repositories) {
    if (repository.missing || repository.usable === false) continue;
    if (!Array.isArray(repository.strayFiles)) throw new Error(`repository ${repository.name}: strayFiles must be an array`);
    for (const stray of repository.strayFiles) flags.push({ code: 'stray_files', message: `Repository ${repository.name} has an untracked stray file "${stray}".`, where: { repository: repository.name, path: stray } });
  }
  for (const task of facts.tasks) for (const worktree of task.worktrees) {
    if (!Array.isArray(worktree.strayFiles)) throw new Error(`${worktree.worktreeId}: strayFiles must be an array`);
    for (const stray of worktree.strayFiles) flags.push({ code: 'stray_files', message: `Task “${task.title}” has an untracked stray file "${stray}" in ${worktree.repository}.`, where: { taskId: task.id, worktreeId: worktree.worktreeId, repository: worktree.repository, path: stray } });
  }
  return flags;
}
