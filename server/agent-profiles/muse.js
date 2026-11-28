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
  return Boolean(promptRegion(lines, line => INPUT_PROMPT.test(line)).prompt) || inputBox(lines) !== null;
}

// The input box at the bottom: the voice-input rule, its text, a closing rule and the footer.
// Muse scrolls a draft taller than the box inside it, so the `❯` line can be off screen.
function inputBox(lines) {
  const text = screenLines(lines);
  let end = text.length - 1;
  while (end >= 0 && !text[end]) end -= 1;
  if (end < 2 || !STATUS_FOOTER.test(text[end]) || !/^─+$/.test(text[end - 1])) return null;
  const start = text.findLastIndex((line, index) => index < end - 1 && VOICE_RULE.test(line));
  return start < 0 ? null : text.slice(start + 1, end - 1);
}

/** Text typed or pasted into the input box and not yet sent. */
export function draftPending(lines) {
  const box = inputBox(lines);
  return box !== null && box.some(line => line && line !== '❯');
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

  // A draft taller than the input box hides `❯`; the status then sits above the voice-input rule.
  const visible = withoutTodoChecklist(lines);
  const region = promptRegion(visible, line => INPUT_PROMPT.test(line));
  const above = region.prompt ? region.above : promptRegion(visible, line => VOICE_RULE.test(line)).above;
  const turn = above.some(line => LIVE_STATUS.test(line)) ? 'working' : 'idle';
  return { turn, backgroundShells: 0 };
}

// Muse draws its todo checklist between the live status line and the input box, one item per line
// indented two spaces (`  ✓ done`, `  ◆ current`); transcript and status lines start at column 0.
// A long checklist would push the status out of the lines read above the prompt, so it is set aside.
const TODO_ITEM = /^ {2}\S /u;

function withoutTodoChecklist(lines) {
  const rule = lines.findLastIndex(line => VOICE_RULE.test(line.replace(/\r/g, '').trim()));
  if (rule < 0) return lines;
  // Blank lines frame the checklist on screen; only a block that holds at least one item is set aside.
  let start = rule;
  let items = 0;
  while (start > 0) {
    const line = lines[start - 1].replace(/\r/g, '');
    if (TODO_ITEM.test(line)) items += 1;
    else if (line.trim()) break;
    start -= 1;
  }
  return items === 0 ? lines : [...lines.slice(0, start), ...lines.slice(rule)];
}

const VOICE_RULE = /^── Voice input \(alt\(option\)\+v to start\) ─+$/u;
const STATUS_FOOTER = /^muse-[^·]+ · [^·]+ · \S.*$/u;
const EXHAUSTED_WINDOW = /^You've used your (?:\d{1,3}-(?:hour|minute)|daily|weekly) quota \(resets at (?:0?[1-9]|1[0-2]):[0-5]\d [AP]M\)\.?$/i;

export function usageLimit(lines) {
  const { above, below, prompt } = promptRegion(lines, line => INPUT_PROMPT.test(line));
  if (prompt !== '❯' || below.length !== 2 || !/^─+$/.test(below[0]) || !STATUS_FOOTER.test(below[1])) return null;
  if (!VOICE_RULE.test(above.at(-1)) || read(lines).turn !== 'idle') return null;
  return EXHAUSTED_WINDOW.test(above.at(-2)) ? 'Muse Code quota exhausted.' : null;
}
