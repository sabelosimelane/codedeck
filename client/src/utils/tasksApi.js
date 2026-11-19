/** Tasks: a titled piece of work with its own place to work. The backend owns every field. */

const FALLBACK = 'Something went wrong. Please try again.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = ['active', 'pr_open', 'merged', 'closed'];
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const absolute = value => typeof value === 'string' && value.startsWith('/') && !value.includes('\0');

/**
 * A task as every backend release has sent it: what it is called and how it stands, with the
 * worktree it started in. The phone reads tasks this way, because an installed phone build
 * also talks to an instance that is older or newer than itself.
 */
export function parseTaskSummary(task, index = 0) {
  const identity = typeof task?.id === 'string' ? task.id : `index ${index}`;
  const guard = (condition, field) => { if (!condition) throw new Error(`Invalid task ${identity} field ${field}`); };
  guard(task !== null && typeof task === 'object' && !Array.isArray(task), 'task');
  guard(typeof task.id === 'string' && UUID.test(task.id), 'id');
  guard(text(task.project), 'project');
  guard(text(task.title) && task.title.length <= 80, 'title');
  guard(STATES.includes(task.state), 'state');
  guard(typeof task.worktreePath === 'string' && task.worktreePath.startsWith('/'), 'worktreePath');
  guard(text(task.branch), 'branch');
  guard(task.baseBranch === null || text(task.baseBranch), 'baseBranch');
  guard(typeof task.baseCommit === 'string' && /^[0-9a-f]{40}$/.test(task.baseCommit), 'baseCommit');
  guard(task.prUrl === null || (typeof task.prUrl === 'string' && /^https?:\/\//.test(task.prUrl)), 'prUrl');
  guard(Number.isSafeInteger(task.revision) && task.revision >= 1, 'revision');
  guard(stamp(task.createdAt), 'createdAt');
  guard(stamp(task.updatedAt), 'updatedAt');
  guard(task.finishedAt === null || stamp(task.finishedAt), 'finishedAt');
  return {
    id: task.id, project: task.project, title: task.title, state: task.state, worktreePath: task.worktreePath,
    branch: task.branch, baseBranch: task.baseBranch, baseCommit: task.baseCommit, prUrl: task.prUrl,
    revision: task.revision, createdAt: task.createdAt, updatedAt: task.updatedAt, finishedAt: task.finishedAt,
  };
}

/** The repositories a task includes, one entry each; exactly one is the one it started in. */
function parseTaskWorktrees(task, taskId) {
  const guard = (condition, field) => { if (!condition) throw new Error(`Invalid task ${taskId} field ${field}`); };
  guard(Array.isArray(task.worktrees) && task.worktrees.length >= 1, 'worktrees');
  const worktrees = task.worktrees.map((worktree) => {
    const part = (condition, field) => guard(condition, `worktrees.${field}`);
    part(worktree !== null && typeof worktree === 'object' && !Array.isArray(worktree), 'worktree');
    part(typeof worktree.id === 'string' && UUID.test(worktree.id), 'id');
    part(text(worktree.repository) && !worktree.repository.includes('/'), 'repository');
    part(typeof worktree.own === 'boolean', 'own');
    part(typeof worktree.first === 'boolean', 'first');
    part(absolute(worktree.worktreePath), 'worktreePath');
    part(text(worktree.branch), 'branch');
    part(worktree.baseBranch === null || text(worktree.baseBranch), 'baseBranch');
    part(typeof worktree.baseCommit === 'string' && /^[0-9a-f]{40}$/.test(worktree.baseCommit), 'baseCommit');
    part(STATES.includes(worktree.state), 'state');
    part(worktree.prUrl === null || (typeof worktree.prUrl === 'string' && /^https?:\/\//.test(worktree.prUrl)), 'prUrl');
    return {
      id: worktree.id, repository: worktree.repository, own: worktree.own, first: worktree.first, worktreePath: worktree.worktreePath,
      branch: worktree.branch, baseBranch: worktree.baseBranch, baseCommit: worktree.baseCommit, state: worktree.state, prUrl: worktree.prUrl,
    };
  });
  guard(worktrees.filter(worktree => worktree.first).length === 1, 'worktrees');
  return worktrees;
}

/** A task with the folder that holds its worktrees and every repository it includes, as this release's backend sends it. */
export function parseTask(task, index = 0) {
  const summary = parseTaskSummary(task, index);
  if (!(task.folder === null || absolute(task.folder))) throw new Error(`Invalid task ${summary.id} field folder`);
  return { ...summary, folder: task.folder, worktrees: parseTaskWorktrees(task, summary.id) };
}

/**
 * A task as the phone reads it: the fields every backend release sends, and the task's
 * repositories when the instance sends them. `worktrees` is null for an instance that does
 * not say; when it does, they are checked like everywhere else.
 */
export function parseTaskForPhone(task, index = 0) {
  const summary = parseTaskSummary(task, index);
  return { ...summary, worktrees: Object.hasOwn(task, 'worktrees') ? parseTaskWorktrees(task, summary.id) : null };
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(`/api/tasks${path}`, {
      method, signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (failure) {
    if (failure?.name === 'AbortError') throw failure;
    throw new Error('Server unreachable');
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(FALLBACK); }
  if (!response.ok) {
    const field = Array.isArray(payload?.errors) && typeof payload.errors[0]?.message === 'string' ? payload.errors[0].message : null;
    // A refusal may say why: `reasons` (code and message each) or `conflicts` (file paths).
    throw Object.assign(new Error(field ?? (text(payload?.message) ? payload.message : FALLBACK)), {
      status: response.status,
      reasons: Array.isArray(payload?.reasons) ? payload.reasons.filter(reason => text(reason?.message)).map(reason => ({ code: String(reason.code), message: reason.message })) : [],
      conflicts: Array.isArray(payload?.conflicts) ? payload.conflicts.filter(text) : [],
    });
  }
  return payload;
}

/** Every task that is still open, across projects, newest first. */
export async function listOpenTasks({ signal } = {}) {
  const tasks = [];
  for (let page = 0; ; page += 1) {
    const body = await request(`?open=true&size=100&page=${page}`, { signal });
    if (!Array.isArray(body?.data) || typeof body?.page?.hasNextPage !== 'boolean') throw new Error('Invalid tasks response');
    body.data.forEach((task, index) => tasks.push(parseTask(task, index)));
    if (!body.page.hasNextPage) return tasks;
  }
}

/** `repositories`: the project's repositories the task includes, the one it starts in first; left out, its own only. */
export async function createTask({ project, title, repositories }) {
  if (!text(project)) throw new TypeError('project must be a nonempty string');
  if (!text(title)) throw new TypeError('title must be a nonempty string');
  if (repositories !== undefined && (!Array.isArray(repositories) || repositories.length === 0 || !repositories.every(text))) throw new TypeError('repositories must be a nonempty list of names');
  return parseTask(await request('', { method: 'POST', body: { project, title: title.trim(), ...(repositories === undefined ? {} : { repositories }) } }));
}

/**
 * Opens a terminal inside the task and returns its session id and the worktree it opened in.
 * `worktreeId` names one repository of the task; left out, the backend picks the one the task started in.
 */
export async function openTaskTerminal(taskId, worktreeId) {
  if (typeof taskId !== 'string' || !UUID.test(taskId)) throw new TypeError('taskId must be a task id');
  if (worktreeId !== undefined && (typeof worktreeId !== 'string' || !UUID.test(worktreeId))) throw new TypeError('worktreeId must be a worktree id');
  const body = await request(`/${taskId}/terminals`, { method: 'POST', ...(worktreeId === undefined ? {} : { body: { worktreeId } }) });
  if (!text(body?.sessionId)) throw new Error('Invalid task terminal response: sessionId');
  if (body.taskId !== taskId) throw new Error('Invalid task terminal response: taskId');
  if (!text(body.project)) throw new Error('Invalid task terminal response: project');
  if (typeof body.worktreeId !== 'string' || !UUID.test(body.worktreeId) || (worktreeId !== undefined && body.worktreeId !== worktreeId)) throw new Error('Invalid task terminal response: worktreeId');
  return { sessionId: body.sessionId, taskId: body.taskId, project: body.project, worktreeId: body.worktreeId };
}

/** The body of a close: the owner's word that ignored files only the task holds are deleted with it, or none. */
function closeBody(options) {
  const value = options?.deleteIgnored;
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError('deleteIgnored must be true or false');
  return value === true ? { body: { deleteIgnored: true } } : {};
}

const requireTaskId = taskId => { if (typeof taskId !== 'string' || !UUID.test(taskId)) throw new TypeError('taskId must be a task id'); };
const count = value => Number.isSafeInteger(value) && value >= 0;

function parseBlockers(list, field) {
  if (!Array.isArray(list)) throw new Error(`Invalid landing response: ${field}`);
  return list.map(item => {
    if (!text(item?.code) || !text(item?.message)) throw new Error(`Invalid landing response: ${field}`);
    return { code: item.code, message: item.message };
  });
}

/** How a task stands for landing, as Git reports it now. */
export function parseLanding(body) {
  const guard = (condition, field) => { if (!condition) throw new Error(`Invalid landing response: ${field}`); };
  guard(body !== null && typeof body === 'object' && !Array.isArray(body), 'body');
  guard(typeof body.taskId === 'string' && UUID.test(body.taskId), 'taskId');
  guard(STATES.includes(body.state), 'state');
  guard(text(body.branch), 'branch');
  guard(body.baseBranch === null || text(body.baseBranch), 'baseBranch');
  guard(body.prUrl === null || (typeof body.prUrl === 'string' && /^https?:\/\//.test(body.prUrl)), 'prUrl');
  guard(typeof body.filesPresent === 'boolean', 'filesPresent');
  guard(typeof body.runActive === 'boolean', 'runActive');
  guard(Array.isArray(body.uncommitted) && body.uncommitted.every(text), 'uncommitted');
  guard(count(body.uncommittedCount) && body.uncommittedCount >= body.uncommitted.length, 'uncommittedCount');
  guard(body.commitsAhead === null || count(body.commitsAhead), 'commitsAhead');
  guard(body.commitsBehind === null || count(body.commitsBehind), 'commitsBehind');
  // Work that is already in the base branch leaves no commit the base lacks.
  guard(body.alreadyInBase === null || body.alreadyInBase === false || (body.alreadyInBase === true && body.commitsAhead === 0), 'alreadyInBase');
  guard(Array.isArray(body.ignoredAtRisk) && body.ignoredAtRisk.every(text), 'ignoredAtRisk');
  guard(count(body.ignoredAtRiskCount) && body.ignoredAtRiskCount >= body.ignoredAtRisk.length && (body.ignoredAtRiskCount === 0) === (body.ignoredAtRisk.length === 0), 'ignoredAtRiskCount');
  guard(body.main !== null && typeof body.main === 'object' && (body.main.branch === null || text(body.main.branch)) && typeof body.main.dirty === 'boolean', 'main');
  guard(Array.isArray(body.remotes), 'remotes');
  guard(body.blockers !== null && typeof body.blockers === 'object', 'blockers');
  return {
    taskId: body.taskId, state: body.state, branch: body.branch, baseBranch: body.baseBranch, prUrl: body.prUrl,
    filesPresent: body.filesPresent, runActive: body.runActive, uncommitted: [...body.uncommitted], uncommittedCount: body.uncommittedCount,
    commitsAhead: body.commitsAhead, commitsBehind: body.commitsBehind, alreadyInBase: body.alreadyInBase, ignoredAtRisk: [...body.ignoredAtRisk], ignoredAtRiskCount: body.ignoredAtRiskCount, main: { branch: body.main.branch, dirty: body.main.dirty },
    remotes: body.remotes.map((remote) => {
      guard(text(remote?.name), 'remotes.name');
      guard(remote.host === null || text(remote.host), 'remotes.host');
      guard(remote.tool === null || remote.tool === 'gh' || remote.tool === 'glab', 'remotes.tool');
      return { name: remote.name, host: remote.host, tool: remote.tool };
    }),
    blockers: {
      commit: parseBlockers(body.blockers.commit, 'blockers.commit'),
      merge: parseBlockers(body.blockers.merge, 'blockers.merge'),
      pullRequest: parseBlockers(body.blockers.pullRequest, 'blockers.pullRequest'),
      close: parseBlockers(body.blockers.close, 'blockers.close'),
    },
  };
}

/** How one repository of a task stands: the landing status, with which repository and worktree it is. */
export function parseWorktreeLanding(body) {
  const landing = parseLanding(body);
  const guard = (condition, field) => { if (!condition) throw new Error(`Invalid landing response: ${field}`); };
  guard(typeof body.worktreeId === 'string' && UUID.test(body.worktreeId), 'worktreeId');
  guard(text(body.repository) && !body.repository.includes('/'), 'repository');
  guard(typeof body.own === 'boolean', 'own');
  guard(typeof body.first === 'boolean', 'first');
  guard(absolute(body.worktreePath), 'worktreePath');
  const { taskId, ...rest } = landing;
  return { taskId, worktreeId: body.worktreeId, repository: body.repository, own: body.own, first: body.first, worktreePath: body.worktreePath, ...rest };
}

const requireWorktreeId = worktreeId => { if (typeof worktreeId !== 'string' || !UUID.test(worktreeId)) throw new TypeError('worktreeId must be a worktree id'); };

/** How every repository of a task stands, the one it started in first. */
export async function listTaskWorktreeLandings(taskId, { signal } = {}) {
  requireTaskId(taskId);
  const landings = [];
  for (let page = 0; ; page += 1) {
    const body = await request(`/${taskId}/worktrees?size=100&page=${page}`, { signal });
    if (!Array.isArray(body?.data) || typeof body?.page?.hasNextPage !== 'boolean') throw new Error('Invalid task worktrees response');
    body.data.forEach(entry => landings.push(parseWorktreeLanding(entry)));
    if (!body.page.hasNextPage) break;
  }
  return landings.sort((a, b) => Number(b.first) - Number(a.first) || a.repository.localeCompare(b.repository));
}

/** Gives an open task a copy of one more of the project's repositories and returns the task with it. */
export async function addTaskRepository(taskId, repository) {
  requireTaskId(taskId);
  if (!text(repository)) throw new TypeError('repository must be a nonempty string');
  return parseTask(await request(`/${taskId}/worktrees`, { method: 'POST', body: { repository } }));
}

export async function commitTaskWorktree(taskId, worktreeId, message) {
  requireTaskId(taskId);
  requireWorktreeId(worktreeId);
  if (!text(message)) throw new TypeError('message must be a nonempty string');
  return parseWorktreeLanding(await request(`/${taskId}/worktrees/${worktreeId}/commit`, { method: 'POST', body: { message: message.trim() } }));
}

/** What every landing of one repository says: which repository, and whether that finished the task. */
function parseRepositoryOutcome(body, action) {
  if (!text(body?.repository)) throw new Error(`Invalid ${action} response: repository`);
  if (typeof body.taskFinished !== 'boolean') throw new Error(`Invalid ${action} response: taskFinished`);
  return { repository: body.repository, taskFinished: body.taskFinished };
}

export async function mergeTaskWorktree(taskId, worktreeId) {
  requireTaskId(taskId);
  requireWorktreeId(worktreeId);
  const body = await request(`/${taskId}/worktrees/${worktreeId}/merge`, { method: 'POST' });
  if (!text(body?.mergedInto) || typeof body.filesRemoved !== 'boolean' || typeof body.branchDeleted !== 'boolean') throw new Error('Invalid merge response');
  const outcome = parseRepositoryOutcome(body, 'merge');
  return { task: parseTask(body.task), repository: outcome.repository, mergedInto: body.mergedInto, filesRemoved: body.filesRemoved, filesDetail: text(body.filesDetail) ? body.filesDetail : null,
    branchDeleted: body.branchDeleted, taskFinished: outcome.taskFinished, ...parseTerminals(body, 'merge') };
}

export async function openTaskWorktreePullRequest(taskId, worktreeId, remote) {
  requireTaskId(taskId);
  requireWorktreeId(worktreeId);
  if (!text(remote)) throw new TypeError('remote must be a nonempty string');
  const body = await request(`/${taskId}/worktrees/${worktreeId}/pull-request`, { method: 'POST', body: { remote } });
  if (typeof body?.prUrl !== 'string' || !/^https?:\/\//.test(body.prUrl)) throw new Error('Invalid pull request response: prUrl');
  if (!text(body.repository)) throw new Error('Invalid pull request response: repository');
  return { task: parseTask(body.task), repository: body.repository, prUrl: body.prUrl, remote: String(body.remote) };
}

export async function closeTaskWorktree(taskId, worktreeId, options) {
  requireTaskId(taskId);
  requireWorktreeId(worktreeId);
  const body = await request(`/${taskId}/worktrees/${worktreeId}/close`, { method: 'POST', ...closeBody(options) });
  if (!text(body?.branchKept) || !count(body.unmergedCommits)) throw new Error('Invalid close response');
  const outcome = parseRepositoryOutcome(body, 'close');
  return { task: parseTask(body.task), repository: outcome.repository, branchKept: body.branchKept, unmergedCommits: body.unmergedCommits, taskFinished: outcome.taskFinished, ...parseTerminals(body, 'close') };
}

export async function getTaskLanding(taskId, { signal } = {}) {
  requireTaskId(taskId);
  return parseLanding(await request(`/${taskId}/landing`, { signal }));
}

export async function commitTask(taskId, message) {
  requireTaskId(taskId);
  if (!text(message)) throw new TypeError('message must be a nonempty string');
  return parseLanding(await request(`/${taskId}/commit`, { method: 'POST', body: { message: message.trim() } }));
}

/** Which of the finished task's terminals the backend closed, and which it could not. */
function parseTerminals(body, action) {
  for (const field of ['terminalsClosed', 'terminalsNotClosed']) {
    if (!Array.isArray(body[field]) || !body[field].every(text)) throw new Error(`Invalid ${action} response: ${field}`);
  }
  return { terminalsClosed: [...body.terminalsClosed], terminalsNotClosed: [...body.terminalsNotClosed] };
}

export async function mergeTask(taskId) {
  requireTaskId(taskId);
  const body = await request(`/${taskId}/merge`, { method: 'POST' });
  if (!text(body?.mergedInto) || typeof body.filesRemoved !== 'boolean' || typeof body.branchDeleted !== 'boolean') throw new Error('Invalid merge response');
  return { task: parseTask(body.task), mergedInto: body.mergedInto, filesRemoved: body.filesRemoved, filesDetail: text(body.filesDetail) ? body.filesDetail : null, branchDeleted: body.branchDeleted, ...parseTerminals(body, 'merge') };
}

export async function openTaskPullRequest(taskId, remote) {
  requireTaskId(taskId);
  if (!text(remote)) throw new TypeError('remote must be a nonempty string');
  const body = await request(`/${taskId}/pull-request`, { method: 'POST', body: { remote } });
  if (typeof body?.prUrl !== 'string' || !/^https?:\/\//.test(body.prUrl)) throw new Error('Invalid pull request response: prUrl');
  return { task: parseTask(body.task), prUrl: body.prUrl, remote: String(body.remote) };
}

export async function closeTask(taskId, options) {
  requireTaskId(taskId);
  const body = await request(`/${taskId}/close`, { method: 'POST', ...closeBody(options) });
  if (!text(body?.branchKept) || !count(body.unmergedCommits)) throw new Error('Invalid close response');
  return { task: parseTask(body.task), branchKept: body.branchKept, unmergedCommits: body.unmergedCommits, ...parseTerminals(body, 'close') };
}

export async function renameTask(taskId, { title, revision }) {
  requireTaskId(taskId);
  if (!text(title)) throw new TypeError('title must be a nonempty string');
  return parseTask(await request(`/${taskId}`, { method: 'PUT', body: { title: title.trim(), revision } }));
}
