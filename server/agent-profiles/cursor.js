import { promptRegion, screenLines } from './live-region.js';

export const id = 'cursor';
// How this CLI invokes a skill; workflow prompts are written with `/name`.
export const skillPrefix = '/';

// `→ Plan, search, build anything` when fresh, `→ Add a follow-up` afterwards.
const INPUT_PROMPT = /^→ (?:Add a follow-up|Plan, search, build anything)\b/u;
// The prompt line carries `ctrl+c to stop` on its right edge only mid-turn.
const WORKING_HINT = /\bctrl\+c to stop$/;
const TRUST_OPTION = /^│\s*▶ \[\w\] /u;
// Text in the input replaces the placeholder, leaving `→ <text>`. Such a line is the prompt
// only above Cursor's footer, which shows the context used: `Auto · 35.7% · 5 files edited`.
const TYPED_PROMPT = /^→ \S/u;
const FOOTER = / · \d+(?:\.\d+)?%(?: ·|\s{2,}|$)/u;
const FOOTER_TAIL_LINES = 4;

/** Returns the test for this screen's prompt line. */
function promptTest(text) {
  const footer = text.filter(Boolean).slice(-FOOTER_TAIL_LINES).some(line => FOOTER.test(line));
  return line => INPUT_PROMPT.test(line) || (footer && TYPED_PROMPT.test(line));
}

export function matches({ foregroundCommand, lines }) {
  if (foregroundCommand === 'agent' || foregroundCommand === 'cursor-agent') return true;
  const text = screenLines(lines);
  return text.some(line => /^Cursor Agent$/.test(line))
    || text.some(promptTest(text))
    || (text.some(line => TRUST_OPTION.test(line)) && text.some(line => /Trust this workspace/.test(line)));
}

export function promptVisible(lines) {
  return Boolean(promptRegion(lines, promptTest(screenLines(lines))).prompt);
}

export function read(lines) {
  const text = screenLines(lines);
  const isPrompt = promptTest(text);
  const hasPrompt = text.some(isPrompt);
  if (!hasPrompt && text.some(line => TRUST_OPTION.test(line))) {
    return { turn: 'needs_input', backgroundShells: 0 };
  }

  const region = promptRegion(lines, isPrompt);
  return { turn: WORKING_HINT.test(region.prompt) ? 'working' : 'idle', backgroundShells: 0 };
}

const FOLLOW_UP = '→ Add a follow-up';
const LIMIT_HEADING = "Error: You've hit your usage limit";
const UPGRADE_ADVICE = 'Get Cursor Pro for more Agent usage, unlimited Tab, and more.';
const PLAN_DETAILS = /^fallbackModel: spendLimitHit: (?:false|true) chatMessage: \*Your usage limits will reset when your monthly cycle ends on \d{1,2}\/\d{1,2}\/\d{4}\.\* spendLimits: \[\d+(?:,\s?\d+)*\]$/;

export function usageLimit(lines) {
  const text = screenLines(lines);
  const { above, below, prompt } = promptRegion(lines, promptTest(text), 9);
  if (prompt !== FOLLOW_UP || below.length !== 2 || !FOOTER.test(below[0]) || !/^\S+ · \S+$/.test(below[1])) return null;

  const heading = above.lastIndexOf(LIMIT_HEADING);
  if (heading < 0) return null;
  const details = above.slice(heading + 1).join(' ');
  if (details === UPGRADE_ADVICE || (details.startsWith(UPGRADE_ADVICE + ' ')
    && PLAN_DETAILS.test(details.slice(UPGRADE_ADVICE.length + 1)))) {
    return "You've hit your Cursor usage limit.";
  }
  return null;
}
