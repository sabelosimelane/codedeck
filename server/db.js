import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.env.HOME || '/root', '.codedeck.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// -------------------------------------------------------------------
// Schema migrations
// -------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS configs (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export default db;
