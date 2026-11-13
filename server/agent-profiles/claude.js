import { count, dialogTail, promptRegion, screenLines } from './live-region.js';

export const id = 'claude';

const INPUT_PROMPT = /^❯(?:\s|$)/u;
const MODE_FOOTER = /^⏵⏵ /u;
const DIALOG_HINT = /\bEsc to cancel\b/;
// `✽ Hatching… (17s · ↓ 88 tokens)`: a spinner glyph, a verb phrase, an ellipsis.
const SPINNER = /^[·✢✳✶✻✽✼✱*] \S.*…/u;
// `✻ Baked for 24s · done 22:05` is the finished form of the same line.
const TURN_COMPLETE = /^[·✢✳✶✻✽✼✱*] \S+ for .* · done\b/u;
const BACKGROUND_SHELLS = /· (\d+) shells?\b/;

export function matches({ foregroundCommand, lines }) {
  // tmux reports Claude Code's foreground command as its version, e.g. `2.1.321`.
  if (/^\d+\.\d+\.\d+$/.test(foregroundCommand)) return true;
  const text = screenLines(lines);
  return text.some(line => /Claude Code v\d|Claude Code'll be able/.test(line))
    || text.some(line => MODE_FOOTER.test(line));
}

export function promptVisible(lines) {
  return Boolean(promptRegion(lines, line => INPUT_PROMPT.test(line)).prompt);
}

export function read(lines) {
  const tail = dialogTail(lines);
  // A selection dialog replaces the prompt box, so its mode footer is gone.
  if (tail.some(line => INPUT_PROMPT.test(line))
    && tail.slice(-4).some(line => DIALOG_HINT.test(line))
    && !tail.some(line => MODE_FOOTER.test(line))) {
    return { turn: 'needs_input', backgroundShells: 0 };
  }

  const region = promptRegion(lines, line => INPUT_PROMPT.test(line));
  const backgroundShells = count(region.below.find(line => MODE_FOOTER.test(line)) || '', BACKGROUND_SHELLS);
  const turn = region.above.some(line => SPINNER.test(line) && !TURN_COMPLETE.test(line)) ? 'working' : 'idle';
  return { turn, backgroundShells };
}
