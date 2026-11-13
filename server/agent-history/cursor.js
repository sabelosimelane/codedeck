import path from 'node:path';
import { sourceLabel, prompt, validateRecord, UUID } from './index.js';
function firstPrompt(fs, file) {
  if (!fs.existsSync(file)) return null;
  const first = fs.readFileSync(file, 'utf8').split('\n')[0];
  let row;
  try { row = JSON.parse(first); } catch { throw new Error(`${file}:1: invalid JSON`); }
  if (row.role !== 'user') return null;
  const text = row.message?.content?.filter(x => x?.type === 'text').map(x => x.text).join('\n');
  if (typeof text !== 'string') throw new Error(`${file}:1: invalid message.content`);
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return prompt(match ? match[1] : text);
}
export function createCursorReader({ home, fs }) {
  const root = path.join(home, '.cursor/chats');
  return { list() {
    if (!fs.existsSync(root)) return { available: false, records: [] };
    const records = [];
    for (const group of fs.readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      for (const entry of fs.readdirSync(path.join(root, group.name), { withFileTypes: true })) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
        const file = path.join(root, group.name, entry.name, 'meta.json');
        if (!fs.existsSync(file)) continue;
        let meta;
        try { meta = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${file}: invalid JSON`); }
        if (meta.isSubagent === true || meta.hasConversation === false || !meta.cwd) continue;
        const encoded = meta.cwd.replace(/^\//, '').replace(/[^a-zA-Z0-9]/g, '-');
        const transcript = path.join(home, '.cursor/projects', encoded, 'agent-transcripts', entry.name, `${entry.name}.jsonl`);
        const title = sourceLabel(meta.title, file, 'title'); const first = firstPrompt(fs, transcript);
        if (!title && !first) continue;
        records.push(validateRecord({ cli: 'cursor', conversationId: entry.name, title, firstPrompt: first, cwd: meta.cwd, updatedAt: meta.updatedAtMs }, file));
      }
    }
    return { available: true, records };
  } };
}
