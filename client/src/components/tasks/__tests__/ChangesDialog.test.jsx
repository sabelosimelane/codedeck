import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

const toast = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({ listTaskChanges: vi.fn() }));
vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('../../../utils/tasksApi.js', () => api);
import ChangesDialog from '../ChangesDialog.jsx';

const id = n => `7a${String(n).padStart(6, '0')}-0000-4000-8000-000000000000`;
const change = (n, overrides = {}) => ({
  id: id(n), project: 'Demo', title: `Change ${n}`, mergedAt: `2026-11-19T10:00:0${n}.000Z`, workflow: 'Bug fix',
  summary: `Summary ${n}`, detail: `# Summary ${n}\n\nWhy ${n} changed.`,
  repositories: [{ repository: 'backend', branch: `task/t-${n}`, baseBranch: 'main', commit: `${n}`.repeat(40), mergedAt: `2026-11-19T10:00:0${n}.000Z` }],
  ...overrides,
});
const page = (changes, { hasNextPage = false, total = changes.length } = {}) => ({ changes, hasNextPage, total });

async function mount(first = page([change(2), change(1)])) {
  if (first instanceof Error) api.listTaskChanges.mockRejectedValueOnce(first); else api.listTaskChanges.mockResolvedValueOnce(first);
  const onClose = vi.fn();
  render(<ChangesDialog project="Demo" onClose={onClose} />);
  await waitFor(() => expect(screen.queryByText('Reading the changes…')).toBeNull());
  return { onClose };
}
const rows = () => within(screen.getByRole('list', { name: 'Changes in Demo' })).getAllByRole('listitem');

beforeEach(() => { toast.mockReset(); api.listTaskChanges.mockReset(); });
afterEach(cleanup);

describe('ChangesDialog', () => {
  it('lists the project\'s changes in the order the backend gives them, each with its summary, when and where it landed', async () => {
    await mount();
    expect(api.listTaskChanges).toHaveBeenCalledWith({ project: 'Demo', page: 0 });
    expect(rows().map(row => within(row).getByRole('heading').textContent)).toEqual(['Change 2', 'Change 1']);
    const first = within(rows()[0]);
    expect(first.getByText('Summary 2')).toBeTruthy();
    expect(first.getByText('Bug fix')).toBeTruthy();
    expect(first.getByText('backend into main')).toBeTruthy();
    expect(first.getByText('2222222')).toBeTruthy();
    expect(first.getByText('2222222').getAttribute('title')).toBe('2'.repeat(40));
    expect(rows()[0].querySelector('time').getAttribute('datetime')).toBe('2026-11-19T10:00:02.000Z');
    expect(screen.getByText('2 changes')).toBeTruthy();
  });

  it('opens and closes the whole note of a change', async () => {
    await mount();
    const first = within(rows()[0]);
    expect(first.queryByText('Why 2 changed.')).toBeNull();
    fireEvent.click(first.getByRole('button', { name: 'Show details of Change 2' }));
    expect(first.getByText('Why 2 changed.')).toBeTruthy();
    expect(within(rows()[1]).queryByText('Why 1 changed.')).toBeNull();
    fireEvent.click(first.getByRole('button', { name: 'Hide details of Change 2' }));
    expect(first.queryByText('Why 2 changed.')).toBeNull();
  });

  it('says why a change has no summary, and shows no commit for one merged before commits were kept', async () => {
    await mount(page([
      change(1, { workflow: null, summary: null, detail: null }),
      change(2, { summary: null, detail: null, repositories: [{ repository: 'backend', branch: 'task/t-2', baseBranch: null, commit: null, mergedAt: '2026-11-19T10:00:02.000Z' }] }),
    ]));
    expect(within(rows()[0]).getByText('No summary: this task was merged without a workflow run.')).toBeTruthy();
    expect(within(rows()[0]).queryByRole('button')).toBeNull();
    expect(within(rows()[1]).getByText('No summary: the last step of its run wrote no note.')).toBeTruthy();
    expect(within(rows()[1]).getByText('backend')).toBeTruthy();
    expect(rows()[1].querySelector('code')).toBeNull();
  });

  it('lists every repository a change landed in', async () => {
    await mount(page([change(1, { repositories: [
      { repository: 'backend', branch: 'task/t-1', baseBranch: 'main', commit: 'a'.repeat(40), mergedAt: '2026-11-19T10:00:01.000Z' },
      { repository: 'mobile-app', branch: 'task/t-1', baseBranch: 'develop', commit: 'b'.repeat(40), mergedAt: '2026-11-19T10:00:02.000Z' },
    ] })]));
    expect(within(rows()[0]).getByText('backend into main')).toBeTruthy();
    expect(within(rows()[0]).getByText('mobile-app into develop')).toBeTruthy();
    expect(screen.getByText('1 change')).toBeTruthy();
  });

  it('says so when nothing was merged', async () => {
    await mount(page([]));
    expect(screen.getByText('Nothing has been merged in Demo yet.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show older changes' })).toBeNull();
  });

  it('adds older changes below when asked, and stops offering when there are no more', async () => {
    await mount(page([change(3), change(2)], { hasNextPage: true, total: 3 }));
    expect(screen.getByText('2 of 3 changes')).toBeTruthy();
    api.listTaskChanges.mockResolvedValueOnce(page([change(1)], { total: 3 }));
    fireEvent.click(screen.getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(api.listTaskChanges).toHaveBeenLastCalledWith({ project: 'Demo', page: 1 });
    expect(rows().map(row => within(row).getByRole('heading').textContent)).toEqual(['Change 3', 'Change 2', 'Change 1']);
    expect(screen.queryByRole('button', { name: 'Show older changes' })).toBeNull();
    expect(screen.getByText('3 changes')).toBeTruthy();
  });

  it('keeps what is shown and reports the reason when older changes cannot be read', async () => {
    await mount(page([change(2)], { hasNextPage: true, total: 2 }));
    api.listTaskChanges.mockRejectedValueOnce(new Error('Server unreachable'));
    fireEvent.click(screen.getByRole('button', { name: 'Show older changes' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'Server unreachable' }));
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Show older changes' }).disabled).toBe(false);
  });

  it('shows the reason when the changes cannot be read, and reads them again on Try again', async () => {
    await mount(new Error('Task request failed'));
    expect(screen.getByRole('alert').textContent).toContain('Task request failed');
    expect(screen.queryByRole('list')).toBeNull();
    api.listTaskChanges.mockResolvedValueOnce(page([change(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses the general message for a failure without a reason', async () => {
    await mount(Object.assign(new Error(''), {}));
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong. Please try again.');
  });

  it('closes on Done, and refuses a project without a name', async () => {
    const { onClose } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ChangesDialog project="" onClose={() => {}} />)).toThrow('changes dialog: project must be a name');
    expect(() => render(<ChangesDialog project="Demo" />)).toThrow('changes dialog: onClose must be a function');
    quiet.mockRestore();
  });
});
