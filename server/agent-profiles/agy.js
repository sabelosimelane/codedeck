import { dialogTail, promptRegion, screenLines } from './live-region.js';

export const id = 'agy';
// How this CLI invokes a skill; workflow prompts are written with `/name`.
export const skillPrefix = '/';

// The empty input line: `>`, or, once a turn is over, `>` with the mode as a hint in it:
// `> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)`.
const INPUT_PROMPT = /^>(?: [A-Z][\w-]* mode: .*\(shift\+tab to cycle\))?$/;
const DIALOG_OPTION = /^> \S/;
const DIALOG_HINT = /↑\/↓ Navigate\b/;
// `⣻  Generating...`: any braille spinner frame followed by a status phrase.
const SPINNER = /^[⠀-⣿]+\s+\S.*\.\.\.$/u;
// Footer: `? for shortcuts   <model> · <effort>` idle, `esc to cancel   …` mid-turn.
const FOOTER = /^(?:\? for shortcuts|esc to cancel)\s{2,}\S.* · \S+$/;
const BUSY_FOOTER = /^esc to cancel\b/;
const RUNNING_TASK_ROW = /^● \[\d{2}:\d{2}:\d{2}\]\s+.*\brunning$/;
const QUOTA_HEADING = /^⚠ Individual quota reached\./;
const QUOTA_REFUSAL = /^⚠ Individual quota reached\.(?: Please upgrade your subscription to increase your limits\.)? Resets in (?=\d)(?:\d{1,4}h)?(?:\d{1,2}m)?(?:\d{1,2}s)?\.$/;

export function matches({ foregroundCommand, lines }) {
  if (foregroundCommand === 'agy') return true;
  const text = screenLines(lines);
  return text.some(line => /^Antigravity CLI\b/.test(line))
    || text.some(line => FOOTER.test(line));
}

export function promptVisible(lines) {
  return Boolean(promptRegion(lines, line => INPUT_PROMPT.test(line)).prompt);
}

export function usageLimit(lines) {
  const { above, below, prompt } = promptRegion(lines, line => INPUT_PROMPT.test(line));
  if (!prompt) return null;
  const footer = below.filter(line => !/^[─━]+$/.test(line));
  if (footer.length !== 1 || !FOOTER.test(footer[0]) || BUSY_FOOTER.test(footer[0])) return null;

  const warning = above.findLastIndex(line => QUOTA_HEADING.test(line));
  if (warning < 0) return null;
  const refusal = above.slice(warning);
  if (/^Error ID: [a-f0-9-]+$/i.test(refusal.at(-1))) refusal.pop();
  const text = refusal.join(' ');
  return QUOTA_REFUSAL.test(text) ? text.slice('⚠ '.length) : null;
}

export function read(lines) {
  const tail = dialogTail(lines);
  if (tail.some(line => DIALOG_OPTION.test(line)) && tail.some(line => DIALOG_HINT.test(line))) {
    return { turn: 'needs_input', backgroundShells: 0 };
  }

  const region = promptRegion(lines, line => INPUT_PROMPT.test(line));
  // Only live `● [hh:mm:ss] … running` rows count — a leftover `N task(s)` footer alone
  // must not pin an idle agent as waiting forever.
  const backgroundShells = region.below.filter(line => RUNNING_TASK_ROW.test(line)).length;
  const working = region.above.some(line => SPINNER.test(line))
    && region.below.some(line => BUSY_FOOTER.test(line));
  return { turn: working ? 'working' : 'idle', backgroundShells };
}
