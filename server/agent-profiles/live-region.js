/**
 * Shared helpers for reading the live region of an agent CLI screen: the
 * status line(s) directly above the input prompt and the footer below it.
 * Transcript text above that region is never inspected, so an answer that
 * happens to look like a spinner cannot be mistaken for one.
 */

const STATUS_LINES_ABOVE_PROMPT = 3;
const DIALOG_TAIL_LINES = 16;
const BOX_DRAWING_ONLY = /^[─━╌═│╭╰╮╯\s]+$/u;

/** Elapsed counter as the CLIs print it: `27s`, `3m 12s`, `1h 02m 03s`. */
export const ELAPSED = String.raw`(?:\d+h )?(?:\d+m )?\d+s`;

export function screenLines(lines) {
  return lines.map(line => line.replace(/\r/g, '').trim());
}

/** The last non-blank lines of the screen, where a selection dialog sits. */
export function dialogTail(lines) {
  return screenLines(lines).filter(Boolean).slice(-DIALOG_TAIL_LINES);
}

/**
 * Locate the last line accepted by `isPrompt` and return the status lines just
 * above it (rules and blank lines skipped) plus everything below it.
 */
export function promptRegion(lines, isPrompt) {
  const text = screenLines(lines);
  let index = -1;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (isPrompt(text[i])) {
      index = i;
      break;
    }
  }
  if (index < 0) return { above: [], below: [], prompt: '' };

  const above = [];
  for (let i = index - 1; i >= 0 && above.length < STATUS_LINES_ABOVE_PROMPT; i -= 1) {
    if (text[i] && !BOX_DRAWING_ONLY.test(text[i])) above.unshift(text[i]);
  }
  return { above, below: text.slice(index + 1).filter(Boolean), prompt: text[index] };
}

export function count(text, pattern) {
  const match = text.match(pattern);
  return match ? Number(match[1]) : 0;
}
