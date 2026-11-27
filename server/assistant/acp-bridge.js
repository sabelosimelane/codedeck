import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAssistantBrief } from './brief.js';
import { validateAssistantSettings } from './assistant-settings-store.js';
import { assistantProfileFor } from './acp-agents.js';
import { isCodedeckAssistantTool } from './codedeck-tools.js';

const require = createRequire(import.meta.url);
const acpSchema = await import(new URL('../schema/zod.gen.js', import.meta.resolve('@agentclientprotocol/sdk')).href);
const DEFAULT_MCP_SERVER_PATH = fileURLToPath(new URL('./mcp-server.js', import.meta.url));
const NOTICE = 'The assistant restarted and does not remember the earlier messages.';
const RESTARTED_BRIEF_NOTICE = 'The assistant restarted and does not remember the earlier messages; it has been briefed again on the current situation.';
const BRIEFED_NOTICE = 'Assistant briefed on the current situation.';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idValid = value => (typeof value === 'string' && value.length > 0) || (Number.isSafeInteger(value) && value >= 0);
const fields = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key));
const errorFrame = message => ({ type: 'error', message });
const UPDATE_TYPES = new Set(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'available_commands_update', 'current_mode_update', 'config_option_update', 'session_info_update', 'usage_update', 'notice', 'compaction_update', 'compaction_summary_chunk']);
const TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);
function validToolCall(value, titleRequired) {
  return plain(value) && typeof value.toolCallId === 'string' && value.toolCallId.length > 0 && (!titleRequired || (typeof value.title === 'string' && value.title.length > 0)) && (value.title === undefined || typeof value.title === 'string') && (value.kind === undefined || TOOL_KINDS.has(value.kind)) && (value.status === undefined || TOOL_STATUSES.has(value.status)) && (value.name === undefined || typeof value.name === 'string') && (value.content === undefined || (Array.isArray(value.content) && value.content.every(item => acpSchema.zToolCallContent.safeParse(item).success))) && (value.locations === undefined || (Array.isArray(value.locations) && value.locations.every(item => acpSchema.zToolCallLocation.safeParse(item).success))) && (value._meta === undefined || plain(value._meta)) && (titleRequired ? acpSchema.zToolCall.safeParse(value).success : acpSchema.zToolCallUpdate.safeParse(value).success);
}

export function adapterCommand() {
  const manifest = require.resolve('@agentclientprotocol/claude-agent-acp/package.json');
  const bin = require(manifest).bin['claude-agent-acp'];
  if (typeof bin !== 'string' || !bin) throw new Error('Claude ACP adapter bin is missing');
  return { command: process.execPath, args: [path.resolve(path.dirname(manifest), bin)] };
}

// A count the result does not carry is said to be unknown, never filled in as 0.
const countOf = (value, label, unknown) => (Number.isSafeInteger(value) ? `${value} ${label}` : unknown);
export function describeProposalDecision(proposal) {
  const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  if (proposal.state === 'declined') return 'declined by the owner';
  if (proposal.state === 'expired') return 'expired when the conversation ended';
  if (proposal.state === 'failed') {
    const msg = oneLine(proposal.result?.message || 'failed');
    const reasons = Array.isArray(proposal.result?.reasons)
      ? proposal.result.reasons.map(r => r?.code).filter(Boolean).join(', ')
      : '';
    return reasons ? `${msg} (${reasons})` : msg;
  }
  const result = proposal.result ?? {};
  if (proposal.kind === 'commit') return oneLine(`committed (${countOf(result.commitsAhead, 'ahead', 'commits ahead unknown')}, ${countOf(result.uncommittedCount, 'uncommitted', 'uncommitted unknown')})`);
  if (proposal.kind === 'merge') return oneLine(typeof result.mergedInto === 'string' && result.mergedInto ? `merged into ${result.mergedInto}` : 'merged');
  if (proposal.kind === 'pull_request') return oneLine(`opened ${result.prUrl ?? 'pull request'}`);
  if (proposal.kind === 'close') return oneLine(result.taskFinished ? 'task closed' : 'worktree closed');
  if (proposal.kind === 'new_task') return oneLine(`created task ${result.id ?? ''} ${result.title ?? ''}`);
  if (proposal.kind === 'start_run') return oneLine(`started run ${result.id ?? ''}`);
  return 'completed';
}

export function handleAssistantConnection(ws, { project, cwd, conversation, store, proposalStore, compose, sessionTokens, assistantUrl, settings, agentStore, mcpServerPath = DEFAULT_MCP_SERVER_PATH, command, args, spawnFn = spawn } = {}) {
  if (typeof project !== 'string' || !project || typeof cwd !== 'string' || !path.isAbsolute(cwd) || conversation?.project !== project || conversation?.state !== 'current' || !store) throw new TypeError('Invalid assistant connection');
  if (compose !== undefined && typeof compose !== 'function') throw new TypeError('Invalid assistant compose function');
  if (typeof settings !== 'function') throw new TypeError('Invalid assistant settings function');
  // An error frame says whether a turn is still running, so the panel keeps a streaming answer
  // through errors raised in the middle of a turn and re-enables Send only after one that ended it.
  let activeTurn = false;
  const send = frame => { if (ws.readyState === 1) ws.send(JSON.stringify(frame.type === 'error' ? { ...frame, turnRunning: activeTurn } : frame)); };
  let selected, agent, profile, selection;
  try {
    selected = validateAssistantSettings(settings(), agentStore);
    if (!selected.agentId) throw new Error('Choose an agent for the assistant in Settings → General');
    agent = agentStore.get(selected.agentId);
    profile = assistantProfileFor(agent);
    selection = profile.selection;
  } catch (error) { send({ type: 'spawn_error', message: error.message }); ws.close(); return null; }
  const adapter = command ? { command, args } : profile.command();
  if (typeof adapter.command !== 'string' || !Array.isArray(adapter.args)) throw new TypeError('Invalid ACP command');
  const env = { ...process.env };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  let child;
  try { child = spawnFn(adapter.command, adapter.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { send({ type: 'spawn_error', message: error.message }); ws.close(); return null; }
  let closed = false; let stderrTail = ''; let buffer = ''; let nextId = 1; let sessionId = null; let turnText = ''; let modeReady = false; let authState = null; let firstPromptBrief = null; let setHeldMode; let started = false; let modeLost = false;
  let issuedToken = null;
  const reportedDecisions = new Set((proposalStore?.listDecided?.(conversation.id) ?? []).map(item => item.id));
  const pending = new Map(); const permissions = new Map(); const toolCalls = new Map();
  const oneLine = value => value.replace(/\s+/g, ' ').trim();
  const saveTool = tool => {
    if (tool.saved) return;
    const title = oneLine(tool.title).slice(0, 100) || 'Tool';
    const command = tool.kind === 'execute' && typeof tool.rawInput?.command === 'string' ? oneLine(tool.rawInput.command).slice(0, 500) : null;
    const content = `${title} — ${tool.status || 'pending'}${command && command !== title ? ` — ${command}` : ''}`;
    store.append(conversation.id, { role: 'tool', content, toolName: title });
    tool.saved = true;
  };
  const flushTools = () => { for (const tool of toolCalls.values()) saveTool(tool); };
  const write = frame => {
    if (closed) return;
    if (child.stdin.destroyed || !child.stdin.writable) { streamError(new Error('ERR_STREAM_DESTROYED')); return; }
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
  };
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { method, resolve, reject }); write({ id, method, params }); });
  const shutdown = () => {
    if (closed) return;
    closed = true;
    if (issuedToken && sessionTokens) {
      sessionTokens.end(issuedToken.token);
      issuedToken = null;
    }
    for (const entry of pending.values()) entry.reject(new Error('ACP process closed'));
    pending.clear(); permissions.clear();
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
      timer.unref?.();
      child.once('exit', () => clearTimeout(timer));
    }
    if (ws.readyState === 1) ws.close();
  };
  const streamError = error => { if (closed) return; send(errorFrame(`ACP stream failed: ${error.message}`)); shutdown(); };
  ws.on('close', shutdown);
  child.on('error', error => { send({ type: 'spawn_error', message: error.message }); shutdown(); });
  child.on('exit', (code, signal) => { if (!closed) { send({ type: 'agent_exit', code, signal, stderrTail }); shutdown(); } });
  child.stdin.on('error', streamError);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('error', streamError); child.stderr.on('error', streamError);
  child.stderr.on('data', chunk => { if (!closed) stderrTail = (stderrTail + chunk).slice(-4096); });
  const handleFrame = frame => {
    if (!plain(frame) || frame.jsonrpc !== '2.0') throw new Error('Invalid ACP JSON-RPC frame.');
    if (frame.id !== undefined && !idValid(frame.id)) throw new Error('Invalid ACP frame id.');
    if (frame.id !== undefined && frame.method === undefined) {
      if ((frame.error !== undefined && (!plain(frame.error) || typeof frame.error.message !== 'string')) || (frame.error === undefined && frame.result === undefined)) throw new Error('Invalid ACP response.');
      const entry = pending.get(frame.id);
      if (!entry) throw new Error('Unknown ACP response id.');
      pending.delete(frame.id);
      // Updates may follow the session/new reply in the same chunk, before the awaiting code runs.
      if (entry.method === 'session/new' && !frame.error && typeof frame.result?.sessionId === 'string' && frame.result.sessionId) sessionId = frame.result.sessionId;
      if (frame.error) entry.reject(new Error(frame.error.message)); else entry.resolve(frame.result);
      return;
    }
    if (frame.id !== undefined && typeof frame.method === 'string') {
      if (frame.method !== 'session/request_permission') { write({ id: frame.id, error: { code: -32601, message: `Unsupported method ${frame.method}` } }); return; }
      const params = frame.params;
      if (!plain(params) || params.sessionId !== sessionId || !validToolCall(params.toolCall, true) || !Array.isArray(params.options) || !params.options.every(option => plain(option) && typeof option.optionId === 'string' && typeof option.name === 'string' && ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind) && (option._meta === undefined || plain(option._meta)) && acpSchema.zPermissionOption.safeParse(option).success)) throw new Error('Invalid ACP permission request.');
      // CodeDeck's own tools are allowed for this call only; anything else is the owner's to answer.
      const once = isCodedeckAssistantTool(params.toolCall) ? params.options.find(option => option.kind === 'allow_once') : undefined;
      if (once) { write({ id: frame.id, result: { outcome: { outcome: 'selected', optionId: once.optionId } } }); return; }
      permissions.set(frame.id, new Set(params.options.map(option => option.optionId)));
      send({ type: 'permission_request', requestId: frame.id, toolCall: params.toolCall, options: params.options });
      return;
    }
    if (frame.id === undefined && frame.method === 'session/update') {
      const params = frame.params; const update = params?.update;
      if (!plain(params) || params.sessionId !== sessionId || !plain(update) || !UPDATE_TYPES.has(update.sessionUpdate) || !acpSchema.zSessionUpdate.safeParse(update).success) throw new Error('Invalid ACP session update.');
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (!plain(update.content) || update.content.type !== 'text' || typeof update.content.text !== 'string') throw new Error('Invalid ACP agent message chunk.');
        turnText += update.content.text;
      } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        if (!validToolCall(update, update.sessionUpdate === 'tool_call')) throw new Error('Invalid ACP tool call.');
        const tool = toolCalls.get(update.toolCallId) || { title: 'Tool', kind: null, rawInput: null, status: null, saved: false };
        if (update.title !== undefined) tool.title = update.title;
        if (update.kind !== undefined) tool.kind = update.kind;
        if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
        if (update.status !== undefined) tool.status = update.status;
        toolCalls.set(update.toolCallId, tool);
        if (tool.status === 'completed' || tool.status === 'failed') saveTool(tool);
      } else if ((update.sessionUpdate === 'current_mode_update' && update.currentModeId !== profile.heldMode.id) || (update.sessionUpdate === 'config_option_update' && update.configOptions?.some(option => option?.id === 'mode' && option.currentValue !== profile.heldMode.id))) {
        // Either report counts for every profile: an agent may say it changed mode in either way.
        modeReady = false;
        if (!started) { modeLost = true; send({ type: 'update', update }); return; }
        send(errorFrame(`${profile.label} changed mode; restoring ${profile.heldMode.id}.`));
        setHeldMode().then(() => { modeReady = true; }).catch(error => { if (!closed) { send(errorFrame(`Could not restore ${profile.heldMode.id}: ${error.message}`)); shutdown(); } });
      }
      send({ type: 'update', update });
      return;
    }
    if (frame.id === undefined && frame.method === 'auth/status_update') {
      const params = frame.params;
      if (!plain(params) || !['authenticated', 'unauthenticated'].includes(params.state) || (params.accounts !== undefined && (!Array.isArray(params.accounts) || !params.accounts.every(account => plain(account) && typeof account.label === 'string' && typeof account.active === 'boolean')))) throw new Error('Invalid ACP auth status update.');
      authState = params.state;
      const label = params.state === 'authenticated' ? (params.accounts?.find(account => account.active)?.label ?? null) : null;
      send({ type: 'auth', state: authState, label });
      return;
    }
    if (frame.id === undefined && typeof frame.method === 'string' && frame.method.startsWith('_')) return;
    throw new Error(`Unknown ACP method ${String(frame.method)}.`);
  };
  child.stdout.on('data', chunk => {
    if (closed) return;
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) { send(errorFrame('The ACP adapter sent an empty frame.')); continue; }
      let frame;
      try { frame = JSON.parse(line); }
      catch { send(errorFrame('The ACP adapter sent invalid JSON.')); continue; }
      try {
        handleFrame(frame);
      } catch (error) {
        send(errorFrame(error.message));
        if (/ended/.test(error.message)) { shutdown(); return; }
        // A refused request is answered, or the adapter would wait for it forever.
        if (plain(frame) && idValid(frame.id) && typeof frame.method === 'string') write({ id: frame.id, error: { code: -32602, message: error.message } });
        continue;
      }
    }
  });
  // Adapter dist/serve.js negotiates v1 for protocolVersion 1. The shapes below
  // match SDK dist/v1/schema/zod.gen.js (initialize, new, prompt, permission).
  (async () => {
    let failurePrefix = `The assistant could not start ${profile.label}`;
    try {
      await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (closed) return;
      let systemPrompt;
      let briefed = false;
      if (compose) {
        failurePrefix = 'The assistant could not read the project situation';
        const situation = await compose(project);
        if (closed) return;
        const briefText = buildAssistantBrief(situation?.markdown);
        if (profile.briefDelivery === 'system_prompt') systemPrompt = { mode: 'append', content: [{ type: 'text', text: briefText }] };
        else firstPromptBrief = briefText;
        briefed = true;
      }
      const mcpServers = [];
      if (sessionTokens && typeof assistantUrl === 'string' && assistantUrl) {
        issuedToken = sessionTokens.issue({ project, conversationId: conversation.id });
        mcpServers.push({
          name: 'codedeck',
          command: process.execPath,
          args: [mcpServerPath],
          env: [
            { name: 'CODEDECK_ASSISTANT_URL', value: assistantUrl },
            { name: 'CODEDECK_ASSISTANT_TOKEN', value: issuedToken.token },
          ],
        });
      }
      const sessionParams = { cwd, mcpServers, ...(systemPrompt ? { systemPrompt } : {}) };
      failurePrefix = `The assistant could not start ${profile.label}`;
      const session = await request('session/new', sessionParams);
      if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error('Invalid ACP session id');
      sessionId = session.sessionId;
      failurePrefix = `The assistant could not switch ${profile.label} to ${profile.heldMode.id}`;
      if (profile.heldMode.via === 'set_mode' && (!plain(session.modes) || !Array.isArray(session.modes.availableModes) || !session.modes.availableModes.some(mode => mode?.id === profile.heldMode.id))) throw new Error(`${profile.label} did not offer ${profile.heldMode.id} mode`);
      let configOptions = session.configOptions;
      if (configOptions !== undefined && !Array.isArray(configOptions)) throw new Error('Invalid ACP configOptions');
      const choices = option => option.options.flatMap(item => Array.isArray(item.options) ? item.options : [item]);
      const active = id => {
        if (configOptions === undefined) return null;
        const option = configOptions.find(item => item?.id === id);
        if (!option) return null;
        if (option.type !== 'select' || typeof option.currentValue !== 'string' || !Array.isArray(option.options) || !acpSchema.zSessionConfigOption.safeParse(option).success || !option.options.every(item => item?.options === undefined || (typeof item.group === 'string' && typeof item.name === 'string' && Array.isArray(item.options))) || !choices(option).every(item => typeof item?.value === 'string' && typeof item.name === 'string')) throw new Error(`Invalid ACP ${id} config option`);
        return option;
      };
      const setOption = async (id, value) => {
        const option = active(id);
        const offered = option ? choices(option).map(item => item.value) : [];
        if (!option || !offered.includes(value)) throw new Error(`${profile.label} did not offer ${id} "${value}"; offered: ${offered.length ? offered.join(', ') : 'none'}`);
        const result = await request('session/set_config_option', { sessionId, configId: id, value });
        if (!plain(result) || !Array.isArray(result.configOptions) || !acpSchema.zSetSessionConfigOptionResponse.safeParse(result).success) throw new Error('Invalid set_config_option response');
        configOptions = result.configOptions;
        if (active(id)?.currentValue !== value) throw new Error(`${profile.label} did not confirm ${id} "${value}"`);
      };
      setHeldMode = async () => {
        if (profile.heldMode.via === 'config_option') return setOption('mode', profile.heldMode.id);
        const result = await request('session/set_mode', { sessionId, modeId: profile.heldMode.id });
        if (!acpSchema.zSetSessionModeResponse.safeParse(result).success) throw new Error('Invalid set_mode response');
      };
      await setHeldMode();
      modeLost = false;
      for (const [id, value] of [[profile.modelOption, selection.model || null], [profile.effortOption, selected.effort]]) {
        if (value === null) continue;
        failurePrefix = `The assistant could not use ${id} "${value}"`;
        await setOption(id, value);
      }
      // Setting a model or effort can move an agent out of its mode, so the mode is checked again.
      failurePrefix = `The assistant could not keep ${profile.label} in its ${profile.heldMode.id} mode`;
      const modeOption = configOptions?.find(option => option?.id === 'mode');
      if (profile.heldMode.via === 'config_option' && !modeOption) throw new Error(`${profile.label} no longer reports its mode`);
      if (modeLost || (modeOption && modeOption.currentValue !== profile.heldMode.id)) throw new Error(`${profile.label} left its ${profile.heldMode.id} mode after its model or effort was set`);
      started = true;
      modeReady = true;
      failurePrefix = `The assistant could not start ${profile.label}`;
      const restarted = store.hasMessages(conversation.id);
      send({ type: 'ready', conversationId: conversation.id, restarted, agentId: agent.id, agentName: agent.name, provider: profile.id, model: active(profile.modelOption)?.currentValue ?? null, effort: profile.effortOption ? active(profile.effortOption)?.currentValue ?? null : null, mode: profile.heldMode.id });
      if (restarted) {
        const notice = store.append(conversation.id, { role: 'notice', content: briefed ? RESTARTED_BRIEF_NOTICE : NOTICE });
        send({ type: 'message', message: notice });
      } else if (briefed) {
        const notice = store.append(conversation.id, { role: 'notice', content: BRIEFED_NOTICE });
        send({ type: 'message', message: notice });
      }
    } catch (error) { if (!closed) { send({ type: 'spawn_error', message: `${failurePrefix}: ${error.message}` }); shutdown(); } }
  })();
  ws.on('message', raw => {
    if (closed) return;
    let frame; try { frame = JSON.parse(raw.toString()); } catch { send({ type: 'error', message: 'Invalid JSON message.' }); return; }
    if (!plain(frame) || typeof frame.type !== 'string') { send(errorFrame('Invalid browser frame.')); return; }
    const allowed = { prompt: ['type', 'text'], cancel: ['type'], permission_response: ['type', 'requestId', 'outcome'] };
    if (!allowed[frame.type] || !fields(frame, allowed[frame.type])) { send(errorFrame('Unknown or invalid browser frame fields.')); return; }
    if (frame.type === 'prompt') {
      if (!sessionId || !modeReady) { send({ type: 'error', message: `Assistant is not ready in ${profile.heldMode.id} mode.` }); return; }
      if (activeTurn) { send({ type: 'error', message: 'A turn is already running.' }); return; }
      if (typeof frame.text !== 'string' || frame.text.length < 1 || frame.text.length > 20000) { send({ type: 'error', message: 'Prompt text must be 1–20000 characters.' }); return; }
      let saved; try { saved = store.append(conversation.id, { role: 'owner', content: frame.text }); } catch (error) { send({ type: 'error', message: error.message }); return; }
      send({ type: 'message', message: saved });
      let promptText = frame.text;
      if (firstPromptBrief !== null) { promptText = `${firstPromptBrief}\n\n${promptText}`; firstPromptBrief = null; }
      if (proposalStore && typeof proposalStore.listDecided === 'function') {
        const newlyDecided = proposalStore.listDecided(conversation.id).filter(item => !reportedDecisions.has(item.id));
        if (newlyDecided.length) {
          const lines = newlyDecided.map(item => `[CodeDeck] Proposal ${item.id} (${item.kind}): ${item.state} — ${describeProposalDecision(item)}`);
          for (const item of newlyDecided) reportedDecisions.add(item.id);
          promptText = `${lines.join('\n')}\n\n${frame.text}`;
        }
      }
      activeTurn = true; turnText = ''; toolCalls.clear();
      request('session/prompt', { sessionId, prompt: [{ type: 'text', text: promptText }] }).then(result => {
        if (typeof result?.stopReason !== 'string') throw new Error('ACP turn ended without stopReason');
        flushTools();
        const saved = turnText ? store.append(conversation.id, { role: 'agent', content: turnText }) : null;
        activeTurn = false; turnText = '';
        send({ type: 'turn_end', messageId: saved?.id ?? null });
      }).catch(error => { if (closed) return; try { flushTools(); } catch (failure) { send(errorFrame(failure.message)); shutdown(); return; } activeTurn = false; turnText = ''; send({ type: 'turn_end', messageId: null }); send({ type: 'error', message: authState === 'unauthenticated' || error.message === 'Authentication required' ? `${profile.label} is not signed in on this machine. Sign in, then send again.` : error.message }); });
    } else if (frame.type === 'cancel') {
      if (!activeTurn) { send(errorFrame('No turn is running.')); return; }
      write({ method: 'session/cancel', params: { sessionId } });
      // ACP: a cancelled turn's open permission requests are answered with the cancelled outcome.
      for (const requestId of permissions.keys()) write({ id: requestId, result: { outcome: { outcome: 'cancelled' } } });
      permissions.clear();
    } else if (frame.type === 'permission_response') {
      if (!idValid(frame.requestId) || !permissions.has(frame.requestId)) { send({ type: 'error', message: 'Unknown permission requestId.' }); return; }
      if (!fields(frame.outcome, frame.outcome?.outcome === 'selected' ? ['outcome', 'optionId'] : ['outcome']) || !['selected', 'cancelled'].includes(frame.outcome.outcome) || (frame.outcome.outcome === 'selected' && !permissions.get(frame.requestId).has(frame.outcome.optionId))) { send({ type: 'error', message: 'Invalid permission outcome.' }); return; }
      permissions.delete(frame.requestId); write({ id: frame.requestId, result: { outcome: frame.outcome } });
    } else send({ type: 'error', message: 'Unknown message type.' });
  });
  return {
    child,
    close: shutdown,
    pushProposal: proposal => { if (!closed) send({ type: 'proposal', proposal }); },
    pushSituation: flags => { if (!closed) send({ type: 'situation', flags }); },
  };
}
