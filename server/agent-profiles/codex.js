import { ELAPSED, count, dialogTail, promptRegion, screenLines } from './live-region.js';

export const id = 'codex';

const INPUT_PROMPT = /^›(?:\s|$)/u;
const DIALOG_OPTION = /^› \d+\. /u;
const DIALOG_HINT = /\benter (?:to )?(?:confirm|continue)\b/i;
// `• Working (27s • esc to interrupt)`, `• Starting MCP servers (22/26): … (1s • esc to interrupt)`
const LIVE_STATUS = new RegExp(String.raw`^• .*\(${ELAPSED} [•·] esc to interrupt\)`, 'u');
const BACKGROUND_TERMINALS = /\b(\d+) background terminals? running\b/i;

export function matches({ foregroundCommand, lines }) {
  if (foregroundCommand === 'codex') return true;
  const text = screenLines(lines);
  return text.some(line => /^>_ OpenAI Codex\b/.test(line))
    || text.some(line => INPUT_PROMPT.test(line))
    || (text.some(line => DIALOG_OPTION.test(line)) && text.some(line => DIALOG_HINT.test(line)));
}

export function promptVisible(lines) {
  return Boolean(promptRegion(lines, line => INPUT_PROMPT.test(line) && !DIALOG_OPTION.test(line)).prompt);
}

export function read(lines) {
  const tail = dialogTail(lines);
  if (tail.some(line => DIALOG_OPTION.test(line)) && tail.some(line => DIALOG_HINT.test(line))) {
    return { turn: 'needs_input', backgroundShells: 0 };
  }

  const region = promptRegion(lines, line => INPUT_PROMPT.test(line) && !DIALOG_OPTION.test(line));
  const backgroundShells = count([...region.above, ...region.below].join(' '), BACKGROUND_TERMINALS);
  const turn = region.above.some(line => LIVE_STATUS.test(line)) ? 'working' : 'idle';
  return { turn, backgroundShells };
}
