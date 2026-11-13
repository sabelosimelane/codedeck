import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findAgentProfileById } from '../agent-profiles/index.js';
import * as claude from '../agent-profiles/claude.js';
import * as muse from '../agent-profiles/muse.js';
import * as cursor from '../agent-profiles/cursor.js';
import * as agy from '../agent-profiles/agy.js';
import * as codex from '../agent-profiles/codex.js';
import { classify } from '../pipelines/agent-readiness.js';

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
