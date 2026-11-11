import { randomUUID } from 'node:crypto';
import { open, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';

const MARKERS = ['mobile_instance', 'mobile_incarnations', 'mobile_devices', 'mobile_attention_observations', 'mobile_attention_events', 'mobile_attention_deliveries'];

/** Back up a persistent SQLite database before the first additive companion migration.
 * Uses SQLite's online backup API, so committed WAL content is included.
 * Does not create tables: the caller must await this before constructing either store.
 */
export async function prepareMobileDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.backup !== 'function' || typeof db.name !== 'string' || !db.name || typeof db.memory !== 'boolean') {
    throw new Error('Mobile migration requires an open SQLite database with a valid filename and memory flag.');
  }
  if (db.memory) return null;
  const marker = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
  if (MARKERS.every(name => marker.get(name)?.name === name)) return null;
  const destination = `${path.resolve(db.name)}.pre-mobile-${randomUUID()}.bak`;
  // Exclusive creation prevents overwriting an unrelated backup. Set restrictive
  // permissions before SQLite opens the destination, not after copying secrets.
  const handle = await open(destination, 'wx', 0o600);
  try {
    await handle.close();
    await db.backup(destination);
    await chmod(destination, 0o600);
    return destination;
  } catch (error) {
    await unlink(destination);
    throw error;
  }
}
