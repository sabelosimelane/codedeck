import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import AssistantChat from './AssistantChat.jsx';

const mock = vi.hoisted(() => ({ fetchSituation: vi.fn(), fetchCurrentConversation: vi.fn(), fetchMessages: vi.fn(), fetchProposals: vi.fn(), approveProposal: vi.fn(), declineProposal: vi.fn(), startConversation: vi.fn(), showToast: vi.fn() }));
vi.mock('../../utils/assistantApi.js', async importOriginal => ({ ...(await importOriginal()), fetchSituation: mock.fetchSituation, fetchCurrentConversation: mock.fetchCurrentConversation, fetchMessages: mock.fetchMessages, fetchProposals: mock.fetchProposals, approveProposal: mock.approveProposal, declineProposal: mock.declineProposal, startConversation: mock.startConversation }));
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

describe('AssistantChat chat', () => {
  it('shows the active Claude account and unauthenticated state, ignoring command updates', async () => {
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'auth', state: 'authenticated', label: 'Claude Ultra' });
    expect(await screen.findByText('Signed in: Claude Ultra')).toBeTruthy();
    sockets[0].receive({ type: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'deep-research', description: 'Research', input: null }] } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('deep-research')).toBeNull();
    sockets[0].receive({ type: 'auth', state: 'unauthenticated', label: null });
    expect(await screen.findByText('Not signed in to Claude Code')).toBeTruthy();
  });
  it('shows a frame parse failure for an unknown server type', async () => {
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'unexpected' });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Invalid assistant socket message'));
    expect(screen.getByRole('textbox', { name: 'Message Claude Code' }).disabled).toBe(true);
  });
  it('waits for the stored owner frame and unlocks after a nonfatal error', async () => {
    mock.fetchSituation.mockResolvedValue(situation([])); render(<AssistantChat projectName="Demo"  />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'ready', conversationId: conversation.id, restarted: false });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Claude Code' }), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.queryByText('hello')).toBeNull();
    sockets[0].receive({ type: 'message', message: { id: 7, conversationId: conversation.id, role: 'owner', content: 'hello', toolName: null, proposalId: null, createdAt: conversation.createdAt } });
    expect(await screen.findByText('hello')).toBeTruthy();
    sockets[0].receive({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial reply' } } });
    expect(await screen.findByText('partial reply')).toBeTruthy();
    sockets[0].receive({ type: 'error', message: 'Prompt failed' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message Claude Code' }).disabled).toBe(false));
    expect(screen.queryByText('partial reply')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Prompt failed');
  });
  it('loads a transcript after mount and sanitizes markdown', async () => {
    mock.fetchSituation.mockResolvedValue(situation([]));
    mock.fetchMessages.mockResolvedValue({ data: [{ id: 1, conversationId: conversation.id, role: 'agent', content: '**Hello** <script>alert(1)</script><img src=x onerror=alert(1)>', toolName: null, proposalId: null, createdAt: conversation.createdAt }], page: { currentPage: 0, size: 100, totalElements: 1, totalPages: 1, hasNextPage: false } });
    const { container } = render(<AssistantChat projectName="Demo"  />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeTruthy());
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(sockets[0].url).toContain('/ws/assistant?project=Demo');
  });
  it('sends the selected permission outcome and shows the choice', async () => {
    mock.fetchSituation.mockResolvedValue(situation([])); render(<AssistantChat projectName="Demo"  />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'permission_request', requestId: 90, toolCall: { toolCallId: 'c1', title: 'Edit file' }, options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(sockets[0].sent).toContainEqual({ type: 'permission_response', requestId: 90, outcome: { outcome: 'selected', optionId: 'reject' } });
    expect(screen.getByText(/Answered: Reject/)).toBeTruthy();
  });
  it('toasts on New conversation success and failure', async () => {
    mock.fetchSituation.mockResolvedValue(situation([]));
    mock.startConversation.mockResolvedValueOnce({ ...conversation, id: '00000000-0000-4000-8000-000000000002' }).mockRejectedValueOnce(new Error('Project is remote.'));
    render(<AssistantChat projectName="Demo"  />);
    await waitFor(() => expect(sockets.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(mock.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    await waitFor(() => expect(sockets.length).toBe(2));
    expect(sockets[0].readyState).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(mock.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Project is remote.' }));
  });
  it('closes the old socket on project switch', async () => {
    mock.fetchSituation.mockResolvedValue(situation([]));
    const { rerender } = render(<AssistantChat projectName="Demo"  />);
    await waitFor(() => expect(sockets.length).toBe(1));
    rerender(<AssistantChat projectName="Other"  />);
    await waitFor(() => expect(sockets.length).toBe(2));
    expect(sockets[0].readyState).toBe(3);
  });
  it('keeps the agent turn after turn_end instead of an empty bubble', async () => {
    mock.fetchSituation.mockResolvedValue(situation([]));
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'ready', conversationId: conversation.id, restarted: false });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Claude Code' }), { target: { value: 'Where am I?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    sockets[0].receive({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'You are on **Phase 2** of 6.' } } });
    sockets[0].receive({ type: 'turn_end', messageId: 9 });
    expect(await screen.findByText(/Phase 2/)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message Claude Code' }).disabled).toBe(false);
  });
  it('streams a turn, disables Send, and sends cancel from Stop', async () => {
    mock.fetchSituation.mockResolvedValue(situation([])); render(<AssistantChat projectName="Demo"  />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'ready', conversationId: conversation.id, restarted: false });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message Claude Code' }).disabled).toBe(false));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Claude Code' }), { target: { value: 'Where am I?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sockets[0].sent).toContainEqual({ type: 'prompt', text: 'Where am I?' });
    expect(screen.getByRole('textbox', { name: 'Message Claude Code' }).disabled).toBe(true);
    sockets[0].receive({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '**Here**' } } });
    await waitFor(() => expect(screen.getByText('Here')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(sockets[0].sent).toContainEqual({ type: 'cancel' });
  });
});


describe('AssistantChat keyboard and terminal states', () => {
  it('sends on Enter and keeps Shift+Enter for a new line', async () => {
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'ready', conversationId: conversation.id, restarted: false });
    const box = screen.getByRole('textbox', { name: 'Message Claude Code' });
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.change(box, { target: { value: 'first line' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(sockets[0].sent.filter(frame => frame.type === 'prompt')).toEqual([]);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(sockets[0].sent.filter(frame => frame.type === 'prompt')).toEqual([{ type: 'prompt', text: 'first line' }]);
  });

  it('shows a spawn error and keeps the input disabled', async () => {
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'spawn_error', message: 'adapter missing' });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Claude Code: adapter missing'));
    expect(screen.getByRole('textbox', { name: 'Message Claude Code' }).disabled).toBe(true);
    sockets[0].close();
    expect(screen.getByRole('alert').textContent).toContain('adapter missing');
  });

  it('shows how the agent exited and keeps the input disabled', async () => {
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'ready', conversationId: conversation.id, restarted: false });
    sockets[0].receive({ type: 'agent_exit', code: null, signal: 'SIGTERM', stderrTail: 'bye' });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Claude Code exited (signal SIGTERM). bye'));
    expect(screen.getByRole('textbox', { name: 'Message Claude Code' }).disabled).toBe(true);
    expect(screen.getByText('Connection closed')).toBeTruthy();
  });
});

describe('AssistantChat proposal cards', () => {
  const proposal = {
    id: '00000000-0000-4000-8000-000000000010',
    conversationId: conversation.id,
    project: 'Demo',
    kind: 'commit',
    payload: { taskId: '00000000-0000-4000-8000-000000000020', message: 'wip: save' },
    summary: 'Commit 3 files in Demo task',
    reason: 'Protect uncommitted changes before merging.',
    state: 'pending',
    result: null,
    createdAt: '2026-11-26T10:00:00.000Z',
    decidedAt: null,
    finishedAt: null,
  };

  it('disables both buttons while approving, renders done outcome, toasts, and refreshes header', async () => {
    let resolveApprove;
    mock.approveProposal.mockImplementationOnce(() => new Promise(resolve => { resolveApprove = resolve; }));
    const onDecision = vi.fn();
    render(<AssistantChat projectName="Demo" onDecision={onDecision} />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'proposal', proposal });

    expect(await screen.findByText('Commit 3 files in Demo task')).toBeTruthy();
    expect(screen.getByText('Protect uncommitted changes before merging.')).toBeTruthy();
    const approveBtn = screen.getByRole('button', { name: 'Approve' });
    const declineBtn = screen.getByRole('button', { name: 'Decline' });
    fireEvent.click(approveBtn);

    expect(approveBtn.disabled).toBe(true);
    expect(declineBtn.disabled).toBe(true);
    expect(screen.getByText(/Working/i)).toBeTruthy();

    resolveApprove({ ...proposal, state: 'done', result: { commitsAhead: 1, uncommittedCount: 0 }, decidedAt: '2026-11-26T10:01:00.000Z', finishedAt: '2026-11-26T10:01:01.000Z' });
    await waitFor(() => expect(screen.getByText(/Done/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(mock.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(onDecision).toHaveBeenCalledTimes(1);
  });

  it('renders failed outcome with reasons and error toast on refusal, and keeps buttons on network failure', async () => {
    const failed = {
      ...proposal,
      kind: 'merge',
      payload: { taskId: '00000000-0000-4000-8000-000000000020' },
      state: 'failed',
      result: { status: 409, message: 'Main has uncommitted changes.', reasons: [{ code: 'main_dirty', message: 'Commit or stash Main first.' }] },
      decidedAt: '2026-11-26T10:01:00.000Z',
      finishedAt: '2026-11-26T10:01:01.000Z',
    };
    mock.approveProposal
      .mockRejectedValueOnce(new Error('Server unreachable'))
      .mockRejectedValueOnce(Object.assign(new Error('Main has uncommitted changes.'), { reasons: failed.result.reasons, proposal: failed }));
    const onDecision = vi.fn();
    render(<AssistantChat projectName="Demo" onDecision={onDecision} />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'proposal', proposal: { ...proposal, kind: 'merge', payload: { taskId: '00000000-0000-4000-8000-000000000020' } } });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mock.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Server unreachable' }));
    expect(screen.getByRole('button', { name: 'Approve' }).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText(/Main has uncommitted changes/)).toBeTruthy());
    expect(screen.getByText(/Commit or stash Main first/)).toBeTruthy();
    expect(mock.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Main has uncommitted changes.' });
    expect(onDecision).toHaveBeenCalledTimes(1);
  });

  it('declines a proposal, renders expired proposals, and confirms New conversation when pending proposals exist', async () => {
    const expired = { ...proposal, id: '00000000-0000-4000-8000-000000000011', summary: 'Expired proposal', state: 'expired', decidedAt: '2026-11-26T09:59:00.000Z' };
    mock.fetchProposals.mockResolvedValueOnce({ data: [proposal, expired], page: { currentPage: 0, size: 100, totalElements: 2, totalPages: 1, hasNextPage: false } });
    mock.declineProposal.mockResolvedValueOnce({ ...proposal, state: 'declined', decidedAt: '2026-11-26T10:01:00.000Z' });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onDecision = vi.fn();
    render(<AssistantChat projectName="Demo" onDecision={onDecision} />);
    expect(await screen.findByText('Expired proposal')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mock.startConversation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(screen.getByText('Declined')).toBeTruthy());
    expect(mock.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(onDecision).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});
