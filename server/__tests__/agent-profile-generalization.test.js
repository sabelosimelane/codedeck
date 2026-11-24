import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyTerminalExecution } from '../terminal-execution-classifier.js';
import { quotaNegatives, quotaScreens } from './fixtures/quota-screens.js';
import * as agy from '../agent-profiles/agy.js';

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

describe('Antigravity quota refusal', () => {
  const refusal = [
    '⚠ Individual quota reached. Please upgrade your subscription to increase your',
    'limits. Resets in 118h12m56s.',
    'Error ID: 05e31602-daa9-494e-8b02-31f32545a6d7-56',
  ];
  const prompt = ['────────────────', '>', '────────────────', '? for shortcuts    auto · Gemini 4 Hydrogen · medium'];

  it('reads the wrapped refusal in the live idle region, excluding the Error ID', () => {
    expect(agy.usageLimit(['● Ran (cd ~/work) (ctrl+o to expand)', ...refusal, ...prompt]))
      .toBe('Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 118h12m56s.');
  });

  it('reads a short refusal with the duration and the mode hint', () => {
    const modePrompt = prompt.map(line => line === '>' ? '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)' : line);
    expect(agy.usageLimit(['⚠ Individual quota reached. Resets in 2h5m.', ...modePrompt]))
      .toBe('Individual quota reached. Resets in 2h5m.');
  });

  it.each([
    ['later transcript', [...refusal, 'New prompt echo', 'More work completed', ...prompt]],
    ['working footer', [...refusal, ...prompt.slice(0, -1), 'esc to cancel     Gemini 4 Hydrogen · medium']],
    ['background command', [...refusal, ...prompt, '● [12:30:00] npm running']],
    ['draft below an older prompt', [...refusal, ...prompt.slice(0, -1), '> typed command', prompt.at(-1)]],
    ['quoted refusal', ['> ⚠ Individual quota reached. Resets in 118h12m56s.', ...prompt]],
    ['command output', ['│ ⚠ Individual quota reached. Resets in 118h12m56s.', ...prompt]],
    ['ordinary prompt', ['Ready for input', ...prompt]],
    ['threshold warning', ['⚠ Individual quota almost reached. Resets in 4h.', ...prompt]],
    ['malformed reset', ['⚠ Individual quota reached. Resets in someday.', ...prompt]],
    ['unrecognized diagnostic', ['⚠ Individual quota reached. user@example.test', ...prompt]],
    ['transient throttling', ['Error: 429 Too many requests', ...prompt]],
  ])('ignores %s', (_, lines) => {
    expect(agy.usageLimit(lines)).toBeNull();
  });
});

describe.each(quotaScreens)('$profile.id quota screen evidence', fixture => {
  const { profile, refusal, idle } = fixture;

  it('identifies a settled refusal at the idle input', () => {
    expect(profile.usageLimit?.([...refusal, ...idle])).toEqual(expect.stringMatching(/quota|limit/));
  });

  it.each(Object.entries(quotaNegatives(fixture)))('rejects %s output', (_, screen) => {
    expect(profile.usageLimit?.(screen)).toBeNull();
  });
});

it.each([
  '■ You’ve hit your usage limit for GPT-6.2. Switch to another model now, or try again at Nov 25th, 2026 9:00 PM.',
  '■ You’ve hit your usage limit. Try again later.',
  '■ You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again later.',
])('recognizes Codex formatter variants: %s', refusal => {
  const { profile, idle } = quotaScreens.find(({ profile }) => profile.id === 'codex');
  const split = refusal.split(' ');
  expect(profile.usageLimit?.([split.slice(0, 11).join(' '), split.slice(11).join(' '), ...idle]))
    .toBe('You’ve hit your usage limit.');
});

// Claude Code 2.1.330 builds `You've hit your ${limitName}${' · resets ' + time}${' · progress saved'}`
// with limit names from its rate-limit table, a time within a day ("9pm", "9:30pm") or a date
// beyond it ("Nov 28, 9pm"), and advice lines from its upsell table, which use a curly apostrophe.
it.each([
  ["You've hit your 5-hour limit · resets 9:30pm (Africa/Johannesburg)"],
  ["You've hit your weekly limit · resets Nov 28, 9pm (Africa/Johannesburg) · progress saved"],
  ["You've hit your Opus limit · resets Dec 1, 2027, 10am (UTC)"],
  ["You've hit your Sonnet limit · resets 9pm (UTC)", '/upgrade or /usage-credits to finish what you’re working on.'],
  ["You've hit your Fable limit · resets 9pm (UTC)", '/usage-credits to finish what you’re working on.'],
  ["You've hit your usage limit · resets 9pm (UTC)", '/usage-credits to request more usage from your admin.'],
  ["You've hit your limit · resets 9pm (UTC)", '/login to switch to an API usage-billed account.'],
  ["You've hit your session limit · resets 9pm (UTC)", '/usage-credits to adjust your monthly spend limit.'],
])('recognizes the installed Claude Code refusal: %s', (...refusal) => {
  const { profile, idle } = quotaScreens.find(({ profile }) => profile.id === 'claude');
  expect(profile.usageLimit?.([...refusal, ...idle])).toBe("You've hit your usage limit.");
});

it.each([
  ["You've hit your 5-hour limit · resets someday (UTC)"],
  ["You've hit your weekly limit · resets Nov 28, 9pm (UTC)", 'Try this other thing instead.'],
])('rejects an unfamiliar Claude Code refusal: %s', (...refusal) => {
  const { profile, idle } = quotaScreens.find(({ profile }) => profile.id === 'claude');
  expect(profile.usageLimit?.([...refusal, ...idle])).toBeNull();
});

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

  it('reports Antigravity folder trust as needing input', () => {
    expect(classify(screen('agy/needs-input-trust.txt')))
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
