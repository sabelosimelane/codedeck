import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSituation, parseSituation, fetchCurrentConversation, fetchMessages, startConversation, parseConversation, parseMessagesPage, parseAssistantFrame, fetchProposals, approveProposal, declineProposal, parseProposal } from './assistantApi.js';

const good = { project: 'Demo', generatedAt: '2026-11-25T20:00:00Z', repositories: [], tasks: [], todos: [], specifications: [], skipped: [], flags: [{ code: 'merge_blocked', message: 'Task is blocked.', where: { taskId: 't' }, blockers: [{ code: 'main_dirty', message: 'Main is dirty.' }] }], truncated: { dirty: false, todos: false, specifications: false }, markdown: '# Demo' };
afterEach(() => vi.unstubAllGlobals());
describe('assistant socket frames', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const message = { id: 1, conversationId: id, role: 'owner', content: 'hello', toolName: null, proposalId: null, createdAt: '2026-11-25T20:00:00.000Z' };
  const frames = [
    { type: 'ready', conversationId: id, restarted: false },
    { type: 'notice', message: 'hello', messageId: 2 },
    { type: 'message', message },
    { type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } },
    { type: 'permission_request', requestId: 90, toolCall: { toolCallId: 't', title: 'Read file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] },
    { type: 'turn_end', messageId: null },
    { type: 'error', message: 'error' },
    { type: 'spawn_error', message: 'missing' },
    { type: 'agent_exit', code: null, signal: 'SIGTERM', stderrTail: '' },
    { type: 'auth', state: 'authenticated', label: 'Claude Ultra' },
    { type: 'auth', state: 'unauthenticated', label: null },
    { type: 'proposal', proposal: { id, conversationId: id, project: 'Demo', kind: 'commit', payload: { taskId: id, message: 'wip' }, summary: 'Commit changes', reason: 'Save work.', state: 'pending', result: null, createdAt: '2026-11-25T20:00:00.000Z', decidedAt: null, finishedAt: null } },
    { type: 'situation', flags: [{ code: 'merge_blocked', message: 'Blocked.', where: { taskId: id } }] },
  ];
  it.each(frames)('checks every required field of $type', frame => {
    expect(parseAssistantFrame(JSON.stringify(frame))).toEqual(frame);
    for (const field of Object.keys(frame)) expect(() => parseAssistantFrame(JSON.stringify({ ...frame, [field]: undefined }))).toThrow(field);
  });
  it('rejects unknown types and malformed nested fields', () => {
    expect(() => parseAssistantFrame('{')).toThrow();
    expect(() => parseAssistantFrame(JSON.stringify({ type: 'surprise' }))).toThrow('type');
    expect(() => parseAssistantFrame(JSON.stringify({ type: 'message', message: { ...message, content: null } }))).toThrow('content');
    expect(() => parseAssistantFrame(JSON.stringify({ type: 'permission_request', requestId: 1, toolCall: { toolCallId: 't' }, options: [] }))).toThrow('title');
    expect(() => parseAssistantFrame(JSON.stringify({ type: 'auth', state: 'unknown', label: null }))).toThrow('state');
    expect(() => parseAssistantFrame(JSON.stringify({ type: 'auth', state: 'authenticated', label: 7 }))).toThrow('label');
  });
});

describe('assistant API', () => {
  it('fetches and validates a situation', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => good }));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchSituation('Demo')).toEqual(good);
    expect(fetch).toHaveBeenCalledWith('/api/projects/Demo/situation', expect.any(Object));
  });
  it('shows the problem message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ message: 'Project is remote.' }) })));
    await expect(fetchSituation('Demo')).rejects.toThrow('Project is remote.');
  });
  it('reports an unreachable server when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    await expect(fetchSituation('Demo')).rejects.toThrow('Server unreachable');
  });
  it('rejects malformed nested fields with their identity', () => {
    expect(() => parseSituation({ ...good, flags: [{ ...good.flags[0], where: { taskId: null } }] })).toThrow(/flags\[0\].where.taskId/);
    expect(() => parseSituation({ ...good, truncated: { dirty: 'false', todos: false, specifications: false } })).toThrow(/truncated.dirty/);
  });
  it('accepts a literal whitespace filename in a task worktree', () => {
    const worktree = { worktreeId: 'w', repository: 'backend', worktreePath: '/tmp/task', branch: 'feature/task', baseBranch: 'main', uncommittedCount: 1, commitsAhead: 0, commitsBehind: 0, blockers: { commit: [], merge: [], pullRequest: [], close: [] }, strayFiles: [' ', '\\n'] };
    const task = { id: 't', title: 'Build', state: 'active', worktrees: [worktree], runs: [] };
    expect(parseSituation({ ...good, tasks: [task] }).tasks[0].worktrees[0].strayFiles).toEqual([' ', '\\n']);
  });
  it('rejects malformed response sections and optional missing flags', () => {
    for (const section of ['repositories', 'tasks', 'todos', 'specifications', 'skipped', 'flags']) {
      expect(() => parseSituation({ ...good, [section]: null })).toThrow(section);
    }
    expect(() => parseSituation({ ...good, repositories: [{ name: 'backend', own: true, path: '/tmp', usable: true, missing: 'yes' }] })).toThrow('repositories[0].missing');
  });
  it('checks every run progress field and phase field', () => {
    const progress = { file: 'docs/todos/x.md', status: 'in_progress', phaseCount: 1, phase: { number: 1, title: 'Work', tasksDone: 1, tasksTotal: 2 }, tasksDone: 1, tasksTotal: 2 };
    const run = { id: 'r', workflow: 'Build', status: 'complete', progressFile: progress.file, progress, steps: [], lastNote: null };
    const value = { ...good, tasks: [{ id: 't', title: 'Build', state: 'active', worktrees: [], runs: [run] }] };
    for (const field of ['phaseCount', 'tasksDone', 'tasksTotal']) expect(() => parseSituation({ ...value, tasks: [{ ...value.tasks[0], runs: [{ ...run, progress: { ...progress, [field]: undefined } }] }] })).toThrow(`progress.${field}`);
    for (const field of ['number', 'title', 'tasksDone', 'tasksTotal']) expect(() => parseSituation({ ...value, tasks: [{ ...value.tasks[0], runs: [{ ...run, progress: { ...progress, phase: { ...progress.phase, [field]: undefined } } }] }] })).toThrow(`progress.phase.${field}`);
  });
});

describe('assistant conversation API', () => {
  const conversation = { id: '00000000-0000-4000-8000-000000000001', project: 'Demo', state: 'current', createdAt: '2026-11-25T20:00:00.000Z', endedAt: null };
  const message = { id: 1, conversationId: conversation.id, role: 'agent', content: '<script>x</script>', toolName: null, proposalId: null, createdAt: conversation.createdAt };
  const page = { data: [message], page: { currentPage: 0, size: 20, totalElements: 1, totalPages: 1, hasNextPage: false } };
  it('loads and guards every conversation and message field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => conversation }).mockResolvedValueOnce({ ok: true, json: async () => page }));
    expect(await fetchCurrentConversation('Demo')).toEqual(conversation);
    expect(await fetchMessages(conversation.id)).toEqual(page);
    for (const field of Object.keys(conversation)) expect(() => parseConversation({ ...conversation, [field]: undefined })).toThrow(field);
    for (const field of Object.keys(message)) expect(() => parseMessagesPage({ ...page, data: [{ ...message, [field]: undefined }] })).toThrow(field);
  });
  it('posts a new conversation and shows the problem message', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => conversation }).mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Project is remote.' }) });
    vi.stubGlobal('fetch', fetch);
    expect(await startConversation('Demo')).toEqual(conversation);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ project: 'Demo' }) });
    await expect(startConversation('Demo')).rejects.toThrow('Project is remote.');
  });
});

describe('parseSituation for missing progress and repository stray files', () => {
  const run = { id: 'r', workflow: 'Build', status: 'complete', progressFile: 'docs/todos/gone.md', steps: [], lastNote: null, progress: { file: 'docs/todos/gone.md', status: 'missing', phaseCount: null, phase: null, tasksDone: null, tasksTotal: null } };
  const task = { id: 't', title: 'Build', state: 'active', worktrees: [], runs: [run] };
  const repository = { name: 'codedeck', own: true, path: '/repo', usable: true, branch: 'main', dirtyCount: 1, dirty: [' '], strayFiles: [' '] };
  it('accepts null progress counts for a missing progress file', () => {
    expect(parseSituation({ ...good, tasks: [task] }).tasks[0].runs[0].progress.phaseCount).toBeNull();
  });
  it('requires a repository strayFiles list of path names', () => {
    expect(parseSituation({ ...good, repositories: [repository] }).repositories[0].strayFiles).toEqual([' ']);
    expect(() => parseSituation({ ...good, repositories: [{ ...repository, strayFiles: undefined }] })).toThrow(/repositories\[0\]\.strayFiles/);
    expect(() => parseSituation({ ...good, repositories: [{ ...repository, strayFiles: [''] }] })).toThrow(/repositories\[0\]\.strayFiles\[0\]/);
  });
  it('still rejects negative progress counts', () => {
    expect(() => parseSituation({ ...good, tasks: [{ ...task, runs: [{ ...run, progress: { ...run.progress, tasksDone: -1 } }] }] })).toThrow(/progress\.tasksDone/);
  });
});

describe('parseSituation for repositories that cannot be read', () => {
  const reason = { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' };
  it('accepts an unusable repository with its reason', () => {
    expect(parseSituation({ ...good, repositories: [{ name: 'plain', own: true, path: '/plain', usable: false, reason }] }).repositories[0].reason).toEqual(reason);
  });
  it('requires usable on every repository and a reason when it is false', () => {
    expect(() => parseSituation({ ...good, repositories: [{ name: 'plain', own: true, path: '/plain', branch: 'main', dirtyCount: 0, dirty: [], strayFiles: [] }] })).toThrow(/repositories\[0\]\.usable/);
    expect(() => parseSituation({ ...good, repositories: [{ name: 'plain', own: true, path: '/plain', usable: false, reason: { code: 'x' } }] })).toThrow(/repositories\[0\]\.reason\.message/);
  });
});

describe('assistant proposals API', () => {
  const id = '00000000-0000-4000-8000-000000000009';
  const conversationId = '00000000-0000-4000-8000-000000000001';
  const proposal = {
    id,
    conversationId,
    project: 'Demo',
    kind: 'commit',
    payload: { taskId: id, message: 'wip' },
    summary: 'Commit changes',
    reason: 'Protect work.',
    state: 'pending',
    result: null,
    createdAt: '2026-11-26T10:00:00.000Z',
    decidedAt: null,
    finishedAt: null,
  };

  it('fetches, approves, and declines proposals, preserving problem reasons and network errors', async () => {
    const page = { data: [proposal], page: { currentPage: 0, size: 100, totalElements: 1, totalPages: 1, hasNextPage: false } };
    const done = { ...proposal, state: 'done', result: { commitsAhead: 1 }, decidedAt: '2026-11-26T10:01:00.000Z', finishedAt: '2026-11-26T10:01:01.000Z' };
    const declined = { ...proposal, state: 'declined', decidedAt: '2026-11-26T10:01:00.000Z' };
    const failed = { ...proposal, state: 'failed', result: { status: 409, message: 'Main is dirty.', reasons: [{ code: 'main_dirty', message: 'Main has uncommitted changes.' }] }, decidedAt: '2026-11-26T10:01:00.000Z', finishedAt: '2026-11-26T10:01:01.000Z' };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page })
      .mockResolvedValueOnce({ ok: true, json: async () => done })
      .mockResolvedValueOnce({ ok: true, json: async () => declined })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Main is dirty.', reasons: failed.result.reasons, proposal: failed }) })
      .mockRejectedValueOnce(new TypeError('network'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchProposals('Demo', { conversationId })).toEqual(page);
    expect(await approveProposal(id)).toEqual(done);
    expect(await declineProposal(id)).toEqual(declined);

    await expect(approveProposal(id)).rejects.toMatchObject({
      message: 'Main is dirty.',
      reasons: failed.result.reasons,
      proposal: failed,
    });
    await expect(approveProposal(id)).rejects.toThrow('Server unreachable');
    expect(() => parseProposal({ ...proposal, state: 'bogus' })).toThrow('state');
  });

  it('surfaces a malformed proposal in a failure problem instead of dropping it silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ message: 'Main is dirty.', proposal: { ...proposal, state: 'bogus' } }) }));
    const failure = await approveProposal(id).then(() => null, error => error);
    expect(failure.message).toMatch(/^Main is dirty\. The proposal in the response could not be read: .*state/);
    expect(failure.proposal).toBeUndefined();
  });
});
