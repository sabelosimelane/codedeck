import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyTerminalExecution, WORKING_SILENCE_SECONDS } from '../terminal-execution-classifier.js';

const root = new URL('./fixtures/agent-screens/', import.meta.url);
const commands = { codex: 'node', claude: '2.1.321', agent: 'agent', agy: 'agy', muse: 'muse', opencode: 'opencode' };
const fixtures = Object.keys(commands).flatMap(cli => readdirSync(new URL(`${cli}/`, root))
  .filter(name => name.endsWith('.txt')).map(name => ({ cli, name })));
const screen = (cli, name) => readFileSync(new URL(`${cli}/${name}`, root), 'utf8');
const classify = (cli, name, options = {}) => classifyTerminalExecution({
  paneCurrentCommand: commands[cli], paneDead: '0', snapshotText: screen(cli, name),
  subagentPanes: [], quietSeconds: 0, ...options,
});

describe('captured agent screens', () => {
  it.each(fixtures)('$cli/$name', ({ cli, name }) => {
    const state = classify(cli, name);
    expect(state.agentCli).toBe(cli === 'agent' ? 'cursor' : cli);
    if (name.startsWith('needs-input-')) {
      expect(state).toMatchObject({ executionStatus: 'running', executionReason: 'agent_needs_input', needsInput: true });
    } else if (name.startsWith('working')) {
      expect(state).toMatchObject({ executionStatus: 'running', executionReason: 'agent_working' });
    } else if (name.includes('background')) {
      expect(state).toMatchObject({ executionStatus: 'running', executionReason: 'agent_background_shells' });
      expect(state.backgroundShells).toBeGreaterThan(0);
    } else {
      expect(state).toMatchObject({ executionStatus: 'idle', executionReason: 'agent_prompt_idle' });
    }
  });

  it('vetoes a stale marker but keeps a fresh marker working', () => {
    expect(classify('codex', 'working.txt', { quietSeconds: WORKING_SILENCE_SECONDS })).toMatchObject({ executionStatus: 'idle', executionReason: 'agent_marker_stale' });
    expect(classify('codex', 'working.txt')).toMatchObject({ executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('reads Cursor running as node at its prompt when its input holds text', () => {
    expect(classify('agent', 'idle-typed-input.txt', { paneCurrentCommand: 'node' }))
      .toMatchObject({ agentCli: 'cursor', executionStatus: 'idle', executionReason: 'agent_prompt_idle' });
  });

  it('reads Cursor running as node as working when its input holds text mid-turn', () => {
    const snapshotText = screen('agent', 'working.txt').replace('Add a follow-up', 'typed ahead   ');
    expect(snapshotText).toContain('→ typed ahead');
    expect(classify('agent', 'working.txt', { paneCurrentCommand: 'node', snapshotText }))
      .toMatchObject({ agentCli: 'cursor', executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('does not take a Codex screen that quotes an arrow line for Cursor', () => {
    const snapshotText = screen('codex', 'working.txt').replace(/\n/, '\n→ quoted line\n');
    expect(classify('codex', 'working.txt', { snapshotText }).agentCli).toBe('codex');
  });

  it('counts a working Claude sub-agent independently of an idle main pane', () => {
    expect(classify('claude', 'main-pane-with-subagent-pane.txt', { subagentPanes: [
      { paneCurrentCommand: '2.1.321', paneDead: '0', snapshotText: screen('claude', 'working.txt') },
    ] })).toMatchObject({ executionStatus: 'running', executionReason: 'agent_delegated', backgroundAgents: 1 });
  });

});
