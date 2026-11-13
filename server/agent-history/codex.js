import path from 'node:path';
import { sourceLabel, prompt, validateRecord } from './index.js';
export function createCodexReader({ home, fs, Database }) {
  const file = path.join(home, '.codex/state_5.sqlite');
  return { list() {
    if (!fs.existsSync(file)) return { available: false, records: [] };
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare("SELECT id, cwd, name, first_user_message, updated_at_ms FROM threads WHERE source = 'cli' AND archived = 0").all();
      return { available: true, records: rows.flatMap((row, i) => {
        const source = `${file}:threads:${i}:${row.id}`;
        const title = sourceLabel(row.name, source, 'name'); const firstPrompt = prompt(sourceLabel(row.first_user_message, source, 'first_user_message'));
        if (!title && !firstPrompt) return [];
        return [validateRecord({ cli: 'codex', conversationId: row.id, title, firstPrompt, cwd: row.cwd, updatedAt: row.updated_at_ms }, `${file}:threads:${i}:${row.id}`)];
      }) };
    } finally { db.close(); }
  } };
}
