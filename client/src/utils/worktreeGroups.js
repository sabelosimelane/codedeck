function nonempty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`worktree groups: ${field} must be a nonempty string`);
  return value;
}
function absolute(value, field) {
  nonempty(value, field);
  if (!value.startsWith('/') || value.includes('\0')) throw new Error(`worktree groups: ${field} must be an absolute path`);
  return value;
}
function optionalPath(value, field) {
  return value === null ? null : absolute(value, field);
}

/**
 * The repositories of a project: its own, at the project's path, then the others it lists.
 * The own one is known here by the folder name of the project's path.
 */
function projectRepositories(project) {
  if (!Array.isArray(project.repositories)) throw new Error('worktree groups: project.repositories must be a list');
  const others = project.repositories.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('worktree groups: repository must be an object');
    nonempty(entry.name, 'repository.name');
    absolute(entry.path, 'repository.path');
    return { name: entry.name, path: entry.path, own: false };
  });
  const folder = project.path.replace(/\/+$/, '');
  return [{ name: nonempty(folder.slice(folder.lastIndexOf('/') + 1), 'project.path folder'), path: project.path, own: true }, ...others];
}

/** The worktrees of a task as a group needs them: which repository, where, and whether still open. */
function taskWorktrees(task) {
  if (!Array.isArray(task.worktrees) || task.worktrees.length === 0) throw new Error('worktree groups: task.worktrees must be a nonempty list');
  return task.worktrees.map((worktree) => {
    if (!worktree || typeof worktree !== 'object' || Array.isArray(worktree)) throw new Error('worktree groups: worktree must be an object');
    nonempty(worktree.id, 'worktree.id');
    nonempty(worktree.repository, 'worktree.repository');
    absolute(worktree.worktreePath, 'worktree.worktreePath');
    nonempty(worktree.branch, 'worktree.branch');
    nonempty(worktree.state, 'worktree.state');
    return worktree;
  });
}

/**
 * The group a path belongs to. Every repository of the project is reached from Main, and
 * every worktree of a task belongs to that task, which is known by the worktree it started in.
 */
function groupKeyForPath(project, repositories, tasks, value) {
  if (value === null || repositories.some(repository => repository.path === value)) return 'main';
  const task = tasks.find(candidate => candidate.project === project.name && candidate.worktrees.some(worktree => worktree.worktreePath === value));
  return task ? task.worktreePath : value;
}

/**
 * The repository to name beside a terminal at `path` in `group`, or null where there is
 * nothing to tell apart: the project's own repository in Main, and a task with one worktree.
 */
export function repositoryLabelForPath(group, path) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('worktree groups: group must be an object');
  if (path === null || path === undefined) return null;
  if (group.isMain) return (group.repositories ?? []).find(repository => !repository.own && repository.path === path)?.name ?? null;
  if (!Array.isArray(group.worktrees) || group.worktrees.length < 2) return null;
  return group.worktrees.find(worktree => worktree.worktreePath === path)?.repository ?? null;
}

/**
 * Where a new terminal can open in a group: any repository of the project in Main, any
 * worktree of a task that is still open in a task. A worktree without a task offers none.
 */
export function groupPlaces(group) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('worktree groups: group must be an object');
  if (group.isMain) return (group.repositories ?? []).map(repository => ({ id: repository.name, label: repository.name, path: repository.path, own: repository.own }));
  if (!Array.isArray(group.worktrees)) return [];
  return group.worktrees.filter(worktree => worktree.state === 'active' || worktree.state === 'pr_open')
    .map(worktree => ({ id: worktree.id, label: worktree.repository, path: worktree.worktreePath, own: false }));
}

/**
 * The place a new terminal opens in when the active one is at `path`: the same place, else the
 * project's own repository in Main, or the first open worktree of a task. Null when the group offers none.
 */
export function placeForPath(group, path) {
  const places = groupPlaces(group);
  return places.find(place => place.path === path) ?? places.find(place => place.own) ?? places[0] ?? null;
}

export function describeWorktreeGroup(group) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('worktree groups: group must be an object');
  absolute(group.path, 'group.path');
  if (typeof group.isMain !== 'boolean') throw new Error('worktree groups: group.isMain must be a boolean');
  if (group.branch !== null && group.branch !== undefined) nonempty(group.branch, 'group.branch');
  if (group.run !== null && group.run !== undefined) {
    if (typeof group.run !== 'object' || Array.isArray(group.run)) throw new Error('worktree groups: group.run must be an object');
    nonempty(group.run.id, 'group.run.id');
    nonempty(group.run.workflowName, 'group.run.workflowName');
  }
  if (group.task !== null && group.task !== undefined) {
    if (typeof group.task !== 'object' || Array.isArray(group.task)) throw new Error('worktree groups: group.task must be an object');
    nonempty(group.task.id, 'group.task.id');
    nonempty(group.task.title, 'group.task.title');
  }
  const folder = group.path.slice(group.path.lastIndexOf('/') + 1);
  nonempty(folder, 'group.path folder');
  // A task is known by its title; where it lives on disk is detail for the tooltip.
  const title = group.isMain ? 'Main' : group.task ? group.task.title : group.run
    ? `${group.run.workflowName} · ${group.run.id.slice(0, 8)}` : folder;
  // A task in several repositories lists each: where it is and on which branch.
  const tooltip = !group.isMain && Array.isArray(group.worktrees) && group.worktrees.length > 1
    ? group.worktrees.map(worktree => `${worktree.repository} · ${worktree.branch}\n${worktree.worktreePath}`).join('\n')
    : [folder, group.branch, group.path].filter(Boolean).join('\n');
  return { title, detail: null, tooltip };
}

export function parseSessionWorktree(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('session worktree: row must be an object');
  const sessionId = nonempty(row.sessionId, 'sessionId');
  const worktreePath = optionalPath(row.worktreePath, 'worktreePath');
  return { sessionId, worktreePath };
}

export function selectStoredWorktrees(projects, groupsByProject, selection, readStorage) {
  if (!Array.isArray(projects)) throw new Error('worktree selection: projects must be an array');
  if (!(groupsByProject instanceof Map)) throw new Error('worktree selection: groupsByProject must be a Map');
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new Error('worktree selection: selection must be an object');
  if (typeof readStorage !== 'function') throw new Error('worktree selection: readStorage must be a function');
  return Object.fromEntries(projects.map(project => {
    nonempty(project?.name, 'project.name');
    const groups = groupsByProject.get(project.name) ?? [];
    if (!Array.isArray(groups)) throw new Error('worktree selection: groups must be an array');
    if (groups.length <= 1) return [project.name, 'main'];
    let stored = 'main';
    try { stored = readStorage(`codedeck-worktree-${project.name}`) ?? 'main'; }
    catch (error) { console.warn(`Could not read worktree selection for ${project.name}: ${error.message}`); }
    const freshlySelected = selection[project.name];
    return [project.name, freshlySelected ?? (groups.some(group => group.key === stored) ? stored : 'main')];
  }));
}

export function selectTabAfterClose(tabs, closedTabId, groupForTab) {
  if (!Array.isArray(tabs)) throw new Error('worktree tabs: tabs must be an array');
  nonempty(closedTabId, 'closedTabId');
  if (typeof groupForTab !== 'function') throw new Error('worktree tabs: groupForTab must be a function');
  const index = tabs.findIndex(tab => tab?.id === closedTabId);
  if (index < 0) throw new Error(`worktree tabs: closed tab ${closedTabId} is missing`);
  const group = groupForTab(tabs[index]);
  nonempty(group, 'group');
  const same = tabs.map((tab, position) => ({ tab, position }))
    .filter(({ tab }) => tab?.id !== closedTabId && groupForTab(tab) === group)
    .sort((a, b) => Math.abs(a.position - index) - Math.abs(b.position - index) || b.position - a.position);
  return same[0]?.tab.id ?? tabs.filter(tab => tab?.id !== closedTabId).at(-1)?.id ?? null;
}

/** Which group each session belongs to: `main`, or the key of a task or of a worktree without one. */
export function resolveSessionWorktrees({ project, sessions, runs, tasks = [] }) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('worktree groups: project must be an object');
  nonempty(project.name, 'project.name');
  absolute(project.path, 'project.path');
  if (!Array.isArray(sessions)) throw new Error('worktree groups: sessions must be an array');
  if (!Array.isArray(runs)) throw new Error('worktree groups: runs must be an array');
  if (!Array.isArray(tasks)) throw new Error('worktree groups: tasks must be an array');
  const repositories = projectRepositories(project);
  const ownTasks = tasks.filter(task => task?.project === project.name).map(task => ({ ...task, worktrees: taskWorktrees(task) }));
  const bySession = new Map();
  const fallbackRuns = new Map();
  for (const run of runs) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('worktree groups: run must be an object');
    nonempty(run.id, 'run.id');
    nonempty(run.project, 'run.project');
    nonempty(run.status, 'run.status');
    nonempty(run.workflowName, 'run.workflowName');
    if (!run.worktree || typeof run.worktree !== 'object' || Array.isArray(run.worktree)) throw new Error('worktree groups: run.worktree must be an object');
    absolute(run.worktree.path, 'run.worktree.path');
    nonempty(run.worktree.branch, 'run.worktree.branch');
    nonempty(run.createdAt, 'run.createdAt');
    if (run.progress !== null && (typeof run.progress !== 'object' || Array.isArray(run.progress))) throw new Error('worktree groups: run.progress must be an object or null');
    if (!Array.isArray(run.steps)) throw new Error('worktree groups: run.steps must be an array');
    for (const step of run.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('worktree groups: step must be an object');
      nonempty(step.status, 'step.status');
      nonempty(step.name, 'step.name');
      if (step.sessionId !== null) nonempty(step.sessionId, 'step.sessionId');
      if (step.note !== null && (typeof step.note !== 'object' || Array.isArray(step.note))) throw new Error('worktree groups: step.note must be an object or null');
      if (run.project !== project.name || ['complete', 'stopped', 'error'].includes(run.status) || !step.sessionId) continue;
      const previous = fallbackRuns.get(step.sessionId);
      if (!previous || run.createdAt > previous.createdAt || (run.createdAt === previous.createdAt && run.id > previous.id)) fallbackRuns.set(step.sessionId, run);
    }
  }
  for (const session of sessions) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('worktree groups: session must be an object');
    nonempty(session.sessionId, 'sessionId');
    optionalPath(session.worktreePath, 'worktreePath');
    if (session.startedAt !== null) nonempty(session.startedAt, 'startedAt');
    const path = session.worktreePath ?? fallbackRuns.get(session.sessionId)?.worktree.path ?? project.path;
    bySession.set(session.sessionId, groupKeyForPath(project, repositories, ownTasks, path));
  }
  return bySession;
}

export function buildWorktreeGroups({ project, sessions, runs, tasks = [] }) {
  if (!Array.isArray(tasks)) throw new Error('worktree groups: tasks must be an array');
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('worktree groups: project must be an object');
  nonempty(project.name, 'project.name');
  absolute(project.path, 'project.path');
  if (!Array.isArray(sessions)) throw new Error('worktree groups: sessions must be an array');
  if (!Array.isArray(runs)) throw new Error('worktree groups: runs must be an array');
  const repositories = projectRepositories(project);
  const ownTasks = tasks.filter(task => task?.project === project.name).map(task => ({ ...task, worktrees: taskWorktrees(task) }));
  const sessionGroups = resolveSessionWorktrees({ project, sessions, runs, tasks });
  // Main reaches every repository of the project: its own checkout and those of the others.
  const main = { key: 'main', path: project.path, label: 'Main', branch: null, isMain: true, sessionIds: [], run: null, task: null,
    repositories, paths: repositories.map(repository => repository.path), worktrees: null };
  const byKey = new Map([['main', main]]);
  const startByKey = new Map();
  const groupForPath = value => {
    const key = groupKeyForPath(project, repositories, ownTasks, value);
    // A group is known by one path: a task's by the worktree it started in.
    if (!byKey.has(key)) byKey.set(key, { key, path: key, label: key.slice(key.lastIndexOf('/') + 1), branch: null, isMain: false, sessionIds: [], run: null, task: null, paths: [key], worktrees: null });
    return byKey.get(key);
  };
  for (const session of sessions) {
    if (!session || typeof session !== 'object') throw new Error('worktree groups: session must be an object');
    nonempty(session.sessionId, 'sessionId');
    optionalPath(session.worktreePath, 'worktreePath');
    if (session.startedAt !== null) nonempty(session.startedAt, 'startedAt');
    const group = groupForPath(sessionGroups.get(session.sessionId) === 'main' ? null : sessionGroups.get(session.sessionId));
    group.sessionIds.push(session.sessionId);
    const prior = startByKey.get(group.key);
    if (session.startedAt && (!prior || session.startedAt < prior)) startByKey.set(group.key, session.startedAt);
  }
  for (const run of runs) {
    if (!run || typeof run !== 'object') throw new Error('worktree groups: run must be an object');
    nonempty(run.id, 'run.id');
    nonempty(run.project, 'run.project');
    nonempty(run.status, 'run.status');
    nonempty(run.workflowName, 'run.workflowName');
    if (!run.worktree || typeof run.worktree !== 'object') throw new Error('worktree groups: run.worktree must be an object');
    absolute(run.worktree.path, 'run.worktree.path');
    nonempty(run.worktree.branch, 'run.worktree.branch');
    nonempty(run.createdAt, 'run.createdAt');
    if (run.progress !== null && (typeof run.progress !== 'object' || Array.isArray(run.progress))) throw new Error('worktree groups: run.progress must be an object or null');
    if (!Array.isArray(run.steps)) throw new Error('worktree groups: run.steps must be an array');
    for (const step of run.steps) {
      if (!step || typeof step !== 'object') throw new Error('worktree groups: step must be an object');
      nonempty(step.status, 'step.status');
      nonempty(step.name, 'step.name');
      if (step.sessionId !== null) nonempty(step.sessionId, 'step.sessionId');
      if (step.note !== null && (typeof step.note !== 'object' || Array.isArray(step.note))) throw new Error('worktree groups: step.note must be an object or null');
    }
    const group = groupForPath(run.worktree.path);
    if (!group.run || run.createdAt > group.run.createdAt || (run.createdAt === group.run.createdAt && run.id > group.run.id)) {
      group.run = run;
      group.branch = run.worktree.branch;
    }
  }
  // Every open task of the project is a group, also before it has a terminal or a run.
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('worktree groups: task must be an object');
    nonempty(task.id, 'task.id');
    nonempty(task.project, 'task.project');
    nonempty(task.title, 'task.title');
    absolute(task.worktreePath, 'task.worktreePath');
    nonempty(task.branch, 'task.branch');
    nonempty(task.createdAt, 'task.createdAt');
    if (task.project !== project.name || task.worktreePath === project.path) continue;
    const group = groupForPath(task.worktreePath);
    const worktrees = taskWorktrees(task);
    group.task = task;
    group.branch = task.branch;
    group.worktrees = worktrees;
    group.paths = worktrees.map(worktree => worktree.worktreePath);
  }
  return [main, ...[...byKey.values()].filter(group => !group.isMain).sort((a, b) => {
    const firstA = startByKey.get(a.key);
    const firstB = startByKey.get(b.key);
    // Groups with terminals keep the order their first terminal opened in; the rest follow, newest task first.
    if (firstA && firstB) return firstA.localeCompare(firstB) || a.path.localeCompare(b.path);
    if (firstA || firstB) return firstA ? -1 : 1;
    return (b.task?.createdAt ?? '').localeCompare(a.task?.createdAt ?? '') || a.path.localeCompare(b.path);
  })];
}
