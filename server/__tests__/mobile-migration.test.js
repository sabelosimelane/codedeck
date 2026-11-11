import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { prepareMobileDatabase } from '../mobile-migration.js';

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function database() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codedeck-mobile-migration-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, 'state.db')); cleanup.push(() => db.close());
  db.pragma('journal_mode = WAL'); db.exec("CREATE TABLE configs(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO configs VALUES ('projects', '[1]')");
  return { db, dir };
}
it('backs up all existing WAL data before adding any companion tables with owner-only permissions', async () => {
  const { db } = await database();
  const backupPath = await prepareMobileDatabase(db);
  expect(path.isAbsolute(backupPath)).toBe(true); expect(backupPath).not.toBe(db.name);
  expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  const backup = new Database(backupPath, { readonly: true });
  try { expect(backup.prepare('SELECT * FROM configs').all()).toEqual([{ key: 'projects', value: '[1]' }]); } finally { backup.close(); }
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'mobile_%'").all()).toEqual([]);
});
it('does not create files for an in-memory database', async () => {
  const db = new Database(':memory:'); cleanup.push(() => db.close()); const backup = vi.spyOn(db, 'backup');
  expect(await prepareMobileDatabase(db)).toBeNull(); expect(backup).not.toHaveBeenCalled();
});
it('skips the backup after the companion migration markers are present', async () => {
  const { db } = await database();
  for (const name of ['mobile_instance', 'mobile_incarnations', 'mobile_devices', 'mobile_attention_observations', 'mobile_attention_events', 'mobile_attention_deliveries']) db.exec(`CREATE TABLE ${name} (id TEXT)`);
  const backup = vi.spyOn(db, 'backup'); expect(await prepareMobileDatabase(db)).toBeNull(); expect(backup).not.toHaveBeenCalled();
});
it('backs up a partially initialized migration instead of assuming it finished', async () => {
  const { db } = await database(); db.exec('CREATE TABLE mobile_instance(id TEXT)');
  expect(await prepareMobileDatabase(db)).toEqual(expect.any(String));
});
it('propagates backup errors and removes only its incomplete backup', async () => {
  const { db, dir } = await database(); const filesBefore = await readdir(dir); vi.spyOn(db, 'backup').mockRejectedValue(new Error('backup failure'));
  await expect(prepareMobileDatabase(db)).rejects.toThrow('backup failure');
  expect(await readdir(dir)).toEqual(filesBefore);
});
it.each([null, {}, { name: null, memory: false, prepare() {}, backup() {} }])('rejects invalid database boundaries', async db => {
  await expect(prepareMobileDatabase(db)).rejects.toThrow(/database/);
});
