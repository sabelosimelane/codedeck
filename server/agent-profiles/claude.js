import { count, dialogTail, promptRegion, screenLines } from './live-region.js';

export const id = 'claude';
// How this CLI invokes a skill; workflow prompts are written with `/name`.
export const skillPrefix = '/';

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

// Claude Code 2.1.330 composes the refusal from its rate-limit names and a reset time that is
// "9pm"/"9:30pm" within a day and "Nov 28, 9pm" (with the year when it differs) beyond it.
const RESET_TIME = String.raw`(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, (?:\d{4}, )?)?(?:[1-9]|1[0-2])(?::[0-5]\d)?[ap]m`;
const SESSION_LIMIT = new RegExp(String.raw`^You've hit your (?:(?:session|5-hour|weekly|Opus|Sonnet|Fable|usage) )?limit · resets ${RESET_TIME} \([A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*\)(?: · progress saved)?$`);
// Its upsell table; "you’re" is printed with a curly apostrophe.
const LIMIT_ADVICE = /^(?:Use your limit reset to reset it now: clau\.de\/reset|\/upgrade to increase your usage limit\.|\/upgrade or \/usage-credits to finish what you[’']re working on\.|\/usage-credits to finish what you[’']re working on\.|\/usage-credits to adjust your monthly spend limit\.|\/usage-credits to request more usage from your admin\.|\/login to switch to an API usage-billed account\.)$/u;
const INPUT_RULE = /^[─━▔▁]+$/u;
const SHORT_TURN_COMPLETE = /^[·✢✳✶✻✽✼✱*] \S+ for \d+(?:m \d+)?s$/u;

export function usageLimit(lines) {
  const { above, below, prompt } = promptRegion(lines, line => INPUT_PROMPT.test(line), 5);
  if (prompt !== '❯' || !INPUT_RULE.test(below[0]) || !MODE_FOOTER.test(below.at(-1)) || below.length > 3) return null;
  const turn = read(lines);
  if (turn.turn !== 'idle' || turn.backgroundShells || / · [1-9]\d* agents?\b/.test(below.at(-1))) return null;

  const heading = above.findLastIndex(line => SESSION_LIMIT.test(line));
  if (heading < 0) return null;
  const trailing = above.slice(heading + 1);
  if (trailing.at(-1) && (TURN_COMPLETE.test(trailing.at(-1)) || SHORT_TURN_COMPLETE.test(trailing.at(-1)))) trailing.pop();
  return trailing.length <= 2 && trailing.every(line => LIMIT_ADVICE.test(line))
    ? "You've hit your usage limit."
    : null;
}
