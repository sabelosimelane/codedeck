import { ELAPSED, dialogTail, promptRegion, screenLines } from './live-region.js';

export const id = 'muse';
// How this CLI invokes a skill; workflow prompts are written with `/name`.
export const skillPrefix = '/';

const INPUT_PROMPT = /^❯(?:\s|$)/u;
const DIALOG_OPTION = /^⟩ \d+\s/u;
const DIALOG_HINT = /^Use Up\/Down\b/;
// `◈ Thinking (5s · esc to interrupt)`, `◇ Running command · … — running (10s · esc to interrupt)`
const LIVE_STATUS = new RegExp(String.raw`^\S .*\(${ELAPSED} · esc to interrupt\)`, 'u');

export function matches({ foregroundCommand, lines }) {
  if (foregroundCommand === 'muse' || /^muse-bin-\d+(?:\.\d+)*(?:-R\d+(?:\.\d+)*)?$/.test(foregroundCommand)) return true;
  const text = screenLines(lines);
  return text.some(line => /^Muse Code\b|^── Voice input/.test(line))
    || (text.some(line => DIALOG_OPTION.test(line)) && text.some(line => DIALOG_HINT.test(line)));
}

export function promptVisible(lines) {
  return Boolean(promptRegion(lines, line => INPUT_PROMPT.test(line)).prompt);
}

// Match the untouched startup screen in full. An empty input box alone is
// also visible during normal work and after a completed turn.
export function emptyWelcomePrompt(lines) {
  const text = screenLines(lines).filter(Boolean);
  const banner = text.findLastIndex(line => /^Muse Code \d+\.\d+\.\d+$/.test(line));
  if (banner < 0) return false;
  const skills = text.findIndex((line, index) => index > banner && /^Skills: \d+ loaded\b/.test(line));
  if (skills < 0 || (skills > banner + 1 && !text[banner + 1].startsWith('warning: rules file '))) return false;
  let i = skills + 1;
  if (/^To continue this session, run muse resume [0-9a-f-]{36}$/.test(text[i])) i++;
  return text.length === i + 4
    && /^── Voice input \(alt\(option\)\+v to start\) ─+$/.test(text[i])
    && text[i + 1] === '❯'
    && /^─+$/.test(text[i + 2])
    && /^muse-[^·]+ · [^·]+ · /.test(text[i + 3]);
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
