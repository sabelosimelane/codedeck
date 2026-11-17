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
  const folder = group.path.slice(group.path.lastIndexOf('/') + 1);
  nonempty(folder, 'group.path folder');
  const title = group.isMain ? 'Main checkout' : group.run
    ? `${group.run.workflowName} · ${group.run.id.slice(0, 8)}` : folder;
  return { title, detail: null, tooltip: [folder, group.branch, group.path].filter(Boolean).join('\n') };
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

export function resolveSessionWorktrees({ project, sessions, runs }) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('worktree groups: project must be an object');
  nonempty(project.name, 'project.name');
  absolute(project.path, 'project.path');
  if (!Array.isArray(sessions)) throw new Error('worktree groups: sessions must be an array');
  if (!Array.isArray(runs)) throw new Error('worktree groups: runs must be an array');
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
    bySession.set(session.sessionId, path === project.path ? 'main' : path);
  }
  return bySession;
}

export function buildWorktreeGroups({ project, sessions, runs }) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('worktree groups: project must be an object');
  nonempty(project.name, 'project.name');
  absolute(project.path, 'project.path');
  if (!Array.isArray(sessions)) throw new Error('worktree groups: sessions must be an array');
  if (!Array.isArray(runs)) throw new Error('worktree groups: runs must be an array');
  const sessionGroups = resolveSessionWorktrees({ project, sessions, runs });
  const main = { key: 'main', path: project.path, label: 'Main checkout', branch: null, isMain: true, sessionIds: [], run: null };
  const byKey = new Map([['main', main]]);
  const startByKey = new Map();
  const groupForPath = value => {
    const key = value === null || value === project.path ? 'main' : value;
    if (!byKey.has(key)) byKey.set(key, { key, path: value, label: value.slice(value.lastIndexOf('/') + 1), branch: null, isMain: false, sessionIds: [], run: null });
    return byKey.get(key);
  };
  for (const session of sessions) {
    if (!session || typeof session !== 'object') throw new Error('worktree groups: session must be an object');
    nonempty(session.sessionId, 'sessionId');
    optionalPath(session.worktreePath, 'worktreePath');
    if (session.startedAt !== null) nonempty(session.startedAt, 'startedAt');
    const group = groupForPath(sessionGroups.get(session.sessionId) === 'main' ? project.path : sessionGroups.get(session.sessionId));
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
  return [main, ...[...byKey.values()].filter(group => !group.isMain).sort((a, b) => {
    const firstA = startByKey.get(a.key) ?? '\uffff';
    const firstB = startByKey.get(b.key) ?? '\uffff';
    return firstA.localeCompare(firstB) || a.path.localeCompare(b.path);
  })];
}
