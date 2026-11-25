import * as codex from './codex.js';
import * as claude from './claude.js';
import * as cursor from './cursor.js';
import * as agy from './agy.js';
import * as muse from './muse.js';
import * as opencode from './opencode.js';
const profiles = [claude, muse, cursor, agy, codex, opencode];
// A shell in the foreground means no agent CLI is running; an inline CLI (OpenCode mini) leaves its
// screen behind when it exits, and that leftover text must not be read as a live agent.
const SHELLS = new Set(['bash', 'csh', 'dash', 'fish', 'ksh', 'sh', 'tcsh', 'zsh']);

export function findAgentProfile({ foregroundCommand, lines }) {
  if (SHELLS.has(foregroundCommand)) return null;
  // The foreground command names the CLI reliably; screen text is only a fallback, because one CLI's
  // transcript can contain another's markers (OpenCode echoes prompts as `›` lines, as Codex draws its input).
  return profiles.find(profile => profile.matches({ foregroundCommand, lines: [] }))
    || profiles.find(profile => profile.matches({ foregroundCommand, lines }))
    || null;
}

export function findAgentProfileById(id) {
  return profiles.find(profile => profile.id === id) || null;
}
