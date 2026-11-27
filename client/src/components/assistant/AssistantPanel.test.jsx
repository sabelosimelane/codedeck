import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import AssistantPanel from './AssistantPanel.jsx';

const mock = vi.hoisted(() => ({ fetchSituation: vi.fn(), fetchCurrentConversation: vi.fn(), fetchMessages: vi.fn(), fetchProposals: vi.fn(), approveProposal: vi.fn(), declineProposal: vi.fn(), startConversation: vi.fn(), showToast: vi.fn() }));
vi.mock('../../utils/assistantApi.js', () => ({ fetchSituation: mock.fetchSituation, fetchCurrentConversation: mock.fetchCurrentConversation, fetchMessages: mock.fetchMessages, fetchProposals: mock.fetchProposals, approveProposal: mock.approveProposal, declineProposal: mock.declineProposal, startConversation: mock.startConversation, parseAssistantFrame: raw => JSON.parse(raw) }));
vi.mock('../ToastContext.jsx', () => ({ useToast: () => ({ showToast: mock.showToast }) }));
const conversation = { id: '00000000-0000-4000-8000-000000000001', project: 'Demo', state: 'current', createdAt: '2026-11-25T20:00:00.000Z', endedAt: null };
const sockets = [];
class FakeWebSocket {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
beforeEach(() => { vi.stubGlobal('WebSocket', FakeWebSocket); mock.fetchCurrentConversation.mockResolvedValue(conversation); mock.fetchMessages.mockResolvedValue({ data: [], page: { currentPage: 0, size: 100, totalElements: 0, totalPages: 0, hasNextPage: false } }); mock.fetchProposals.mockResolvedValue({ data: [], page: { currentPage: 0, size: 100, totalElements: 0, totalPages: 0, hasNextPage: false } }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); sockets.length = 0; });
const situation = flags => ({ flags });

describe('AssistantPanel header', () => {
  it('renders every flag and refreshes on demand', async () => {
    mock.fetchSituation.mockResolvedValue(situation([{ code: 'merge_blocked', message: 'Task Build is blocked by Main.', where: { taskId: 't' } }, { code: 'stray_files', message: 'Todo docs/todos/work.md has stray files.', where: { path: 'docs/todos/work.md' } }]));
    render(<AssistantPanel projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Task Build is blocked/)).toBeTruthy());
    expect(screen.getByRole('list').textContent).toContain('Todo docs/todos/work.md has stray files.');
    expect(screen.getByText('docs/todos/work.md').tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mock.fetchSituation).toHaveBeenCalledTimes(2));
  });
  it('shows an empty state and the server problem on failure', async () => {
    mock.fetchSituation.mockResolvedValueOnce(situation([])).mockRejectedValueOnce(new Error('Project is remote.'));
    render(<AssistantPanel projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Nothing needs your attention')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('Project is remote.')).toBeTruthy());
  });
  it('closes when the close button is pressed', () => {
    mock.fetchSituation.mockResolvedValue(situation([]));
    const onClose = vi.fn();
    render(<AssistantPanel projectName="Demo" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close assistant' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('keeps the flags on screen while a refresh of the same project is pending', async () => {
    mock.fetchSituation.mockResolvedValueOnce(situation([{ code: 'old', message: 'Project A is dirty.', where: {} }])).mockImplementationOnce(() => new Promise(() => {}));
    render(<AssistantPanel projectName="A" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Project A is dirty.')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mock.fetchSituation).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Project A is dirty.')).toBeTruthy();
  });
  it('clears the previous project while the next request is pending', async () => {
    mock.fetchSituation.mockResolvedValueOnce(situation([{ code: 'old', message: 'Project A is dirty.', where: {} }])).mockImplementationOnce(() => new Promise(() => {}));
    const { rerender } = render(<AssistantPanel projectName="A" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Project A is dirty.')).toBeTruthy());
    rerender(<AssistantPanel projectName="B" onClose={() => {}} />);
    await waitFor(() => expect(mock.fetchSituation).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Project A is dirty.')).toBeNull();
  });
});

describe('AssistantPanel periodic refresh', () => {
  it('refetches every 30 seconds while open and stops after it closes', async () => {
    vi.useFakeTimers();
    try {
      mock.fetchSituation.mockResolvedValue(situation([]));
      const { unmount } = render(<AssistantPanel projectName="Demo" onClose={() => {}} />);
      expect(mock.fetchSituation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(mock.fetchSituation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mock.fetchSituation).toHaveBeenCalledTimes(2);
      unmount();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mock.fetchSituation).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AssistantPanel unusable repositories', () => {
  it('says which repository cannot be read instead of claiming nothing needs attention', async () => {
    mock.fetchSituation.mockResolvedValue({ flags: [], repositories: [{ name: 'job-broker', own: true, path: '/job-broker', usable: false, reason: { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' } }] });
    render(<AssistantPanel projectName="job-broker" onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['job-broker: This folder is not the top level of a Git working tree.']));
    expect(screen.queryByText('Nothing needs your attention')).toBeNull();
  });
});

describe('AssistantPanel room for the chat', () => {
  it('keeps the situation in its own scroll region, separate from the chat', async () => {
    mock.fetchSituation.mockResolvedValue(situation([{ code: 'a', message: 'Todo docs/todos/a.md has not started.', where: {} }]));
    render(<AssistantPanel projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/has not started/)).toBeTruthy());
    const region = screen.getByRole('region', { name: 'Where things stand' });
    expect(region.contains(screen.getByRole('list'))).toBe(true);
    expect(region.contains(screen.getByRole('region', { name: 'Assistant chat' }))).toBe(false);
  });
  it('hides and shows the situation so the chat can take the whole panel', async () => {
    mock.fetchSituation.mockResolvedValue(situation([{ code: 'a', message: 'Todo docs/todos/a.md has not started.', where: {} }, { code: 'b', message: 'Repository x has 1 uncommitted files.', where: {} }]));
    render(<AssistantPanel projectName="Demo" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/has not started/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Hide (2)' }));
    expect(screen.queryByText(/has not started/)).toBeNull();
    expect(screen.getByRole('region', { name: 'Assistant chat' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show (2)' }));
    expect(screen.getByText(/has not started/)).toBeTruthy();
  });
});
