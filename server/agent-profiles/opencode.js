import { dialogTail, promptRegion, screenLines } from './live-region.js';

export const id = 'opencode';
export const skillPrefix = '/';

const PROMPT = /^┃(?:\s|$)/u;
const BANNER = /^▪ oc mini v\d+\.\d+\.\d+\b/u;
const FOOTER = /· ctrl\+p menu$/u;
// The spinner frame before `esc interrupt` is one glyph in every capture (`🯦`); allow a short run in case.
const WORKING_FOOTER = /^(?:\S{1,4} )?esc interrupt · /u;
// `△ Permission required` / `△ Reject permission` with a `… enter confirm …` key hint.
const DIALOG_TITLE = /^△ \S/u;
const DIALOG_HINT = /\benter confirm\b/u;

export function matches({ foregroundCommand, lines }) {
  if (foregroundCommand === 'opencode') return true;
  const text = screenLines(lines);
  return text.some(line => BANNER.test(line))
    || promptRegion(lines, line => PROMPT.test(line)).below.some(line => FOOTER.test(line));
}

export function promptVisible(lines) {
  return Boolean(promptRegion(lines, line => PROMPT.test(line)).prompt);
}

export function read(lines) {
  const tail = dialogTail(lines);
  if (tail.some(line => DIALOG_TITLE.test(line)) && tail.some(line => DIALOG_HINT.test(line))) {
    return { turn: 'needs_input', backgroundShells: 0 };
  }
  const { below } = promptRegion(lines, line => PROMPT.test(line));
  return {
    turn: below.some(line => WORKING_FOOTER.test(line)) ? 'working' : 'idle',
    backgroundShells: 0,
  };
}
