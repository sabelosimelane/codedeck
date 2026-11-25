import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as opencode from '../agent-profiles/opencode.js';
import { findAgentProfile } from '../agent-profiles/index.js';
import { classifyTerminalExecution } from '../terminal-execution-classifier.js';

const startup = [
  '▪ oc mini v2.3.2 · /path/to/project',
  '┃ Ask anything, / for commands, @ for context…',
  'Build · DeepSeek V4.1 Flash · OpenRouter · ctrl+p menu',
];
const completed = [
  'DONE',
  'Build · DeepSeek V4.1 Flash · 11.8s',
  '┃',
  'Build · DeepSeek V4.1 Flash · 23.2K (2%) · OpenRouter · $0.00 · ctrl+p menu',
];
const working = [
  'Also should I rename the session? Not necessary.',
  '┃',
  '🯦 esc interrupt · Build · DeepSeek V4.1 Flash · OpenRouter · ctrl+p menu',
];

describe('OpenCode mini live profile', () => {
  it('matches the foreground command and screen evidence', () => {
    expect(opencode.id).toBe('opencode');
    expect(opencode.skillPrefix).toBe('/');
    expect(opencode.matches({ foregroundCommand: 'opencode', lines: [] })).toBe(true);
    expect(findAgentProfile({ foregroundCommand: 'node', lines: startup })?.id).toBe('opencode');
    expect(findAgentProfile({ foregroundCommand: 'node', lines: completed })?.id).toBe('opencode');
  });

  it.each([
    ['startup', startup],
    ['after a turn', completed],
  ])('reads %s as idle with a visible prompt', (_, lines) => {
    expect(opencode.promptVisible(lines)).toBe(true);
    expect(opencode.read(lines)).toEqual({ turn: 'idle', backgroundShells: 0 });
  });

  it('reads the working footer below the last prompt', () => {
    expect(opencode.read(working)).toEqual({ turn: 'working', backgroundShells: 0 });
    expect(classifyTerminalExecution({ paneCurrentCommand: 'opencode', paneDead: '0', snapshotText: working.join('\n'), subagentPanes: [], quietSeconds: 0 }))
      .toMatchObject({ agentCli: 'opencode', executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('ignores transcript text containing the working marker above the prompt', () => {
    expect(opencode.read(['esc interrupt · Build · copied transcript', ...completed]))
      .toEqual({ turn: 'idle', backgroundShells: 0 });
  });

  // opencode mini draws inline: its screen stays after it exits, with `›` lines Codex's prompt matcher also accepts.
  const screen = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const classify = (paneCurrentCommand, snapshotText) => classifyTerminalExecution({ paneCurrentCommand, paneDead: '0', snapshotText, subagentPanes: [], quietSeconds: 0 });

  it('is read as OpenCode, not Codex, once a prompt is echoed as a `›` line', () => {
    expect(findAgentProfile({ foregroundCommand: 'opencode', lines: screen('agent-screens/opencode/working-tool.txt').split('\n') })?.id).toBe('opencode');
  });

  it('is read as OpenCode when its transcript names another CLI', () => {
    expect(classify('opencode', ['Claude Code v2.1.3 is installed here', ...working].join('\n')))
      .toMatchObject({ agentCli: 'opencode', executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('reads its permission dialog as needing input', () => {
    expect(opencode.read(screen('agent-screens/opencode/needs-input-permission.txt').split('\n')))
      .toEqual({ turn: 'needs_input', backgroundShells: 0 });
  });

  it('keeps reading a spinner frame wider than one glyph as working', () => {
    expect(opencode.read(['┃', '⠋⠙ esc interrupt · Build · X · ctrl+p menu'])).toEqual({ turn: 'working', backgroundShells: 0 });
  });

  it('reads the screen left after it exits to the shell as a shell prompt, not an agent', () => {
    expect(classify('zsh', screen('opencode-exited.txt')))
      .toMatchObject({ agentCli: null, executionStatus: 'idle', executionReason: 'shell_prompt' });
  });
});
