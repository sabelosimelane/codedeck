const valid = (condition, field) => { if (!condition) throw new Error(`Invalid situation field ${field}`); };
const object = (value, field) => { valid(value !== null && typeof value === 'object' && !Array.isArray(value), field); return value; };
const list = (value, field) => { valid(Array.isArray(value), field); return value; };
const text = (value, field) => valid(typeof value === 'string' && value.trim().length > 0, field);
const pathText = (value, field) => valid(typeof value === 'string' && value.length > 0, field);
const nullableText = (value, field) => { if (value !== null) text(value, field); };
// Why a docs file was left out of the situation; only a file that was read has a size.
const SKIPPED_REASONS = ['too_large', 'no_title', 'not_a_file', 'missing'];
const number = (value, field) => valid(Number.isSafeInteger(value) && value >= 0, field);
const nullableNumber = (value, field) => { if (value !== null) number(value, field); };
const boolean = (value, field) => valid(typeof value === 'boolean', field);
export function parseAssistantSettings(value) {
  object(value, 'settings');
  valid(Object.keys(value).every(key => key === 'agentId' || key === 'effort'), 'settings');
  // An empty agentId means no agent is chosen yet; the backend checks the agent and its efforts.
  valid(value.agentId === '' || (typeof value.agentId === 'string' && value.agentId.trim().length > 0), 'agentId');
  nullableText(value.effort, 'effort');
  valid(value.agentId !== '' || value.effort === null, 'effort');
  return { agentId: value.agentId, effort: value.effort };
}
export async function getAssistantSettings({ signal } = {}) {
  return parseAssistantSettings(await assistantRequest('/api/assistant/settings', { signal }, 'assistant settings'));
}
export async function saveAssistantSettings(value) {
  const settings = parseAssistantSettings(value);
  return parseAssistantSettings(await assistantRequest('/api/assistant/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }, 'assistant settings'));
}
const strings = (value, field) => list(value, field).forEach((entry, index) => pathText(entry, `${field}[${index}]`));

export function parseSituation(value) {
  object(value, 'root');
  text(value.project, 'project');
  text(value.generatedAt, 'generatedAt');
  valid(Number.isFinite(Date.parse(value.generatedAt)), 'generatedAt');
  list(value.repositories, 'repositories').forEach((repo, index) => {
    const key = `repositories[${index}]`; object(repo, key);
    text(repo.name, `${key}.name`); boolean(repo.own, `${key}.own`); text(repo.path, `${key}.path`);
    boolean(repo.usable, `${key}.usable`);
    if (repo.usable === false) {
      object(repo.reason, `${key}.reason`); text(repo.reason.code, `${key}.reason.code`); text(repo.reason.message, `${key}.reason.message`);
      return;
    }
    if (repo.missing !== undefined) boolean(repo.missing, `${key}.missing`);
    if (repo.missing === true) return;
    nullableText(repo.branch, `${key}.branch`); number(repo.dirtyCount, `${key}.dirtyCount`); strings(repo.dirty, `${key}.dirty`); strings(repo.strayFiles, `${key}.strayFiles`);
  });
  list(value.tasks, 'tasks').forEach((task, index) => {
    const key = `tasks[${index}]`; object(task, key);
    text(task.id, `${key}.id`); text(task.title, `${key}.title`); text(task.state, `${key}.state`);
    list(task.worktrees, `${key}.worktrees`).forEach((worktree, position) => {
      const field = `${key}.worktrees[${position}]`; object(worktree, field);
      for (const part of ['worktreeId', 'repository', 'worktreePath', 'branch']) text(worktree[part], `${field}.${part}`);
      nullableText(worktree.baseBranch, `${field}.baseBranch`);
      number(worktree.uncommittedCount, `${field}.uncommittedCount`);
      nullableNumber(worktree.commitsAhead, `${field}.commitsAhead`);
      nullableNumber(worktree.commitsBehind, `${field}.commitsBehind`);
      object(worktree.blockers, `${field}.blockers`);
      for (const kind of ['commit', 'merge', 'pullRequest', 'close']) list(worktree.blockers[kind], `${field}.blockers.${kind}`).forEach((reason, i) => { object(reason, `${field}.blockers.${kind}[${i}]`); text(reason.code, `${field}.blockers.${kind}[${i}].code`); text(reason.message, `${field}.blockers.${kind}[${i}].message`); });
      strings(worktree.strayFiles, `${field}.strayFiles`);
      if (worktree.missing !== undefined) boolean(worktree.missing, `${field}.missing`);
    });
    list(task.runs, `${key}.runs`).forEach((run, position) => {
      const field = `${key}.runs[${position}]`; object(run, field);
      for (const part of ['id', 'workflow', 'status']) text(run[part], `${field}.${part}`);
      nullableText(run.progressFile, `${field}.progressFile`);
      list(run.steps, `${field}.steps`).forEach((step, i) => { object(step, `${field}.steps[${i}]`); number(step.index, `${field}.steps[${i}].index`); text(step.name, `${field}.steps[${i}].name`); text(step.status, `${field}.steps[${i}].status`); });
      if (run.progress !== null) {
        object(run.progress, `${field}.progress`); text(run.progress.file, `${field}.progress.file`); text(run.progress.status, `${field}.progress.status`);
        nullableNumber(run.progress.phaseCount, `${field}.progress.phaseCount`);
        if (run.progress.phase !== null) {
          object(run.progress.phase, `${field}.progress.phase`);
          number(run.progress.phase.number, `${field}.progress.phase.number`);
          number(run.progress.phase.position, `${field}.progress.phase.position`);
          text(run.progress.phase.title, `${field}.progress.phase.title`);
          number(run.progress.phase.tasksDone, `${field}.progress.phase.tasksDone`);
          number(run.progress.phase.tasksTotal, `${field}.progress.phase.tasksTotal`);
        }
        nullableNumber(run.progress.tasksDone, `${field}.progress.tasksDone`);
        nullableNumber(run.progress.tasksTotal, `${field}.progress.tasksTotal`);
      }
      if (run.lastNote !== null) { object(run.lastNote, `${field}.lastNote`); number(run.lastNote.stepIndex, `${field}.lastNote.stepIndex`); text(run.lastNote.firstLine, `${field}.lastNote.firstLine`); }
    });
  });
  list(value.todos, 'todos').forEach((todo, index) => {
    const key = `todos[${index}]`; object(todo, key);
    for (const part of ['path', 'location', 'repository', 'title']) text(todo[part], `${key}.${part}`);
    nullableText(todo.spec, `${key}.spec`); nullableText(todo.status, `${key}.status`);
    object(todo.repositories, `${key}.repositories`); boolean(todo.repositories.found, `${key}.repositories.found`); nullableText(todo.repositories.problem, `${key}.repositories.problem`);
    list(todo.repositories.entries, `${key}.repositories.entries`).forEach((entry, i) => { object(entry, `${key}.repositories.entries[${i}]`); text(entry.repository, `${key}.repositories.entries[${i}].repository`); text(entry.role, `${key}.repositories.entries[${i}].role`); nullableText(entry.todo, `${key}.repositories.entries[${i}].todo`); });
    strings(todo.dependsOn, `${key}.dependsOn`);
    list(todo.phases, `${key}.phases`).forEach((phase, i) => { object(phase, `${key}.phases[${i}]`); number(phase.number, `${key}.phases[${i}].number`); valid(typeof phase.title === 'string', `${key}.phases[${i}].title`); number(phase.done, `${key}.phases[${i}].done`); number(phase.total, `${key}.phases[${i}].total`); });
    boolean(todo.committed, `${key}.committed`);
    if (todo.alsoIn !== undefined) strings(todo.alsoIn, `${key}.alsoIn`);
  });
  list(value.specifications, 'specifications').forEach((spec, index) => { const key = `specifications[${index}]`; object(spec, key); text(spec.path, `${key}.path`); text(spec.location, `${key}.location`); boolean(spec.committed, `${key}.committed`); });
  list(value.skipped, 'skipped').forEach((item, index) => { const key = `skipped[${index}]`; object(item, key); text(item.path, `${key}.path`); text(item.location, `${key}.location`); valid(SKIPPED_REASONS.includes(item.reason), `${key}.reason`); if (item.size === null) valid(item.reason === 'not_a_file' || item.reason === 'missing', `${key}.size`); else number(item.size, `${key}.size`); });
  list(value.flags, 'flags').forEach((flag, index) => {
    const key = `flags[${index}]`; object(flag, key); text(flag.code, `${key}.code`); text(flag.message, `${key}.message`); object(flag.where, `${key}.where`);
    for (const part of ['taskId', 'worktreeId', 'runId', 'repository', 'path']) if (Object.hasOwn(flag.where, part)) (part === 'path' ? pathText : text)(flag.where[part], `${key}.where.${part}`);
    if (flag.blockers !== undefined) list(flag.blockers, `${key}.blockers`).forEach((blocker, i) => { object(blocker, `${key}.blockers[${i}]`); text(blocker.code, `${key}.blockers[${i}].code`); text(blocker.message, `${key}.blockers[${i}].message`); });
  });
  object(value.truncated, 'truncated');
  for (const key of ['dirty', 'todos', 'specifications']) boolean(value.truncated[key], `truncated.${key}`);
  text(value.markdown, 'markdown');
  return value;
}

export async function fetchSituation(projectName, { signal } = {}) {
  text(projectName, 'projectName');
  return parseSituation(await assistantRequest(`/api/projects/${encodeURIComponent(projectName)}/situation`, { signal }, 'situation'));
}

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function parseConversation(value) {
  object(value, 'conversation');
  valid(uuid(value.id), 'id');
  text(value.project, 'project');
  valid(['current', 'ended'].includes(value.state), 'state');
  valid(iso(value.createdAt), 'createdAt');
  valid(value.endedAt === null || iso(value.endedAt), 'endedAt');
  return value;
}
export function parseMessage(value) {
  object(value, 'message');
  valid(Number.isSafeInteger(value.id) && value.id > 0, 'id');
  valid(uuid(value.conversationId), 'conversationId');
  valid(['owner', 'agent', 'tool', 'notice'].includes(value.role), 'role');
  valid(typeof value.content === 'string' && value.content.length >= 1 && value.content.length <= 200000, 'content');
  valid(value.role === 'tool' ? typeof value.toolName === 'string' && value.toolName.length >= 1 && value.toolName.length <= 100 : value.toolName === null, 'toolName');
  valid(value.proposalId === null || uuid(value.proposalId), 'proposalId');
  valid(iso(value.createdAt), 'createdAt');
  return value;
}
export function parseMessagesPage(value) {
  object(value, 'messages');
  list(value.data, 'data').forEach(parseMessage);
  object(value.page, 'page');
  for (const field of ['currentPage', 'size', 'totalElements', 'totalPages']) number(value.page[field], `page.${field}`);
  valid(value.page.size >= 1 && value.page.size <= 100, 'page.size');
  boolean(value.page.hasNextPage, 'page.hasNextPage');
  return value;
}
const PROPOSAL_KINDS = ['commit', 'merge', 'pull_request', 'close', 'new_task', 'start_run', 'stop_run', 'resume_run', 'continue_run', 'answer_run', 'change_team'];
const PROPOSAL_STATES = ['pending', 'approved', 'declined', 'done', 'failed', 'expired'];

function parseFlags(flags, prefix = 'flags') {
  list(flags, prefix).forEach((flag, index) => {
    const key = `${prefix}[${index}]`; object(flag, key); text(flag.code, `${key}.code`); text(flag.message, `${key}.message`); object(flag.where, `${key}.where`);
    for (const part of ['taskId', 'worktreeId', 'runId', 'repository', 'path']) if (Object.hasOwn(flag.where, part)) (part === 'path' ? pathText : text)(flag.where[part], `${key}.where.${part}`);
    if (flag.blockers !== undefined) list(flag.blockers, `${key}.blockers`).forEach((blocker, i) => { object(blocker, `${key}.blockers[${i}]`); text(blocker.code, `${key}.blockers[${i}].code`); text(blocker.message, `${key}.blockers[${i}].message`); });
  });
}

export function parseProposal(value) {
  object(value, 'proposal');
  valid(uuid(value.id), 'id');
  valid(uuid(value.conversationId), 'conversationId');
  text(value.project, 'project');
  valid(PROPOSAL_KINDS.includes(value.kind), 'kind');
  object(value.payload, 'payload');
  text(value.summary, 'summary');
  text(value.reason, 'reason');
  valid(PROPOSAL_STATES.includes(value.state), 'state');
  valid(value.result === null || (typeof value.result === 'object' && !Array.isArray(value.result)), 'result');
  valid(iso(value.createdAt), 'createdAt');
  valid(value.decidedAt === null || iso(value.decidedAt), 'decidedAt');
  valid(value.finishedAt === null || iso(value.finishedAt), 'finishedAt');
  return value;
}

export function parseProposalsPage(value) {
  object(value, 'proposals');
  list(value.data, 'data').forEach(parseProposal);
  object(value.page, 'page');
  for (const field of ['currentPage', 'size', 'totalElements', 'totalPages']) number(value.page[field], `page.${field}`);
  valid(value.page.size >= 1 && value.page.size <= 100, 'page.size');
  boolean(value.page.hasNextPage, 'page.hasNextPage');
  return value;
}

async function assistantRequest(url, options, label = 'assistant') {
  let response;
  try { response = await fetch(url, options); }
  catch (error) { if (error?.name === 'AbortError') throw error; throw new Error('Server unreachable'); }
  let body;
  try { body = await response.json(); }
  catch (error) { throw new Error(`The ${label} response could not be read.`, { cause: error }); }
  if (!response.ok) {
    const err = new Error(typeof body?.message === 'string' && body.message ? body.message : `The ${label} request failed.`);
    if (Array.isArray(body?.reasons)) err.reasons = body.reasons;
    if (Array.isArray(body?.conflicts)) err.conflicts = body.conflicts;
    if (body?.proposal && typeof body.proposal === 'object') {
      // A proposal that fails its checks is not shown, but the owner is told the response was unreadable.
      try { err.proposal = parseProposal(body.proposal); }
      catch (parseError) { err.message = `${err.message} The proposal in the response could not be read: ${parseError.message}`; }
    }
    throw err;
  }
  return body;
}
export function parseAssistantFrame(raw) {
  const frame = JSON.parse(raw);
  object(frame, 'frame');
  text(frame.type, 'type');
  const integer = (value, field) => valid(Number.isSafeInteger(value) && value > 0, field);
  const requestId = (value, field) => valid((Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && value.length > 0), field);
  switch (frame.type) {
    case 'ready': valid(uuid(frame.conversationId), 'conversationId'); boolean(frame.restarted, 'restarted'); text(frame.agentId, 'agentId'); text(frame.agentName, 'agentName'); text(frame.provider, 'provider'); nullableText(frame.model, 'model'); nullableText(frame.effort, 'effort'); text(frame.mode, 'mode'); boolean(frame.turnRunning, 'turnRunning'); break;
    case 'notice': text(frame.message, 'message'); integer(frame.messageId, 'messageId'); break;
    case 'message': parseMessage(frame.message); break;
    case 'update': {
      object(frame.update, 'update'); text(frame.update.sessionUpdate, 'update.sessionUpdate');
      const update = frame.update;
      if (update.sessionUpdate === 'agent_message_chunk') { object(update.content, 'update.content'); valid(update.content.type === 'text', 'update.content.type'); valid(typeof update.content.text === 'string', 'update.content.text'); }
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') { text(update.toolCallId, 'update.toolCallId'); if (update.sessionUpdate === 'tool_call') text(update.title, 'update.title'); }
      break;
    }
    case 'permission_request':
      requestId(frame.requestId, 'requestId'); object(frame.toolCall, 'toolCall'); text(frame.toolCall.toolCallId, 'toolCall.toolCallId'); text(frame.toolCall.title, 'toolCall.title');
      list(frame.options, 'options').forEach((option, index) => { object(option, `options[${index}]`); text(option.optionId, `options[${index}].optionId`); text(option.name, `options[${index}].name`); valid(['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind), `options[${index}].kind`); });
      break;
    case 'turn_end': valid(frame.messageId === null || (Number.isSafeInteger(frame.messageId) && frame.messageId > 0), 'messageId'); break;
    case 'auth': valid(['authenticated', 'unauthenticated'].includes(frame.state), 'state'); valid(frame.label === null || (typeof frame.label === 'string' && frame.label.trim().length > 0), 'label'); break;
    case 'proposal': parseProposal(frame.proposal); break;
    case 'situation': parseFlags(frame.flags, 'flags'); break;
    case 'error': text(frame.message, 'message'); boolean(frame.turnRunning, 'turnRunning'); break;
    case 'spawn_error': text(frame.message, 'message'); break;
    case 'agent_exit': valid(frame.code === null || Number.isSafeInteger(frame.code), 'code'); valid(frame.signal === null || (typeof frame.signal === 'string' && frame.signal.length > 0), 'signal'); valid(typeof frame.stderrTail === 'string', 'stderrTail'); break;
    default: throw new Error(`Invalid assistant frame type ${frame.type}`);
  }
  return frame;
}
export async function fetchCurrentConversation(project, { signal } = {}) {
  text(project, 'project');
  return parseConversation(await assistantRequest(`/api/assistant/conversations/current?project=${encodeURIComponent(project)}`, { signal }));
}
export async function fetchMessages(conversationId, { page = 0, size = 100, signal } = {}) {
  valid(uuid(conversationId), 'conversationId');
  number(page, 'page'); valid(Number.isSafeInteger(size) && size >= 1 && size <= 100, 'size');
  return parseMessagesPage(await assistantRequest(`/api/assistant/conversations/${conversationId}/messages?page=${page}&size=${size}&sort=createdAt,asc`, { signal }));
}
export async function startConversation(project) {
  text(project, 'project');
  return parseConversation(await assistantRequest('/api/assistant/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) }));
}
export async function fetchProposals(project, { conversationId, page = 0, size = 100, signal } = {}) {
  text(project, 'project');
  if (conversationId !== undefined) valid(uuid(conversationId), 'conversationId');
  number(page, 'page'); valid(Number.isSafeInteger(size) && size >= 1 && size <= 100, 'size');
  const params = new URLSearchParams({ project, page: String(page), size: String(size), sort: 'createdAt,asc' });
  if (conversationId !== undefined) params.set('conversationId', conversationId);
  return parseProposalsPage(await assistantRequest(`/api/assistant/proposals?${params.toString()}`, { signal }, 'proposals'));
}
export async function approveProposal(id) {
  valid(uuid(id), 'id');
  return parseProposal(await assistantRequest(`/api/assistant/proposals/${id}/approve`, { method: 'POST' }, 'proposal'));
}
export async function declineProposal(id) {
  valid(uuid(id), 'id');
  return parseProposal(await assistantRequest(`/api/assistant/proposals/${id}/decline`, { method: 'POST' }, 'proposal'));
}
