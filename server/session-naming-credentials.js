import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireField, isText } from './session-naming-validation.js';

export function createNamingCredentialStore(filename) {
  return {
    read() {
      try {
        const stat = lstatSync(filename);
        requireField(stat.isFile() && (stat.mode & 0o077) === 0, 'credentialFile', 'A private regular file is required');
        const value = readFileSync(filename, 'utf8');
        requireField(isText(value, 4096), 'credential', 'A nonempty credential is required');
        return value;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    write(value) {
      if (value === null) {
        try { unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return;
      }
      requireField(isText(value, 4096), 'credential', 'Use a nonempty credential of at most 4096 characters');
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${randomUUID()}`;
      try {
        writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, filename);
      } finally {
        try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    },
  };
}
