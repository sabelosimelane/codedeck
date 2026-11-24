import { ELAPSED, count, dialogTail, promptRegion, screenLines } from './live-region.js';

export const id = 'codex';
// Codex invokes a skill with `$name`; a workflow prompt writes it as `/name`.
export const skillPrefix = '$';

const INPUT_PROMPT = /^›(?:\s|$)/u;
const DIALOG_OPTION = /^› \d+\. /u;
const DIALOG_HINT = /\benter (?:to )?(?:confirm|continue)\b/i;
// `• Working (27s • esc to interrupt)`, `• Starting MCP servers (22/26): … (1s • esc to interrupt)`
const LIVE_STATUS = new RegExp(String.raw`^• .*\(${ELAPSED} [•·] esc to interrupt\)`, 'u');
const BACKGROUND_TERMINALS = /\b(\d+) background terminals? running\b/i;
// The run state in the footer, when the status line has it and the pane is wide enough to show it:
// `GPT-6.2-Sol medium · ~/work/demo · Working · Context 10% used`. Codex hides the live status line
// while it writes text, between tools and for its final answer; the footer still says Working then.
const FOOTER_WORKING = /(?:^| · )Working(?: · |$)/u;

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
  const working = region.above.some(line => LIVE_STATUS.test(line)) || region.below.some(line => FOOTER_WORKING.test(line));
  const turn = working ? 'working' : 'idle';
  return { turn, backgroundShells };
}

// Codex's usage-limit error history cell starts with ■. Match its formatter's
// complete refusal and return fixed text so account/model detail stays in the terminal.
const IDLE_INPUT = /^›(?: Ask Codex to do anything)?$/u;
const SHORTCUTS = /^(?:← for agents · )?\? for shortcuts(?:\s{2,}⚠ \d+ warnings? · f2 to view)?$/u;
const STATUS_FOOTER = /^[\w.-]+(?: [\w.-]+)* · (?:~|\/)\S.*$/u;
const USAGE_LIMIT = /^■ You[’']ve hit your usage limit[. ]/u;
const RETRY_AT = String.raw`(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(?:st|nd|rd|th), \d{4} )?(?:[1-9]|1[0-2]):[0-5]\d [AP]M`;
const RETRY = String.raw`again (?:later|at ${RETRY_AT})\.`;
const UPGRADE_ADVICE = [
  String.raw`Upgrade to Pro \(https://chatgpt\.com/explore/pro\), visit https://chatgpt\.com/settings/usage to purchase more credits`,
  String.raw`To get more access now, send a request to your admin`,
  String.raw`Upgrade to Plus to continue using Codex \(https://chatgpt\.com/explore/plus\),`,
  String.raw`Visit https://chatgpt\.com/settings/usage to purchase more credits`,
].join('|');
const LIMIT_REFUSAL = new RegExp(
  String.raw`^■ You[’']ve hit your usage limit(?:\. Try ${RETRY}|(?: for [\w.-]+(?: [\w.-]+){0,4}\. Switch to another model now,|\. (?:${UPGRADE_ADVICE})) or try ${RETRY})$`, 'u',
);

export function usageLimit(lines) {
  const { above, below, prompt } = promptRegion(lines, line => INPUT_PROMPT.test(line), 5);
  if (!IDLE_INPUT.test(prompt) || !SHORTCUTS.test(below.at(-1)) || below.length > 2) return null;
  if (below.length === 2 && !STATUS_FOOTER.test(below[0])) return null;
  const turn = read(lines);
  if (turn.turn !== 'idle' || turn.backgroundShells) return null;

  const heading = above.findLastIndex(line => USAGE_LIMIT.test(line));
  return heading >= 0 && LIMIT_REFUSAL.test(above.slice(heading).join(' '))
    ? 'You’ve hit your usage limit.'
    : null;
}
