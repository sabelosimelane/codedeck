import path from 'node:path';
import { createClaudeReader } from './claude.js';
import { createCodexReader } from './codex.js';
import { createCursorReader } from './cursor.js';
import { createAgyReader } from './agy.js';

export const CLIS = ['claude', 'codex', 'cursor', 'agy'];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const textOrNull = value => value === null || (typeof value === 'string' && value.trim().length > 0 && value === value.trim());
export function validateRecord(record, source) {
  const checks = {
    cli: CLIS.includes(record?.cli),
    conversationId: typeof record?.conversationId === 'string' && UUID.test(record.conversationId),
    title: textOrNull(record?.title),
    firstPrompt: textOrNull(record?.firstPrompt) && (record?.firstPrompt === null || [...record.firstPrompt].length <= 200),
    cwd: typeof record?.cwd === 'string' && path.isAbsolute(record.cwd) && !record.cwd.includes('\0'),
    updatedAt: Number.isSafeInteger(record?.updatedAt) && record.updatedAt >= 0,
  };
  for (const [field, valid] of Object.entries(checks)) if (!valid) throw new Error(`${source}: invalid ${field}`);
  if (record.title === null && record.firstPrompt === null) throw new Error(`${source}: title and firstPrompt are missing`);
  return record;
}
export function sourceLabel(value, source, field) {
  if (value !== null && value !== undefined && typeof value !== 'string') throw new Error(`${source}: invalid ${field}`);
  return label(value);
}
export function label(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
export function prompt(value) { return label(label(value)?.slice(0, 200)) ?? null; }
export function mergeHistory(readers, cwds, { cli, q, page = 0, size = 20 } = {}) {
  if (!Array.isArray(cwds) || cwds.some(cwd => typeof cwd !== 'string' || !path.isAbsolute(cwd))) throw new Error('Invalid cwd set');
  const scope = new Set(cwds);
  const sources = [];
  const records = [];
  for (const [name, reader] of Object.entries(readers)) {
    const result = reader.list(cwds);
    if (typeof result?.available !== 'boolean' || !Array.isArray(result?.records)) throw new Error(`${name}: invalid reader result`);
    sources.push({ cli: name, available: result.available });
    for (const record of result.records) {
      validateRecord(record, `${name} reader`);
      if (scope.has(record.cwd) && (!cli || record.cli === cli) && (!q || [record.title, record.firstPrompt].some(v => v?.toLowerCase().includes(q.toLowerCase())))) records.push(record);
    }
  }
  records.sort((a, b) => b.updatedAt - a.updatedAt || a.cli.localeCompare(b.cli) || a.conversationId.localeCompare(b.conversationId));
  return { data: records.slice(page * size, (page + 1) * size), page: { currentPage: page, size, totalElements: records.length, totalPages: Math.ceil(records.length / size), hasNextPage: (page + 1) * size < records.length }, sources };
}

/**
 * Merge records collected from local + remote hosts, deduplicating by (cli, conversationId)
 * so the most recently updated copy is authoritative regardless of host.
 */
export function mergeMultiHostHistory(hostResults, { host, cli, q, page = 0, size = 20 } = {}) {
  const hosts = [];
  const cliAvailability = new Map(CLIS.map(name => [name, false]));
  const byKey = new Map();

  for (const entry of hostResults) {
    hosts.push({ host: entry.host, available: Boolean(entry.available), error: entry.error ?? null });
    if (!entry.available) continue;
    for (const src of entry.sources ?? []) {
      if (src.available) cliAvailability.set(src.cli, true);
    }
    for (const record of entry.records ?? []) {
      const key = `${record.cli}:${record.conversationId}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...record, availableHosts: [record.host] });
      } else {
        const availableHosts = existing.availableHosts.includes(record.host)
          ? existing.availableHosts
          : [...existing.availableHosts, record.host];
        if (record.updatedAt > existing.updatedAt) {
          byKey.set(key, { ...record, availableHosts });
        } else {
          existing.availableHosts = availableHosts;
        }
      }
    }
  }

  const queryLower = q ? q.toLowerCase() : null;
  const records = [];
  for (const record of byKey.values()) {
    if (host && record.host !== host && !record.availableHosts.includes(host)) continue;
    if (cli && record.cli !== cli) continue;
    if (queryLower && ![record.title, record.firstPrompt].some(v => v?.toLowerCase().includes(queryLower))) continue;
    records.push(record);
  }

  records.sort((a, b) => b.updatedAt - a.updatedAt || a.cli.localeCompare(b.cli) || a.conversationId.localeCompare(b.conversationId));
  const sources = CLIS.map(name => ({ cli: name, available: cliAvailability.get(name) === true }));
  return {
    data: records.slice(page * size, (page + 1) * size),
    page: {
      currentPage: page,
      size,
      totalElements: records.length,
      totalPages: Math.ceil(records.length / size),
      hasNextPage: (page + 1) * size < records.length,
    },
    sources,
    hosts,
  };
}
export function createAgentHistory({ home, fs, Database }) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('Agent history requires absolute home');
  if (!fs || typeof fs.existsSync !== 'function' || typeof fs.readFileSync !== 'function') throw new Error('Agent history requires fs');
  if (typeof Database !== 'function') throw new Error('Agent history requires Database');
  const readers = { claude: createClaudeReader({ home, fs }), codex: createCodexReader({ home, fs, Database }), cursor: createCursorReader({ home, fs }), agy: createAgyReader({ home, fs, Database }) };
  return { readers, search: (cwds, options) => mergeHistory(readers, cwds, options) };
}
