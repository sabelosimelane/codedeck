import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { label, sourceLabel, prompt, validateRecord } from './index.js';
export function createAgyReader({ home, fs, Database }) {
  const file = path.join(home, '.gemini/antigravity-cli/conversation_summaries.db');
  const history = path.join(home, '.gemini/antigravity-cli/history.jsonl');
  return { list(cwds) {
    if (!fs.existsSync(file)) return { available: false, records: [] };
    const prompts = new Map();
    if (fs.existsSync(history)) {
      const lines = fs.readFileSync(history, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let row;
        try { row = JSON.parse(lines[i]); } catch { throw new Error(`${history}:${i + 1}: invalid JSON`); }
        if (!row.conversationId || row.type === 'slash_command' || !label(row.display)) continue;
        if (!Number.isSafeInteger(row.timestamp)) throw new Error(`${history}:${i + 1}: invalid timestamp`);
        const prior = prompts.get(row.conversationId);
        if (!prior || row.timestamp < prior.timestamp) prompts.set(row.conversationId, { timestamp: row.timestamp, text: prompt(row.display) });
      }
    }
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries WHERE nesting_depth = 0').all();
      return { available: true, records: rows.flatMap((row, i) => {
        const title = sourceLabel(row.title, `${file}:conversation_summaries:${i}`, 'title'); const firstPrompt = prompts.get(row.conversation_id)?.text ?? null;
        if (!title && !firstPrompt) return [];
        if (row.workspace_uris === '') return [];
        let uris;
        try { uris = JSON.parse(row.workspace_uris); } catch { throw new Error(`${file}:conversation_summaries:${i}: invalid workspace_uris`); }
        if (!Array.isArray(uris) || uris.some(uri => typeof uri !== 'string' || !uri.startsWith('file://'))) throw new Error(`${file}:conversation_summaries:${i}: invalid workspace_uris`);
        const updatedAt = Date.parse(row.last_modified_time);
        return uris.flatMap(uri => {
          let cwd;
          try { cwd = fileURLToPath(uri); } catch { throw new Error(`${file}:conversation_summaries:${i}: invalid workspace_uris`); }
          if (cwds && !cwds.includes(cwd)) return [];
          return [validateRecord({ cli: 'agy', conversationId: row.conversation_id, title, firstPrompt, cwd, updatedAt }, `${file}:conversation_summaries:${i}:${row.conversation_id}`)];
        });
      }) };
    } finally { db.close(); }
  } };
}
