import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return { X: Icon, Play: Icon };
});

import RunWorkflowDialog from '../RunWorkflowDialog';

const workflows = [
  { id: '11111111-1111-1111-1111-111111111111', name: 'Feature' },
  { id: '22222222-2222-2222-2222-222222222222', name: 'Review' },
];
const HEAD = 'a'.repeat(40);
const eligible = (patch = {}) => ({ project: 'Demo', eligible: true, reasons: [], dirty: false, branch: 'main', head: HEAD, ...patch });
const worktree = (patch = {}) => ({
  path: '/git/worktrees/demo-feature', name: 'demo-feature', branch: 'feature/x', head: HEAD,
  current: false, dirty: false, selectable: true, reason: null, ...patch,
});
const HOME = worktree({ path: '/git/demo', name: 'demo', branch: 'main', current: true });
const SETUP_MISSING = { code: 'setup_agent_missing', message: 'Choose a setup agent in Settings → Workflows.' };

function mockApi({ preflight = eligible(), worktrees = [HOME, worktree()] } = {}) {
  global.fetch = vi.fn(async (url) => {
    const target = String(url);
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (target.includes('/workflows')) return json({ data: workflows, page: { hasNextPage: false } });
    if (target.includes('/preflight')) return json(preflight);
    if (target.includes('/worktrees')) return json({ data: worktrees, page: { hasNextPage: false } });
    throw new Error(`unexpected request ${target}`);
  });
}

const TASK = { id: '7a000000-0000-4000-8000-000000000001', project: 'Demo', title: 'Replies', worktreePath: '/git/worktrees/demo-feature' };
const BUSY = { id: '7a000000-0000-4000-8000-000000000002', project: 'Demo', title: 'Busy one', worktreePath: '/git/worktrees/demo-busy' };

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
});

describe('RunWorkflowDialog', () => {
  it('explains the input and path requirement only for a selected templated Progress file', async () => {
    mockApi();
    workflows[0].progressFile = 'docs/{input}';
    workflows[1].progressFile = 'docs/todo.md';
    try {
      await renderDialog();
      expect(screen.getByText('This workflow reads its progress from docs/{input}, so this must be that file\'s path.')).toBeTruthy();
      expect(screen.queryByText('A description of the work, or the path of a file its steps should work from.')).toBeNull();
      fireEvent.change(screen.getByRole('combobox', { name: 'Workflow' }), { target: { value: workflows[1].id } });
      expect(screen.queryByText(/so this must be that file/)).toBeNull();
      expect(screen.getByText('A description of the work, or the path of a file its steps should work from.')).toBeTruthy();
    } finally {
      delete workflows[0].progressFile;
      delete workflows[1].progressFile;
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
      workflowId: workflows[0].id, input: 'ship the feature', requestId: expect.stringMatching(/^[\w-]{1,128}$/),
      newTask: {},
    }));
    expect(onClose).toHaveBeenCalled();
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
      worktree({ path: '/git/worktrees/demo-busy', name: 'demo-busy', branch: 'busy', selectable: false, reason: { code: 'in_use', message: 'An open workflow run is using this worktree.' } }),
    ] });
    const gone = { id: '7a000000-0000-4000-8000-000000000003', project: 'Demo', title: 'Vanished', worktreePath: '/git/worktrees/demo-gone' };
    const foreign = { id: '7a000000-0000-4000-8000-000000000004', project: 'Other', title: 'Elsewhere', worktreePath: '/git/worktrees/other' };
    await renderDialog({ tasks: [TASK, BUSY, gone, foreign] });

    expect(screen.getAllByRole('radio').map(radio => [radio.textContent, radio.disabled])).toEqual([['A new task', false], ['An open task', false], ['Main', false]]);
    fireEvent.click(where('An open task'));
    expect(taskOptions()).toEqual([
      { value: TASK.id, label: 'Replies · uncommitted changes', disabled: false },
      { value: BUSY.id, label: 'Busy one — An open workflow run is using this worktree.', disabled: true },
      { value: gone.id, label: 'Vanished — its files are no longer on disk', disabled: true },
    ]);
  });

  it('does not offer an open task when the project has none, or Main when it cannot take a run', async () => {
    mockApi({ worktrees: [{ ...HOME, selectable: false, reason: { code: 'in_use', message: 'An open workflow run is using this worktree.' } }] });
    await renderDialog({ tasks: [] });
    expect(where('An open task').disabled).toBe(true);
    expect(where('An open task').title).toBe('This project has no open tasks');
    expect(where('Main').disabled).toBe(true);
    expect(where('Main').title).toBe('An open workflow run is using this worktree.');
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
      workflowId: workflows[0].id, input: 'docs/todos/x.md', requestId: expect.stringMatching(/^[\w-]{1,128}$/), taskId: TASK.id,
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
