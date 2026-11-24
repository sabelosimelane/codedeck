import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
const toast = vi.hoisted(() => vi.fn());
vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return { X: Icon, Play: Icon };
});

import RunWorkflowDialog from '../RunWorkflowDialog';

const TIMEOUTS = { agentReadySeconds: 120, resetSettleSeconds: 15, finalSignalIdleSeconds: 24, lostPromptSeconds: 30, stallWarningMinutes: 15 };

const stamp = { revision: 1, createdAt: '2026-11-13T11:00:00.000Z', updatedAt: '2026-11-13T11:00:00.000Z' };
const agents = ['Default', 'Team dev', 'Trial'].map((name, index) => ({
  ...stamp, id: `11111111-1111-4111-8111-11111111111${index}`, name, launchCommand: 'agent', resetCommand: '/clear',
}));
const team = { ...stamp, name: 'Daily', id: '11111111-1111-4111-8111-222222222222', members: [{ role: 'Developer', agentId: agents[1].id }] };
const localSource = { kind: 'local', id: null, version: null, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null };
const workflowFields = { ...stamp, kind: 'other', description: '', agentsDecide: false, progressFile: null,
  source: { ...localSource },
  nodes: ['Develop', 'Fix'].map(name => ({ name, role: 'Developer', prompt: 'Work', repeat: { mode: 'once' }, askOwner: false, approval: false, readOnly: false })) };
const workflows = [
  { ...workflowFields, id: '11111111-1111-4111-8111-111111111111', name: 'Feature' },
  { ...workflowFields, id: '22222222-2222-4222-8222-222222222222', name: 'Review' },
];
const HEAD = 'a'.repeat(40);
const eligible = (patch = {}) => ({ project: 'Demo', eligible: true, reasons: [], dirty: false, branch: 'main', head: HEAD, ...patch });
const worktree = (patch = {}) => ({
  path: '/git/worktrees/demo-feature', name: 'demo-feature', branch: 'feature/x', head: HEAD,
  current: false, dirty: false, selectable: true, reason: null, ...patch,
});
const HOME = worktree({ path: '/git/demo', name: 'demo', branch: 'main', current: true });
const SETUP_MISSING = { code: 'setup_agent_missing', message: 'Choose a setup agent in Settings → Workflows.' };

function mockApi({ preflight = eligible(), worktrees = [HOME, worktree()], candidates = [], defaultBaseBranch = null, teams = [team] } = {}) {
  global.fetch = vi.fn(async (url) => {
    const target = String(url);
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (target.endsWith('/pipelines/settings')) return json({ setupAgentId: null, defaultBaseBranch, timeouts: TIMEOUTS, revision: 1 });
    if (target.includes('/agents') || target.includes('/teams')) return { ok: true, json: async () => ({ data: target.includes('/teams') ? teams : agents, page: { hasNextPage: false } }) };
    if (target.includes('/workflows')) return json({ data: workflows, page: { hasNextPage: false } });
    if (target.includes('/preflight')) return json(preflight);
    if (target.includes('/tasks/worktree-candidates')) return json({ data: candidates, page: { currentPage: 0, size: 100, totalElements: candidates.length, totalPages: candidates.length ? 1 : 0, hasNextPage: false } });
    if (target.includes('/worktrees')) return json({ data: worktrees, page: { hasNextPage: false } });
    throw new Error(`unexpected request ${target}`);
  });
}

// Tasks as the app holds them: each with the repositories it includes, the one it started in first.
const part = (id, repository, worktreePath, extra = {}) => ({ id, repository, own: true, first: true, worktreePath, branch: 'task/x', baseBranch: 'main', baseCommit: HEAD, state: 'active', prUrl: null, ...extra });
const TASK = { id: '7a000000-0000-4000-8000-000000000001', project: 'Demo', title: 'Replies', worktreePath: '/git/worktrees/demo-feature',
  worktrees: [part('7b000000-0000-4000-8000-000000000001', 'demo', '/git/worktrees/demo-feature')] };
const BUSY = { id: '7a000000-0000-4000-8000-000000000002', project: 'Demo', title: 'Busy one', worktreePath: '/git/worktrees/demo-busy',
  worktrees: [part('7b000000-0000-4000-8000-000000000002', 'demo', '/git/worktrees/demo-busy')] };

async function renderDialog(props = {}) {
  const onStart = props.onStart ?? vi.fn(async () => ({ id: 'r1' }));
  const onClose = props.onClose ?? vi.fn();
  render(<RunWorkflowDialog projectName="Demo" tasks={props.tasks ?? [TASK]} defaultTaskId={props.defaultTaskId ?? null} onClose={onClose} onStart={onStart} />);
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workflow' })).toBeTruthy());
  return { onStart, onClose };
}

const where = name => screen.getByRole('radio', { name });
const chosenPlace = () => screen.getAllByRole('radio').find(radio => radio.getAttribute('aria-checked') === 'true').textContent;
const taskOptions = () => [...screen.getByRole('combobox', { name: 'Task' }).options].map(option => ({ value: option.value, label: option.textContent, disabled: option.disabled }));
const startButton = () => screen.getByRole('button', { name: 'Start' });
const requestedWorktrees = () => global.fetch.mock.calls.some(([url]) => String(url).includes('/worktrees'));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.mockReset();
});

describe('RunWorkflowDialog', () => {
  it('makes a task from a selected worktree and starts in its repository', async () => {
    const candidate = { path: '/git/worktrees/mobile-spec', name: 'mobile-spec', repository: 'mobile-app', own: false,
      branch: 'feature/spec', head: HEAD, uncommittedCount: 1, selectable: true, reason: null };
    const disabled = { ...candidate, path: '/git/worktrees/mobile-busy', name: 'mobile-busy', selectable: false,
      reason: { code: 'in_use', message: 'An open workflow run is already using it.' } };
    mockApi({ candidates: [candidate, disabled] });
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url, options) => String(url) === '/api/tasks' && options?.method === 'POST'
      ? { ok: true, status: 201, json: async () => ({ ...TASK, title: 'Spec work', worktreePath: candidate.path,
        state: 'active', branch: candidate.branch, baseBranch: 'main', baseCommit: HEAD, prUrl: null, revision: 1,
        createdAt: stamp.createdAt, updatedAt: stamp.updatedAt, finishedAt: null, folder: null,
        worktrees: [part('7b000000-0000-4000-8000-000000000003', 'mobile-app', candidate.path, { own: false, branch: candidate.branch })] }) }
      : originalFetch(url, options));
    const { onStart } = await renderDialog({ tasks: [] });
    fireEvent.click(where('An existing worktree'));
    expect(screen.getByRole('option', { name: /mobile-busy/ }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'docs/todo.md' } });
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK.id })));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringContaining('Spec work') }));
  });

  it('keeps an adopted task and switches to it when starting the run fails', async () => {
    const candidate = { path: '/git/worktrees/demo-spec', name: 'demo-spec', repository: 'demo', own: true,
      branch: 'feature/spec', head: HEAD, uncommittedCount: 1, selectable: true, reason: null };
    mockApi({ candidates: [candidate] });
    const originalFetch = global.fetch;
    const made = { ...TASK, title: 'Spec', worktreePath: candidate.path, state: 'active', branch: candidate.branch,
      baseBranch: 'main', baseCommit: HEAD, prUrl: null, revision: 1, createdAt: stamp.createdAt,
      updatedAt: stamp.updatedAt, finishedAt: null, folder: null,
      worktrees: [part('7b000000-0000-4000-8000-000000000003', 'demo', candidate.path, { branch: candidate.branch })] };
    global.fetch = vi.fn(async (url, options) => String(url) === '/api/tasks' && options?.method === 'POST'
      ? { ok: true, status: 201, json: async () => made } : originalFetch(url, options));
    const onStart = vi.fn().mockRejectedValueOnce(new Error('Cannot start run')).mockResolvedValueOnce({ id: 'r2' });
    const { onClose } = await renderDialog({ tasks: [], onStart });
    fireEvent.click(where('An existing worktree'));
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'work' } });
    fireEvent.click(startButton());
    await waitFor(() => expect(where('An open task').getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByRole('combobox', { name: 'Task' }).value).toBe(TASK.id);
    expect(screen.getByRole('combobox', { name: 'Task' }).selectedOptions[0].disabled).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('Cannot start run');
    expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'Cannot start run' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry start' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(global.fetch.mock.calls.filter(([url, options]) => String(url) === '/api/tasks' && options?.method === 'POST')).toHaveLength(1);
  });

  it('sends the corrected input to the adopted task after the backend refused the first one', async () => {
    const candidate = { path: '/git/worktrees/demo-spec', name: 'demo-spec', repository: 'demo', own: true,
      branch: 'feature/spec', head: HEAD, uncommittedCount: 1, selectable: true, reason: null };
    mockApi({ candidates: [candidate] });
    const originalFetch = global.fetch;
    const made = { ...TASK, title: 'Spec', worktreePath: candidate.path, state: 'active', branch: candidate.branch,
      baseBranch: 'main', baseCommit: HEAD, prUrl: null, revision: 1, createdAt: stamp.createdAt,
      updatedAt: stamp.updatedAt, finishedAt: null, folder: null,
      worktrees: [part('7b000000-0000-4000-8000-000000000003', 'demo', candidate.path, { branch: candidate.branch })] };
    global.fetch = vi.fn(async (url, options) => String(url) === '/api/tasks' && options?.method === 'POST'
      ? { ok: true, status: 201, json: async () => made } : originalFetch(url, options));
    const refused = Object.assign(new Error('docs/wrong.md is not in the chosen worktree.'), { status: 400 });
    const onStart = vi.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce({ id: 'r2' });
    await renderDialog({ tasks: [], onStart });
    fireEvent.click(where('An existing worktree'));
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'docs/wrong.md' } });
    fireEvent.click(startButton());
    await waitFor(() => expect(where('An open task').getAttribute('aria-checked')).toBe('true'));
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'docs/right.md' } });
    fireEvent.click(screen.getByRole('button', { name: /^(Start|Retry start)$/ }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(2));
    expect(onStart.mock.calls[1][0]).toMatchObject({ taskId: TASK.id, input: 'docs/right.md' });
    expect(global.fetch.mock.calls.filter(([url, options]) => String(url) === '/api/tasks' && options?.method === 'POST')).toHaveLength(1);
  });
  it('keeps dictated paragraphs and selected files in order, then sends the remaining files', async () => {
    mockApi();
    const { onStart } = await renderDialog();
    const input = screen.getByLabelText('Input');
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.rows).toBeGreaterThanOrEqual(6);
    const draft = 'First paragraph.\n\nSecond paragraph.';
    fireEvent.change(input, { target: { value: draft } });
    const first = new File(['first'], 'reference.txt');
    const second = new File(['second'], 'reference.txt');
    const empty = new File([], 'empty.txt');
    const picker = screen.getByLabelText('Attach files');
    expect(picker.multiple).toBe(true);
    fireEvent.change(picker, { target: { files: [first, second] } });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove reference.txt' })).toHaveLength(2));
    fireEvent.drop(screen.getByRole('group', { name: 'Drop workflow attachments' }), { dataTransfer: { files: [empty] } });
    await screen.findByRole('button', { name: 'Remove empty.txt' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove reference.txt' })[0]);
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ input: draft, files: [second, empty] })));
  });

  it('keeps a multiline draft editable in path mode until it fits on one line', async () => {
    mockApi();
    workflows[1].progressFile = 'docs/{input}';
    try {
      await renderDialog();
      fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'First\nSecond' } });
      fireEvent.change(screen.getByRole('combobox', { name: 'Workflow' }), { target: { value: workflows[1].id } });
      expect(screen.getByLabelText('Input').value).toBe('First\nSecond');
      expect(startButton().disabled).toBe(true);
      fireEvent.change(screen.getByLabelText('Input'), { target: { value: '/tmp/todo.md' } });
      expect(startButton().disabled).toBe(true);
      fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'todo.md' } });
      expect(screen.getByLabelText('Input').tagName).toBe('INPUT');
      expect(startButton().disabled).toBe(false);
    } finally {
      workflows[1].progressFile = null;
    }
  });

  it('retries an unconfirmed start with the original file objects and request ID', async () => {
    mockApi();
    const onStart = vi.fn().mockRejectedValueOnce(new TypeError('Connection lost')).mockResolvedValueOnce({ id: 'r1' });
    const { onClose } = await renderDialog({ onStart });
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'My draft' } });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [new File(['x'], 'ref.txt')] } });
    await screen.findByRole('button', { name: 'Remove ref.txt' });
    fireEvent.click(startButton());
    const retry = await screen.findByRole('button', { name: 'Retry start' });
    expect(screen.getByLabelText('Input').disabled).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onStart.mock.calls[1][0]).toBe(onStart.mock.calls[0][0]);
  });

  it('closes a failed reservation before allowing an edited draft to use a fresh ID', async () => {
    mockApi();
    const runId = 'b00c698b-8a04-41dc-a8df-104b1527faaf';
    const originalFetch = global.fetch;
    let firstId;
    global.fetch = vi.fn(async (url, options) => url.endsWith(`/runs/${runId}/cleanup`)
      ? { ok: true, status: 200, json: async () => ({ runId, provisioningState: 'closed', terminalsClosed: [], terminalsNotClosed: [] }) }
      : originalFetch(url, options));
    const onStart = vi.fn().mockImplementationOnce(async ({ requestId }) => {
      firstId = requestId;
      throw Object.assign(new Error('Could not copy the file'), {
        status: 500, reservation: { requestId, runId, provisioningState: 'failed' },
      });
    }).mockResolvedValueOnce({ id: 'next' });
    await renderDialog({ onStart });
    const file = new File(['x'], 'ref.txt');
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Keep this draft' } });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [file] } });
    await screen.findByRole('button', { name: 'Remove ref.txt' });
    fireEvent.click(startButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Close failed start' }));
    await waitFor(() => expect(screen.getByLabelText('Input').disabled).toBe(false));
    expect(screen.getByLabelText('Input').value).toBe('Keep this draft');
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Edited\n\ndraft' } });
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(2));
    expect(onStart.mock.calls[1][0]).toMatchObject({ input: 'Edited\n\ndraft', files: [file] });
    expect(onStart.mock.calls[1][0].requestId).not.toBe(firstId);
  });

  it('keeps valid files from a mixed selection and never uploads on cancel', async () => {
    mockApi();
    const { onStart, onClose } = await renderDialog();
    const tooBig = new File([], 'oversize.txt');
    Object.defineProperty(tooBig, 'size', { value: 20 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [tooBig, new File([], 'valid.txt')] } });
    await screen.findByRole('button', { name: 'Remove valid.txt' });
    expect(screen.getByRole('alert').textContent).toContain('oversize.txt');
    expect(startButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('explains the input and path requirement only for a selected templated Progress file', async () => {
    mockApi();
    workflows[0].progressFile = 'docs/{input}';
    workflows[1].progressFile = 'docs/todo.md';
    try {
      await renderDialog();
      expect(screen.getByText("This workflow reads its progress from docs/{input}. Type the part that replaces {input}, or the file's whole path inside the project. A full path from your disk is not accepted.")).toBeTruthy();
      expect(screen.queryByText('A description of the work, or the path of a file its steps should work from.')).toBeNull();
      fireEvent.change(screen.getByRole('combobox', { name: 'Workflow' }), { target: { value: workflows[1].id } });
      expect(screen.queryByText(/so this must be that file/)).toBeNull();
      expect(screen.getByText('A description of the work, or the path of a file its steps should work from.')).toBeTruthy();
    } finally {
      workflows[0].progressFile = null;
      workflows[1].progressFile = null;
    }
  });
  it('starts a run in a new task without a title, left to be named from the work, unless one is typed', async () => {
    mockApi();
    const { onStart, onClose } = await renderDialog();

    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow' }), { target: { value: workflows[0].id } });
    expect(chosenPlace()).toBe('A new task');
    expect(startButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'ship the feature' } });
    expect(screen.getByLabelText('Task title').value).toBe('');
    expect(screen.getByLabelText('Task title').placeholder).toBe('Named from the work once the run starts, or type a title');
    expect(startButton().disabled).toBe(false);
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({
      workflowId: workflows[0].id, teamId: team.id, input: 'ship the feature', requestId: expect.stringMatching(/^[\w-]{1,128}$/),
      newTask: {},
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('cuts a new task from the default base branch unless another is typed, and says which', async () => {
    mockApi({ defaultBaseBranch: 'develop' });
    const { onStart } = await renderDialog();
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'ship the feature' } });
    const field = screen.getByLabelText('Base branch');
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('develop (the default)');
    expect(screen.getByText(/own copy of the project from develop,/)).toBeTruthy();
    fireEvent.change(field, { target: { value: ' release/2.1 ' } });
    expect(screen.getByText(/own copy of the project from release\/2\.1,/)).toBeTruthy();
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ newTask: { baseBranch: 'release/2.1' } })));
  });

  it('sends no base branch when none is typed, so the backend applies its default', async () => {
    mockApi();
    const { onStart } = await renderDialog();
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'ship the feature' } });
    expect(screen.getByLabelText('Base branch').placeholder).toBe('main (the branch Main is on)');
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ newTask: {} })));
  });

  it('refuses to start with a base branch that is not a branch name', async () => {
    mockApi();
    await renderDialog();
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'ship the feature' } });
    fireEvent.change(screen.getByLabelText('Base branch'), { target: { value: 'two words' } });
    expect(screen.getByText(/Use a Git branch name/)).toBeTruthy();
    expect(startButton().disabled).toBe(true);
  });

  it('asks for no base branch when the run works in an open task', async () => {
    mockApi();
    await renderDialog();
    fireEvent.click(where('An open task'));
    expect(screen.queryByLabelText('Base branch')).toBeNull();
  });

  it('sends no title again once a typed one is cleared', async () => {
    mockApi();
    const { onStart } = await renderDialog();
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow' }), { target: { value: workflows[0].id } });
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'ship the feature' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Typed' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: '   ' } });
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ newTask: {} })));
  });

  it('keeps a typed task title whatever the input becomes, at most 80 characters', async () => {
    mockApi();
    const { onStart } = await renderDialog();
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: `docs/${'x'.repeat(200)}.md` } });
    expect(screen.getByLabelText('Task title').value).toBe('');
    expect(screen.getByLabelText('Task title').maxLength).toBe(80);
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: '  WhatsApp replies ' } });
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'docs/todos/replies.md' } });
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ input: 'docs/todos/replies.md', newTask: { title: 'WhatsApp replies' } })));
    expect(onStart.mock.calls[0][0]).not.toHaveProperty('worktreePath');
    expect(onStart.mock.calls[0][0]).not.toHaveProperty('taskId');
  });

  it('blocks Start when preflight is ineligible, lists reasons and does not ask for worktrees', async () => {
    mockApi({ preflight: eligible({
      eligible: false, branch: null, head: null,
      reasons: [{ code: 'not_git_toplevel', message: 'Project path is not a git top-level working tree.' }],
    }) });
    await renderDialog();

    expect(screen.getByText(/not a git top-level/i)).toBeTruthy();
    expect(startButton().disabled).toBe(true);
    expect(requestedWorktrees()).toBe(false);
    expect(screen.queryByRole('radiogroup', { name: 'Where to work' })).toBeNull();
  });

  it('warns that uncommitted changes in Main stay out of a new task, without blocking Start', async () => {
    mockApi({ preflight: eligible({ dirty: true }) });
    await renderDialog();
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'x' } });

    expect(screen.getByText('Uncommitted changes in Main will not be in the task.')).toBeTruthy();
    expect(screen.getByText(/gets its own copy of the project from main/)).toBeTruthy();
    expect(startButton().disabled).toBe(false);
  });

  it('offers a new task, the open tasks of this project by title, and Main', async () => {
    mockApi({ worktrees: [
      HOME,
      worktree({ dirty: true }),
      worktree({ path: '/git/worktrees/demo-busy', name: 'demo-busy', branch: 'busy', selectable: false, reason: { code: 'in_use', message: 'An open workflow run is already using it.' } }),
    ] });
    const gone = { id: '7a000000-0000-4000-8000-000000000003', project: 'Demo', title: 'Vanished', worktreePath: '/git/worktrees/demo-gone', worktrees: [part('7b000000-0000-4000-8000-000000000008', 'demo', '/git/worktrees/demo-gone')] };
    const foreign = { id: '7a000000-0000-4000-8000-000000000004', project: 'Other', title: 'Elsewhere', worktreePath: '/git/worktrees/other', worktrees: [part('7b000000-0000-4000-8000-000000000009', 'other', '/git/worktrees/other')] };
    await renderDialog({ tasks: [TASK, BUSY, gone, foreign] });

    expect(screen.getAllByRole('radio').map(radio => [radio.textContent, radio.disabled])).toEqual([['A new task', false], ['An open task', false], ['Main', false]]);
    fireEvent.click(where('An open task'));
    expect(taskOptions()).toEqual([
      { value: TASK.id, label: 'Replies · uncommitted changes', disabled: false },
      { value: BUSY.id, label: 'Busy one — An open workflow run is already using it.', disabled: true },
      { value: gone.id, label: 'Vanished — its files are no longer on disk', disabled: true },
    ]);
  });

  it('does not offer an open task when the project has none, or Main when it cannot take a run', async () => {
    mockApi({ worktrees: [{ ...HOME, selectable: false, reason: { code: 'in_use', message: 'An open workflow run is already using it.' } }] });
    await renderDialog({ tasks: [] });
    expect(where('An open task').disabled).toBe(true);
    expect(where('An open task').title).toBe('This project has no open tasks');
    expect(where('Main').disabled).toBe(true);
    expect(where('Main').title).toBe('An open workflow run is already using it.');
  });

  it('starts a run in the chosen open task and says what that means', async () => {
    mockApi({ preflight: eligible({ dirty: true }), worktrees: [HOME, worktree({ dirty: true })] });
    const { onStart } = await renderDialog();

    fireEvent.click(where('An open task'));
    expect(screen.getByRole('combobox', { name: 'Task' }).value).toBe(TASK.id);
    expect(screen.getByText('Runs in this task as it is, with no Setup step.')).toBeTruthy();
    expect(screen.getByText('There are uncommitted changes here.')).toBeTruthy();
    expect(screen.queryByLabelText('Task title')).toBeNull();
    expect(screen.queryByText(/will not be in the task/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'docs/todos/x.md' } });
    fireEvent.click(startButton());

    await waitFor(() => expect(onStart).toHaveBeenCalledWith({
      workflowId: workflows[0].id, teamId: team.id, input: 'docs/todos/x.md', requestId: expect.stringMatching(/^[\w-]{1,128}$/), taskId: TASK.id,
    }));
  });

  it('starts in the task the owner is looking at, and in Main when asked', async () => {
    mockApi();
    const { onStart } = await renderDialog({ defaultTaskId: TASK.id });
    expect(chosenPlace()).toBe('An open task');
    expect(screen.getByRole('combobox', { name: 'Task' }).value).toBe(TASK.id);
    fireEvent.click(where('Main'));
    expect(screen.getByText('Runs directly in Main, with no copy of its own and no Setup step.')).toBeTruthy();
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: '/git/demo' })));
    expect(onStart.mock.calls[0][0]).not.toHaveProperty('newTask');
  });

  it('opens on a new task when the task the owner is looking at cannot take a run', async () => {
    mockApi({ worktrees: [
      HOME,
      worktree(),
      worktree({ path: '/git/worktrees/demo-busy', name: 'demo-busy', branch: 'busy', selectable: false, reason: { code: 'in_use', message: 'An open workflow run is already using it.' } }),
    ] });
    await renderDialog({ tasks: [BUSY, TASK], defaultTaskId: BUSY.id });
    expect(chosenPlace()).toBe('A new task');
    // Asked for an open task, the owner gets the first one that can take a run.
    fireEvent.click(where('An open task'));
    expect(screen.getByRole('combobox', { name: 'Task' }).value).toBe(TASK.id);
    expect(startButton().disabled).toBe(false);
  });

  it('shows the task the owner is looking at, and why it cannot take a run, when no open task can', async () => {
    mockApi({ worktrees: [
      HOME,
      worktree({ path: '/git/worktrees/demo-busy', name: 'demo-busy', branch: 'busy', selectable: false, reason: { code: 'in_use', message: 'An open workflow run is already using it.' } }),
    ] });
    await renderDialog({ tasks: [BUSY], defaultTaskId: BUSY.id });
    expect(chosenPlace()).toBe('A new task');
    fireEvent.click(where('An open task'));
    expect(screen.getByRole('combobox', { name: 'Task' }).value).toBe(BUSY.id);
    expect(screen.getByText('An open workflow run is already using it.', { selector: '.ui-note' })).toBeTruthy();
    expect(startButton().disabled).toBe(true);
  });

  it('falls back to a new task when the task it opened on is no longer open', async () => {
    mockApi();
    await renderDialog({ tasks: [], defaultTaskId: TASK.id });
    expect(chosenPlace()).toBe('A new task');
    expect(screen.getByLabelText('Task title')).toBeTruthy();
  });

  it('needs a setup agent only for a new task', async () => {
    mockApi({ preflight: eligible({ eligible: false, reasons: [SETUP_MISSING] }) });
    await renderDialog();
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'x' } });

    expect(screen.getByText(SETUP_MISSING.message)).toBeTruthy();
    expect(startButton().disabled).toBe(true);

    fireEvent.click(where('An open task'));
    expect(screen.queryByText(SETUP_MISSING.message)).toBeNull();
    expect(startButton().disabled).toBe(false);
  });

  it('closes and asks for the workflow builder from Edit workflows', async () => {
    mockApi();
    const asked = vi.fn();
    window.addEventListener('codedeck:open-workflow-builder', asked);
    try {
      const { onClose, onStart } = await renderDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Edit workflows…' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(onStart).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('codedeck:open-workflow-builder', asked);
    }
  });

  it('shows the API message when worktrees cannot be listed', async () => {
    global.fetch = vi.fn(async (url) => {
      const target = String(url);
      if (target.endsWith('/pipelines/settings')) return { ok: true, json: async () => ({ setupAgentId: null, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1 }) };
      if (target.includes('/agents') || target.includes('/teams')) return { ok: true, json: async () => ({ data: target.includes('/teams') ? [team] : agents, page: { hasNextPage: false } }) };
      if (target.includes('/workflows')) return { ok: true, json: async () => ({ data: workflows, page: { hasNextPage: false } }) };
      if (target.includes('/preflight')) return { ok: true, json: async () => eligible() };
      return { ok: false, status: 500, json: async () => ({ message: 'Pipelines request failed' }) };
    });
    render(<RunWorkflowDialog projectName="Demo" onClose={() => {}} onStart={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toBe('Pipelines request failed');
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });

  it('refuses a preflight response with an invalid field', async () => {
    mockApi({ preflight: eligible({ reasons: 'none' }) });
    render(<RunWorkflowDialog projectName="Demo" onClose={() => {}} onStart={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid preflight from the pipelines API: reasons/);
  });

  it('refuses a worktree record with an invalid field instead of rendering it', async () => {
    mockApi({ worktrees: [worktree({ selectable: 'yes' })] });
    render(<RunWorkflowDialog projectName="Demo" onClose={() => {}} onStart={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid worktree from the pipelines API: selectable/);
  });
});

describe('RunWorkflowDialog in a project with several repositories', () => {
  const OTHERS = [{ name: 'mobile-app', path: '/git/mobile-app' }, { name: 'frontend', path: '/git/worktrees/frontend-main' }];
  const repo = (name, path, extra = {}) => ({ name, path, own: false, branch: 'main', head: HEAD, dirty: false, usable: true, reason: null, ...extra });
  const REPOSITORIES = [repo('demo', '/git/demo', { own: true }), repo('mobile-app', '/git/mobile-app', { branch: 'develop' }),
    repo('frontend', '/git/worktrees/frontend-main', { branch: null, head: null, dirty: null, usable: false, reason: { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' } })];
  const ACROSS = { id: '7a000000-0000-4000-8000-000000000003', project: 'Demo', title: 'Across', worktreePath: '/git/worktrees/across/mobile-app', worktrees: [
    part('7b000000-0000-4000-8000-000000000003', 'mobile-app', '/git/worktrees/across/mobile-app', { own: false }),
    part('7b000000-0000-4000-8000-000000000004', 'demo', '/git/worktrees/across/demo', { first: false }),
    part('7b000000-0000-4000-8000-000000000005', 'frontend', '/git/worktrees/across/frontend', { own: false, first: false, state: 'merged' }),
  ] };

  function mockRepositories(candidates = []) {
    mockApi({ candidates });
    const base = global.fetch;
    global.fetch = vi.fn(async (url, options) => {
      if (String(url).includes('/repositories')) return { ok: true, status: 200, json: async () => ({ data: REPOSITORIES, page: { hasNextPage: false, totalElements: REPOSITORIES.length } }) };
      return base(url, options);
    });
  }
  async function renderAcross(props = {}) {
    const onStart = vi.fn(async () => ({ id: 'r1' }));
    render(<RunWorkflowDialog projectName="Demo" repositories={OTHERS} tasks={props.tasks ?? [TASK, ACROSS]} defaultTaskId={props.defaultTaskId ?? null} onClose={vi.fn()} onStart={onStart} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workflow' })).toBeTruthy());
    return { onStart };
  }
  const startIn = () => screen.getByRole('combobox', { name: 'Start in' });
  const options = select => [...select.options].map(option => ({ label: option.textContent, disabled: option.disabled }));
  const type = value => fireEvent.change(screen.getByRole('textbox', { name: 'Input' }), { target: { value } });
  const sent = onStart => { const { requestId, ...rest } = onStart.mock.calls[0][0]; expect(requestId).toEqual(expect.any(String)); return rest; };

  it('starts an adopted worktree in its repository without including other repositories', async () => {
    const candidate = { path: '/git/worktrees/mobile-spec', name: 'mobile-spec', repository: 'mobile-app', own: false,
      branch: 'feature/spec', head: HEAD, uncommittedCount: 1, selectable: true, reason: null };
    mockRepositories([candidate]);
    const base = global.fetch;
    global.fetch = vi.fn(async (url, options) => String(url) === '/api/tasks' && options?.method === 'POST'
      ? { ok: true, status: 201, json: async () => ({ ...TASK, title: 'Spec', state: 'active', worktreePath: candidate.path,
        branch: candidate.branch, baseBranch: 'develop', baseCommit: HEAD, prUrl: null, revision: 1,
        createdAt: stamp.createdAt, updatedAt: stamp.updatedAt, finishedAt: null, folder: null,
        worktrees: [part('7b000000-0000-4000-8000-000000000003', 'mobile-app', candidate.path,
          { own: false, branch: candidate.branch, baseBranch: 'develop' })] }) }
      : base(url, options));
    const { onStart } = await renderAcross({ tasks: [] });
    fireEvent.click(where('An existing worktree'));
    type('docs/todo.md');
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(sent(onStart)).toMatchObject({ taskId: TASK.id, startIn: 'mobile-app' });
    expect(sent(onStart)).not.toHaveProperty('newTask');
  });

  it('asks which repository a new task starts in and which others it includes', async () => {
    mockRepositories();
    const { onStart } = await renderAcross();
    expect(options(startIn())).toEqual([
      { label: 'demo', disabled: false },
      { label: 'mobile-app', disabled: false },
      { label: 'frontend — This folder is not the top level of a Git working tree.', disabled: true },
    ]);
    expect(startIn().value).toBe('demo');
    // The choice is named on screen, not only for assistive technology.
    expect(screen.getByText('Start in')).toBeTruthy();
    // The list New task shows: every repository with where its copy would start from.
    expect(screen.getByRole('group', { name: 'Repositories' })).toBeTruthy();
    expect(screen.getByText('from main')).toBeTruthy();
    expect(screen.getByText('from develop')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Also include/ })).toBeNull();
    // The repository the run starts in is always included; nothing else is unless ticked.
    expect(screen.getByRole('checkbox', { name: 'demo' }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'demo' }).disabled).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'mobile-app' }).checked).toBe(false);
    expect(screen.getByRole('checkbox', { name: 'frontend' }).disabled).toBe(true);
    type('docs/todos/replies.md');
    fireEvent.change(startIn(), { target: { value: 'mobile-app' } });
    expect(screen.getByRole('checkbox', { name: 'mobile-app' }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'mobile-app' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'demo' }));
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(sent(onStart)).toEqual({ workflowId: workflows[0].id, teamId: team.id, input: 'docs/todos/replies.md', newTask: { repositories: ['mobile-app', 'demo'] }, startIn: 'mobile-app' });
  });

  it('starts a new task in the project\'s own repository alone when nothing is changed', async () => {
    mockRepositories();
    const { onStart } = await renderAcross();
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'Replies' } });
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(sent(onStart)).toEqual({ workflowId: workflows[0].id, teamId: team.id, input: '', newTask: { title: 'Replies', repositories: ['demo'] }, startIn: 'demo' });
  });

  it('asks which repository of an open task the run starts in, among those still open', async () => {
    mockRepositories();
    const { onStart } = await renderAcross({ defaultTaskId: ACROSS.id });
    expect(chosenPlace()).toBe('An open task');
    expect(options(startIn())).toEqual([{ label: 'mobile-app', disabled: false }, { label: 'demo', disabled: false }]);
    expect(startIn().value).toBe('mobile-app');
    fireEvent.change(startIn(), { target: { value: 'demo' } });
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(sent(onStart)).toEqual({ workflowId: workflows[0].id, teamId: team.id, input: '', taskId: ACROSS.id, startIn: 'demo' });
  });

  it('starts in an open task with one repository the way it always did', async () => {
    mockRepositories();
    const { onStart } = await renderAcross({ defaultTaskId: TASK.id });
    expect(screen.queryByRole('combobox', { name: 'Start in' })).toBeNull();
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(sent(onStart)).toEqual({ workflowId: workflows[0].id, teamId: team.id, input: '', taskId: TASK.id });
  });

  it('runs in Main of the repository chosen: the project\'s own, or another one\'s own checkout', async () => {
    mockRepositories();
    const { onStart } = await renderAcross();
    fireEvent.click(where('Main'));
    expect(options(startIn())).toEqual([{ label: 'demo', disabled: false }, { label: 'mobile-app', disabled: false }, { label: 'frontend — This folder is not the top level of a Git working tree.', disabled: true }]);
    fireEvent.change(startIn(), { target: { value: 'mobile-app' } });
    expect(screen.getByText('Runs directly in the checkout of mobile-app, with no copy of its own and no Setup step. It changes that repository only.')).toBeTruthy();
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(sent(onStart)).toEqual({ workflowId: workflows[0].id, teamId: team.id, input: '', worktreePath: '/git/mobile-app' });
  });

  it('says why when the repositories cannot be read, and starts nothing', async () => {
    mockApi();
    const base = global.fetch;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/repositories')) return { ok: false, status: 409, json: async () => ({ message: 'Repositories are only available for local projects.' }) };
      return base(url);
    });
    render(<RunWorkflowDialog projectName="Demo" repositories={OTHERS} tasks={[]} onClose={vi.fn()} onStart={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Repositories are only available for local projects.'));
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });
});

describe('RunWorkflowDialog reading a todo\'s Repositories line', () => {
  const OTHERS = [{ name: 'mobile-app', path: '/git/mobile-app' }, { name: 'frontend', path: '/git/frontend' }];
  const repo = (name, path, own = false) => ({ name, path, own, branch: 'main', head: HEAD, dirty: false, usable: true, reason: null });
  const REPOSITORIES = [repo('backend', '/git/demo', true), repo('mobile-app', '/git/mobile-app'), repo('frontend', '/git/frontend')];
  const TEMPLATED = [{ ...workflowFields, id: '33333333-3333-4333-8333-333333333333', name: 'Build', progressFile: 'docs/{input}' }, { ...workflowFields, id: '44444444-4444-4444-8444-444444444444', name: 'Loose', progressFile: null }];
  const entry = (repository, role, patch = {}) => ({ repository, role, todo: null, input: null, listed: true, present: null, ...patch });
  const PHONE = entry('mobile-app', 'todo', { todo: 'docs/todos/tag-phone.md', input: 'todos/tag-phone.md', present: true });
  const plan = (patch = {}) => ({ progressFile: 'docs/todos/tag.md', input: 'todos/tag.md', foundIn: 'backend', problem: null,
    repositories: [entry('backend', 'this'), PHONE, entry('frontend', 'minor')], ...patch });
  const NOTHING = { progressFile: 'docs/x.md', input: 'x.md', foundIn: null, problem: null, repositories: null };

  /** `plans`: what the backend answers for each input typed; a function answers by itself. */
  function mockPlans(plans) {
    const asked = [];
    global.fetch = vi.fn(async (url, options) => {
      const target = String(url);
      const json = body => ({ ok: true, status: 200, json: async () => body });
      if (target.includes('/run-plans')) {
        const body = JSON.parse(options.body);
        asked.push(body);
        const answer = typeof plans === 'function' ? plans(body) : plans[body.input] ?? NOTHING;
        return answer instanceof Error ? { ok: false, status: 409, json: async () => ({ message: answer.message }) } : json(answer);
      }
      if (target.endsWith('/pipelines/settings')) return json({ setupAgentId: null, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1 });
      if (target.includes('/agents') || target.includes('/teams')) return { ok: true, json: async () => ({ data: target.includes('/teams') ? [team] : agents, page: { hasNextPage: false } }) };
      if (target.includes('/workflows')) return json({ data: TEMPLATED, page: { hasNextPage: false } });
      if (target.includes('/preflight')) return json(eligible());
      if (target.includes('/tasks/worktree-candidates')) return json({ data: [], page: { currentPage: 0, size: 100, totalElements: 0, totalPages: 0, hasNextPage: false } });
      if (target.includes('/worktrees')) return json({ data: [HOME], page: { hasNextPage: false } });
      if (target.includes('/repositories')) return json({ data: REPOSITORIES, page: { hasNextPage: false, totalElements: REPOSITORIES.length } });
      throw new Error(`unexpected request ${target}`);
    });
    return asked;
  }
  async function renderPlanned(props = {}) {
    const onStart = props.onStart ?? vi.fn(async request => ({ id: `run-${request.startIn}` }));
    const onClose = vi.fn();
    render(<RunWorkflowDialog projectName="Demo" repositories={props.repositories ?? OTHERS} tasks={props.tasks ?? []} planDelay={0} onClose={onClose} onStart={onStart} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workflow' })).toBeTruthy());
    return { onStart, onClose };
  }
  const type = value => fireEvent.change(screen.getByRole('textbox', { name: 'Input' }), { target: { value } });
  const startIn = () => screen.getByRole('combobox', { name: 'Start in' });
  const box = name => screen.getByRole('checkbox', { name });
  const calls = onStart => onStart.mock.calls.map(([request, options]) => { const { requestId, ...rest } = request; expect(requestId).toEqual(expect.any(String)); return [rest, options]; });

  it('pre-fills where the run starts, what the task includes and the other runs to start, and starts them all on Start', async () => {
    const asked = mockPlans({ 'todos/tag.md': plan() });
    const { onStart, onClose } = await renderPlanned();
    type('todos/tag.md');
    await waitFor(() => expect(screen.getByText('From the Repositories line of docs/todos/tag.md.')).toBeTruthy());
    expect(asked.at(-1)).toEqual({ workflowId: TEMPLATED[0].id, project: 'Demo', input: 'todos/tag.md' });
    expect(startIn().value).toBe('backend');
    expect(box('frontend').checked).toBe(true);
    expect(box('mobile-app').checked).toBe(false);
    expect(box('Also start a run in mobile-app with docs/todos/tag-phone.md').checked).toBe(true);

    fireEvent.click(startButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const ids = onStart.mock.calls.map(([request]) => request.requestId);
    expect(new Set(ids).size).toBe(2);
    expect(calls(onStart)).toEqual([
      [{ workflowId: TEMPLATED[0].id, teamId: team.id, input: 'todos/tag.md', newTask: { repositories: ['backend', 'frontend'] }, startIn: 'backend' }, undefined],
      // The other run gets a task of its own and does not take the owner away from the first.
      [{ workflowId: TEMPLATED[0].id, teamId: team.id, input: 'todos/tag-phone.md', newTask: { repositories: ['mobile-app'] }, startIn: 'mobile-app' }, { follow: false }],
    ]);
  });

  it('starts only what stays ticked, and lets the owner change every choice', async () => {
    mockPlans({ 'todos/tag.md': plan() });
    const { onStart } = await renderPlanned();
    type('todos/tag.md');
    await waitFor(() => expect(box('frontend').checked).toBe(true));
    fireEvent.click(box('frontend'));
    fireEvent.click(box('Also start a run in mobile-app with docs/todos/tag-phone.md'));
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(calls(onStart)).toEqual([[{ workflowId: TEMPLATED[0].id, teamId: team.id, input: 'todos/tag.md', newTask: { repositories: ['backend'] }, startIn: 'backend' }, undefined]]);
  });

  it('starts in the repository that holds the todo, until the owner picks another', async () => {
    mockPlans({ 'todos/tag-phone.md': { progressFile: 'docs/todos/tag-phone.md', input: 'todos/tag-phone.md', foundIn: 'mobile-app', problem: null, repositories: null } });
    await renderPlanned();
    expect(startIn().value).toBe('backend');
    type('todos/tag-phone.md');
    await waitFor(() => expect(startIn().value).toBe('mobile-app'));
    expect(screen.getByText('docs/todos/tag-phone.md is in mobile-app.')).toBeTruthy();
    expect(screen.queryByText(/From the Repositories line/)).toBeNull();
    fireEvent.change(startIn(), { target: { value: 'frontend' } });
    type('todos/tag-tablet.md');
    await waitFor(() => expect(global.fetch.mock.calls.filter(([url]) => String(url).includes('/run-plans')).length).toBeGreaterThan(1));
    expect(startIn().value).toBe('frontend');
  });

  it('does not offer a run it could not start, and says why', async () => {
    mockPlans({ 'todos/tag.md': plan({ repositories: [
      entry('backend', 'this'),
      entry('mobile-app', 'todo', { todo: 'docs/todos/tag-phone.md', input: 'todos/tag-phone.md', present: false }),
      entry('frontend', 'todo', { todo: 'plans/console.md', input: null, present: true }),
      entry('website', 'todo', { todo: 'docs/todos/site.md', input: 'todos/site.md', listed: false }),
      entry('tools', 'minor', { listed: false }),
    ] }) });
    const { onStart } = await renderPlanned();
    type('todos/tag.md');
    await waitFor(() => expect(screen.getByText('From the Repositories line of docs/todos/tag.md.')).toBeTruthy());
    for (const [name, reason] of [
      ['Also start a run in mobile-app with docs/todos/tag-phone.md', 'docs/todos/tag-phone.md is not committed in mobile-app.'],
      ['Also start a run in frontend with plans/console.md', 'plans/console.md does not fit this workflow\'s Progress file, docs/{input}.'],
      ['Also start a run in website with docs/todos/site.md', 'website is not one of this project\'s repositories.'],
    ]) {
      expect(box(name).disabled).toBe(true);
      expect(box(name).checked).toBe(false);
      expect(screen.getByText(reason)).toBeTruthy();
    }
    expect(screen.getByText('The todo names tools, which is not one of this project\'s repositories.')).toBeTruthy();
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
  });

  it('shows a line that could not be read and pre-fills nothing from it', async () => {
    mockPlans({ 'todos/tag.md': plan({ repositories: null, problem: 'backend (major): use this todo, minor, or the path of a .md file inside that repository' }) });
    await renderPlanned();
    type('todos/tag.md');
    await waitFor(() => expect(screen.getByText('The Repositories line of docs/todos/tag.md was not used: backend (major): use this todo, minor, or the path of a .md file inside that repository')).toBeTruthy());
    expect(box('frontend').checked).toBe(false);
    expect(screen.queryByRole('checkbox', { name: /Also start a run/ })).toBeNull();
  });

  it('says so when the todo cannot be looked up, and still lets the run start', async () => {
    mockPlans(() => new Error('Workflow runs are only available for local projects.'));
    const { onStart } = await renderPlanned();
    type('todos/tag.md');
    await waitFor(() => expect(screen.getByText('The todo could not be looked up: Workflow runs are only available for local projects.')).toBeTruthy());
    fireEvent.click(startButton());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
  });

  it('keeps the dialog open when the first run does not start, and starts no other', async () => {
    mockPlans({ 'todos/tag.md': plan() });
    const onStart = vi.fn(async () => null);
    const { onClose } = await renderPlanned({ onStart });
    type('todos/tag.md');
    await waitFor(() => expect(box('Also start a run in mobile-app with docs/todos/tag-phone.md').checked).toBe(true));
    fireEvent.click(startButton());
    await screen.findByRole('button', { name: 'Retry start' });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sends files only to the primary run and retries a failed extra independently', async () => {
    mockPlans({ 'todos/tag.md': plan() });
    const onStart = vi.fn().mockResolvedValueOnce({ id: 'primary' }).mockRejectedValueOnce(new TypeError('Offline')).mockResolvedValueOnce({ id: 'extra' });
    const { onClose } = await renderPlanned({ onStart });
    type('todos/tag.md');
    await screen.findByText('Attachments go to the primary run only.');
    const file = new File(['x'], 'ref.txt');
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [file] } });
    await screen.findByRole('button', { name: 'Remove ref.txt' });
    fireEvent.click(startButton());
    const retry = await screen.findByRole('button', { name: 'Retry remaining runs' });
    expect(onStart.mock.calls[0][0].files).toEqual([file]);
    expect(onStart.mock.calls[1][0]).toMatchObject({ input: 'todos/tag-phone.md', startIn: 'mobile-app' });
    expect(onStart.mock.calls[1][0]).not.toHaveProperty('files');
    fireEvent.click(retry);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onStart.mock.calls[2][0]).toBe(onStart.mock.calls[1][0]);
  });

  it('asks only for a new task of a workflow that reads a Progress file', async () => {
    const asked = mockPlans({ 'todos/tag.md': plan() });
    await renderPlanned();
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow' }), { target: { value: TEMPLATED[1].id } });
    type('todos/tag.md');
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow' }), { target: { value: TEMPLATED[0].id } });
    await waitFor(() => expect(screen.getByText('From the Repositories line of docs/todos/tag.md.')).toBeTruthy());
    expect(asked.every(body => body.workflowId === TEMPLATED[0].id)).toBe(true);
    const before = asked.length;
    fireEvent.click(where('Main'));
    type('todos/other.md');
    await waitFor(() => expect(screen.queryByText(/From the Repositories line/)).toBeNull());
    expect(asked.length).toBe(before);
  });
});

it('shows the inherited team effort in the run step assignments', async () => {
  mockApi({ teams: [{ ...team, members: [{ ...team.members[0], effort: 'high' }] }] });
  await renderDialog();
  fireEvent.click(screen.getByText('Step assignments'));
  const picker = screen.getByLabelText('Develop agent');
  expect(picker.selectedOptions[0].textContent).toBe('Use Team dev · high');
  expect(picker.options[2].textContent).toBe('Team dev');
});

it('uses a team and overrides just one of two steps sharing its role', async () => {
  mockApi();
  const { onStart } = await renderDialog();
  fireEvent.change(screen.getByLabelText('Team'), { target: { value: team.id } });
  fireEvent.click(screen.getByText('Step assignments'));
  expect(screen.getByLabelText('Develop agent').selectedOptions[0].textContent).toContain('Team dev');
  fireEvent.change(screen.getByLabelText('Fix agent'), { target: { value: agents[2].id } });
  fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'a change' } });
  fireEvent.click(startButton());
  await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ teamId: team.id, stepOverrides: { Fix: agents[2].id } })));
});

it('allows disabling a step for a single run from Step assignments', async () => {
  mockApi();
  const { onStart } = await renderDialog();
  fireEvent.click(screen.getByText('Step assignments'));
  const toggle = screen.getByLabelText('Run Fix');
  expect(toggle.checked).toBe(true);
  fireEvent.click(toggle);
  expect(toggle.checked).toBe(false);
  expect(screen.getByLabelText('Fix agent').disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'a change' } });
  fireEvent.click(startButton());
  await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ disabledSteps: ['Fix'] })));
});
