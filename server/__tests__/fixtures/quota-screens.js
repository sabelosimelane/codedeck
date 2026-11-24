import * as agy from '../../agent-profiles/agy.js';
import * as claude from '../../agent-profiles/claude.js';
import * as codex from '../../agent-profiles/codex.js';
import * as cursor from '../../agent-profiles/cursor.js';
import * as muse from '../../agent-profiles/muse.js';

// Refusal text provenance is documented in §4 of the run-step agents/fallbacks spec.
// Idle and working controls come from the adjacent agent-screens captures.
export const quotaScreens = [
  {
    profile: agy, command: 'agy',
    refusal: ['⚠ Individual quota reached. Resets in 2h5m.'],
    idle: ['─', '>', '─', '? for shortcuts    auto · Gemini 4 Hydrogen · medium'],
    working: ['⣻  Generating...'],
    delegated: ['● [12:30:00] npm running'],
    forecast: '⚠ Individual quota almost reached. Resets in 4h.',
  },
  {
    profile: claude, command: '2.1.330',
    refusal: ["You've hit your session limit · resets 9pm (Africa/Johannesburg)"],
    idle: ['─', '❯', '─', 'dev ~/work/demo…', '⏵⏵ bypass permissions on (shift+tab to cycle)'],
    working: ['✽ Hatching… (17s · ↓ 88 tokens)'],
    delegated: ['⏵⏵ bypass permissions on · 1 shell'],
    forecast: 'Approaching session limit. Switching off fast mode.',
  },
  {
    profile: codex, command: 'codex',
    refusal: ['■ You’ve hit your usage limit. Try again at 9:00 PM.'],
    idle: ['› Ask Codex to do anything', 'GPT-6.1-Sol high · ~/work/demo · Ready · Context 59% used', '← for agents · ? for shortcuts'],
    working: ['• Working (27s • esc to interrupt)'],
    delegated: ['1 background terminal running · /ps to view · /stop to close'],
    forecast: '⚠ You have less than 10% of your weekly limit left.',
  },
  {
    profile: cursor, command: 'cursor-agent',
    refusal: ["Error: You've hit your usage limit", 'Get Cursor Pro for more Agent usage, unlimited Tab, and more.',
      'fallbackModel:', 'spendLimitHit: false',
      'chatMessage: *Your usage limits will reset when your monthly cycle ends on 10/2/2026.*', 'spendLimits: [50,100,200]'],
    idle: ['→ Add a follow-up', 'Composer 2.5 · 6.9%    Run Everything', '~/work/demo · main'],
    working: [],
    delegated: ['$ sleep 15', 'Running in background'],
    forecast: 'Get Cursor Pro for more Agent usage, unlimited Tab, and more.',
  },
  {
    profile: muse, command: 'muse',
    refusal: ["You've used your 5-hour quota (resets at 9:00 PM)."],
    idle: ['── Voice input (alt(option)+v to start) ───', '❯', '───', 'muse-spark-1.3-contributor · high · ~/work/demo · YOLO'],
    working: ['◈ Thinking (5s · esc to interrupt)'],
    delegated: ['◇ Running command · sleep — running (10s · esc to interrupt)'],
    forecast: 'At this pace your 5-hour quota runs out in about 15 minutes.',
  },
];

export function quotaNegatives({ profile, refusal, idle, working, delegated, forecast }) {
  const promptIndex = idle.findIndex(line => /^[>›→❯]/u.test(line));
  const typed = idle.map((line, index) => index === promptIndex ? line[0] + ' typed command' : line);
  const busy = idle.map((line, index) => {
    if (profile.id === 'agy') return line.replace('? for shortcuts', 'esc to cancel   ');
    if (profile.id === 'cursor' && index === promptIndex) return line + '    ctrl+c to stop';
    return line;
  });
  return {
    working: [...refusal, ...working, ...busy],
    delegated: [...refusal, ...idle, ...delegated],
    quoted: [...refusal.map(line => '> ' + line), ...idle],
    reply: [...refusal.map(line => '• ' + line), ...idle],
    command: [...refusal.map(line => '│ ' + line), ...idle],
    draft: [...refusal, ...typed],
    historical: [...refusal, 'A more recent prompt was submitted', 'More work completed', ...idle],
    forecast: [forecast, ...idle],
    ...(profile.id === 'muse' && { 'last reported status': ['Usage exhausted (last reported)', ...idle] }),
    malformed: [refusal[0] + ' unfamiliar refusal decoration', ...idle],
    login: ['Authentication required. Please sign in again.', ...idle],
    throttled: ['API Error: Server is temporarily limiting requests.', ...idle],
    '429': ['Error: 429 Too many requests', ...idle],
  };
}
