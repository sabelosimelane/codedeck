import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as kiro from '../agent-profiles/kiro.js';
import { findAgentProfile } from '../agent-profiles/index.js';
import { classifyTerminalExecution } from '../terminal-execution-classifier.js';
import { classify as classifyReadiness } from '../pipelines/agent-readiness.js';

// idle-fresh.txt is the owner's Kiro CLI 2.x screen (with the 3.0 notice). The working, turn-complete
// and permission screens are built from the strings published for Kiro CLI 3.1.0 by other tools
// that drive it (AgEnD, cli-agent-orchestrator); they were not captured from a live Kiro here.
const screen = name => readFileSync(new URL(`./fixtures/agent-screens/kiro/${name}`, import.meta.url), 'utf8').split('\n');
const classify = (paneCurrentCommand, name) => classifyTerminalExecution({
  paneCurrentCommand, paneDead: '0', snapshotText: screen(name).join('\n'), subagentPanes: [], quietSeconds: 0,
});

describe('Kiro CLI live profile', () => {
  it('names itself and invokes skills with /', () => {
    expect(kiro.id).toBe('kiro');
    expect(kiro.skillPrefix).toBe('/');
  });

  it.each(['kiro-cli', 'kiro-cli-chat', 'kiro'])('matches the foreground command %s alone', foregroundCommand => {
    expect(kiro.matches({ foregroundCommand, lines: [] })).toBe(true);
  });

  // Kiro 3 runs its interface as its bundled bun running tui.js, so tmux names `bun`.
  it.each(['idle-fresh.txt', 'working.txt', 'turn-complete.txt', 'draft-unsent.txt'])('is found from the screen %s under bun, not as Codex', name => {
    expect(findAgentProfile({ foregroundCommand: 'bun', lines: screen(name) })?.id).toBe('kiro');
  });

  it('does not claim another CLI screen or a bare `>` transcript', () => {
    expect(kiro.matches({ foregroundCommand: 'node', lines: ['› Write tests for the parser', 'gpt-6 medium · ~/work'] })).toBe(false);
    expect(kiro.matches({ foregroundCommand: 'bun', lines: ['> quoted', 'plain text'] })).toBe(false);
  });

  it.each(['idle-fresh.txt', 'turn-complete.txt'])('reads %s as idle at a visible prompt, which is ready', name => {
    const lines = screen(name);
    expect(kiro.promptVisible(lines)).toBe(true);
    expect(kiro.read(lines)).toEqual({ turn: 'idle', backgroundShells: 0 });
    expect(kiro.draftPending(lines)).toBe(false);
    const state = classify('bun', name);
    expect(state).toMatchObject({ agentCli: 'kiro', executionStatus: 'idle', executionReason: 'agent_prompt_idle' });
    expect(classifyReadiness({ ...state, lines, profile: findAgentProfile({ foregroundCommand: 'bun', lines }), isAlive: true, entryExists: true })).toBe('ready');
  });

  it('reads a turn in progress as working', () => {
    expect(kiro.read(screen('working.txt'))).toEqual({ turn: 'working', backgroundShells: 0 });
    expect(classify('kiro-cli', 'working.txt')).toMatchObject({ agentCli: 'kiro', executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('reads the working line in the prompt row alone as working', () => {
    const lines = screen('turn-complete.txt').map(line => line.startsWith('› ') ? '› Kiro is working · 12s · Type to steer · Ctrl+S to queue' : line);
    expect(kiro.read(lines)).toEqual({ turn: 'working', backgroundShells: 0 });
  });

  it('ignores "Thinking..." in the answer above the prompt area', () => {
    expect(kiro.read(screen('turn-complete.txt'))).toEqual({ turn: 'idle', backgroundShells: 0 });
  });

  it('reads the tool approval prompt as needing input', () => {
    const lines = screen('needs-input-permission.txt');
    expect(kiro.read(lines)).toEqual({ turn: 'needs_input', backgroundShells: 0 });
    expect(findAgentProfile({ foregroundCommand: 'bun', lines })?.id).toBe('kiro');
    expect(classify('kiro-cli', 'needs-input-permission.txt')).toMatchObject({ executionReason: 'agent_needs_input', needsInput: true });
  });

  it.each([
    ['workspace trust', ['Trust this workspace?', '❯ Trust, continue', "  Don't trust, exit"]],
    ['expired sign-in', ['You are not logged in. Login now?', '❯ Yes', '  No']],
    ['the 3.0 launch menu', ['Kiro CLI 3.0 is here. Classic is no longer supported.', '❯ Continue with V3', '  Exit']],
  ])('reads the %s dialog as needing input', (_, lines) => {
    expect(kiro.read(lines)).toEqual({ turn: 'needs_input', backgroundShells: 0 });
  });

  it('does not read an approval already answered above the prompt as pending', () => {
    const lines = [...screen('needs-input-permission.txt'), 'y', 'Tests passed.', ...screen('turn-complete.txt').slice(-6)];
    expect(kiro.read(lines)).toEqual({ turn: 'idle', backgroundShells: 0 });
  });

  // Kiro takes the Enter after a paste as finishing the paste: the prompt stays in the input row.
  it('reports a prompt left in the input row as an unsent draft', () => {
    const lines = screen('draft-unsent.txt');
    expect(kiro.promptVisible(lines)).toBe(true);
    expect(kiro.read(lines)).toEqual({ turn: 'idle', backgroundShells: 0 });
    expect(kiro.draftPending(lines)).toBe(true);
  });

  it('has no prompt without its status row', () => {
    expect(kiro.promptVisible(['› ask a question or describe a task ↵'])).toBe(false);
  });
});
