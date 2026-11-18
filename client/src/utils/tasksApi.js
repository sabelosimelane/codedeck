/** Tasks: a titled piece of work with its own place to work. The backend owns every field. */

const FALLBACK = 'Something went wrong. Please try again.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES = ['active', 'pr_open', 'merged', 'closed'];
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = value => typeof value === 'string' && value.trim().length > 0;

export function parseTask(task, index = 0) {
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

export async function createTask({ project, title }) {
  if (!text(project)) throw new TypeError('project must be a nonempty string');
  if (!text(title)) throw new TypeError('title must be a nonempty string');
  return parseTask(await request('', { method: 'POST', body: { project, title: title.trim() } }));
}

/** Opens a terminal inside the task and returns its session id. */
export async function openTaskTerminal(taskId) {
  if (typeof taskId !== 'string' || !UUID.test(taskId)) throw new TypeError('taskId must be a task id');
  const body = await request(`/${taskId}/terminals`, { method: 'POST' });
  if (!text(body?.sessionId)) throw new Error('Invalid task terminal response: sessionId');
  if (body.taskId !== taskId) throw new Error('Invalid task terminal response: taskId');
  if (!text(body.project)) throw new Error('Invalid task terminal response: project');
  return { sessionId: body.sessionId, taskId: body.taskId, project: body.project };
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
  guard(body.main !== null && typeof body.main === 'object' && (body.main.branch === null || text(body.main.branch)) && typeof body.main.dirty === 'boolean', 'main');
  guard(Array.isArray(body.remotes), 'remotes');
  guard(body.blockers !== null && typeof body.blockers === 'object', 'blockers');
  return {
    taskId: body.taskId, state: body.state, branch: body.branch, baseBranch: body.baseBranch, prUrl: body.prUrl,
    filesPresent: body.filesPresent, runActive: body.runActive, uncommitted: [...body.uncommitted], uncommittedCount: body.uncommittedCount,
    commitsAhead: body.commitsAhead, commitsBehind: body.commitsBehind, main: { branch: body.main.branch, dirty: body.main.dirty },
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

export async function closeTask(taskId) {
  requireTaskId(taskId);
  const body = await request(`/${taskId}/close`, { method: 'POST' });
  if (!text(body?.branchKept) || !count(body.unmergedCommits)) throw new Error('Invalid close response');
  return { task: parseTask(body.task), branchKept: body.branchKept, unmergedCommits: body.unmergedCommits, ...parseTerminals(body, 'close') };
}

export async function renameTask(taskId, { title, revision }) {
  requireTaskId(taskId);
  if (!text(title)) throw new TypeError('title must be a nonempty string');
  return parseTask(await request(`/${taskId}`, { method: 'PUT', body: { title: title.trim(), revision } }));
}
