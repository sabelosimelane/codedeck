import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyTerminalExecution } from '../terminal-execution-classifier.js';

const screen = name => readFileSync(
  new URL(`./fixtures/agent-screens/${name}`, import.meta.url),
  'utf8'
);

function classify(snapshotText, paneCurrentCommand = 'node') {
  return classifyTerminalExecution({
    paneCurrentCommand,
    paneDead: '0',
    snapshotText,
    subagentPanes: [],
    quietSeconds: 0,
  });
}

function edited(name, from, to) {
  const original = screen(name);
  const changed = original.replace(from, to);
  if (changed === original) throw new Error(`fixture ${name} does not contain ${from}`);
  return changed;
}

describe('agent profiles beyond the exact captured frame', () => {
  it('keeps a Codex turn running once its elapsed counter passes an hour', () => {
    expect(classify(edited('codex/working.txt', /\(\d+s • esc/, '(1h 02m 03s • esc')))
      .toMatchObject({ executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('keeps a Codex turn running whatever verb the live status line uses', () => {
    expect(classify(edited('codex/working.txt', '• Working (', '• Compacting context (')))
      .toMatchObject({ executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('reports Codex needs input when the selection sits on the second option', () => {
    const moved = edited('codex/needs-input-approval.txt', '› 1. Yes, proceed (y)', '  1. Yes, proceed (y)')
      .replace('  2. Yes, and', '› 2. Yes, and');
    expect(classify(moved))
      .toMatchObject({ executionStatus: 'running', executionReason: 'agent_needs_input', needsInput: true });
  });

  it('keeps a Claude Code turn running once its elapsed counter passes an hour', () => {
    expect(classify(edited('claude/working.txt', /… \(\d+s ·/, '… (1h 2m 3s ·')))
      .toMatchObject({ executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('keeps a Claude Code turn running before the spinner shows a token count', () => {
    expect(classify(edited('claude/working.txt', /… \(\d+s · ↓ \d+ tokens\)/, '… (2s)')))
      .toMatchObject({ executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('reports Claude Code needs input when the selection sits on the last option', () => {
    const moved = edited('claude/needs-input-permission.txt', '❯ 1. Yes', '  1. Yes')
      .replace('   4. No', ' ❯ 4. No');
    expect(classify(moved))
      .toMatchObject({ executionStatus: 'running', executionReason: 'agent_needs_input', needsInput: true });
  });

  it('keeps an Antigravity turn running on every spinner frame and status word', () => {
    for (const status of ['⢿  Generating...', '⣾  Thinking...', '⡿  Running command...']) {
      expect(classify(edited('agy/working.txt', /^.*Generating\.\.\..*$/m, status)))
        .toMatchObject({ executionStatus: 'running', executionReason: 'agent_working' });
    }
  });

  it('recognises Antigravity whichever model its footer names', () => {
    expect(classify(screen('agy/working.txt').replaceAll('Gemini 3.8 Flash', 'Gemini 4 Pro').replace(/^.*Antigravity CLI.*$/m, '')))
      .toMatchObject({ agentCli: 'agy', executionStatus: 'running' });
  });

  it('reports Antigravity needs input when the selection sits on the last option', () => {
    const moved = edited('agy/needs-input-approval.txt', '> 1. Yes, run command', '  1. Yes, run command')
      .replace('  4. No, cancel', '> 4. No, cancel');
    expect(classify(moved))
      .toMatchObject({ executionStatus: 'running', executionReason: 'agent_needs_input', needsInput: true });
  });

  it('recognises Cursor Agent whichever model its footer names', () => {
    expect(classify(screen('agent/working.txt').replace(/Composer [\d.]+/g, 'Sonnet 5').replace(/^.*Cursor Agent.*$/m, '')))
      .toMatchObject({ agentCli: 'cursor', executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('keeps a Muse turn running once its elapsed counter passes a minute', () => {
    expect(classify(edited('muse/working-thinking.txt', /\(\d+s · esc/, '(3m 12s · esc')))
      .toMatchObject({ executionStatus: 'running', executionReason: 'agent_working' });
  });

  it('reports Muse needs input when the selection sits on the second option', () => {
    const moved = edited('muse/needs-input-trust.txt', '⟩ 1  Trust and continue', '  1  Trust and continue')
      .replace('  2  Quit', '⟩ 2  Quit');
    expect(classify(moved))
      .toMatchObject({ executionStatus: 'running', executionReason: 'agent_needs_input', needsInput: true });
  });
});
