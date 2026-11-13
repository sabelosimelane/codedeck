import { ELAPSED, dialogTail, promptRegion, screenLines } from './live-region.js';

export const id = 'muse';

const INPUT_PROMPT = /^❯(?:\s|$)/u;
const DIALOG_OPTION = /^⟩ \d+\s/u;
const DIALOG_HINT = /^Use Up\/Down\b/;
// `◈ Thinking (5s · esc to interrupt)`, `◇ Running command · … — running (10s · esc to interrupt)`
const LIVE_STATUS = new RegExp(String.raw`^\S .*\(${ELAPSED} · esc to interrupt\)`, 'u');

export function matches({ foregroundCommand, lines }) {
  if (foregroundCommand === 'muse') return true;
  const text = screenLines(lines);
  return text.some(line => /^Muse Code\b|^── Voice input/.test(line))
    || (text.some(line => DIALOG_OPTION.test(line)) && text.some(line => DIALOG_HINT.test(line)));
}

export function promptVisible(lines) {
  return Boolean(promptRegion(lines, line => INPUT_PROMPT.test(line)).prompt);
}

export function read(lines) {
  const tail = dialogTail(lines);
  if (tail.some(line => DIALOG_OPTION.test(line)) && tail.some(line => DIALOG_HINT.test(line))) {
    return { turn: 'needs_input', backgroundShells: 0 };
  }

  const region = promptRegion(lines, line => INPUT_PROMPT.test(line));
  const turn = region.above.some(line => LIVE_STATUS.test(line)) ? 'working' : 'idle';
  return { turn, backgroundShells: 0 };
}
