import readline from 'node:readline';

const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const lines = readline.createInterface({ input: process.stdin });
let permissionId = 90;
let mode = 'auto';
let modeSets = 0;
let sessionNewParams = null;
const scenario = process.argv[2];
const update = value => send({ method: 'session/update', params: { sessionId: 'fake-session', update: value } });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') { if (message.params?.protocolVersion !== 1 || message.params.clientCapabilities?.terminal !== false) throw new Error('Invalid ACP initialize'); send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }); return; }
  if (message.method === 'session/new') { if (!Array.isArray(message.params?.mcpServers) || typeof message.params.cwd !== 'string') throw new Error('Invalid ACP session/new'); sessionNewParams = message.params; send({ id: message.id, result: { sessionId: 'fake-session', ...(scenario === 'missing-modes' ? {} : { modes: { currentModeId: mode, availableModes: scenario === 'no-default' ? [{ id: 'auto', name: 'Auto' }] : [{ id: 'default', name: 'Manual', description: 'Always ask before making changes' }, { id: 'auto', name: 'Auto' }] } }) } }); return; }
  if (message.method === 'session/set_mode') { if (message.params?.sessionId !== 'fake-session' || message.params.modeId !== 'default') throw new Error('Invalid ACP session/set_mode'); modeSets += 1; if (scenario === 'set-mode-error') send({ id: message.id, error: { code: -32000, message: 'mode refused' } }); else { const done = () => { mode = 'default'; send({ id: message.id, result: {} }); }; if (scenario === 'slow-restore' && modeSets > 1) setTimeout(done, 60); else done(); } return; }
  if (message.method === 'session/prompt') {
    const text = message.params.prompt[0].text;
    if (mode !== 'default') throw new Error('Prompt in unsafe mode');
    if (text === 'inspect-session') {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(sessionNewParams) } });
      send({ id: message.id, result: { stopReason: 'end_turn' } }); return;
    }
    if (text.includes('echo-prompt')) {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      send({ id: message.id, result: { stopReason: 'end_turn' } }); return;
    }
    if (text === 'mode-flip') { mode = 'auto'; update({ sessionUpdate: 'current_mode_update', currentModeId: 'auto' }); send({ id: message.id, result: { stopReason: 'end_turn' } }); return; }
    if (text === 'auth-error') { send({ method: 'auth/status_update', params: { state: 'unauthenticated' } }); send({ id: message.id, error: { code: -32000, message: 'Authentication required' } }); return; }
    if (text === 'real-frames') {
      send({ method: '_auth/status_update', params: { authStatus: { kind: 'account', label: 'Claude Ultra' } } });
      send({ method: 'auth/status_update', params: { state: 'authenticated', accounts: [{ label: 'Claude Ultra', active: true }] } });
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'deep-research', description: 'Research', input: null }] });
      update({ sessionUpdate: 'session_info_update', title: 'Uncommitted files', updatedAt: '2026-11-25T22:18:56.961Z' });
      update({ sessionUpdate: 'usage_update', used: 36919, size: 1000000 });
      update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_017', name: 'Bash', rawInput: {}, status: 'pending', title: 'Terminal', kind: 'execute', content: [] });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_017', rawInput: { command: 'git status --short' }, title: 'git status --short' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_017', status: 'completed', rawOutput: '?? notes.txt' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' }, messageId: 'msg_011' });
      send({ id: message.id, result: { stopReason: 'end_turn' } }); return;
    }
    if (text === 'delayed') { setTimeout(() => send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call', toolCallId: 'late', title: 'Late tool', kind: 'read', status: 'completed' } } }), 30); return; }
    if (text === 'unicode') {
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Sawubona 👋 ünïcödé' } } } }) + '\n');
      const split = bytes.indexOf(Buffer.from('👋')) + 2;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => { process.stdout.write(bytes.subarray(split)); send({ id: message.id, result: { stopReason: 'end_turn' } }); }, 10);
      return;
    }
    if (text === 'empty') { send({ id: message.id, result: { stopReason: 'end_turn' } }); return; }
    if (text === 'duplicate') {
      const update = { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call', toolCallId: 'same', title: 'Read file', kind: 'read', status: 'completed' } };
      send({ method: 'session/update', params: update }); send({ method: 'session/update', params: update });
      send({ id: message.id, result: { stopReason: 'end_turn' } }); return;
    }
    if (text === 'unsupported') { send({ id: 95, method: 'fs/read_text_file', params: {} }); return; }
    if (text === 'exit') { process.stderr.write('fake exit'); process.exit(7); }
    if (text === 'permission') {
      send({ id: permissionId, method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { toolCallId: 'c1', title: 'Edit file' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] } });
      return;
    }
    send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read file', kind: 'read', status: 'completed' } } });
    send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } });
    send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'owner' } } } });
    send({ id: message.id, result: { stopReason: 'end_turn' } });
  }
  if (message.id === permissionId && message.result) {
    send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(message.result.outcome) } } } });
  }
  if (message.id === 95 && message.error) send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(message.error.code) } } } });
  if (message.method === 'session/cancel') send({ method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cancelled' } } } });
});
