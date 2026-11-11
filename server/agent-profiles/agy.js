import { dialogTail, promptRegion, screenLines } from './live-region.js';

export const id = 'agy';

const INPUT_PROMPT = /^>$/;
const DIALOG_OPTION = /^> \S/;
const DIALOG_HINT = /↑\/↓ Navigate\b/;
// `⣻  Generating...`: any braille spinner frame followed by a status phrase.
const SPINNER = /^[⠀-⣿]+\s+\S.*\.\.\.$/u;
// Footer: `? for shortcuts   <model> · <effort>` idle, `esc to cancel   …` mid-turn.
const FOOTER = /^(?:\? for shortcuts|esc to cancel)\s{2,}\S.* · \S+$/;
const BUSY_FOOTER = /^esc to cancel\b/;

export function matches({ foregroundCommand, lines }) {
  if (foregroundCommand === 'agy') return true;
  const text = screenLines(lines);
  return text.some(line => /^Antigravity CLI\b/.test(line))
    || text.some(line => FOOTER.test(line));
}

export function read(lines) {
  const tail = dialogTail(lines);
  if (tail.some(line => DIALOG_OPTION.test(line)) && tail.some(line => DIALOG_HINT.test(line))) {
    return { turn: 'needs_input', backgroundShells: 0 };
  }

  const region = promptRegion(lines, line => INPUT_PROMPT.test(line));
  const working = region.above.some(line => SPINNER.test(line))
    && region.below.some(line => BUSY_FOOTER.test(line));
  return { turn: working ? 'working' : 'idle', backgroundShells: 0 };
}
