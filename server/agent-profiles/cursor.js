import { promptRegion, screenLines } from './live-region.js';

export const id = 'cursor';

// `→ Plan, search, build anything` when fresh, `→ Add a follow-up` afterwards.
const INPUT_PROMPT = /^→ (?:Add a follow-up|Plan, search, build anything)\b/u;
// The prompt line carries `ctrl+c to stop` on its right edge only mid-turn.
const WORKING_HINT = /\bctrl\+c to stop$/;
const TRUST_OPTION = /^│\s*▶ \[\w\] /u;

export function matches({ foregroundCommand, lines }) {
  if (foregroundCommand === 'agent' || foregroundCommand === 'cursor-agent') return true;
  const text = screenLines(lines);
  return text.some(line => /^Cursor Agent$/.test(line))
    || text.some(line => INPUT_PROMPT.test(line))
    || (text.some(line => TRUST_OPTION.test(line)) && text.some(line => /Trust this workspace/.test(line)));
}

export function promptVisible(lines) {
  return Boolean(promptRegion(lines, line => INPUT_PROMPT.test(line)).prompt);
}

export function read(lines) {
  const text = screenLines(lines);
  const hasPrompt = text.some(line => INPUT_PROMPT.test(line));
  if (!hasPrompt && text.some(line => TRUST_OPTION.test(line))) {
    return { turn: 'needs_input', backgroundShells: 0 };
  }

  const region = promptRegion(lines, line => INPUT_PROMPT.test(line));
  return { turn: WORKING_HINT.test(region.prompt) ? 'working' : 'idle', backgroundShells: 0 };
}
