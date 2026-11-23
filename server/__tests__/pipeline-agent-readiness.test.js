import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findAgentProfileById } from '../agent-profiles/index.js';
import * as claude from '../agent-profiles/claude.js';
import * as muse from '../agent-profiles/muse.js';
import * as cursor from '../agent-profiles/cursor.js';
import * as agy from '../agent-profiles/agy.js';
import * as codex from '../agent-profiles/codex.js';
import { classify } from '../pipelines/agent-readiness.js';
import { classifyTerminalExecution } from '../terminal-execution-classifier.js';

const root = new URL('./fixtures/agent-screens/', import.meta.url);
const screen = (cli, name) => readFileSync(new URL(`${cli}/${name}`, root), 'utf8').replace(/\r/g, '').split('\n');

const profiles = [
  { id: 'claude', profile: claude, fixtureDir: 'claude' },
  { id: 'muse', profile: muse, fixtureDir: 'muse' },
  { id: 'cursor', profile: cursor, fixtureDir: 'agent' },
  { id: 'agy', profile: agy, fixtureDir: 'agy' },
  { id: 'codex', profile: codex, fixtureDir: 'codex' },
];

const alive = { isAlive: true, entryExists: true };

describe('findAgentProfileById', () => {
  it.each(profiles.map(p => p.id))('resolves %s', (id) => {
    expect(findAgentProfileById(id)?.id).toBe(id);
  });

  it('returns null for unknown ids', () => {
    expect(findAgentProfileById('unknown')).toBeNull();
    expect(findAgentProfileById('')).toBeNull();
  });
});

describe('promptVisible', () => {
  it.each(profiles)('$id is true on idle-fresh and false before the prompt is drawn', ({ profile, fixtureDir }) => {
    expect(profile.promptVisible(screen(fixtureDir, 'idle-fresh.txt'))).toBe(true);
    expect(profile.promptVisible(['starting up…', '', ''])).toBe(false);
  });
});

// agy shows its mode in the empty input line once a turn is over:
// `> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)`. That is its prompt.
describe('agy idle with its mode shown in the input line', () => {
  const lines = screen('agy', 'idle-mode-hint.txt');

  it('is at its prompt and ready for a step', () => {
    const execution = classifyTerminalExecution({
      paneCurrentCommand: 'agy', paneDead: '0', snapshotText: lines.join('\n'), subagentPanes: [], quietSeconds: 0,
    });
    expect(agy.read(lines)).toEqual({ turn: 'idle', backgroundShells: 0 });
    expect(agy.promptVisible(lines)).toBe(true);
    expect(execution.executionReason).toBe('agent_prompt_idle');
    expect(classify({ executionReason: execution.executionReason, foregroundCommand: 'agy', lines, profile: agy, ...alive })).toBe('ready');
  });

  it('still reads its dialogs as dialogs, not as a prompt', () => {
    for (const name of ['needs-input-approval.txt', 'needs-input-trust.txt']) {
      expect(agy.read(screen('agy', name)).turn).toBe('needs_input');
    }
  });

  it('keeps agy waiting (agent_background_shells) while background tasks are running below the prompt', () => {
    const lines = [
      '  Fixed the cancelGate helper in PanicControllerTest.kt. Waiting for the running :app:testDebugUnitTest TDD failure check (task-53) to complete.',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '>',
      '────────────────────────────────────────────────────────────────────────────────',
      '  ● [19:46:02] cd /home/dev/git/acme/worktrees/sample-task-e8b74aed/mobile-app && ./gradlew :core:jvmTest --tests ... running',
      '────────────────────────────────────────────────────────────────────────────────',
      '? for shortcuts                                                                                              Gemini 4 Hydrogen · medium · 1 task(s) · /tasks',
    ];
    expect(agy.read(lines)).toEqual({ turn: 'idle', backgroundShells: 1 });
    const execution = classifyTerminalExecution({
      paneCurrentCommand: 'agy',
      paneDead: '0',
      snapshotText: lines.join('\n'),
      subagentPanes: [],
      quietSeconds: 45,
    });
    expect(execution).toMatchObject({
      executionStatus: 'running',
      executionReason: 'agent_background_shells',
      backgroundShells: 1,
    });
    expect(classify({
      executionReason: execution.executionReason,
      foregroundCommand: 'agy',
      lines,
      profile: agy,
      ...alive,
    })).toBe('waiting');
  });

  it('treats an idle agy prompt with only a stale task footer as ready (no live running row)', () => {
    const lines = [
      '  Fixed the cancelGate helper in PanicControllerTest.kt.',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '>',
      '────────────────────────────────────────────────────────────────────────────────',
      '? for shortcuts                                                                                              Gemini 4 Hydrogen · medium · 1 task(s) · /tasks',
    ];
    expect(agy.read(lines)).toEqual({ turn: 'idle', backgroundShells: 0 });
    const execution = classifyTerminalExecution({
      paneCurrentCommand: 'agy',
      paneDead: '0',
      snapshotText: lines.join('\n'),
      subagentPanes: [],
      quietSeconds: 45,
    });
    expect(execution).toMatchObject({
      executionStatus: 'idle',
      executionReason: 'agent_prompt_idle',
    });
    expect(classify({
      executionReason: execution.executionReason,
      foregroundCommand: 'agy',
      lines,
      profile: agy,
      ...alive,
    })).toBe('ready');
  });
});

// Codex hides its `• Working (…)` line while it writes text, between tools and for its final
// answer. Its footer still says the turn is running; a step must not be started on that screen.
describe('Codex writing text in the middle of a turn', () => {
  const readiness = (lines) => {
    const execution = classifyTerminalExecution({
      paneCurrentCommand: 'codex', paneDead: '0', snapshotText: lines.join('\n'), subagentPanes: [], quietSeconds: 0,
    });
    return {
      reason: execution.executionReason,
      readiness: classify({ executionReason: execution.executionReason, foregroundCommand: 'codex', lines, profile: codex, ...alive }),
    };
  };

  it.each(['working-writing-before-tool.txt', 'working-writing-final-answer.txt'])('%s is working, not ready', (name) => {
    expect(codex.read(screen('codex', name))).toEqual({ turn: 'working', backgroundShells: 0 });
    expect(readiness(screen('codex', name))).toEqual({ reason: 'agent_working', readiness: 'waiting' });
  });

  it('is ready once the footer says Ready', () => {
    const lines = screen('codex', 'working-writing-final-answer.txt').map(line => line.replace(' · Working · ', ' · Ready · '));
    expect(codex.read(lines).turn).toBe('idle');
    expect(readiness(lines)).toEqual({ reason: 'agent_prompt_idle', readiness: 'ready' });
  });

  it('reads the run state only from the footer below the prompt', () => {
    const lines = [
      '• The status line reads GPT-6.2-Sol medium · ~/work/demo · Working · Context 10% used while a turn runs.',
      '',
      '  Worked for 12s • 10:39',
      '',
      '› Ask Codex to do anything',
      '',
      '  GPT-6.2-Sol medium · ~/work/demo · Ready · Context 10% used',
      '  ← for agents · ? for shortcuts',
    ];
    expect(codex.read(lines).turn).toBe('idle');
  });

  it('does not take a word of the folder name for the run state', () => {
    const lines = ['› Ask Codex to do anything', '', '  GPT-6.2-Sol medium · ~/Working · Ready · Context 10% used'];
    expect(codex.read(lines).turn).toBe('idle');
  });

  it('reads a footer cut short before the run state as it did before', () => {
    const lines = screen('codex', 'working-writing-final-answer.txt').map(line => line.replace(/ · Working · .*$/, '…'));
    expect(lines.some(line => line.includes('~/work/demo…'))).toBe(true);
    expect(codex.read(lines).turn).toBe('idle');
  });
});

describe('classify agent readiness (Spec §8.4)', () => {
  it.each(profiles)('$id → ready when agent_prompt_idle and prompt is visible', ({ profile, fixtureDir }) => {
    expect(classify({
      executionReason: 'agent_prompt_idle',
      foregroundCommand: 'node',
      lines: screen(fixtureDir, 'idle-fresh.txt'),
      profile,
      ...alive,
    })).toBe('ready');
  });

  it.each(profiles)('$id → waiting when agent_prompt_idle but prompt is not visible yet', ({ profile }) => {
    expect(classify({
      executionReason: 'agent_prompt_idle',
      foregroundCommand: 'node',
      lines: ['starting up…', '', ''],
      profile,
      ...alive,
    })).toBe('waiting');
  });

  it.each(profiles)('$id → needs_input when execution reason is agent_needs_input', ({ profile, fixtureDir }) => {
    expect(classify({
      executionReason: 'agent_needs_input',
      foregroundCommand: 'node',
      lines: screen(fixtureDir, 'needs-input-trust.txt'),
      profile,
      ...alive,
    })).toBe('needs_input');
  });

  it.each(profiles)('$id → waiting while the agent is still working', ({ profile, fixtureDir }) => {
    const working = fixtureDir === 'muse' ? 'working-thinking.txt' : 'working.txt';
    expect(classify({
      executionReason: 'agent_working',
      foregroundCommand: 'node',
      lines: screen(fixtureDir, working),
      profile,
      ...alive,
    })).toBe('waiting');
  });

  it('→ exited when the shell prompt has returned after a non-shell launch', () => {
    expect(classify({
      executionReason: 'shell_prompt',
      foregroundCommand: 'zsh',
      lines: ['dev@host demo %'],
      profile: null,
      ...alive,
    })).toBe('exited');
  });

  it('→ closed when the session entry is gone', () => {
    expect(classify({
      executionReason: 'agent_prompt_idle',
      foregroundCommand: 'node',
      lines: screen('claude', 'idle-fresh.txt'),
      profile: claude,
      isAlive: true,
      entryExists: false,
    })).toBe('closed');
  });

  it('→ closed when the session is not alive', () => {
    expect(classify({
      executionReason: 'agent_prompt_idle',
      foregroundCommand: 'node',
      lines: screen('claude', 'idle-fresh.txt'),
      profile: claude,
      isAlive: false,
      entryExists: true,
    })).toBe('closed');
  });
});
