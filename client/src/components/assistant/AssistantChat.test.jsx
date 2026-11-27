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

const READY = { type: 'ready', restarted: false, agentId: '00000000-0000-4000-8000-0000000000a1', agentName: 'Claude Opus', provider: 'claude', model: 'opus', effort: 'high', mode: 'default' };
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
    expect(await screen.findByText('Not signed in')).toBeTruthy();
  });
  it('names the chosen agent in the heading and while it works, whatever its provider', async () => {
    mock.fetchSituation.mockResolvedValue(situation([])); render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ ...READY, conversationId: conversation.id, agentName: 'OpenCode Flash', provider: 'opencode', model: 'deepseek/deepseek-flash', effort: null, mode: 'plan' });
    expect(await screen.findByText(/OpenCode Flash · deepseek\/deepseek-flash · CLI default effort/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the assistant' }), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('OpenCode Flash is working…')).toBeTruthy();
  });
  it('shows a frame parse failure for an unknown server type', async () => {
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'unexpected' });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Invalid assistant socket message'));
    expect(screen.getByRole('textbox', { name: 'Message the assistant' }).disabled).toBe(true);
  });
  it('waits for the stored owner frame and unlocks after a nonfatal error', async () => {
    mock.fetchSituation.mockResolvedValue(situation([])); render(<AssistantChat projectName="Demo"  />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ ...READY, conversationId: conversation.id });
    expect(await screen.findByText(/Claude Opus · opus · high/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the assistant' }), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.queryByText('hello')).toBeNull();
    sockets[0].receive({ type: 'message', message: { id: 7, conversationId: conversation.id, role: 'owner', content: 'hello', toolName: null, proposalId: null, createdAt: conversation.createdAt } });
    expect(await screen.findByText('hello')).toBeTruthy();
    sockets[0].receive({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial reply' } } });
    expect(await screen.findByText('partial reply')).toBeTruthy();
    sockets[0].receive({ type: 'error', message: 'Prompt failed', turnRunning: false });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message the assistant' }).disabled).toBe(false));
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
  it('keeps the streamed answer and the running state through an error raised mid-turn', async () => {
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ ...READY, conversationId: conversation.id });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the assistant' }), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    sockets[0].receive({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first half ' } } });
    sockets[0].receive({ type: 'error', message: 'Claude Code switched to plan mode; restoring ask before acting.', turnRunning: true });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('plan mode'));
    expect(screen.getByText(/first half/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    sockets[0].receive({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second half' } } });
    sockets[0].receive({ type: 'turn_end', messageId: 9 });
    expect(await screen.findByText('first half second half')).toBeTruthy();
  });
  it('removes unanswered permission cards when the turn ends', async () => {
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ type: 'permission_request', requestId: 90, toolCall: { toolCallId: 'c1', title: 'Edit file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy());
    sockets[0].receive({ type: 'turn_end', messageId: null });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull());
  });
  it('says a commit count is unknown instead of 0 in the approval toast', async () => {
    const pending = { id: '00000000-0000-4000-8000-000000000003', conversationId: conversation.id, project: 'Demo', kind: 'commit', payload: { taskId: conversation.id, message: 'wip' }, summary: 'Commit changes', reason: 'Save work.', state: 'pending', result: null, createdAt: conversation.createdAt, decidedAt: null, finishedAt: null };
    mock.fetchProposals.mockResolvedValue({ data: [pending], page: { currentPage: 0, size: 100, totalElements: 1, totalPages: 1, hasNextPage: false } });
    mock.approveProposal.mockResolvedValue({ ...pending, state: 'done', result: { commitsAhead: null, uncommittedCount: 0 }, decidedAt: conversation.createdAt, finishedAt: conversation.createdAt });
    render(<AssistantChat projectName="Demo" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mock.showToast).toHaveBeenCalledWith({ type: 'success', message: 'Committed (commits ahead unknown, 0 uncommitted).' }));
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
    sockets[0].receive({ ...READY, conversationId: conversation.id });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the assistant' }), { target: { value: 'Where am I?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    sockets[0].receive({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'You are on **Phase 2** of 6.' } } });
    sockets[0].receive({ type: 'turn_end', messageId: 9 });
    expect(await screen.findByText(/Phase 2/)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message the assistant' }).disabled).toBe(false);
  });
  it('streams a turn, disables Send, and sends cancel from Stop', async () => {
    mock.fetchSituation.mockResolvedValue(situation([])); render(<AssistantChat projectName="Demo"  />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ ...READY, conversationId: conversation.id });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message the assistant' }).disabled).toBe(false));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the assistant' }), { target: { value: 'Where am I?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sockets[0].sent).toContainEqual({ type: 'prompt', text: 'Where am I?' });
    expect(screen.getByRole('textbox', { name: 'Message the assistant' }).disabled).toBe(true);
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
    sockets[0].receive({ ...READY, conversationId: conversation.id });
    const box = screen.getByRole('textbox', { name: 'Message the assistant' });
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
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Assistant: adapter missing'));
    expect(screen.getByRole('textbox', { name: 'Message the assistant' }).disabled).toBe(true);
    sockets[0].close();
    expect(screen.getByRole('alert').textContent).toContain('adapter missing');
  });

  it('shows how the agent exited and keeps the input disabled', async () => {
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ ...READY, conversationId: conversation.id });
    sockets[0].receive({ type: 'agent_exit', code: null, signal: 'SIGTERM', stderrTail: 'bye' });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Claude Opus exited (signal SIGTERM). bye'));
    expect(screen.getByRole('textbox', { name: 'Message the assistant' }).disabled).toBe(true);
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

describe('AssistantChat tool calls', () => {
  const stored = (id, role, content) => ({ id, conversationId: conversation.id, role, content, toolName: role === 'tool' ? content : null, proposalId: null, createdAt: conversation.createdAt });
  it('folds each run of tool calls into one collapsed line between the replies', async () => {
    mock.fetchMessages.mockResolvedValue({ data: [
      stored(1, 'owner', 'Help me finish batch 1'),
      stored(2, 'tool', 'mcp__codedeck__read_todo'),
      stored(3, 'tool', 'cd /Users/me/trade-proxy && git status --short && git branch -a --list'),
      stored(4, 'tool', 'mcp__codedeck__list_runs'),
      stored(5, 'agent', 'Batch 1 is half built.'),
      stored(6, 'tool', 'mcp__codedeck__get_situation'),
    ], page: { currentPage: 0, size: 100, totalElements: 6, totalPages: 1, hasNextPage: false } });
    render(<AssistantChat projectName="Demo" />);
    expect(await screen.findByText('Batch 1 is half built.')).toBeTruthy();
    expect(screen.queryByText(/^Tool:/)).toBeNull();
    const groups = document.querySelectorAll('details.assistant-chat-tools');
    expect(groups).toHaveLength(2);
    expect(groups[0].open).toBe(false);
    expect(groups[0].querySelector('summary').textContent).toBe('Used 3 tools: read todo, cd /Users/me/trade-proxy && git sta…, list runs');
    expect([...groups[0].querySelectorAll('li')].map(item => item.textContent)).toEqual(['mcp__codedeck__read_todo', 'cd /Users/me/trade-proxy && git status --short && git branch -a --list', 'mcp__codedeck__list_runs']);
    expect(groups[1].querySelector('summary').textContent).toBe('Used 1 tool: get situation');
    // The replies stay in order around the folded lines.
    const transcript = document.querySelector('.assistant-chat-transcript');
    expect([...transcript.children].map(node => node.tagName === 'DETAILS' ? 'tools' : node.textContent.trim())).toEqual(['Help me finish batch 1', 'tools', 'Batch 1 is half built.', 'tools']);
  });
});

describe('AssistantChat stored tool calls', () => {
  it('names a stored call by its tool, not by the saved status line, and marks a failure', async () => {
    const call = (id, toolName, content) => ({ id, conversationId: conversation.id, role: 'tool', content, toolName, proposalId: null, createdAt: conversation.createdAt });
    mock.fetchMessages.mockResolvedValue({ data: [
      call(1, 'mcp__codedeck__list_runs', 'mcp__codedeck__list_runs — completed'),
      call(2, 'git status', 'git status — failed — git status'),
    ], page: { currentPage: 0, size: 100, totalElements: 2, totalPages: 1, hasNextPage: false } });
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(document.querySelector('details.assistant-chat-tools summary')?.textContent).toBe('Used 2 tools: list runs, git status (failed)'));
    expect([...document.querySelectorAll('details.assistant-chat-tools li')].map(item => item.textContent)).toEqual(['mcp__codedeck__list_runs — completed', 'git status — failed — git status']);
  });
});

describe('AssistantChat scrolling', () => {
  // jsdom has no layout: give the transcript a fixed viewport and a content height that grows.
  function sized(transcript, { height = 200 } = {}) {
    let content = 1000;
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, get: () => height });
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, get: () => content });
    return { grow: amount => { content += amount; } };
  }
  const agentChunk = text => ({ type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
  async function ready() {
    render(<AssistantChat projectName="Demo" />);
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].receive({ ...READY, conversationId: conversation.id });
    await screen.findByText(/Claude Opus · opus · high/);
    return document.querySelector('.assistant-chat-transcript');
  }
  it('follows new output while the owner is at the bottom', async () => {
    const transcript = await ready(); const { grow } = sized(transcript);
    transcript.scrollTop = 800; fireEvent.scroll(transcript);
    grow(300); sockets[0].receive(agentChunk('More text'));
    await waitFor(() => expect(transcript.scrollTop).toBe(transcript.scrollHeight));
  });
  it('leaves the owner where they are after they scroll up to read', async () => {
    const transcript = await ready(); const { grow } = sized(transcript);
    transcript.scrollTop = 100; fireEvent.scroll(transcript);
    grow(300); sockets[0].receive(agentChunk('More text'));
    await screen.findByText('More text');
    expect(transcript.scrollTop).toBe(100);
  });
  it('always brings a new permission request into view', async () => {
    const transcript = await ready(); const { grow } = sized(transcript);
    transcript.scrollTop = 100; fireEvent.scroll(transcript);
    grow(300); sockets[0].receive({ type: 'permission_request', requestId: 90, toolCall: { toolCallId: 'c1', title: 'Edit file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
    await waitFor(() => expect(transcript.scrollTop).toBe(transcript.scrollHeight));
  });
});
