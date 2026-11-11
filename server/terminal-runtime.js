/**
 * Terminal runtime abstraction.
 *
 * CodeDeck now requires tmux for all real terminal sessions. This file keeps a
 * legacy raw-PTY helper for tests/reference, but the exported factory always
 * returns the tmux runtime contract consumed by `ws-handler.js`.
 */

import { spawn } from 'node-pty';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'node:crypto';
import { buildShellEnv } from './shell-env.js';
import { isTransportFailure, STATUS_POLL_TIMEOUT_MS } from './command-runner.js';
import { collectSessionProcessIds, parsePaneProcesses, parseProcessSnapshot } from './session-processes.js';
import {
  TERMINAL_EXECUTION_UNKNOWN,
  classifyTerminalExecution,
} from './terminal-execution-classifier.js';

export {
  TERMINAL_EXECUTION_DEAD,
  TERMINAL_EXECUTION_IDLE,
  TERMINAL_EXECUTION_RUNNING,
  TERMINAL_EXECUTION_UNKNOWN,
  classifyTerminalExecution,
} from './terminal-execution-classifier.js';

export const TERMINAL_SNAPSHOT_WINDOW_LINES = 10000;
const TMUX_HISTORY_LIMIT = TERMINAL_SNAPSHOT_WINDOW_LINES;
export const TERMINAL_RUNTIME_CONTRACT = 'tmux_required';
export const TERMINAL_RUNTIME_BLOCKED_REASON = 'missing_tmux';
export const TERMINAL_RUNTIME_BLOCKED_MESSAGE = 'Install tmux to enable durable CodeDeck terminals.';
export const TERMINAL_PTY_SPAWN_BLOCKED_REASON = 'pty_spawn_failed';
export const TERMINAL_PTY_SPAWN_BLOCKED_MESSAGE = 'Terminal PTY helper cannot start processes.';
export const SESSION_KILL_GRACE_MS = 2000;
export const TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE = 'snapshot_unavailable';
export const TERMINAL_HISTORY_WARNING_MESSAGE_SNAPSHOT_UNAVAILABLE = 'Recent scrollback could not be restored accurately. Live terminal output is attached, but preserved history is unavailable.';
const execFileAsync = promisify(execFile);
const PANE_FORMAT = '#{pane_index}\t#{pane_current_command}\t#{pane_dead}\t#{window_activity}\t#{pane_current_path}';
const UNKNOWN_EXECUTION_DETAILS = Object.freeze({ agentCli: null, backgroundAgents: 0, backgroundShells: 0, needsInput: false });
const processSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForProcessExit(ids, isAlive, now, sleep, timeoutMs) {
  const deadline = now() + timeoutMs;
  let survivors = ids;
  while (survivors.length) {
    const states = await Promise.all(survivors.map(async id => ({ id, alive: await isAlive(id) })));
    survivors = states.filter(state => state.alive).map(state => state.id);
    if (!survivors.length || now() >= deadline) break;
    await sleep(Math.min(100, deadline - now()));
  }
  return survivors;
}

function localProcessAlive(signalProcess, pid) {
  try { signalProcess(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') throw new Error(`Cannot inspect terminal process ${pid}: permission denied`, { cause: error });
    throw error;
  }
}

export function parseTerminalPaneMetadata(raw) {
  if (typeof raw !== 'string') throw new Error('tmux pane metadata must be text');
  const panes = raw.replace(/\r/g, '').trimEnd().split('\n').map(line => {
    const fields = line.split('\t');
    if (fields.length !== 5) throw new Error('tmux pane metadata must contain pane_index, pane_current_command, pane_dead, window_activity, pane_current_path');
    const [index, paneCurrentCommand, paneDead, activity, paneCurrentPath] = fields;
    if (!/^(0|[1-9]\d*)$/.test(index) || !Number.isSafeInteger(Number(index))) throw new Error('tmux pane_index must be a nonnegative integer');
    if (!paneCurrentCommand.trim()) throw new Error('tmux pane_current_command must be nonempty');
    if (paneDead !== '0' && paneDead !== '1') throw new Error('tmux pane_dead must be 0 or 1');
    if (!/^(0|[1-9]\d*)$/.test(activity) || !Number.isSafeInteger(Number(activity))) throw new Error('tmux window_activity must be a nonnegative epoch second');
    if (!paneCurrentPath.trim()) throw new Error('tmux pane_current_path must be nonempty');
    return { paneIndex: Number(index), paneCurrentCommand, paneDead, windowActivity: Number(activity), paneCurrentPath };
  }).sort((a, b) => a.paneIndex - b.paneIndex);
  if (new Set(panes.map(pane => pane.paneIndex)).size !== panes.length) throw new Error('tmux pane_index must be unique');
  return panes;
}

function classifyPanes(panes, snapshots, clockSeconds) {
  if (!Number.isSafeInteger(clockSeconds) || clockSeconds < 0) throw new Error('tmux remote_clock must be a nonnegative epoch second');
  if (panes.length !== snapshots.length) throw new Error('tmux pane snapshots must match pane metadata');
  const [main, ...subagents] = panes.map((pane, index) => ({ ...pane, snapshotText: snapshots[index] }));
  if (!main) throw new Error('tmux pane_index main pane required');
  if (main.windowActivity > clockSeconds) throw new Error('tmux window_activity must not exceed remote_clock');
  return classifyTerminalExecution({
    paneCurrentCommand: main.paneCurrentCommand, paneDead: main.paneDead,
    snapshotText: main.snapshotText, subagentPanes: subagents,
    quietSeconds: clockSeconds - main.windowActivity,
  });
}

export function getTerminalHistoryWarningMessage(reason = TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE) {
  if (reason === TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE) {
    return TERMINAL_HISTORY_WARNING_MESSAGE_SNAPSHOT_UNAVAILABLE;
  }

  return TERMINAL_HISTORY_WARNING_MESSAGE_SNAPSHOT_UNAVAILABLE;
}

export function getTerminalRuntimeStatus(runtime) {
  const tmuxAvailable = runtime?.type === 'tmux'
    ? runtime.isAvailable?.() ?? true
    : false;
  const ptySpawnStatus = runtime?.type === 'tmux' && tmuxAvailable
    ? runtime.getPtySpawnStatus?.() ?? { available: true, error: null }
    : { available: false, error: null };
  const ptySpawnAvailable = ptySpawnStatus.available === true;
  const terminalCreationAllowed = runtime?.type === 'tmux' && tmuxAvailable && ptySpawnAvailable;
  const terminalRuntimeBlockedReason = terminalCreationAllowed
    ? null
    : (!tmuxAvailable ? TERMINAL_RUNTIME_BLOCKED_REASON : TERMINAL_PTY_SPAWN_BLOCKED_REASON);
  const terminalRuntimeBlockedMessage = terminalCreationAllowed
    ? null
    : (!tmuxAvailable
      ? TERMINAL_RUNTIME_BLOCKED_MESSAGE
      : `${TERMINAL_PTY_SPAWN_BLOCKED_MESSAGE} ${ptySpawnStatus.error || ''}`.trim());

  return {
    terminalRuntime: runtime?.type ?? 'unknown',
    terminalRuntimeContract: TERMINAL_RUNTIME_CONTRACT,
    tmuxAvailable,
    ptySpawnAvailable,
    terminalCreationAllowed,
    terminalRuntimeBlockedReason,
    terminalRuntimeBlockedMessage,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a sessionId for use as a tmux session name.
 * tmux names cannot contain dots or colons.
 */
function sanitizeTmuxName(sessionId) {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Check whether a tmux session with the given name exists.
 */
function tmuxSessionExists(tmuxName) {
  try {
    // A bare target prefix-matches (`demo-1` finds `demo-15`); `=` is exact.
    execFileSync('tmux', ['has-session', '-t', `=${tmuxName}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function assertDetachedSessionInput({ cwd, cols, rows, sessionId }) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) throw new Error('Detached session requires a cwd');
  if (!Number.isSafeInteger(cols) || cols < 2 || cols > 1000) throw new Error('Detached session requires integer cols from 2 to 1000');
  if (!Number.isSafeInteger(rows) || rows < 2 || rows > 1000) throw new Error('Detached session requires integer rows from 2 to 1000');
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256 || /[\x00-\x1f\x7f]/.test(sessionId)) throw new Error('Detached session requires a valid sessionId');
}

function createLocalTmuxSession(tmuxName, { cwd, cols, rows }) {
  // history-limit only affects the initial pane if it is in place before
  // the tmux session/window is created. A cold tmux socket can reject
  // this global write before any server exists; session options applied
  // afterwards still keep the new durable window on the snapshot limit.
  try {
    ensureTmuxGlobalWindowOptions();
  } catch (err) {
    if (!isTmuxMissingServerError(err)) {
      throw err;
    }
  }
  execFileSync('tmux', [
    'new-session', '-d',
    '-s', tmuxName,
    '-c', cwd,
    '-x', String(cols),
    '-y', String(rows),
  ], { stdio: 'pipe' });
}

function getCommandErrorText(err) {
  return [
    err?.message,
    err?.stderr?.toString?.(),
    err?.stdout?.toString?.(),
  ].filter(Boolean).join('\n');
}

function isTmuxMissingServerError(err) {
  const errorText = getCommandErrorText(err);
  return errorText.includes('no server running')
    || /error connecting to .*tmux.*No such file or directory/.test(errorText);
}

function isTmuxMissingSessionError(err) {
  return isTmuxMissingServerError(err)
    || /can't find session|session not found|no such session/i.test(getCommandErrorText(err));
}

/**
 * Check whether the tmux binary is available on this machine.
 */
export function isTmuxAvailable() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Unicode ranges whose code points occupy two terminal cells. Sourced from
// UAX #11 East Asian Width (classes W and F) plus the emoji-presentation
// promotions defined in UTS #51; xterm renders every codepoint in these
// ranges as a double-width cell, so truncation must count them the same way.
// Kept sorted so the linear scan can short-circuit once the codepoint is
// below the current range's lower bound.
const TERMINAL_WIDE_RANGES = [
  [0x1100, 0x115F],   // Hangul Jamo
  [0x231A, 0x231B],   // ⌚ watch, ⌛ hourglass
  [0x2329, 0x232A],   // angle brackets
  [0x23E9, 0x23EC],   // ⏩⏪⏫⏬ fast-forward / rewind double arrows
  [0x23F0, 0x23F0],   // ⏰ alarm clock
  [0x23F3, 0x23F3],   // ⏳ hourglass with flowing sand
  [0x25FD, 0x25FE],   // ◽◾ white/black medium small squares
  [0x2614, 0x2615],   // ☔ umbrella, ☕ hot beverage
  [0x2648, 0x2653],   // ♈–♓ zodiac signs
  [0x267F, 0x267F],   // ♿ wheelchair
  [0x2693, 0x2693],   // ⚓ anchor
  [0x26A1, 0x26A1],   // ⚡ high voltage
  [0x26AA, 0x26AB],   // ⚪⚫ medium circles
  [0x26BD, 0x26BE],   // ⚽ soccer, ⚾ baseball
  [0x26C4, 0x26C5],   // ⛄ snowman, ⛅ sun behind cloud
  [0x26CE, 0x26CE],   // ⛎ Ophiuchus
  [0x26D4, 0x26D4],   // ⛔ no entry
  [0x26EA, 0x26EA],   // ⛪ church
  [0x26F2, 0x26F3],   // ⛲ fountain, ⛳ flag in hole
  [0x26F5, 0x26F5],   // ⛵ sailboat
  [0x26FA, 0x26FA],   // ⛺ tent
  [0x26FD, 0x26FD],   // ⛽ fuel pump
  [0x2705, 0x2705],   // ✅ white heavy check mark
  [0x270A, 0x270B],   // ✊ raised fist, ✋ raised hand
  [0x2728, 0x2728],   // ✨ sparkles
  [0x274C, 0x274C],   // ❌ cross mark
  [0x274E, 0x274E],   // ❎ negative squared cross mark
  [0x2753, 0x2755],   // ❓❔❕ question / exclamation glyphs
  [0x2757, 0x2757],   // ❗ heavy exclamation mark
  [0x2795, 0x2797],   // ➕➖➗ plus / minus / divide
  [0x27B0, 0x27B0],   // ➰ curly loop
  [0x27BF, 0x27BF],   // ➿ double curly loop
  [0x2B1B, 0x2B1C],   // ⬛⬜ large squares
  [0x2B50, 0x2B50],   // ⭐ medium star
  [0x2B55, 0x2B55],   // ⭕ heavy large circle
  [0x2E80, 0x303E],   // CJK Radicals / Kangxi / CJK Symbols (excl. 0x303F)
  [0x3041, 0x33FF],   // Hiragana, Katakana, Bopomofo, CJK compat
  [0x3400, 0x4DBF],   // CJK Unified Ideographs Extension A
  [0x4E00, 0x9FFF],   // CJK Unified Ideographs
  [0xA000, 0xA4CF],   // Yi Syllables / Radicals
  [0xAC00, 0xD7A3],   // Hangul Syllables
  [0xF900, 0xFAFF],   // CJK Compatibility Ideographs
  [0xFE30, 0xFE4F],   // CJK Compatibility Forms
  [0xFF00, 0xFF60],   // Fullwidth Forms
  [0xFFE0, 0xFFE6],   // Fullwidth Signs
  [0x1F1E6, 0x1F1FF], // Regional Indicator Symbols (flag emoji halves)
  [0x1F300, 0x1F64F], // Miscellaneous Symbols and Pictographs + Emoticons
  [0x1F680, 0x1F6FF], // Transport and Map
  [0x1F900, 0x1F9FF], // Supplemental Symbols and Pictographs
  [0x1FA00, 0x1FAFF], // Symbols and Pictographs Extended-A
  [0x20000, 0x2FFFD], // CJK Unified Ideographs Extensions B–F
  [0x30000, 0x3FFFD], // CJK Unified Ideographs Extension G
];

const VARIATION_SELECTOR_16 = 0xFE0F;
const COMBINING_ENCLOSING_KEYCAP = 0x20E3;
const ZERO_WIDTH_JOINER = 0x200D;
const REGIONAL_INDICATOR_START = 0x1F1E6;
const REGIONAL_INDICATOR_END = 0x1F1FF;
const EMOJI_MODIFIER_START = 0x1F3FB;
const EMOJI_MODIFIER_END = 0x1F3FF;
const TAG_COMPONENT_START = 0xE0020;
const TAG_COMPONENT_END = 0xE007F;
const COMBINING_MARK_REGEX = /\p{Mark}/u;
const EXTENDED_PICTOGRAPHIC_REGEX = /\p{Extended_Pictographic}/u;

function isWideCodepoint(cp) {
  for (const [lo, hi] of TERMINAL_WIDE_RANGES) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

function isExtendedPictographicCodepoint(cp) {
  return EXTENDED_PICTOGRAPHIC_REGEX.test(String.fromCodePoint(cp));
}

function isCombiningMarkCodepoint(cp) {
  return COMBINING_MARK_REGEX.test(String.fromCodePoint(cp));
}

function isRegionalIndicatorCodepoint(cp) {
  return cp >= REGIONAL_INDICATOR_START && cp <= REGIONAL_INDICATOR_END;
}

function isEmojiModifierCodepoint(cp) {
  return cp >= EMOJI_MODIFIER_START && cp <= EMOJI_MODIFIER_END;
}

function isTagComponentCodepoint(cp) {
  return cp >= TAG_COMPONENT_START && cp <= TAG_COMPONENT_END;
}

function readCodepoint(text, index) {
  const cp = text.codePointAt(index);
  const ch = String.fromCodePoint(cp);
  return { cp, ch, nextIndex: index + ch.length };
}

function* iterateFallbackTerminalGraphemes(text) {
  let index = 0;

  while (index < text.length) {
    const start = index;
    let { cp, ch, nextIndex } = readCodepoint(text, index);
    let segment = ch;
    index = nextIndex;

    // Approximate UAX #29 for the emoji-heavy cases that matter here:
    // regional-indicator flags, combining-mark/keycap sequences, emoji
    // modifiers, tag-based flags, and ZWJ emoji families/professions.
    if (isRegionalIndicatorCodepoint(cp) && index < text.length) {
      const next = readCodepoint(text, index);
      if (isRegionalIndicatorCodepoint(next.cp)) {
        segment += next.ch;
        index = next.nextIndex;
      }
    }

    while (index < text.length) {
      const next = readCodepoint(text, index);

      if (
        isCombiningMarkCodepoint(next.cp)
        || isEmojiModifierCodepoint(next.cp)
        || isTagComponentCodepoint(next.cp)
      ) {
        segment += next.ch;
        index = next.nextIndex;
        continue;
      }

      if (next.cp === ZERO_WIDTH_JOINER) {
        segment += next.ch;
        index = next.nextIndex;

        if (index >= text.length) {
          break;
        }

        const joined = readCodepoint(text, index);
        segment += joined.ch;
        index = joined.nextIndex;
        cp = joined.cp;
        continue;
      }

      break;
    }

    yield { segment, index: start };
  }
}

function* iterateTerminalGraphemes(text) {
  if (!text) {
    return;
  }

  if (GRAPHEME_SEGMENTER) {
    yield* GRAPHEME_SEGMENTER.segment(text);
    return;
  }

  yield* iterateFallbackTerminalGraphemes(text);
}

function measureTerminalGraphemeWidth(segment) {
  let hasEmojiPresentationSelector = false;
  let hasKeycapComposition = false;
  let hasExtendedPictographicBase = false;

  for (const ch of segment) {
    const cp = ch.codePointAt(0);

    if (isWideCodepoint(cp)) {
      return 2;
    }

    if (cp === VARIATION_SELECTOR_16) {
      hasEmojiPresentationSelector = true;
      continue;
    }

    if (cp === COMBINING_ENCLOSING_KEYCAP) {
      hasKeycapComposition = true;
      continue;
    }

    if (isExtendedPictographicCodepoint(cp)) {
      hasExtendedPictographicBase = true;
    }
  }

  if (hasKeycapComposition) {
    return 2;
  }

  // Some emoji-presenting graphemes stay in narrow Unicode blocks until FE0F
  // promotes them to emoji presentation (for example ✈️ or ☑️). xterm renders
  // those graphemes as double-width, so measuring only the first codepoint
  // undercounts them and lets replayed rows overflow the live pane width.
  if (hasEmojiPresentationSelector && hasExtendedPictographicBase) {
    return 2;
  }

  return 1;
}

const GRAPHEME_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/**
 * Measure the display width of a string in terminal cells. Iterates by
 * grapheme cluster so combining marks attach to their base character and
 * surrogate pairs are treated as a single codepoint.
 */
export function measureTerminalCellWidth(text) {
  if (!text) return 0;
  let cells = 0;
  for (const { segment } of iterateTerminalGraphemes(text)) {
    cells += measureTerminalGraphemeWidth(segment);
  }
  return cells;
}

/**
 * Truncate a string so it fits inside `maxCells` terminal cells, cutting on
 * grapheme boundaries. Callers can rely on the returned string to never
 * exceed the pane width when xterm replays it.
 */
export function truncateToTerminalCells(text, maxCells) {
  if (!text || maxCells <= 0) return '';
  let cells = 0;
  let end = 0;
  for (const { segment, index } of iterateTerminalGraphemes(text)) {
    const width = measureTerminalGraphemeWidth(segment);
    if (cells + width > maxCells) break;
    cells += width;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

// ---------------------------------------------------------------------------
// Raw PTY runtime
// ---------------------------------------------------------------------------

function createPtyRuntime() {
  return {
    type: 'pty',

    /**
     * Spawn a raw shell PTY.
     */
    spawn({ cwd, cols, rows }) {
      const shell = process.env.SHELL || '/bin/zsh';
      return spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: buildShellEnv(shell, process.env),
      });
    },

    /**
     * Kill a raw PTY session. After this the session is unrecoverable.
     */
    kill(entry, _sessionId) {
      if (!entry?.pty) return;
      try {
        entry.pty.kill();
      } catch {
        // PTY may already be gone
      }
    },

    /**
     * Raw PTY sessions cannot survive process death.
     */
    isSessionRecoverable() {
      return false;
    },

    /**
     * Raw PTY sessions do not expose a durable external cwd source.
     * Fall back to the server's last known value.
     */
    getSessionCwd(entry) {
      return entry.cwd;
    },

    /**
     * Raw PTY sessions do not have external durable sessions to enumerate.
     */
    listSessionIds() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// tmux-backed runtime
// ---------------------------------------------------------------------------

const INCARNATION_OPTION = '@codedeck_incarnation';
function incarnationTarget(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256 || /[\x00-\x1f\x7f]/.test(sessionId)) {
    throw new Error('Terminal incarnation sessionId must be nonempty text of at most 256 characters without controls.');
  }
  // set/show-option resolve a pane target; the colon makes the exact
  // session component explicit (bare =name is treated as a literal name).
  return `=${sanitizeTmuxName(sessionId)}:`;
}
function tmuxActivityMs(raw, sessionId) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const seconds = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error(`Invalid tmux activity time for session ${sessionId}.`);
  return seconds * 1000;
}
function incarnationValue(raw, sessionId, allowMissing = false) {
  if (typeof raw !== 'string') throw new Error(`Invalid terminal incarnation response for session ${sessionId}.`);
  const value = raw.replace(/\r?\n$/, '');
  if (allowMissing && value === '') return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid terminal incarnation for session ${sessionId}.`);
  }
  return value;
}
function incarnationReadArgs(target) { return ['show-options', '-qv', '-t', target, INCARNATION_OPTION]; }
function incarnationWriteArgs(target) {
  // tmux -o checks only the session-local value atomically; -q makes a racing
  // initializer a no-op. Never overwrite a UUID on an existing durable session.
  return ['set-option', '-oq', '-t', target, INCARNATION_OPTION, randomUUID()];
}

function ensureTmuxGlobalWindowOptions() {
  execFileSync('tmux', [
    'set-window-option', '-g', 'history-limit', String(TMUX_HISTORY_LIMIT),
  ], { stdio: 'pipe' });
}

function ensureTmuxSessionOptions(tmuxName) {
  execFileSync('tmux', incarnationWriteArgs(`=${tmuxName}:`), { stdio: 'pipe', timeout: STATUS_POLL_TIMEOUT_MS });
  execFileSync('tmux', [
    'set-option', '-t', tmuxName, 'status', 'off',
  ], { stdio: 'pipe' });
  execFileSync('tmux', [
    'set-window-option', '-t', tmuxName, 'history-limit', String(TMUX_HISTORY_LIMIT),
  ], { stdio: 'pipe' });
  execFileSync('tmux', [
    'set-option', '-t', tmuxName, 'mouse', 'on',
  ], { stdio: 'pipe' });
  // Match xterm's green selection (#6ee7b7 at 25% over #0e0e10 ≈ #26443a) so
  // tmux copy-mode doesn't render its default yellow and read as a different
  // kind of selection than the browser-side one.
  execFileSync('tmux', [
    'set-window-option', '-t', tmuxName, 'mode-style', 'bg=#26443a,fg=#e4e4e8',
  ], { stdio: 'pipe' });
  // 'on', not the default 'external': external REJECTS OSC 52 from programs
  // inside the pane (TUIs copying a selection), so their copies die in a tmux
  // buffer. 'on' accepts them and forwards to the browser's clipboard addon.
  execFileSync('tmux', [
    'set-option', '-s', 'set-clipboard', 'on',
  ], { stdio: 'pipe' });
}

function getTmuxPaneNumberValue(target, format) {
  const raw = execFileSync(
    'tmux',
    ['display-message', '-p', '-t', target, format],
    { stdio: 'pipe', encoding: 'utf8' }
  ).trim();
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTmuxBoolean(value) {
  return value === '1';
}

const TMUX_PANE_STATE_FORMAT = [
  '#{alternate_on}',
  '#{pane_in_mode}',
  '#{pane_mode}',
  '#{cursor_x}',
  '#{cursor_y}',
  '#{cursor_flag}',
  '#{cursor_shape}',
  '#{cursor_blinking}',
  '#{cursor_very_visible}',
  '#{insert_flag}',
  '#{origin_flag}',
  '#{wrap_flag}',
  '#{keypad_flag}',
  '#{keypad_cursor_flag}',
  '#{mouse_standard_flag}',
  '#{mouse_button_flag}',
  '#{mouse_all_flag}',
  '#{mouse_utf8_flag}',
  '#{mouse_sgr_flag}',
  '#{bracketed_paste_flag}',
].join('\t');

/**
 * Parse the raw `display-message` output produced by TMUX_PANE_STATE_FORMAT
 * into the terminalState shape consumed by snapshot hydration. Pure — shared
 * by the local (sync) and host (async, runner-routed) snapshot paths.
 */
function parseTmuxPaneStateOutput(rawOutput) {
  const raw = rawOutput.replace(/\r/g, '').replace(/\n$/, '');
  const [
    alternateOnRaw = '0',
    paneInModeRaw = '0',
    paneModeRaw = '',
    cursorXRaw = '0',
    cursorYRaw = '0',
    cursorVisibleRaw = '1',
    cursorShapeRaw = 'block',
    cursorBlinkingRaw = '0',
    cursorVeryVisibleRaw = '0',
    insertModeRaw = '0',
    originModeRaw = '0',
    autoWrapRaw = '1',
    keypadModeRaw = '0',
    applicationCursorKeysRaw = '0',
    mouseStandardRaw = '0',
    mouseButtonRaw = '0',
    mouseAllRaw = '0',
    mouseUtf8Raw = '0',
    mouseSgrRaw = '0',
    bracketedPasteRaw = '0',
  ] = raw.split('\t');
  const paneInMode = parseInt(paneInModeRaw, 10) > 0;

  let mouseMode = 'off';
  if (parseTmuxBoolean(mouseAllRaw)) {
    mouseMode = 'all';
  } else if (parseTmuxBoolean(mouseButtonRaw)) {
    mouseMode = 'button';
  } else if (parseTmuxBoolean(mouseStandardRaw)) {
    mouseMode = 'standard';
  }

  let mouseEncoding = 'default';
  if (parseTmuxBoolean(mouseSgrRaw)) {
    mouseEncoding = 'sgr';
  } else if (parseTmuxBoolean(mouseUtf8Raw)) {
    mouseEncoding = 'utf8';
  }

  return {
    screenMode: paneInMode ? 'mode' : (parseTmuxBoolean(alternateOnRaw) ? 'alternate' : 'primary'),
    paneMode: paneModeRaw || null,
    cursorX: parseInt(cursorXRaw, 10) || 0,
    cursorY: parseInt(cursorYRaw, 10) || 0,
    cursorVisible: parseTmuxBoolean(cursorVisibleRaw),
    cursorShape: cursorShapeRaw || 'block',
    cursorBlinking: parseTmuxBoolean(cursorBlinkingRaw),
    cursorVeryVisible: parseTmuxBoolean(cursorVeryVisibleRaw),
    insertMode: parseTmuxBoolean(insertModeRaw),
    originMode: parseTmuxBoolean(originModeRaw),
    autoWrap: parseTmuxBoolean(autoWrapRaw),
    keypadMode: parseTmuxBoolean(keypadModeRaw),
    applicationCursorKeys: parseTmuxBoolean(applicationCursorKeysRaw),
    mouseMode,
    mouseEncoding,
    bracketedPaste: parseTmuxBoolean(bracketedPasteRaw),
  };
}

function getTmuxPaneSnapshotState(target) {
  const raw = execFileSync(
    'tmux',
    ['display-message', '-p', '-t', target, TMUX_PANE_STATE_FORMAT],
    { stdio: 'pipe', encoding: 'utf8' }
  );
  return parseTmuxPaneStateOutput(raw);
}

function normalizeCapturedSnapshot(output, windowLines = TERMINAL_SNAPSHOT_WINDOW_LINES, metadata = {}) {
  const normalizedWindowLines = Math.max(1, parseInt(windowLines, 10) || TERMINAL_SNAPSHOT_WINDOW_LINES);
  const historyGuaranteed = metadata.historyGuaranteed ?? true;
  const historyWarningReason = metadata.historyWarningReason ?? null;
  const historyWarningMessage = historyWarningReason
    ? metadata.historyWarningMessage ?? getTerminalHistoryWarningMessage(historyWarningReason)
    : null;

  if (!output) {
    return {
      data: '',
      lineCount: 0,
      windowLines: normalizedWindowLines,
      historyGuaranteed,
      historyWarningReason,
      historyWarningMessage,
      ...(metadata.terminalState ? { terminalState: metadata.terminalState } : {}),
    };
  }

  const lines = output.replace(/\r/g, '').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  const recentLines = lines.slice(-normalizedWindowLines);
  if (recentLines.length === 0) {
    return {
      data: '',
      lineCount: 0,
      windowLines: normalizedWindowLines,
      historyGuaranteed,
      historyWarningReason,
      historyWarningMessage,
      ...(metadata.terminalState ? { terminalState: metadata.terminalState } : {}),
    };
  }

  return {
    // Snapshot payloads are row dumps, not a live terminal byte stream.
    // Re-emit rows with CRLF separators so xterm restores each captured row
    // at column 0 instead of line-feeding from the previous cursor position.
    data: `${recentLines.join('\r\n')}\r\n`,
    lineCount: recentLines.length,
    windowLines: normalizedWindowLines,
    historyGuaranteed,
    historyWarningReason,
    historyWarningMessage,
    ...(metadata.terminalState ? { terminalState: metadata.terminalState } : {}),
  };
}

function createTmuxRuntime({ now = Date.now, sleep = processSleep, signalProcess = process.kill.bind(process), excludePids = [process.pid, process.ppid] } = {}) {
  let ptySpawnStatus = null;

  function checkPtySpawnStatus() {
    if (ptySpawnStatus) return ptySpawnStatus;

    try {
      const probe = spawn(process.execPath, ['-e', ''], {
        name: 'xterm-256color',
        cols: 1,
        rows: 1,
        cwd: process.cwd(),
        env: process.env,
      });
      try {
        probe.kill?.();
      } catch {
        // The probe process may already have exited.
      }
      ptySpawnStatus = { available: true, error: null };
    } catch (err) {
      ptySpawnStatus = {
        available: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return ptySpawnStatus;
  }

  return {
    type: 'tmux',

    isAvailable() {
      return isTmuxAvailable();
    },

    getPtySpawnStatus() {
      return checkPtySpawnStatus();
    },

    getSessionIncarnation(sessionId) {
      const target = incarnationTarget(sessionId);
      const options = { stdio: 'pipe', encoding: 'utf8', timeout: STATUS_POLL_TIMEOUT_MS };
      const existing = incarnationValue(execFileSync('tmux', incarnationReadArgs(target), options), sessionId, true);
      if (existing) return existing;
      execFileSync('tmux', incarnationWriteArgs(target), options);
      return incarnationValue(execFileSync('tmux', incarnationReadArgs(target), options), sessionId);
    },

    /** When this session last did anything, per tmux, in ms. Seeds "last activity" for sessions no client has attached to. */
    async getSessionActivityAsync(sessionId) {
      const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', incarnationTarget(sessionId), '#{session_activity}'], { encoding: 'utf8', timeout: STATUS_POLL_TIMEOUT_MS });
      return tmuxActivityMs(stdout, sessionId);
    },

    async getSessionIncarnationAsync(sessionId) {
      const target = incarnationTarget(sessionId);
      const options = { encoding: 'utf8', timeout: STATUS_POLL_TIMEOUT_MS };
      const { stdout } = await execFileAsync('tmux', incarnationReadArgs(target), options);
      const existing = incarnationValue(stdout, sessionId, true);
      if (existing) return existing;
      await execFileAsync('tmux', incarnationWriteArgs(target), options);
      const result = await execFileAsync('tmux', incarnationReadArgs(target), options);
      return incarnationValue(result.stdout, sessionId);
    },


    /**
     * Spawn (or re-attach to) a tmux-backed session.
     *
     * If the tmux session doesn't exist yet, creates one detached with the
     * given cwd and dimensions, then attaches via a node-pty wrapper.
     * If it already exists (e.g. server restarted), just attaches.
     */
    spawn({ cwd, cols, rows, sessionId }) {
      if (!this.isAvailable()) {
        throw new Error(TERMINAL_RUNTIME_BLOCKED_MESSAGE);
      }
      const currentPtySpawnStatus = checkPtySpawnStatus();
      if (!currentPtySpawnStatus.available) {
        throw new Error(`${TERMINAL_PTY_SPAWN_BLOCKED_MESSAGE} ${currentPtySpawnStatus.error || ''}`.trim());
      }

      const tmuxName = sanitizeTmuxName(sessionId);

      if (!tmuxSessionExists(tmuxName)) createLocalTmuxSession(tmuxName, { cwd, cols, rows });

      // Keep tmux session options aligned with the browser terminal.
      // history-limit matters for durable session restore after reload/server restart.
      ensureTmuxSessionOptions(tmuxName);

      // Attach via node-pty so we get the same onData/onExit/write/resize API.
      // -T hyperlinks: tmux only forwards OSC 8 links to clients declaring it.
      return spawn('tmux', ['-T', 'hyperlinks', 'attach-session', '-t', tmuxName], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
      });
    },

    /**
     * Create a durable tmux session with no client attached, for a terminal
     * started from the phone. The id must be freshly reserved: an existing
     * session under it is someone else's terminal and is never adopted.
     */
    createDetachedSession({ cwd, cols, rows, sessionId }) {
      assertDetachedSessionInput({ cwd, cols, rows, sessionId });
      if (!this.isAvailable()) throw new Error(TERMINAL_RUNTIME_BLOCKED_MESSAGE);
      const tmuxName = sanitizeTmuxName(sessionId);
      if (tmuxSessionExists(tmuxName)) throw new Error(`tmux session ${sessionId} already exists`);
      createLocalTmuxSession(tmuxName, { cwd, cols, rows });
      ensureTmuxSessionOptions(tmuxName);
    },

    /**
     * Kill both the node-pty attachment and the underlying tmux session.
     */
    kill(entry, sessionId) {
      if (this.isAvailable()) {
        const tmuxName = sanitizeTmuxName(sessionId);
        let alreadyGone = false;
        try {
          execFileSync('tmux', ['kill-session', '-t', `=${tmuxName}`], { stdio: 'pipe' });
        } catch (error) {
          if (!isTmuxMissingSessionError(error)) {
            throw new Error(`Failed to kill tmux session ${sessionId}: ${getCommandErrorText(error)}`, { cause: error });
          }
          alreadyGone = true;
        }
        if (!alreadyGone && tmuxSessionExists(tmuxName)) throw new Error(`tmux session ${sessionId} still exists after kill-session`);
      }
      if (entry?.pty) {
        try {
          entry.pty.kill();
        } catch {
          // PTY wrapper may already be gone
        }
      }
    },

    async killAsync(entry, sessionId) {
      if (this.isAvailable()) {
        const tmuxName = sanitizeTmuxName(sessionId);
        let panes = [];
        try {
          const { stdout } = await execFileAsync('tmux', ['list-panes', '-s', '-t', `=${tmuxName}:`, '-F', '#{pane_pid}\t#{pane_tty}'], { encoding: 'utf8' });
          panes = parsePaneProcesses(stdout);
        } catch (error) {
          if (!isTmuxMissingSessionError(error)) throw error;
        }
        let ids = [];
        if (panes.length) {
          const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,tty='], { encoding: 'utf8' });
          ids = collectSessionProcessIds({ panes, processes: parseProcessSnapshot(stdout), excludePids });
        }
        let alreadyGone = false;
        try {
          execFileSync('tmux', ['kill-session', '-t', `=${tmuxName}`], { stdio: 'pipe' });
        } catch (error) {
          if (!isTmuxMissingSessionError(error)) throw new Error(`Failed to kill tmux session ${sessionId}: ${getCommandErrorText(error)}`, { cause: error });
          alreadyGone = true;
        }
        if (!alreadyGone && tmuxSessionExists(tmuxName)) throw new Error(`tmux session ${sessionId} still exists after kill-session`);
        const isAlive = pid => localProcessAlive(signalProcess, pid);
        const survivors = await waitForProcessExit(ids, isAlive, now, sleep, SESSION_KILL_GRACE_MS);
        for (const pid of survivors) {
          try { signalProcess(pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        const remaining = await waitForProcessExit(survivors, isAlive, now, sleep, 1000);
        if (remaining.length) throw new Error(`tmux session ${sessionId} still has surviving processes: ${remaining.join(', ')}`);
        if (survivors.length) console.log(`[terminal] force-killed session=${sessionId} count=${survivors.length}`);
      }
      if (entry?.pty) {
        try { entry.pty.kill(); } catch { /* PTY wrapper may already be gone */ }
      }
    },

    /**
     * Check whether the underlying tmux session is still alive,
     * meaning the node-pty wrapper can be re-spawned to recover.
     */
    isSessionRecoverable(sessionId) {
      if (!this.isAvailable()) return false;
      const tmuxName = sanitizeTmuxName(sessionId);
      return tmuxSessionExists(tmuxName);
    },

    /**
     * Resolve the live cwd from the active tmux pane instead of the original
     * spawn directory. This keeps the UI in sync after `cd` commands.
     */
    getSessionCwd(entry, sessionId) {
      if (!this.isAvailable()) return entry.cwd;
      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const cwd = execFileSync(
          'tmux',
          ['display-message', '-p', '-t', tmuxName, '#{pane_current_path}'],
          { stdio: 'pipe', encoding: 'utf8' }
        ).trim();

        return cwd || entry.cwd;
      } catch {
        return entry.cwd;
      }
    },

    async getSessionCwdAsync(entry, sessionId) {
      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const { stdout } = await execFileAsync(
          'tmux',
          ['display-message', '-p', '-t', tmuxName, '#{pane_current_path}'],
          { encoding: 'utf8' }
        );
        const cwd = stdout.trim();
        return cwd || entry?.cwd || null;
      } catch {
        return entry?.cwd || null;
      }
    },

    /**
     * Report whether the pane is executing work. tmux foreground metadata and
     * the visible snapshot tail are classified together so shell scripts,
     * ordinary commands, and persistent agent CLIs share one evidence path.
     */
    getSessionExecutionState(sessionId) {
      if (!this.isAvailable()) {
        return {
          executionStatus: TERMINAL_EXECUTION_UNKNOWN,
          foregroundCommand: null,
          executionReason: 'tmux_unavailable',
          executionConfidence: 'low',
          ...UNKNOWN_EXECUTION_DETAILS,
        };
      }

      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const panes = parseTerminalPaneMetadata(execFileSync('tmux',
          ['list-panes', '-t', `${tmuxName}:0`, '-F', PANE_FORMAT],
          { stdio: 'pipe', encoding: 'utf8' }));
        const snapshots = panes.map(pane => execFileSync('tmux',
          ['capture-pane', '-p', '-t', `${tmuxName}:0.${pane.paneIndex}`],
          { stdio: 'pipe', encoding: 'utf8' }));
        return classifyPanes(panes, snapshots, Math.floor(Date.now() / 1000));
      } catch {
        return {
          executionStatus: TERMINAL_EXECUTION_UNKNOWN,
          foregroundCommand: null,
          executionReason: 'tmux_lookup_failed',
          executionConfidence: 'low',
          ...UNKNOWN_EXECUTION_DETAILS,
        };
      }
    },

    async getSessionExecutionStateAsync(sessionId, { onSnapshot } = {}) {
      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const { stdout } = await execFileAsync('tmux',
          ['list-panes', '-t', `${tmuxName}:0`, '-F', PANE_FORMAT], { encoding: 'utf8' });
        const panes = parseTerminalPaneMetadata(stdout);
        const snapshots = await Promise.all(panes.map(async pane => (await execFileAsync('tmux',
          ['capture-pane', '-p', '-t', `${tmuxName}:0.${pane.paneIndex}`], { encoding: 'utf8' })).stdout));
        onSnapshot?.(snapshots[0]);
        return classifyPanes(panes, snapshots, Math.floor(Date.now() / 1000));
      } catch {
        return {
          executionStatus: TERMINAL_EXECUTION_UNKNOWN,
          foregroundCommand: null,
          executionReason: 'tmux_lookup_failed',
          executionConfidence: 'low',
          ...UNKNOWN_EXECUTION_DETAILS,
        };
      }
    },

    /**
     * Force the durable tmux window to the requested geometry before snapshot
     * capture so reconnect restores reflect the current browser size.
     */
    resizeSession(sessionId, cols, rows) {
      if (!this.isAvailable()) return;
      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        execFileSync(
          'tmux',
          ['resize-window', '-t', `${tmuxName}:0`, '-x', String(cols), '-y', String(rows)],
          { stdio: 'pipe' }
        );
      } catch {
        // Keep reconnect recovery best-effort if tmux rejects the resize.
      }
    },

    /**
     * Capture the authoritative recent tmux window used to rebuild browser
     * attachments. The snapshot includes the currently visible pane content and
     * is capped to the most recent 10,000 terminal lines.
     */
    captureSessionSnapshot(sessionId, windowLines = TERMINAL_SNAPSHOT_WINDOW_LINES) {
      if (!this.isAvailable()) {
        return normalizeCapturedSnapshot('', windowLines, {
          historyGuaranteed: false,
          historyWarningReason: TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE,
        });
      }

      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const normalizedWindowLines = Math.max(1, parseInt(windowLines, 10) || TERMINAL_SNAPSHOT_WINDOW_LINES);
        const terminalState = getTmuxPaneSnapshotState(tmuxName);
        const captureArgs = ['capture-pane', '-p'];
        let primaryPaneWidth = 0;

        if (terminalState.screenMode === 'mode') {
          captureArgs.push('-M', '-e', '-N');
        } else if (terminalState.screenMode === 'alternate') {
          captureArgs.push('-a', '-e', '-N');
        } else {
          const paneHeight = getTmuxPaneNumberValue(tmuxName, '#{pane_height}');
          const visiblePaneLines = Math.max(1, paneHeight || 0);
          const historyLines = Math.max(normalizedWindowLines - visiblePaneLines, 0);
          const startLine = historyLines > 0 ? `-${historyLines}` : '0';
          primaryPaneWidth = getTmuxPaneNumberValue(tmuxName, '#{pane_width}');
          // Preserve the current tmux row layout for primary-screen scrollback
          // instead of joining wrapped rows into logical lines. Re-wrapping
          // joined rows on restore can recreate redraw corruption while
          // scrolling through restored history after a reconnect.
          captureArgs.push('-S', startLine);
        }

        captureArgs.push('-t', tmuxName);

        const rawOutput = execFileSync('tmux', captureArgs, {
          stdio: 'pipe',
          encoding: 'utf8',
        });

        // tmux keeps historical scrollback at the width it was rendered at, so
        // a narrow pane today can still surface rows that were captured at a
        // wider layout. Replaying those wide rows into xterm wraps them and
        // stamps a stray column of wrapped remnants down the right edge.
        // Clamp each primary-screen row to the live pane width so the replayed
        // snapshot mirrors what tmux itself shows in the current viewport.
        // pane_width is counted in terminal cells, so we have to truncate by
        // display cells and grapheme boundaries — otherwise CJK, emoji or
        // surrogate-pair content still overflows the pane (or gets sliced in
        // half) and the right-edge wrap artifact survives.
        const output = primaryPaneWidth > 0
          ? rawOutput.split('\n').map(row => truncateToTerminalCells(row, primaryPaneWidth)).join('\n')
          : rawOutput;

        return normalizeCapturedSnapshot(output, normalizedWindowLines, {
          historyGuaranteed: true,
          terminalState,
        });
      } catch {
        return normalizeCapturedSnapshot('', windowLines, {
          historyGuaranteed: false,
          historyWarningReason: TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE,
        });
      }
    },

    /**
     * List known durable tmux session ids so the backend can allocate a fresh
     * browser terminal id without colliding with hidden historical sessions.
     */
    listSessionIds() {
      if (!this.isAvailable()) return [];
      try {
        const output = execFileSync(
          'tmux',
          ['list-sessions', '-F', '#S'],
          { stdio: 'pipe', encoding: 'utf8' }
        );
        return output
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    },

    async listSessionIdsAsync({ strict = false } = {}) {
      try {
        const { stdout } = await execFileAsync(
          'tmux',
          ['list-sessions', '-F', '#S'],
          { encoding: 'utf8' }
        );
        return stdout
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);
      } catch (error) {
        if (strict && !isTmuxMissingServerError(error)) throw error;
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Host-routed tmux runtime (remote host connectors — Spec §8.4)
// ---------------------------------------------------------------------------

/**
 * Create an async-only tmux runtime whose every operation executes through the
 * given command runner — for remote hosts, that means over the runner's
 * multiplexed SSH connection. Local sessions keep using the sync runtime above;
 * this factory exists so remote sessions never touch the local tmux server.
 *
 * Transport failures (host unreachable) are surfaced distinctly from
 * definitive tmux results wherever the difference matters for truthfulness:
 * `isSessionRecoverableAsync` THROWS on transport failure — the session's
 * remote state is unknown, and reporting `false` would let callers mark a
 * presumed-alive session dead (Spec §8.2).
 */
export function createHostTerminalRuntime(runner, hostName, { now = Date.now, sleep = processSleep, excludePids = [process.pid, process.ppid] } = {}) {
  function tmux(args, opts = {}) {
    return runner.run('tmux', args, opts);
  }

  async function getPaneNumberValue(target, format) {
    const { stdout } = await tmux(
      ['display-message', '-p', '-t', target, format],
      { timeout: STATUS_POLL_TIMEOUT_MS }
    );
    const parsed = parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async function ensureSessionOptions(tmuxName) {
    await tmux(incarnationWriteArgs(`=${tmuxName}:`), { timeout: STATUS_POLL_TIMEOUT_MS });
    await tmux(['set-option', '-t', tmuxName, 'status', 'off']);
    await tmux(['set-window-option', '-t', tmuxName, 'history-limit', String(TMUX_HISTORY_LIMIT)]);
    await tmux(['set-option', '-t', tmuxName, 'mouse', 'on']);
    // Same green-tinted copy-mode highlight as the local runtime.
    await tmux(['set-window-option', '-t', tmuxName, 'mode-style', 'bg=#26443a,fg=#e4e4e8']);
    // Accept OSC 52 from inner programs, not just tmux's own copy-mode.
    await tmux(['set-option', '-s', 'set-clipboard', 'on']);
  }

  /** A transport failure is never read as "no such session". */
  async function hostSessionExists(tmuxName) {
    try {
      await tmux(['has-session', '-t', `=${tmuxName}`]);
      return true;
    } catch (err) {
      if (isTransportFailure(err)) throw err;
      return false;
    }
  }

  async function createHostTmuxSession(tmuxName, { cwd, cols, rows }) {
    // Best-effort global history-limit so the initial pane inherits the
    // snapshot window; a cold tmux socket may reject it (same tolerance as
    // the local runtime).
    try {
      await tmux(['set-window-option', '-g', 'history-limit', String(TMUX_HISTORY_LIMIT)]);
    } catch (err) {
      if (isTransportFailure(err) || !isTmuxMissingServerError(err)) throw err;
    }
    await tmux([
      'new-session', '-d',
      '-s', tmuxName,
      '-c', cwd,
      '-x', String(cols),
      '-y', String(rows),
    ]);
  }

  const sessionStatusScript = [
    'set -e',
    // Read pane activity first: a clock sampled before it could trail an
    // actively printing pane and fail the activity <= clock guard.
    `panes=$(tmux list-panes -t "$1:0" -F '${PANE_FORMAT}')`,
    'date +%s',
    `printf '\\000'`,
    `printf '%s\\n' "$panes"`,
    `printf '\\000'`,
    `for pane in $(tmux list-panes -t "$1:0" -F '#{pane_index}'); do`,
    `  tmux capture-pane -p -t "$1:0.$pane"`,
    `  printf '\\000'`,
    `done`,
  ].join('\n');

  return {
    type: 'tmux',
    host: hostName,

    /** Host counterpart of the local getSessionActivityAsync. */
    async getSessionActivityAsync(sessionId) {
      const { stdout } = await tmux(['display-message', '-p', '-t', incarnationTarget(sessionId), '#{session_activity}'], { timeout: STATUS_POLL_TIMEOUT_MS });
      return tmuxActivityMs(stdout, sessionId);
    },

    async getSessionIncarnationAsync(sessionId) {
      const target = incarnationTarget(sessionId);
      const options = { timeout: STATUS_POLL_TIMEOUT_MS };
      const { stdout } = await tmux(incarnationReadArgs(target), options);
      const existing = incarnationValue(stdout, sessionId, true);
      if (existing) return existing;
      await tmux(incarnationWriteArgs(target), options);
      const result = await tmux(incarnationReadArgs(target), options);
      return incarnationValue(result.stdout, sessionId);
    },


    /** Remote tmux presence check (Spec §8.3) — never conflates "missing" with "unreachable". */
    async checkTmuxAsync() {
      try {
        await tmux(['-V'], { timeout: STATUS_POLL_TIMEOUT_MS });
        return { available: true, transport: false, error: null };
      } catch (err) {
        return {
          available: false,
          transport: isTransportFailure(err),
          error: err?.message || 'tmux check failed',
        };
      }
    },

    /**
     * Spawn (or re-attach to) the host's tmux session. Mirrors the local
     * runtime's flow: create detached if missing, align session options, then
     * attach interactively — here via the runner's PTY (`ssh -tt ... tmux
     * attach-session` for remote runners).
     */
    async spawnAsync({ cwd, cols, rows, sessionId }) {
      const tmuxName = sanitizeTmuxName(sessionId);

      if (!await hostSessionExists(tmuxName)) await createHostTmuxSession(tmuxName, { cwd, cols, rows });

      await ensureSessionOptions(tmuxName);

      return runner.spawnPty('tmux', ['-T', 'hyperlinks', 'attach-session', '-t', tmuxName], { cols, rows });
    },

    /** Host counterpart of the local createDetachedSession: never adopts an existing session. */
    async createDetachedSessionAsync({ cwd, cols, rows, sessionId }) {
      assertDetachedSessionInput({ cwd, cols, rows, sessionId });
      const tmuxName = sanitizeTmuxName(sessionId);
      if (await hostSessionExists(tmuxName)) throw new Error(`tmux session ${sessionId} already exists on ${hostName}`);
      await createHostTmuxSession(tmuxName, { cwd, cols, rows });
      await ensureSessionOptions(tmuxName);
    },

    /** Kill the host tmux session, confirm its absence, then close the PTY wrapper. */
    async killAsync(entry, sessionId) {
      const tmuxName = sanitizeTmuxName(sessionId);
      let panes = [];
      try {
        const { stdout } = await tmux(['list-panes', '-s', '-t', `=${tmuxName}:`, '-F', '#{pane_pid}\t#{pane_tty}']);
        panes = parsePaneProcesses(stdout);
      } catch (error) {
        if (isTransportFailure(error) || !isTmuxMissingSessionError(error)) throw error;
      }
      let ids = [];
      if (panes.length) {
        const { stdout } = await runner.run('ps', ['-axo', 'pid=,ppid=,tty=']);
        ids = collectSessionProcessIds({ panes, processes: parseProcessSnapshot(stdout), excludePids });
      }
      let alreadyGone = false;
      try {
        await tmux(['kill-session', '-t', `=${tmuxName}`]);
      } catch (error) {
        if (isTransportFailure(error)) throw error;
        if (!isTmuxMissingSessionError(error)) {
          throw new Error(`Failed to kill tmux session ${sessionId}: ${getCommandErrorText(error)}`, { cause: error });
        }
        alreadyGone = true;
      }
      if (!alreadyGone && await hostSessionExists(tmuxName)) throw new Error(`tmux session ${sessionId} still exists after kill-session`);
      const isAlive = async pid => {
        try { await runner.run('kill', ['-0', String(pid)]); return true; }
        catch (error) {
          if (isTransportFailure(error)) throw error;
          if (/not permitted|permission denied/i.test(getCommandErrorText(error))) throw new Error(`Cannot inspect terminal process ${pid}: permission denied`, { cause: error });
          if (/no such process/i.test(getCommandErrorText(error))) return false;
          throw error;
        }
      };
      const survivors = await waitForProcessExit(ids, isAlive, now, sleep, SESSION_KILL_GRACE_MS);
      for (const pid of survivors) {
        try { await runner.run('kill', ['-9', String(pid)]); }
        catch (error) {
          if (isTransportFailure(error) || !/no such process/i.test(getCommandErrorText(error))) throw error;
        }
      }
      const remaining = await waitForProcessExit(survivors, isAlive, now, sleep, 1000);
      if (remaining.length) throw new Error(`tmux session ${sessionId} still has surviving processes: ${remaining.join(', ')}`);
      if (survivors.length) console.log(`[terminal] force-killed session=${sessionId} count=${survivors.length}`);
      if (entry?.pty) {
        try {
          entry.pty.kill();
        } catch {
          // PTY wrapper may already be gone
        }
      }
    },

    /**
     * True/false only on definitive tmux answers; THROWS on transport failure
     * so callers never treat "can't reach the host" as "session gone".
     */
    async isSessionRecoverableAsync(sessionId) {
      const tmuxName = sanitizeTmuxName(sessionId);
      try {
        await tmux(['has-session', '-t', `=${tmuxName}`], { timeout: STATUS_POLL_TIMEOUT_MS });
        return true;
      } catch (err) {
        if (isTransportFailure(err)) throw err;
        return false;
      }
    },

    /** Runner-routed equivalent of the local snapshot capture — same shape, same clamping. */
    async captureSessionSnapshotAsync(sessionId, windowLines = TERMINAL_SNAPSHOT_WINDOW_LINES) {
      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const normalizedWindowLines = Math.max(1, parseInt(windowLines, 10) || TERMINAL_SNAPSHOT_WINDOW_LINES);
        const { stdout: stateRaw } = await tmux(
          ['display-message', '-p', '-t', tmuxName, TMUX_PANE_STATE_FORMAT],
          { timeout: STATUS_POLL_TIMEOUT_MS }
        );
        const terminalState = parseTmuxPaneStateOutput(stateRaw);
        const captureArgs = ['capture-pane', '-p'];
        let primaryPaneWidth = 0;

        if (terminalState.screenMode === 'mode') {
          captureArgs.push('-M', '-e', '-N');
        } else if (terminalState.screenMode === 'alternate') {
          captureArgs.push('-a', '-e', '-N');
        } else {
          const paneHeight = await getPaneNumberValue(tmuxName, '#{pane_height}');
          const visiblePaneLines = Math.max(1, paneHeight || 0);
          const historyLines = Math.max(normalizedWindowLines - visiblePaneLines, 0);
          const startLine = historyLines > 0 ? `-${historyLines}` : '0';
          primaryPaneWidth = await getPaneNumberValue(tmuxName, '#{pane_width}');
          captureArgs.push('-S', startLine);
        }

        captureArgs.push('-t', tmuxName);

        const { stdout: rawOutput } = await tmux(captureArgs);

        // Same width clamp as the local runtime: historical rows wider than
        // the live pane would wrap on replay and stripe the right edge.
        const output = primaryPaneWidth > 0
          ? rawOutput.split('\n').map(row => truncateToTerminalCells(row, primaryPaneWidth)).join('\n')
          : rawOutput;

        return normalizeCapturedSnapshot(output, normalizedWindowLines, {
          historyGuaranteed: true,
          terminalState,
        });
      } catch {
        return normalizeCapturedSnapshot('', windowLines, {
          historyGuaranteed: false,
          historyWarningReason: TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE,
        });
      }
    },

    /** Best-effort durable window resize before snapshot capture, like local. */
    async resizeSessionAsync(sessionId, cols, rows) {
      const tmuxName = sanitizeTmuxName(sessionId);
      try {
        await tmux(['resize-window', '-t', `${tmuxName}:0`, '-x', String(cols), '-y', String(rows)]);
      } catch {
        // Keep reconnect recovery best-effort if tmux rejects the resize.
      }
    },

    async getSessionCwdAsync(entry, sessionId) {
      const tmuxName = sanitizeTmuxName(sessionId);
      try {
        const { stdout } = await tmux(
          ['display-message', '-p', '-t', tmuxName, '#{pane_current_path}'],
          { timeout: STATUS_POLL_TIMEOUT_MS }
        );
        return stdout.trim() || entry?.cwd || null;
      } catch {
        return entry?.cwd || null;
      }
    },

    /** One SSH round-trip for the status cache's cwd + execution snapshot. */
    async getSessionStatusAsync(entry, sessionId, { onSnapshot } = {}) {
      const tmuxName = sanitizeTmuxName(sessionId);
      try {
        const { stdout } = await runner.run(
          'sh',
          ['-c', sessionStatusScript, 'codedeck-session-status', tmuxName],
          { timeout: STATUS_POLL_TIMEOUT_MS },
        );
        const parts = stdout.split('\0');
        if (parts.length < 4 || parts.at(-1) !== '') throw new Error('remote session status separators missing');
        const clock = parts[0].trim();
        if (!/^(0|[1-9]\d*)$/.test(clock) || !Number.isSafeInteger(Number(clock))) throw new Error('tmux remote_clock must be a nonnegative epoch second');
        const panes = parseTerminalPaneMetadata(parts[1]);
        const snapshots = parts.slice(2, -1);
        const executionState = classifyPanes(panes, snapshots, Number(clock));
        onSnapshot?.(snapshots[0]);
        return {
          cwd: panes[0].paneCurrentPath,
          executionState,
        };
      } catch {
        return {
          cwd: entry?.cwd || null,
          executionState: {
            executionStatus: TERMINAL_EXECUTION_UNKNOWN,
            foregroundCommand: null,
            executionReason: 'tmux_lookup_failed',
            executionConfidence: 'low',
            ...UNKNOWN_EXECUTION_DETAILS,
          },
        };
      }
    },

    /**
     * List the host's durable tmux sessions. Definitive answers ("no server
     * running") are an empty list; a transport failure is [] by default (status
     * sweeps skip the host) but rethrows in strict mode so allocation-style
     * callers can fail fast instead of acting on evidence they don't have.
     */
    async listSessionIdsAsync({ strict = false } = {}) {
      try {
        const { stdout } = await tmux(
          ['list-sessions', '-F', '#S'],
          { timeout: STATUS_POLL_TIMEOUT_MS }
        );
        return stdout
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);
      } catch (err) {
        if (strict && !isTmuxMissingServerError(err)) throw err;
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a terminal runtime based on the requested mode.
 *
 * @param {'pty' | 'tmux'} mode
 * @returns {object} runtime with spawn/kill/isSessionRecoverable
 */
export function createTerminalRuntime(mode = 'tmux', options = {}) {
  if (mode && mode !== 'tmux') {
    console.warn(`[terminal-runtime] ignoring unsupported runtime "${mode}" — tmux is required`);
  }

  const runtime = createTmuxRuntime(options);

  if (!runtime.isAvailable()) {
    console.warn('[terminal-runtime] tmux is required but not installed — terminal creation is blocked');
    return runtime;
  }

  console.log('[terminal-runtime] using tmux-backed sessions');
  return runtime;
}
