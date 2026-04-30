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
import { buildShellEnv } from './shell-env.js';
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
export const TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE = 'snapshot_unavailable';
export const TERMINAL_HISTORY_WARNING_MESSAGE_SNAPSHOT_UNAVAILABLE = 'Recent scrollback could not be restored accurately. Live terminal output is attached, but preserved history is unavailable.';
const execFileAsync = promisify(execFile);

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
  const terminalCreationAllowed = runtime?.type === 'tmux' && tmuxAvailable;

  return {
    terminalRuntime: runtime?.type ?? 'unknown',
    terminalRuntimeContract: TERMINAL_RUNTIME_CONTRACT,
    tmuxAvailable,
    terminalCreationAllowed,
    terminalRuntimeBlockedReason: terminalCreationAllowed ? null : TERMINAL_RUNTIME_BLOCKED_REASON,
    terminalRuntimeBlockedMessage: terminalCreationAllowed ? null : TERMINAL_RUNTIME_BLOCKED_MESSAGE,
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
    execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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

function ensureTmuxGlobalWindowOptions() {
  execFileSync('tmux', [
    'set-window-option', '-g', 'history-limit', String(TMUX_HISTORY_LIMIT),
  ], { stdio: 'pipe' });
}

function ensureTmuxSessionOptions(tmuxName) {
  execFileSync('tmux', [
    'set-option', '-t', tmuxName, 'status', 'off',
  ], { stdio: 'pipe' });
  execFileSync('tmux', [
    'set-window-option', '-t', tmuxName, 'history-limit', String(TMUX_HISTORY_LIMIT),
  ], { stdio: 'pipe' });
  execFileSync('tmux', [
    'set-option', '-t', tmuxName, 'mouse', 'off',
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

function getTmuxPaneSnapshotState(target) {
  const format = [
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

  const raw = execFileSync(
    'tmux',
    ['display-message', '-p', '-t', target, format],
    { stdio: 'pipe', encoding: 'utf8' }
  ).replace(/\r/g, '').replace(/\n$/, '');
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

function createTmuxRuntime() {
  return {
    type: 'tmux',

    isAvailable() {
      return isTmuxAvailable();
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

      const tmuxName = sanitizeTmuxName(sessionId);

      if (!tmuxSessionExists(tmuxName)) {
        // history-limit only affects the initial pane if it is in place before
        // the tmux session/window is created. A cold tmux socket can reject
        // this global write before any server exists; session options below
        // still keep the new durable window on the CodeDeck snapshot limit.
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

      // Keep tmux session options aligned with the browser terminal.
      // history-limit matters for durable session restore after reload/server restart.
      ensureTmuxSessionOptions(tmuxName);

      // Attach via node-pty so we get the same onData/onExit/write/resize API
      return spawn('tmux', ['attach-session', '-t', tmuxName], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
      });
    },

    /**
     * Kill both the node-pty attachment and the underlying tmux session.
     */
    kill(entry, sessionId) {
      if (entry?.pty) {
        try {
          entry.pty.kill();
        } catch {
          // PTY wrapper may already be gone
        }
      }
      if (!this.isAvailable()) return;
      const tmuxName = sanitizeTmuxName(sessionId);
      try {
        execFileSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'pipe' });
      } catch {
        // Session may already be gone
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
        };
      }

      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const raw = execFileSync(
          'tmux',
          ['display-message', '-p', '-t', tmuxName, '#{pane_current_command}\t#{pane_dead}'],
          { stdio: 'pipe', encoding: 'utf8' }
        ).replace(/\r/g, '').replace(/\n$/, '');
        const [paneCurrentCommand = '', paneDead = '0'] = raw.split('\t');

        const snapshotText = execFileSync(
          'tmux',
          ['capture-pane', '-p', '-S', '-40', '-t', tmuxName],
          { stdio: 'pipe', encoding: 'utf8' }
        );

        return classifyTerminalExecution({
          paneCurrentCommand,
          paneDead,
          snapshotText,
        });
      } catch {
        return {
          executionStatus: TERMINAL_EXECUTION_UNKNOWN,
          foregroundCommand: null,
          executionReason: 'tmux_lookup_failed',
          executionConfidence: 'low',
        };
      }
    },

    async getSessionExecutionStateAsync(sessionId) {
      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const [{ stdout: rawOutput }, { stdout: snapshotText }] = await Promise.all([
          execFileAsync(
            'tmux',
            ['display-message', '-p', '-t', tmuxName, '#{pane_current_command}\t#{pane_dead}'],
            { encoding: 'utf8' }
          ),
          execFileAsync(
            'tmux',
            ['capture-pane', '-p', '-S', '-40', '-t', tmuxName],
            { encoding: 'utf8' }
          ),
        ]);
        const raw = rawOutput.replace(/\r/g, '').replace(/\n$/, '');
        const [paneCurrentCommand = '', paneDead = '0'] = raw.split('\t');

        return classifyTerminalExecution({
          paneCurrentCommand,
          paneDead,
          snapshotText,
        });
      } catch {
        return {
          executionStatus: TERMINAL_EXECUTION_UNKNOWN,
          foregroundCommand: null,
          executionReason: 'tmux_lookup_failed',
          executionConfidence: 'low',
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

    async listSessionIdsAsync() {
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
      } catch {
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
export function createTerminalRuntime(mode = 'tmux') {
  if (mode && mode !== 'tmux') {
    console.warn(`[terminal-runtime] ignoring unsupported runtime "${mode}" — tmux is required`);
  }

  const runtime = createTmuxRuntime();

  if (!runtime.isAvailable()) {
    console.warn('[terminal-runtime] tmux is required but not installed — terminal creation is blocked');
    return runtime;
  }

  console.log('[terminal-runtime] using tmux-backed sessions');
  return runtime;
}
