import path from 'node:path';
import { sourceLabel, prompt, validateRecord, UUID } from './index.js';
const encoded = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-');
function userText(record) {
  if (record.type !== 'user' || record.isSidechain === true || record.agentName || record.isMeta === true || (record.promptSource !== undefined && record.promptSource !== 'typed')) return null;
  const content = record.message?.content;
  if (typeof content === 'string') return /^<(?:local-command|command-|system-reminder|hook)/.test(content.trim()) ? null : prompt(content);
  if (!Array.isArray(content)) return null;
  const text = content.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n').trim();
  return /^<(?:local-command|command-|system-reminder|hook)/.test(text) ? null : prompt(text);
}
export function createClaudeReader({ home, fs }) {
  const root = path.join(home, '.claude/projects');
  const cache = new Map();
  return { list(cwds) {
    if (!fs.existsSync(root)) return { available: false, records: [] };
    const records = [];
    for (const cwd of cwds) {
      const dir = path.join(root, encoded(cwd));
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !UUID.test(path.basename(entry.name, '.jsonl')) || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, entry.name);
        const stat = fs.statSync(file);
        const key = `${stat.mtimeMs}:${stat.size}`;
        let cached = cache.get(file);
        if (!cached || cached.key !== key) {
          const lines = fs.readFileSync(file, 'utf8').split('\n');
          let title = null; let custom = null; let firstPrompt = null; let updatedAt = 0; let interactive = false; let actualCwd = null;
          for (let i = 0; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            let row;
            try { row = JSON.parse(lines[i]); } catch {
              // The last split segment has no terminating newline: Claude is still appending that record.
              // It is read on the next request, once the file's mtime/size change.
              if (i === lines.length - 1) break;
              throw new Error(`${file}:${i + 1}: invalid JSON`);
            }
            if (row.entrypoint === 'cli' && row.isSidechain !== true && !row.agentName && row.cwd === cwd) { interactive = true; actualCwd = row.cwd; }
            if (row.type === 'ai-title' && row.sessionId === path.basename(entry.name, '.jsonl')) title = sourceLabel(row.aiTitle, `${file}:${i + 1}`, 'aiTitle');
            if (row.type === 'custom-title' && row.sessionId === path.basename(entry.name, '.jsonl')) custom = sourceLabel(row.customTitle, `${file}:${i + 1}`, 'customTitle');
            if (row.entrypoint === 'cli' && !row.agentName && row.cwd === cwd && firstPrompt === null) firstPrompt = userText(row);
            if (row.entrypoint === 'cli' && row.cwd === cwd && row.timestamp !== undefined) {
              const ms = Date.parse(row.timestamp);
              if (!Number.isFinite(ms)) throw new Error(`${file}:${i + 1}: invalid timestamp`);
              updatedAt = Math.max(updatedAt, ms);
            }
          }
          const finalTitle = custom ?? title;
          cached = { key, record: interactive && actualCwd && updatedAt && (finalTitle || firstPrompt) ? validateRecord({ cli: 'claude', conversationId: path.basename(entry.name, '.jsonl'), title: finalTitle, firstPrompt, cwd: actualCwd, updatedAt }, file) : null };
          cache.set(file, cached);
        }
        if (cached.record) records.push(cached.record);
      }
    }
    return { available: true, records };
  } };
}
