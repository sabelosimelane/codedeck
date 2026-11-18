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
    throw new Error(field ?? (text(payload?.message) ? payload.message : FALLBACK));
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
