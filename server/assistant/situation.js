import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as callbackExecFile } from 'node:child_process';
import { listDirtyPaths } from '../pipelines/run-worktree.js';
import { isOpenRun } from '../pipelines/run-worktree-hold.js';
import { readTodoDocs } from './todo-docs.js';
import { situationFlags } from './situation-flags.js';

const defaultExecFile = callbackExecFile;
const text = (value, field, id) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${id}: ${field} must be non-empty text`);
  return value;
};
/** A path from Git: any non-empty string, untrimmed, because a file may be named " ". */
const pathText = (value, field, id) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${id}: ${field} must be a non-empty path`);
  return value;
};
const nullableText = (value, field, id) => value === null ? null : text(value, field, id);
const bool = (value, field, id) => {
  if (typeof value !== 'boolean') throw new Error(`${id}: ${field} must be boolean`);
  return value;
};
const count = (value, field, id, nullable = false) => {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${id}: ${field} must be a non-negative integer`);
  return value;
};
const array = (value, field, id) => {
  if (!Array.isArray(value)) throw new Error(`${id}: ${field} must be an array`);
  return value;
};
const absolute = (value, field, id) => {
  text(value, field, id);
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error(`${id}: ${field} must be an absolute path`);
  return value;
};
const locationMissing = async root => {
  try { return !(await fs.stat(root)).isDirectory(); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return true;
    throw error;
  }
};

export function strayPaths(paths) {
  return paths.filter(file => {
    const name = path.basename(file);
    // Blank, or only whitespace and backslash escapes (`\n`, `\t`, a lone `\`): never a name like `n t`.
    return name.trim() === '' || (/^(?:\s|\\[nrt0]?)+$/.test(name) && name.includes('\\'));
  });
}

function checkedBlockers(blockers, id) {
  if (!blockers || typeof blockers !== 'object') throw new Error(`${id}: blockers must be an object`);
  return Object.fromEntries(['commit', 'merge', 'pullRequest', 'close'].map(kind => [kind, array(blockers[kind], `blockers.${kind}`, id).map((reason, index) => ({ code: text(reason?.code, `blockers.${kind}[${index}].code`, id), message: text(reason?.message, `blockers.${kind}[${index}].message`, id) }))]));
}

function checkedProgress(progress, id) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) throw new Error(`${id}: progress must be an object or null`);
  const phase = progress.phase === null ? null : progress.phase;
  if (phase !== null && (!phase || typeof phase !== 'object' || Array.isArray(phase))) throw new Error(`${id}: progress.phase must be an object or null`);
  return {
    file: text(progress.file, 'progress.file', id),
    status: text(progress.status, 'progress.status', id),
    phaseCount: count(progress.phaseCount, 'progress.phaseCount', id, true),
    phase: phase === null ? null : { number: count(phase.number, 'progress.phase.number', id), title: text(phase.title, 'progress.phase.title', id), tasksDone: count(phase.tasksDone, 'progress.phase.tasksDone', id), tasksTotal: count(phase.tasksTotal, 'progress.phase.tasksTotal', id) },
    tasksDone: count(progress.tasksDone, 'progress.tasksDone', id, true),
    tasksTotal: count(progress.tasksTotal, 'progress.tasksTotal', id, true),
  };
}

function renderMarkdown(situation) {
  const lines = [`# ${situation.project} — where things stand`, ''];
  if (situation.flags.length) {
    lines.push('## Attention', ...situation.flags.map(flag => `- ${flag.message}`), '');
  } else lines.push('Nothing needs your attention.', '');
  lines.push('## Repositories', ...situation.repositories.map(repo => `- ${repo.name}: ${repo.usable === false ? repo.reason.message : repo.missing ? 'folder missing' : `${repo.branch ?? 'detached'}, ${repo.dirtyCount} dirty paths`}`), '');
  lines.push('## Tasks', ...situation.tasks.map(task => `- ${task.title} (${task.id}): ${task.worktrees.length} worktrees, ${task.runs.length} runs`), '');
  lines.push('## Todos', ...situation.todos.map(todo => `- ${todo.path} (${todo.location}): ${todo.phases.map(phase => `Phase ${phase.number} ${phase.done}/${phase.total}`).join(', ') || 'no phases'}`));
  return lines.join('\n');
}

export async function composeSituation({ projectName, findProject, repositoryService, taskStore, landing, runStore, runView, execFile = defaultExecFile } = {}) {
  text(projectName, 'projectName', 'situation');
  for (const [name, service] of [['findProject', findProject], ['repositoryService.list', repositoryService?.list], ['taskStore.list', taskStore?.list], ['landing.worktrees', landing?.worktrees], ['runStore.list', runStore?.list], ['runView', runView], ['execFile', execFile]]) {
    if (typeof service !== 'function') throw new Error(`situation: ${name} must be a function`);
  }
  const project = findProject(projectName);
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  text(project.name, 'project.name', projectName);
  absolute(project.path, 'project.path', projectName);
  if (project.host !== undefined && project.host !== null && project.host !== 'local') throw Object.assign(new Error('Assistant is only available for local projects.'), { status: 409 });
  const rawRepositories = await repositoryService.list(projectName);
  const repositories = [];
  const todos = [];
  const todoCopies = [];
  const specifications = [];
  const skipped = [];
  const truncated = { dirty: false, todos: false, specifications: false };
  const readDocs = async (root, location, repository, dirtyPaths) => {
    const result = await readTodoDocs({ root, location, dirtyPaths, execFile });
    if (result.missing) return { missing: true };
    result.todos.forEach(todo => todoCopies.push({ repository, todo }));
    specifications.push(...result.specifications);
    result.skipped.forEach(item => skipped.push({ ...item, location }));
    for (const key of ['todos', 'specifications']) truncated[key] ||= result.truncated[key];
    return result;
  };
  for (const raw of array(rawRepositories, 'repositories', projectName)) {
    const id = `repository ${raw?.name ?? raw?.path ?? projectName}`;
    const name = text(raw?.name, 'name', id);
    const root = absolute(raw.path, 'path', id);
    const own = bool(raw.own, 'own', id);
    const usable = bool(raw.usable, 'usable', id);
    if (!usable) {
      const reason = raw.reason;
      if (!reason || typeof reason !== 'object') throw new Error(`${id}: reason must be an object when the repository is not usable`);
      repositories.push({ name, own, path: root, usable: false, reason: { code: text(reason.code, 'reason.code', id), message: text(reason.message, 'reason.message', id) } });
      continue;
    }
    const branch = raw.branch === null ? null : text(raw.branch, 'branch', id);
    if (await locationMissing(root)) { repositories.push({ name, own, path: root, usable: true, missing: true }); continue; }
    const status = await listDirtyPaths({ worktreePath: root, execFile, detailed: true });
    const dirtyPaths = array(status.paths, 'dirty paths', id).map((value, index) => pathText(value, `dirty[${index}]`, id));
    truncated.dirty ||= dirtyPaths.length > 50;
    repositories.push({ name, own, path: root, usable: true, branch, dirtyCount: dirtyPaths.length, dirty: dirtyPaths.slice(0, 50), strayFiles: strayPaths(array(status.untracked, 'untracked paths', id).map((value, index) => pathText(value, `untracked[${index}]`, id))) });
    await readDocs(root, `main:${name}`, name, dirtyPaths);
  }
  const tasks = [];
  const rawRuns = array(runStore.list(), 'runs', projectName);
  for (const rawTask of array(taskStore.list(), 'tasks', projectName)) {
    const id = text(rawTask?.id, 'id', 'task');
    text(rawTask.title, 'title', id);
    text(rawTask.state, 'state', id);
    if (text(rawTask.project, 'project', id) !== projectName || !['active', 'pr_open'].includes(rawTask.state)) continue;
    const worktrees = [];
    for (const view of array(await landing.worktrees(id), 'worktrees', id)) {
      const worktreeId = text(view?.worktreeId, 'worktreeId', id);
      const identity = `task ${id} worktree ${worktreeId}`;
      const root = absolute(view.worktreePath, 'worktreePath', identity);
      const repository = text(view.repository, 'repository', identity);
      const filesPresent = bool(view.filesPresent, 'filesPresent', identity);
      const result = { worktreeId, repository, worktreePath: root, branch: text(view.branch, 'branch', identity), baseBranch: nullableText(view.baseBranch, 'baseBranch', identity), uncommittedCount: count(view.uncommittedCount, 'uncommittedCount', identity), commitsAhead: count(view.commitsAhead, 'commitsAhead', identity, true), commitsBehind: count(view.commitsBehind, 'commitsBehind', identity, true), blockers: checkedBlockers(view.blockers, identity), strayFiles: [] };
      if (!filesPresent || await locationMissing(root)) { result.missing = true; result.strayFiles = []; }
      else {
        const status = await listDirtyPaths({ worktreePath: root, execFile, detailed: true });
        result.strayFiles = strayPaths(array(status.untracked, 'untracked paths', identity));
        await readDocs(root, `task:${id}/${worktreeId}`, repository, status.paths);
      }
      worktrees.push(result);
    }
    const runs = [];
    for (const rawRun of rawRuns) {
      const runId = text(rawRun.id, 'id', `task ${id} run`);
      if (rawRun.taskId !== null && typeof rawRun.taskId !== 'string') throw new Error(`${runId}: taskId must be null or text`);
      // The run store holds every project's runs; only this task's runs are read and checked further.
      if (rawRun.taskId !== id) continue;
      if (!['not_created', 'present', 'removed', 'removal_blocked', 'external', 'released'].includes(rawRun.worktreeState)) throw new Error(`${runId}: worktreeState must be a known state`);
      if (text(rawRun.project, 'project', runId) !== projectName) throw new Error(`${runId}: project must equal ${projectName}`);
      if (!isOpenRun(rawRun)) continue;
      const view = await runView(rawRun);
      const workflow = text(view.workflowName, 'workflowName', runId);
      const status = text(view.status, 'status', runId);
      const steps = array(view.steps, 'steps', runId).map((step, index) => ({ index: count(step.index, `steps[${index}].index`, runId), name: text(step.name, `steps[${index}].name`, runId), status: text(step.status, `steps[${index}].status`, runId) }));
      const progress = view.progress === null ? null : checkedProgress(view.progress, runId);
      const progressFile = progress?.file ?? null;
      const lastNote = [...view.steps].reverse().find(step => step.note?.summary)?.note ?? null;
      runs.push({ id: runId, workflow, status, steps, progressFile, progress, lastNote: lastNote ? { stepIndex: view.steps.findIndex(step => step.note === lastNote), firstLine: text(lastNote.summary, 'lastNote.summary', runId) } : null });
    }
    tasks.push({ id, title: rawTask.title, state: rawTask.state, worktrees, runs });
  }
  const mains = new Map(todoCopies.filter(copy => copy.todo.location.startsWith('main:')).map(copy => [`${copy.repository}\0${copy.todo.path}`, copy.todo]));
  for (const { repository, todo } of todoCopies) {
    const main = mains.get(`${repository}\0${todo.path}`);
    if (main && main !== todo && main.contentHash === todo.contentHash) {
      main.alsoIn = [...(main.alsoIn ?? []), todo.location];
    } else todos.push(todo);
  }
  const repositoryByTodo = new Map(todoCopies.map(({ repository, todo }) => [`${todo.location}\0${todo.path}`, repository]));
  const result = { project: projectName, generatedAt: new Date().toISOString(), repositories, tasks, todos: todos.map(({ contentHash, ...todo }) => ({ ...todo, repository: repositoryByTodo.get(`${todo.location}\0${todo.path}`) })), specifications, skipped, truncated };
  result.flags = situationFlags(result);
  result.markdown = renderMarkdown(result);
  return result;
}
