import React, { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useToast } from '../ToastContext.jsx';
import {
  approveProposal,
  declineProposal,
  fetchCurrentConversation,
  fetchMessages,
  fetchProposals,
  parseAssistantFrame,
  startConversation,
} from '../../utils/assistantApi.js';
import './AssistantPanel.css';

export function renderMarkdown(text) { return DOMPurify.sanitize(marked.parse(text)); }

function describePayload(proposal) {
  const payload = proposal.payload ?? {};
  switch (proposal.kind) {
    case 'commit':
      return `Commit on task ${payload.taskId}${payload.worktreeId ? ` (worktree ${payload.worktreeId})` : ''} with message “${payload.message}”.`;
    case 'merge':
      return `Merge task ${payload.taskId}${payload.worktreeId ? ` (worktree ${payload.worktreeId})` : ''} into its base branch.`;
    case 'pull_request':
      return `Push and open a pull request on remote ${payload.remote} for task ${payload.taskId}${payload.worktreeId ? ` (worktree ${payload.worktreeId})` : ''}.`;
    case 'close':
      return `Close task ${payload.taskId}${payload.worktreeId ? ` (worktree ${payload.worktreeId})` : ''} without deleting ignored files.`;
    case 'new_task':
      return `Create task “${payload.title}”${Array.isArray(payload.repositories) && payload.repositories.length ? ` in ${payload.repositories.join(', ')}` : ''}.`;
    case 'start_run':
      return `Start workflow ${payload.workflowId}${payload.taskId ? ` on task ${payload.taskId}` : payload.newTask?.title ? ` in new task “${payload.newTask.title}”` : ''}.`;
    default:
      return proposal.kind;
  }
}

function describeDoneResult(proposal) {
  const result = proposal.result ?? {};
  // A count the result does not carry is said to be unknown, never filled in as 0.
  const countOf = (value, label, unknown) => (Number.isSafeInteger(value) ? `${value} ${label}` : unknown);
  if (proposal.kind === 'commit') return `Committed (${countOf(result.commitsAhead, 'ahead', 'commits ahead unknown')}, ${countOf(result.uncommittedCount, 'uncommitted', 'uncommitted unknown')}).`;
  if (proposal.kind === 'merge') return typeof result.mergedInto === 'string' && result.mergedInto ? `Merged into ${result.mergedInto}.` : 'Merged.';
  if (proposal.kind === 'pull_request') return result.prUrl ? `Opened ${result.prUrl}.` : 'Pull request opened.';
  if (proposal.kind === 'close') return result.taskFinished ? 'Task closed.' : 'Worktree closed.';
  if (proposal.kind === 'new_task') return result.title ? `Created task “${result.title}”.` : 'Task created.';
  if (proposal.kind === 'start_run') return result.id ? `Started run ${result.id}.` : 'Workflow run started.';
  return 'Completed.';
}

export default function AssistantChat({ projectName, onDecision, onSituationFlags }) {
  const [chatError, setChatError] = useState(null);
  const [conversationVersion, setConversationVersion] = useState(0);
  const [messages, setMessages] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [inFlightProposalId, setInFlightProposalId] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [stream, setStream] = useState('');
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('connecting');
  const [auth, setAuth] = useState(null);
  const [activeConfig, setActiveConfig] = useState(null);
  // The socket handler is set up once, so it reads the agent's name through a ref set on ready.
  const agentNameRef = useRef('The assistant');
  const wsRef = useRef(null);
  const streamRef = useRef('');
  const onSituationFlagsRef = useRef(onSituationFlags);
  onSituationFlagsRef.current = onSituationFlags;
  const { showToast } = useToast();

  const upsertProposal = incoming => {
    setProposals(previous => {
      const exists = previous.some(item => item.id === incoming.id);
      return exists ? previous.map(item => (item.id === incoming.id ? incoming : item)) : [...previous, incoming];
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    let ws;
    setMessages([]); setProposals([]); setInFlightProposalId(null); setPermissions([]); setStream(''); streamRef.current = '';
    setChatError(null); setStatus('connecting'); setAuth(null); setActiveConfig(null);
    (async () => {
      try {
        const conversation = await fetchCurrentConversation(projectName, { signal: controller.signal });
        const transcript = [];
        let page = 0;
        do {
          const result = await fetchMessages(conversation.id, { page, signal: controller.signal });
          transcript.push(...result.data);
          if (!result.page.hasNextPage) break;
          page += 1;
        } while (!controller.signal.aborted);
        const loadedProposals = [];
        let proposalPage = 0;
        do {
          const result = await fetchProposals(projectName, { conversationId: conversation.id, page: proposalPage, signal: controller.signal });
          loadedProposals.push(...result.data);
          if (!result.page.hasNextPage) break;
          proposalPage += 1;
        } while (!controller.signal.aborted);
        if (controller.signal.aborted) return;
        setMessages(transcript);
        setProposals(loadedProposals);
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ws/assistant?project=${encodeURIComponent(projectName)}`);
        wsRef.current = ws;
        ws.onmessage = event => {
          let frame;
          try { frame = parseAssistantFrame(event.data); }
          catch (failure) { setChatError(`Invalid assistant socket message: ${failure.message}`); setStatus(previous => previous === 'running' ? 'ready' : previous); return; }
          if (frame.type === 'ready') { agentNameRef.current = frame.agentName; setActiveConfig({ agentName: frame.agentName, provider: frame.provider, model: frame.model, effort: frame.effort, mode: frame.mode }); setStatus('ready'); return; }
          if (frame.type === 'auth') { setAuth(frame); return; }
          if (frame.type === 'proposal') { upsertProposal(frame.proposal); return; }
          if (frame.type === 'situation') { onSituationFlagsRef.current?.(frame.flags); return; }
          if (frame.type === 'notice') { setMessages(previous => [...previous, { id: frame.messageId, role: 'notice', content: frame.message }]); return; }
          if (frame.type === 'message') { setMessages(previous => previous.some(item => item.id === frame.message.id) ? previous : [...previous, frame.message]); return; }
          if (frame.type === 'update') {
            const update = frame.update;
            if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
              streamRef.current += update.content.text;
              setStream(streamRef.current);
            }
            if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
              setMessages(previous => {
                const existing = previous.find(item => item.toolCallId === update.toolCallId);
                if (existing) return previous.map(item => item.toolCallId === update.toolCallId ? { ...item, content: update.title ?? item.content } : item);
                if (update.sessionUpdate === 'tool_call') return [...previous, { id: `tool-${update.toolCallId}`, toolCallId: update.toolCallId, role: 'tool', content: update.title, toolName: update.title }];
                return previous;
              });
            }
            return;
          }
          if (frame.type === 'permission_request') { setPermissions(previous => [...previous, { ...frame, choice: null }]); return; }
          if (frame.type === 'turn_end') {
            const content = streamRef.current;
            if (content && frame.messageId !== null) setMessages(previous => [...previous, { id: frame.messageId, role: 'agent', content }]);
            // A permission request the turn ended without is no longer answerable.
            setPermissions(previous => previous.filter(item => item.choice !== null));
            streamRef.current = ''; setStream(''); setStatus('ready'); return;
          }
          if (frame.type === 'spawn_error') { setChatError(`Assistant: ${frame.message}`); setStatus('error'); return; }
          if (frame.type === 'agent_exit') { setChatError(`${agentNameRef.current} exited (${frame.code === null ? `signal ${frame.signal}` : `code ${frame.code}`}). ${frame.stderrTail}`); setStatus('ended'); return; }
          if (frame.type === 'error') {
            setChatError(frame.message);
            // An error raised mid-turn leaves the turn and its streamed answer alone; turn_end finishes them.
            if (!frame.turnRunning) { streamRef.current = ''; setStream(''); setStatus(previous => (previous === 'running' ? 'ready' : previous)); }
          }
        };
        ws.onclose = () => { if (!controller.signal.aborted) { setStatus(previous => previous === 'error' ? previous : 'ended'); setChatError(previous => previous || 'Assistant connection closed.'); } };
      } catch (failure) { if (!controller.signal.aborted) { setChatError(failure.message); setStatus('error'); } }
    })();
    return () => { controller.abort(); ws?.close(); if (wsRef.current === ws) wsRef.current = null; };
  }, [projectName, conversationVersion]);

  const send = () => {
    if (status !== 'ready' || wsRef.current?.readyState !== 1) return;
    const text = input.trim();
    if (!text || text.length > 20000) return;
    wsRef.current.send(JSON.stringify({ type: 'prompt', text }));
    setInput(''); setChatError(null); setStatus('running');
  };
  const respond = (requestId, option) => {
    if (wsRef.current?.readyState !== 1) { showToast({ type: 'error', message: 'Assistant connection closed.' }); return; }
    wsRef.current.send(JSON.stringify({ type: 'permission_response', requestId, outcome: { outcome: 'selected', optionId: option.optionId } }));
    setPermissions(previous => previous.map(item => item.requestId === requestId ? { ...item, choice: option.name } : item));
  };
  const handleProposalDecision = async (proposal, action) => {
    if (inFlightProposalId !== null) return;
    setInFlightProposalId(proposal.id);
    try {
      const updated = action === 'approve' ? await approveProposal(proposal.id) : await declineProposal(proposal.id);
      upsertProposal(updated);
      showToast({
        type: 'success',
        message: action === 'approve' ? describeDoneResult(updated) : 'Proposal declined.',
      });
      onDecision?.();
    } catch (failure) {
      if (failure?.proposal) {
        upsertProposal(failure.proposal);
        onDecision?.();
      }
      showToast({ type: 'error', message: failure.message });
    } finally {
      setInFlightProposalId(null);
    }
  };
  const newConversation = async () => {
    const pendingCount = proposals.filter(item => item.state === 'pending').length;
    if (pendingCount > 0 && !window.confirm(`Start a new conversation? ${pendingCount} pending ${pendingCount === 1 ? 'proposal' : 'proposals'} will expire.`)) {
      return;
    }
    try { await startConversation(projectName); showToast({ type: 'success', message: 'New conversation started.' }); setConversationVersion(value => value + 1); }
    catch (failure) { showToast({ type: 'error', message: failure.message }); }
  };

  return <section className="assistant-chat" aria-label="Assistant chat">
      <div className="assistant-chat-heading"><h2>Chat</h2><span>{[auth?.state === 'authenticated' ? auth.label ? `Signed in: ${auth.label}` : 'Signed in' : auth?.state === 'unauthenticated' ? 'Not signed in' : null, activeConfig && `${activeConfig.agentName} · ${activeConfig.model ?? 'CLI default model'} · ${activeConfig.effort ?? 'CLI default effort'}`].filter(Boolean).join(' · ')}</span><button type="button" onClick={newConversation}>New conversation</button></div>
      <div className="assistant-chat-transcript" aria-live="polite">
        {messages.map(message => message.role === 'tool'
          ? <div className="assistant-chat-tool" key={message.id}>Tool: {message.content}</div>
          : message.role === 'notice'
            ? <div className="assistant-chat-notice" key={message.id}>{message.content}</div>
            : <div className={`assistant-chat-message ${message.role}`} key={message.id} dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />)}
        {stream && <div className="assistant-chat-message agent" dangerouslySetInnerHTML={{ __html: renderMarkdown(stream) }} />}
        {permissions.map(item => <div className="assistant-chat-permission" key={item.requestId}>Permission: {item.toolCall.title}{item.choice ? <span>Answered: {item.choice}</span> : item.options.map(option => <button type="button" key={option.optionId} onClick={() => respond(item.requestId, option)}>{option.name}</button>)}</div>)}
        {proposals.map(proposal => {
          const busy = inFlightProposalId === proposal.id;
          return <div className={`assistant-proposal-card state-${proposal.state}`} key={proposal.id}>
            <div className="assistant-proposal-summary"><strong>{proposal.summary}</strong></div>
            <p className="assistant-proposal-reason">{proposal.reason}</p>
            <p className="assistant-proposal-detail">{describePayload(proposal)}</p>
            {proposal.state === 'pending' && <div className="assistant-proposal-actions">
              <button type="button" disabled={busy || inFlightProposalId !== null} onClick={() => handleProposalDecision(proposal, 'approve')}>Approve</button>
              <button type="button" disabled={busy || inFlightProposalId !== null} onClick={() => handleProposalDecision(proposal, 'decline')}>Decline</button>
              {busy && <span className="assistant-proposal-working" role="status">Working…</span>}
            </div>}
            {proposal.state === 'approved' && <p className="assistant-proposal-outcome">Working…</p>}
            {proposal.state === 'done' && <p className="assistant-proposal-outcome done">Done — {describeDoneResult(proposal)}</p>}
            {proposal.state === 'declined' && <p className="assistant-proposal-outcome muted">Declined</p>}
            {proposal.state === 'expired' && <p className="assistant-proposal-outcome muted">Expired</p>}
            {proposal.state === 'failed' && <div className="assistant-proposal-outcome failed">
              <p>Failed — {proposal.result?.message ?? 'Proposal failed.'}</p>
              {Array.isArray(proposal.result?.reasons) && proposal.result.reasons.length > 0 && <ul>
                {proposal.result.reasons.map((item, idx) => <li key={`${item.code ?? idx}`}>{item.message ?? item.code}</li>)}
              </ul>}
              {Array.isArray(proposal.result?.conflicts) && proposal.result.conflicts.length > 0 && <p>Conflicts: {proposal.result.conflicts.join(', ')}</p>}
            </div>}
          </div>;
        })}
      </div>
      {chatError && <p role="alert" className="assistant-panel-error">{chatError}</p>}
      <p className="assistant-chat-status">{status === 'connecting' ? 'Connecting…' : status === 'running' ? `${activeConfig?.agentName ?? 'The assistant'} is working…` : status === 'ready' ? 'Ready' : 'Connection closed'}</p>
      <div className="assistant-chat-compose">
        <textarea aria-label="Message the assistant" value={input} disabled={status !== 'ready'} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} />
        {status === 'running' ? <button type="button" onClick={() => wsRef.current?.send(JSON.stringify({ type: 'cancel' }))}>Stop</button> : <button type="button" onClick={send} disabled={status !== 'ready' || !input.trim()}>Send</button>}
      </div>
    </section>;
}
