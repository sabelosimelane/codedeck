import { dialogTail, screenLines } from './live-region.js';

export const id = 'kiro';
export const skillPrefix = '/';

// The status row above the input: `Default · claude-haiku-5.5 · thinking · medium · ◔ 2%   ~/path ·`.
// The pie glyph fills with the context used.
const STATUS_ROW = / · [○◔◑◕●] \d+%/u;
const PROMPT = /^[›>❯](?:\s|$)/u;
const PLACEHOLDER = /^ask a question,? or describe a task\b/iu;
const WORKING_PROMPT = /^Kiro is working · /u;
// `ᗣ Thinking... (esc to cancel)` between the transcript and the status row.
const THINKING = /^(?:\S{1,2} )?Thinking\.\.\.(?: \(esc to cancel\))?$/u;
const RULE = /^[─━\s]+$/u;
const LINES_ABOVE_STATUS = 3;
const CHROME = [/· \/quit to exit$/u, /^\/sessions to resume · /u];
const DIALOGS = [
  /^Allow this action\?/u,
  /^Trust this workspace\?/u,
  /\bLogin now\?/u,
  /^Welcome to Kiro CLI, let's get you signed in!/u,
  /^Kiro CLI 3\.0 is here\./u,
];

export function matches({ foregroundCommand, lines }) {
  if (['kiro', 'kiro-cli', 'kiro-cli-chat'].includes(foregroundCommand)) return true;
  const text = screenLines(lines);
  return Boolean(inputRow(text))
    || text.some(line => CHROME.some(pattern => pattern.test(line)))
    || dialogTail(lines).some(line => DIALOGS.some(pattern => pattern.test(line)));
}

// The prompt is the first prompt line after the last status row; transcript `>` lines come before it.
function inputRow(text) {
  const status = text.findLastIndex(line => STATUS_ROW.test(line));
  if (status < 0) return null;
  const offset = text.slice(status + 1).findIndex(line => PROMPT.test(line));
  if (offset < 0) return null;
  const index = status + 1 + offset;
  return { status, index, input: text[index].replace(PROMPT, '').trim() };
}

export function promptVisible(lines) {
  return inputRow(screenLines(lines)) !== null;
}

export function read(lines) {
  const text = screenLines(lines);
  const row = inputRow(text);
  // A dialog replaces the input; one above the status row was answered already.
  const dialogFrom = row ? row.status + 1 : 0;
  const tail = dialogTail(lines);
  const dialogStart = text.filter(Boolean).length - tail.length;
  const nonBlank = text.map((line, index) => ({ line, index })).filter(({ line }) => line);
  const pendingDialog = tail.some((line, at) => nonBlank[dialogStart + at].index >= dialogFrom
    && DIALOGS.some(pattern => pattern.test(line)));
  if (pendingDialog) return { turn: 'needs_input', backgroundShells: 0 };
  if (!row) return { turn: 'idle', backgroundShells: 0 };
  const above = text.slice(0, row.status).filter(line => line && !RULE.test(line)).slice(-LINES_ABOVE_STATUS);
  const working = WORKING_PROMPT.test(row.input) || above.some(line => THINKING.test(line));
  return { turn: working ? 'working' : 'idle', backgroundShells: 0 };
}

/** A prompt still in the input row: Kiro took the Enter after the paste as ending the paste. */
export function draftPending(lines) {
  const row = inputRow(screenLines(lines));
  return row !== null && row.input !== '' && !PLACEHOLDER.test(row.input) && !WORKING_PROMPT.test(row.input);
}
