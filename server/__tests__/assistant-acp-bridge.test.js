import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createConversationStore } from '../assistant/conversation-store.js';
import { createProposalStore } from '../assistant/proposal-store.js';
import { createSessionTokens } from '../assistant/session-tokens.js';
import { adapterCommand, describeProposalDecision, handleAssistantConnection } from '../assistant/acp-bridge.js';
import { buildLaunchCommand } from '../../shared/agent-presets.mjs';

const fixture = fileURLToPath(new URL('./fixtures/assistant-fake-acp-agent.js', import.meta.url));
const dbs = []; const sockets = [];
afterEach(() => { sockets.splice(0).forEach(ws => ws.close()); dbs.splice(0).forEach(db => db.close()); });
class Socket extends EventEmitter {
  readyState = 1; sent = []; close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
  send(value) { this.sent.push(JSON.parse(value)); this.emit('sent'); }
  receive(value) { this.emit('message', JSON.stringify(value)); }
}
function waitFor(ws, type) { const existing = ws.sent.find(frame => frame.type === type); if (existing) return Promise.resolve(existing); return new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(`No ${type}: ${JSON.stringify(ws.sent)}`)), 3000); ws.on('sent', function onSent() { const frame = ws.sent.find(item => item.type === type); if (frame) { clearTimeout(timeout); ws.off('sent', onSent); resolve(frame); } }); }); }
function setup(options = {}) {
  const db = new Database(':memory:'); dbs.push(db); const store = createConversationStore(db);
  const ws = new Socket(); sockets.push(ws); const conversation = store.current('Demo');
  const provider = options.provider ?? 'claude';
  const agents = { get: id => id === provider ? { id, name: `${provider} agent`, launchCommand: buildLaunchCommand({ provider, model: options.model ?? '', effort: '', skipPermissions: false }).command } : null };
  const { provider: _provider, model: _model, ...connection } = options;
  return { db, store, ws, conversation, connect: () => handleAssistantConnection(ws, { project: 'Demo', cwd: process.cwd(), conversation, store, settings: () => ({ agentId: provider, effort: null }), agentStore: agents, command: process.execPath, args: [fixture], ...connection }) };
}
describe('ACP bridge with a provider whose mode is a config option (OpenCode)', () => {
  const inspect = async ws => { ws.sent.length = 0; ws.receive({ type: 'prompt', text: 'inspect-config' }); await waitFor(ws, 'turn_end'); return ws.sent.find(frame => frame.type === 'update' && frame.update.content?.type === 'text').update.content.text; };
  it('holds plan through set_config_option, never set_mode, and reports it on ready', async () => {
    const { ws, connect } = setup({ provider: 'opencode', args: [fixture, 'opencode'] }); connect();
    expect(await waitFor(ws, 'ready')).toMatchObject({ provider: 'opencode', mode: 'plan', agentId: 'opencode' });
    expect(await inspect(ws)).toContain('"configSets":[["mode","plan"]]');
  });
  it('sends the brief with the first prompt only, not as a systemPrompt', async () => {
    const compose = async () => ({ markdown: '# Situation\nPhase 2 has 4 of 6 tasks done.' });
    const { ws, connect } = setup({ provider: 'opencode', args: [fixture, 'opencode'], compose }); connect();
    await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'inspect-session' }); await waitFor(ws, 'turn_end');
    const first = ws.sent.filter(frame => frame.type === 'update' && frame.update.content?.type === 'text').at(-1).update.content.text;
    expect(first).not.toContain('systemPrompt');
    ws.sent.length = 0;
    ws.receive({ type: 'prompt', text: 'echo-prompt again' }); await waitFor(ws, 'turn_end');
    const second = ws.sent.find(frame => frame.type === 'update' && frame.update.content?.type === 'text').update.content.text;
    expect(second).toBe('echo-prompt again');
  });
  it('puts the brief before the owner text of the first prompt', async () => {
    const compose = async () => ({ markdown: '# Situation\nPhase 2 has 4 of 6 tasks done.' });
    const { ws, connect } = setup({ provider: 'opencode', args: [fixture, 'opencode'], compose }); connect();
    await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'echo-prompt first' }); await waitFor(ws, 'turn_end');
    const text = ws.sent.find(frame => frame.type === 'update' && frame.update.content?.type === 'text').update.content.text;
    expect(text).toContain('Phase 2 has 4 of 6 tasks done.');
    expect(text.endsWith('echo-prompt first')).toBe(true);
  });
  it('restores plan when a config_option_update reports another mode', async () => {
    const { ws, connect } = setup({ provider: 'opencode', args: [fixture, 'opencode'] }); connect();
    await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'mode-flip-config' }); await waitFor(ws, 'turn_end');
    expect(ws.sent).toContainEqual(expect.objectContaining({ type: 'error', message: 'OpenCode changed mode; restoring plan.' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await inspect(ws)).toContain('"configSets":[["mode","plan"],["mode","plan"]]');
  });
});
describe('ACP bridge keeps the held mode however it is changed', () => {
  it('fails closed when setting the model moves the agent out of its held mode', async () => {
    const { ws, connect } = setup({ provider: 'opencode', model: 'sonnet', args: [fixture, 'opencode-model-resets-mode'] }); connect();
    expect(await waitFor(ws, 'spawn_error')).toMatchObject({ message: expect.stringContaining('left its plan mode') });
    expect(ws.sent.some(frame => frame.type === 'ready')).toBe(false);
  });
  it('restores the held mode when a set_mode agent reports a mode change as a config option', async () => {
    const { ws, connect } = setup(); connect();
    await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'mode-flip-config-option' }); await waitFor(ws, 'turn_end');
    expect(ws.sent).toContainEqual(expect.objectContaining({ type: 'error', message: 'Claude Code changed mode; restoring default.' }));
  });
});
describe('ACP bridge without a usable agent', () => {
  it('refuses to start when no agent is chosen', async () => {
    const { ws, connect } = setup({ settings: () => ({ agentId: '', effort: null }) }); connect();
    expect(await waitFor(ws, 'spawn_error')).toMatchObject({ message: 'Choose an agent for the assistant in Settings → General' });
  });
  it('names the reason when the chosen agent no longer exists', async () => {
    const { ws, connect } = setup({ settings: () => ({ agentId: 'gone', effort: null }) }); connect();
    expect(await waitFor(ws, 'spawn_error')).toMatchObject({ message: expect.stringContaining('Saved agent does not exist') });
  });
});
describe('ACP bridge with fake stdio agent', () => {
  it('does not set config for defaults and reports the active defaults', async () => {
    const { ws, connect } = setup(); connect();
    expect(await waitFor(ws, 'ready')).toMatchObject({ model: 'default', effort: 'default' });
    ws.receive({ type: 'prompt', text: 'inspect-config' });
    await waitFor(ws, 'turn_end');
    expect(ws.sent.find(frame => frame.type === 'update' && frame.update.content?.type === 'text').update.content.text).toContain('"configSets":[]');
  });
  it('sets model before effort and reports confirmed active values', async () => {
    const { ws, connect } = setup({ model: 'opus', settings: () => ({ agentId: 'claude', effort: 'high' }) }); connect();
    expect(await waitFor(ws, 'ready')).toMatchObject({ model: 'opus', effort: 'high' });
    ws.receive({ type: 'prompt', text: 'inspect-config' }); await waitFor(ws, 'turn_end');
    expect(ws.sent.find(frame => frame.type === 'update' && frame.update.content?.type === 'text').update.content.text).toContain('"configSets":[["model","opus"],["effort","high"]]');
  });
  it('accepts grouped options and rechecks effort after changing model', async () => {
    const grouped = setup({ model: 'opus', args: [fixture, 'grouped-options'], settings: () => ({ agentId: 'claude', effort: 'high' }) }); grouped.connect();
    expect(await waitFor(grouped.ws, 'ready')).toMatchObject({ model: 'opus', effort: 'high' });
    const unavailable = setup({ model: 'opus', args: [fixture, 'effort-missing-after-model'], settings: () => ({ agentId: 'claude', effort: 'high' }) }); unavailable.connect();
    expect(await waitFor(unavailable.ws, 'spawn_error')).toMatchObject({ message: expect.stringContaining('effort "high"') });
    expect(unavailable.ws.readyState).toBe(3);
  });
  it('refuses prompts until the selected config is confirmed', async () => {
    const { ws, connect } = setup({ model: 'opus', args: [fixture, 'slow-config'] }); connect();
    await new Promise(resolve => setTimeout(resolve, 60));
    ws.receive({ type: 'prompt', text: 'empty' });
    expect(await waitFor(ws, 'error')).toMatchObject({ message: expect.stringContaining('not ready') });
    await waitFor(ws, 'ready');
  });
  it.each([['missing-model', 'opus'], ['missing-opus', 'opus']])('fails closed when model is unavailable: %s', async (scenario, model) => {
    const { ws, connect } = setup({ model, args: [fixture, scenario] }); connect();
    expect(await waitFor(ws, 'spawn_error')).toMatchObject({ message: expect.stringContaining(`model "${model}"`) });
    expect(ws.readyState).toBe(3);
  });
  it('fails closed for malformed config reply', async () => {
    const { ws, connect } = setup({ model: 'opus', args: [fixture, 'bad-config-reply'] }); connect();
    expect(await waitFor(ws, 'spawn_error')).toMatchObject({ message: expect.stringContaining('model') });
    expect(ws.readyState).toBe(3);
  });
  it('switches an auto session to default before ready and before prompts', async () => {
    const { ws, connect } = setup(); connect();
    await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'empty' });
    expect(await waitFor(ws, 'turn_end')).toMatchObject({ messageId: null });
  });
  it.each(['missing-modes', 'no-default', 'set-mode-error'])('fails closed when safe mode is unavailable: %s', async scenario => {
    const { ws, connect } = setup({ args: [fixture, scenario] }); connect();
    expect(await waitFor(ws, 'spawn_error')).toMatchObject({ message: expect.stringContaining('default') });
    expect(ws.sent.some(frame => frame.type === 'ready')).toBe(false);
    expect(ws.readyState).toBe(3);
  });
  it('reverts an unsafe mode update and refuses prompts until default succeeds', async () => {
    const { ws, connect } = setup({ args: [fixture, 'slow-restore'] }); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'mode-flip' });
    expect(await waitFor(ws, 'error')).toMatchObject({ message: expect.stringContaining('mode') });
    await waitFor(ws, 'turn_end');
    ws.receive({ type: 'prompt', text: 'empty' });
    expect(ws.sent.filter(frame => frame.type === 'message' && frame.message.role === 'owner')).toHaveLength(1);
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('not ready') });
    await new Promise(resolve => setTimeout(resolve, 80));
    ws.sent.length = 0;
    ws.receive({ type: 'prompt', text: 'empty' });
    expect(await waitFor(ws, 'turn_end')).toMatchObject({ messageId: null });
  });
  it('forwards real v1 updates, auth state, and stores the final tool title and command once', async () => {
    const { ws, store, conversation, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'real-frames' }); await waitFor(ws, 'turn_end');
    for (const kind of ['available_commands_update', 'session_info_update', 'usage_update', 'tool_call', 'tool_call_update', 'agent_message_chunk']) expect(ws.sent.some(frame => frame.type === 'update' && frame.update.sessionUpdate === kind)).toBe(true);
    expect(ws.sent).toContainEqual({ type: 'auth', state: 'authenticated', label: 'Claude Ultra' });
    expect(ws.sent.filter(frame => frame.type === 'error')).toHaveLength(0);
    expect(store.messages(conversation.id).data.filter(item => item.role === 'tool')).toEqual([expect.objectContaining({ toolName: 'git status --short', content: expect.stringContaining('completed') })]);
    expect(store.messages(conversation.id).data.at(-1).content).toBe('Done');
  });
  it('reports unauthenticated prompt errors and ends the turn', async () => {
    const { ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'auth-error' });
    expect(await waitFor(ws, 'turn_end')).toEqual({ type: 'turn_end', messageId: null });
    expect(ws.sent).toContainEqual({ type: 'auth', state: 'unauthenticated', label: null });
    expect(ws.sent).toContainEqual({ type: 'error', message: 'Claude Code is not signed in on this machine. Sign in, then send again.', turnRunning: false });
  });
  it('handshakes, stores the owner before prompt, and combines chunks into one turn', async () => {
    const { store, ws, conversation, connect } = setup(); connect();
    expect(await waitFor(ws, 'ready')).toMatchObject({ conversationId: conversation.id, restarted: false });
    ws.receive({ type: 'prompt', text: 'hello' });
    expect(store.messages(conversation.id).data[0]).toMatchObject({ role: 'owner', content: 'hello' });
    expect(await waitFor(ws, 'turn_end')).toMatchObject({ messageId: expect.any(Number) });
    expect(store.messages(conversation.id).data.map(m => m.role)).toEqual(['owner', 'tool', 'agent']);
    expect(store.messages(conversation.id).data[2].content).toBe('Hello owner');
  });
  it('forwards a permission response unchanged and rejects unknown ids', async () => {
    const { ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'permission' });
    const requested = await waitFor(ws, 'permission_request');
    expect(requested).toMatchObject({ requestId: 90, toolCall: { title: 'Edit file' } });
    ws.receive({ type: 'permission_response', requestId: 91, outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(await waitFor(ws, 'error')).toMatchObject({ type: 'error' });
    ws.receive({ type: 'permission_response', requestId: 90, outcome: { outcome: 'selected', optionId: 'reject' } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(ws.sent.some(frame => frame.update?.content?.text === '{"outcome":"selected","optionId":"reject"}')).toBe(true);
  });
  it('allows a CodeDeck tool of its own once without asking the owner', async () => {
    const { ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'codedeck-permission' });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(ws.sent.some(frame => frame.type === 'permission_request')).toBe(false);
    expect(ws.sent.some(frame => frame.update?.content?.text === '{"outcome":"selected","optionId":"once"}')).toBe(true);
  });
  it.each([
    ['a tool CodeDeck does not offer', 'lookalike-permission'],
    ['a CodeDeck name only in the title the model controls', 'title-only-permission'],
    ['a server named codedeck from project configuration', 'project-server-permission'],
  ])('still asks the owner about %s', async (_case, text) => {
    const { ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text });
    expect(await waitFor(ws, 'permission_request')).toMatchObject({ requestId: 90 });
  });
  it('announces a restart when the transcript exists', async () => {
    const { store, ws, conversation, connect } = setup(); store.append(conversation.id, { role: 'owner', content: 'old' }); connect();
    expect(await waitFor(ws, 'ready')).toMatchObject({ restarted: true });
    expect(store.messages(conversation.id).data.at(-1)).toMatchObject({ role: 'notice', content: expect.stringContaining('does not remember') });
  });
  it('reports spawn errors and exits, and strips Claude session markers', async () => {
    const bad = setup({ command: '/not/a/command', args: [] }); bad.connect(); expect(await waitFor(bad.ws, 'spawn_error')).toMatchObject({ message: expect.any(String) });
    const good = setup(); good.connect(); await waitFor(good.ws, 'ready'); good.ws.receive({ type: 'prompt', text: 'exit' });
    expect(await waitFor(good.ws, 'agent_exit')).toMatchObject({ code: 7, stderrTail: 'fake exit' });
  });
  it('resolves the pinned adapter bin and removes Claude session markers from the child environment', async () => {
    const resolved = adapterCommand();
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args[0]).toMatch(/claude-agent-acp\/dist\/index\.js$/);
    const previous = [process.env.CLAUDECODE, process.env.CLAUDE_CODE_ENTRYPOINT];
    process.env.CLAUDECODE = 'parent'; process.env.CLAUDE_CODE_ENTRYPOINT = 'parent';
    try {
      let childEnv;
      const fixtureRun = setup({ spawnFn: (command, args, options) => { childEnv = options.env; return spawn(command, args, options); } });
      fixtureRun.connect(); await waitFor(fixtureRun.ws, 'ready');
      expect(childEnv).not.toHaveProperty('CLAUDECODE');
      expect(childEnv).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    } finally {
      if (previous[0] === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = previous[0];
      if (previous[1] === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = previous[1];
    }
  });
  it('does not crash when a tool update arrives after New conversation ends the old one', async () => {
    const { store, ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'delayed' });
    store.startNew('Demo');
    expect(await waitFor(ws, 'error')).toMatchObject({ message: expect.stringContaining('ended') });
    expect(ws.readyState).toBe(3);
  });
  it('ends an empty turn without an agent message and stores a repeated tool call only once', async () => {
    const { store, ws, conversation, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'empty' });
    expect(await waitFor(ws, 'turn_end')).toMatchObject({ messageId: null });
    ws.sent.length = 0;
    ws.receive({ type: 'prompt', text: 'duplicate' });
    await waitFor(ws, 'turn_end');
    expect(store.messages(conversation.id).data.filter(item => item.role === 'tool')).toHaveLength(1);
    expect(store.messages(conversation.id).data.filter(item => item.role === 'agent')).toHaveLength(0);
  });
  it('rejects invalid prompts, forwards cancel, and denies unknown agent methods', async () => {
    const { ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: '' });
    expect(await waitFor(ws, 'error')).toMatchObject({ message: expect.stringContaining('1–20000') });
    ws.receive({ type: 'prompt', text: 'unsupported' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(ws.sent.some(frame => frame.update?.content?.text === '-32601')).toBe(true);
    ws.receive({ type: 'cancel' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(ws.sent.some(frame => frame.update?.content?.text === 'cancelled')).toBe(true);
  });
  it('rejects malformed browser frames without losing the socket', async () => {
    const { ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive(null); ws.receive('x');
    expect(ws.sent.filter(frame => frame.type === 'error')).toHaveLength(2);
    expect(ws.readyState).toBe(1);
    ws.receive({ type: 'prompt', text: 'empty' });
    expect(await waitFor(ws, 'turn_end')).toMatchObject({ messageId: null });
  });
  it('closes cleanly when child stdin fails', async () => {
    const { ws, connect } = setup(); const bridge = connect(); await waitFor(ws, 'ready');
    bridge.child.stdin.destroy();
    bridge.child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    ws.receive({ type: 'prompt', text: 'hello' });
    expect(ws.sent.filter(frame => frame.type === 'error')).toHaveLength(1);
    expect(ws.readyState).toBe(3);
  });
  it.each(['prompt', 'cancel', 'permission_response'])('handles destroyed child stdin while sending %s', async type => {
    const { ws, connect } = setup(); const bridge = connect(); await waitFor(ws, 'ready');
    if (type === 'cancel') ws.receive({ type: 'prompt', text: 'delayed' });
    if (type === 'permission_response') { ws.receive({ type: 'prompt', text: 'permission' }); await waitFor(ws, 'permission_request'); }
    bridge.child.stdin.destroy();
    if (type === 'prompt') ws.receive({ type: 'prompt', text: 'hello' });
    if (type === 'cancel') ws.receive({ type: 'cancel' });
    if (type === 'permission_response') ws.receive({ type: 'permission_response', requestId: 90, outcome: { outcome: 'cancelled' } });
    expect(await waitFor(ws, 'error')).toMatchObject({ message: expect.stringContaining('ACP stream failed') });
    expect(ws.sent.filter(frame => frame.type === 'error')).toHaveLength(1);
    expect(ws.readyState).toBe(3);
  });
  it('preserves a UTF-8 reply split inside a character', async () => {
    const { ws, store, conversation, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'unicode' }); await waitFor(ws, 'turn_end');
    expect(store.messages(conversation.id).data.at(-1).content).toBe('Sawubona 👋 ünïcödé');
  });
  it('ignores late adapter output after close', async () => {
    const { ws, store, conversation, connect } = setup(); const bridge = connect(); await waitFor(ws, 'ready');
    bridge.close(); ws.close(); const before = store.messages(conversation.id).data.length;
    bridge.child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call', toolCallId: 'late', title: 'Late tool' } } })}\n`);
    expect(store.messages(conversation.id).data).toHaveLength(before);
  });
  it('sends stored owner message and does not prompt when storing fails', async () => {
    const { ws, store, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'empty' });
    expect(await waitFor(ws, 'message')).toMatchObject({ message: { role: 'owner', content: 'empty', id: expect.any(Number) } });
    await waitFor(ws, 'turn_end');
    const original = store.append; store.append = () => { throw new Error('store failed'); };
    ws.sent.length = 0; ws.receive({ type: 'prompt', text: 'hello' });
    expect(await waitFor(ws, 'error')).toMatchObject({ message: 'store failed' });
    expect(ws.sent.some(frame => frame.type === 'message')).toBe(false);
    store.append = original;
  });
  it('rejects browser fields and permission outcomes outside the offered request', async () => {
    const { ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'hello', extra: true });
    ws.receive({ type: 'cancel' });
    expect(ws.sent.filter(frame => frame.type === 'error')).toHaveLength(2);
    ws.receive({ type: 'prompt', text: 'permission' }); await waitFor(ws, 'permission_request');
    ws.receive({ type: 'permission_response', requestId: 90, outcome: { outcome: 'selected', optionId: 'not-offered' } });
    expect(ws.sent.filter(frame => frame.type === 'error')).toHaveLength(3);
    expect(ws.readyState).toBe(1);
  });
  it('reports malformed ACP notifications and unknown methods', async () => {
    const { ws, connect } = setup(); const bridge = connect(); await waitFor(ws, 'ready');
    const send = frame => bridge.child.stdout.emit('data', `${JSON.stringify(frame)}\n`);
    send({ jsonrpc: '2.0', method: 'session/unknown', params: {} });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read' } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call', toolCallId: 't' } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'unrecognized' } } });
    expect(ws.sent.filter(frame => frame.type === 'error')).toHaveLength(4);
  });
  it('rejects malformed nested ACP tool content and permission options', async () => {
    const { ws, connect } = setup(); const bridge = connect(); await waitFor(ws, 'ready');
    const send = frame => bridge.child.stdout.emit('data', `${JSON.stringify(frame)}\n`);
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read', content: [{ type: 'content', content: { type: 'text', text: 42 } }] } } });
    send({ jsonrpc: '2.0', id: 200, method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { toolCallId: 't', title: 'Read' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once', _meta: 'bad' }] } });
    expect(ws.sent.filter(frame => frame.type === 'error')).toHaveLength(2);
  });
  it('passes codedeck MCP server and assistant brief systemPrompt in session/new, emits briefed notice, and ends token on close', async () => {
    const sessionTokens = createSessionTokens();
    const compose = async project => ({
      project,
      markdown: `# ${project} — where things stand\n## Attention\n- Phase 2 has 4 of 6 tasks done.`,
      flags: [],
    });
    const { ws, store, conversation, connect } = setup({
      compose,
      sessionTokens,
      assistantUrl: 'http://127.0.0.1:43001',
    });
    const bridge = connect();
    await waitFor(ws, 'ready');

    expect(sessionTokens.size()).toBe(1);
    expect(store.messages(conversation.id).data).toContainEqual(
      expect.objectContaining({ role: 'notice', content: 'Assistant briefed on the current situation.' }),
    );
    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: 'message', message: expect.objectContaining({ role: 'notice', content: 'Assistant briefed on the current situation.' }) }),
    );

    ws.receive({ type: 'prompt', text: 'inspect-session' });
    await waitFor(ws, 'turn_end');
    const agentReply = store.messages(conversation.id).data.filter(m => m.role === 'agent').at(-1).content;
    const params = JSON.parse(agentReply);

    expect(params.mcpServers).toHaveLength(1);
    expect(params.mcpServers[0]).toMatchObject({
      name: 'codedeck',
      command: process.execPath,
      args: [expect.stringMatching(/server\/assistant\/mcp-server\.js$/)],
    });
    const envMap = Object.fromEntries(params.mcpServers[0].env.map(item => [item.name, item.value]));
    expect(envMap.CODEDECK_ASSISTANT_URL).toBe('http://127.0.0.1:43001');
    expect(envMap.CODEDECK_ASSISTANT_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionTokens.verify(envMap.CODEDECK_ASSISTANT_TOKEN)).toMatchObject({ project: 'Demo', conversationId: conversation.id });

    expect(params.systemPrompt).toEqual({
      mode: 'append',
      content: [{ type: 'text', text: expect.stringContaining('# Demo — where things stand') }],
    });
    expect(params.systemPrompt.content[0].text).toContain('Phase 2 has 4 of 6 tasks done.');

    bridge.close();
    expect(sessionTokens.size()).toBe(0);
    expect(sessionTokens.verify(envMap.CODEDECK_ASSISTANT_TOKEN)).toBeNull();
  });

  it('reports a situation failure as such, issues no token and never becomes ready', async () => {
    const sessionTokens = createSessionTokens();
    const compose = async () => { throw new Error('situation: task t-1 worktree w-1 branch must be text'); };
    const { ws, connect } = setup({ compose, sessionTokens, assistantUrl: 'http://127.0.0.1:43001' });
    connect();
    const failure = await waitFor(ws, 'spawn_error');
    expect(failure.message).toBe('The assistant could not read the project situation: situation: task t-1 worktree w-1 branch must be text');
    expect(failure.message).not.toContain('ask before acting');
    expect(ws.sent.some(frame => frame.type === 'ready')).toBe(false);
    expect(sessionTokens.size()).toBe(0);
    expect(ws.readyState).toBe(3);
  });

  it('prefixes newly decided proposals to the next prompt once and pushes proposal and situation frames', async () => {
    const { db, store, ws, conversation, connect } = setup();
    const proposalStore = createProposalStore(db);
    const bridge = handleAssistantConnection(ws, {
      project: 'Demo',
      cwd: process.cwd(),
      conversation,
      store,
      proposalStore,
      settings: () => ({ agentId: 'claude', effort: null }),
      agentStore: { get: () => ({ id: 'claude', name: 'Claude Code', launchCommand: 'command claude' }) },
      command: process.execPath,
      args: [fixture],
    });
    await waitFor(ws, 'ready');

    const p1 = proposalStore.create({
      conversationId: conversation.id,
      project: 'Demo',
      kind: 'commit',
      payload: { taskId: '11111111-1111-4111-8111-111111111111', message: 'wip' },
      summary: 'Commit changes',
      reason: 'Checkpoint.',
    });
    bridge.pushProposal(p1);
    expect(ws.sent).toContainEqual({ type: 'proposal', proposal: p1 });

    proposalStore.claimApprove(p1.id);
    const done = proposalStore.finish(p1.id, { state: 'done', result: { commitsAhead: 1 } });
    bridge.pushProposal(done);
    bridge.pushSituation([{ code: 'merge_blocked', message: 'Blocked', where: {} }]);
    expect(ws.sent).toContainEqual({ type: 'situation', flags: [{ code: 'merge_blocked', message: 'Blocked', where: {} }] });

    ws.receive({ type: 'prompt', text: 'echo-prompt first' });
    await waitFor(ws, 'turn_end');
    const firstAgentReply = store.messages(conversation.id).data.filter(m => m.role === 'agent').at(-1).content;
    expect(firstAgentReply).toContain(`[CodeDeck] Proposal ${p1.id} (commit): done`);
    expect(firstAgentReply).toContain('echo-prompt first');
    // Stored owner message stays clean without the system prefix.
    expect(store.messages(conversation.id).data.filter(m => m.role === 'owner').at(-1).content).toBe('echo-prompt first');

    // Second prompt does not repeat the already-reported decision.
    ws.sent.length = 0;
    ws.receive({ type: 'prompt', text: 'echo-prompt second' });
    await waitFor(ws, 'turn_end');
    const secondAgentReply = store.messages(conversation.id).data.filter(m => m.role === 'agent').at(-1).content;
    expect(secondAgentReply).toBe('echo-prompt second');
    expect(connect).toBeTypeOf('function');
  });
});

describe('ACP bridge review fixes', () => {
  const texts = ws => ws.sent.filter(frame => frame.type === 'update' && frame.update.sessionUpdate === 'agent_message_chunk').map(frame => frame.update.content.text);
  it('accepts an update that arrives in the same chunk as the session/new reply', async () => {
    const { ws, connect } = setup({ args: [fixture, 'update-with-session'] }); connect();
    await waitFor(ws, 'ready');
    expect(ws.sent.filter(frame => frame.type === 'error')).toEqual([]);
    expect(ws.sent.some(frame => frame.type === 'update' && frame.update.sessionUpdate === 'available_commands_update')).toBe(true);
  });
  it('keeps reading the rest of a chunk after one frame fails validation', async () => {
    const { ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'bad-then-end' });
    await waitFor(ws, 'turn_end');
    expect(texts(ws)).toContain('after bad');
  });
  it('answers a refused permission request with a JSON-RPC error so the turn can end', async () => {
    const { ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'bad-permission' });
    await waitFor(ws, 'turn_end');
    expect(texts(ws)).toContain('refused -32602');
  });
  it('says on every error frame whether a turn is still running', async () => {
    const { ws, connect } = setup({ args: [fixture, 'slow-restore'] }); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'cancel' });
    expect(ws.sent.filter(frame => frame.type === 'error').at(-1)).toMatchObject({ message: 'No turn is running.', turnRunning: false });
    ws.receive({ type: 'prompt', text: 'permission' }); await waitFor(ws, 'permission_request');
    ws.receive({ type: 'prompt', text: 'again' });
    expect(ws.sent.filter(frame => frame.type === 'error').at(-1)).toMatchObject({ message: 'A turn is already running.', turnRunning: true });
  });
  it('answers open permission requests as cancelled when the owner cancels the turn', async () => {
    const { ws, connect } = setup(); connect(); await waitFor(ws, 'ready');
    ws.receive({ type: 'prompt', text: 'permission' }); await waitFor(ws, 'permission_request');
    ws.receive({ type: 'cancel' });
    await new Promise(resolve => { const check = () => (texts(ws).includes('cancelled') ? resolve() : setTimeout(check, 10)); check(); });
    expect(texts(ws)).toContain(JSON.stringify({ outcome: 'cancelled' }));
    ws.receive({ type: 'permission_response', requestId: 90, outcome: { outcome: 'selected', optionId: 'allow' } });
    expect(ws.sent.filter(frame => frame.type === 'error').at(-1)).toMatchObject({ message: 'Unknown permission requestId.' });
  });
});

describe('ACP bridge process lifecycle', () => {
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const exited = child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode }); else child.once('exit', (code, signal) => resolve({ code, signal })); });

  it('ends the adapter process when the socket closes', async () => {
    let child;
    const { ws, connect } = setup({ spawnFn: (command, args, options) => (child = spawn(command, args, options)) });
    connect();
    await waitFor(ws, 'ready');
    expect(alive(child.pid)).toBe(true);
    ws.close();
    const result = await exited(child);
    expect(result.signal).toBe('SIGTERM');
    expect(alive(child.pid)).toBe(false);
  });

  it('kills an adapter that ignores SIGTERM after three seconds', async () => {
    let child;
    const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const { ws, connect } = setup({ command: process.execPath, args: ['-e', stubborn], spawnFn: (command, args, options) => (child = spawn(command, args, options)) });
    connect();
    await new Promise(resolve => setTimeout(resolve, 300));
    const started = Date.now();
    ws.close();
    const result = await exited(child);
    expect(result.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
  }, 8000);
});

describe('describeProposalDecision', () => {
  const done = (kind, result) => ({ kind, state: 'done', result });
  it('says a count is unknown instead of reporting it as 0', () => {
    expect(describeProposalDecision(done('commit', { commitsAhead: null, uncommittedCount: 0 }))).toBe('committed (commits ahead unknown, 0 uncommitted)');
    expect(describeProposalDecision(done('commit', { commitsAhead: 2, uncommittedCount: 1 }))).toBe('committed (2 ahead, 1 uncommitted)');
  });
  it('does not name a branch the merge result did not give', () => {
    expect(describeProposalDecision(done('merge', {}))).toBe('merged');
    expect(describeProposalDecision(done('merge', { mergedInto: 'main' }))).toBe('merged into main');
  });
});
