import * as codex from './codex.js';
import * as claude from './claude.js';
import * as cursor from './cursor.js';
import * as agy from './agy.js';
import * as muse from './muse.js';
const profiles = [claude, muse, cursor, agy, codex];
export function findAgentProfile({ foregroundCommand, lines }) {
  return profiles.find(profile => profile.matches({ foregroundCommand, lines })) || null;
}

export function findAgentProfileById(id) {
  return profiles.find(profile => profile.id === id) || null;
}
