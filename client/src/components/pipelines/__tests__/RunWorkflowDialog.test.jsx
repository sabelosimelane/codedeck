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

async function renderDialog(props = {}) {
  const onStart = props.onStart ?? vi.fn(async () => ({ id: 'r1' }));
  const onClose = props.onClose ?? vi.fn();
  render(<RunWorkflowDialog projectName="Demo" onClose={onClose} onStart={onStart} />);
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workflow' })).toBeTruthy());
  return { onStart, onClose };
}

const worktreeSelect = () => screen.getByRole('combobox', { name: 'Worktree' });
const worktreeOptions = () => [...worktreeSelect().options].map(option => ({ value: option.value, label: option.textContent, disabled: option.disabled }));
const startButton = () => screen.getByRole('button', { name: 'Start' });
const requestedWorktrees = () => global.fetch.mock.calls.some(([url]) => String(url).includes('/worktrees'));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RunWorkflowDialog', () => {
  it('loads workflows and starts a run in a new worktree with the selected input', async () => {
    mockApi();
    const { onStart, onClose } = await renderDialog();

    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow' }), { target: { value: workflows[0].id } });
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'ship the feature' } });
    expect(worktreeSelect().value).toBe('');
    fireEvent.click(startButton());

    await waitFor(() => expect(onStart).toHaveBeenCalledWith({
      workflowId: workflows[0].id,
      input: 'ship the feature',
      requestId: expect.stringMatching(/^[\w-]{1,128}$/),
    }));
    expect(onClose).toHaveBeenCalled();
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
    expect(screen.queryByRole('combobox', { name: 'Worktree' })).toBeNull();
  });

  it('warns about uncommitted changes without blocking Start', async () => {
    mockApi({ preflight: eligible({ dirty: true }) });
    await renderDialog();

    expect(screen.getByText(/Uncommitted changes in this checkout will not be in the run's worktree/i)).toBeTruthy();
    expect(startButton().disabled).toBe(false);
  });

  it('offers a new worktree first, then the project worktrees with their branch and state', async () => {
    mockApi({ worktrees: [
      HOME,
      worktree({ dirty: true }),
      worktree({ path: '/git/worktrees/demo-busy', name: 'demo-busy', branch: 'busy', selectable: false, reason: { code: 'in_use', message: 'An open workflow run is using this worktree.' } }),
      worktree({ path: '/git/worktrees/demo-detached', name: 'demo-detached', branch: null, selectable: false, reason: { code: 'detached', message: 'No branch is checked out in this worktree.' } }),
    ] });
    await renderDialog();

    expect(worktreeOptions()).toEqual([
      { value: '', label: 'New worktree (new branch from main)', disabled: false },
      { value: '/git/demo', label: 'demo · main · this checkout', disabled: false },
      { value: '/git/worktrees/demo-feature', label: 'demo-feature · feature/x · uncommitted changes', disabled: false },
      { value: '/git/worktrees/demo-busy', label: 'demo-busy · busy — An open workflow run is using this worktree.', disabled: true },
      { value: '/git/worktrees/demo-detached', label: 'demo-detached · no branch — No branch is checked out in this worktree.', disabled: true },
    ]);
  });

  it('starts a run in the chosen existing worktree and says what that means', async () => {
    mockApi({ preflight: eligible({ dirty: true }), worktrees: [HOME, worktree({ dirty: true })] });
    const { onStart } = await renderDialog();

    fireEvent.change(worktreeSelect(), { target: { value: '/git/worktrees/demo-feature' } });
    expect(screen.getByText('Runs in this worktree as it is: no Setup step, and CodeDeck will not remove it when the run ends.')).toBeTruthy();
    expect(screen.getByText('This worktree has uncommitted changes.')).toBeTruthy();
    expect(screen.queryByText(/will not be in the run's worktree/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'docs/todos/x.md' } });
    fireEvent.click(startButton());

    await waitFor(() => expect(onStart).toHaveBeenCalledWith({
      workflowId: workflows[0].id,
      input: 'docs/todos/x.md',
      requestId: expect.stringMatching(/^[\w-]{1,128}$/),
      worktreePath: '/git/worktrees/demo-feature',
    }));
  });

  it('needs a setup agent only for a new worktree', async () => {
    mockApi({ preflight: eligible({ eligible: false, reasons: [SETUP_MISSING] }) });
    await renderDialog();

    expect(screen.getByText(SETUP_MISSING.message)).toBeTruthy();
    expect(startButton().disabled).toBe(true);

    fireEvent.change(worktreeSelect(), { target: { value: '/git/worktrees/demo-feature' } });
    expect(screen.queryByText(SETUP_MISSING.message)).toBeNull();
    expect(startButton().disabled).toBe(false);
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
