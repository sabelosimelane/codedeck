import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateRecord } from './index.js';

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 15_000;

/**
 * Self-contained Python 3 script executed on a remote host over multiplexed SSH.
 * Uses only the Python standard library (sqlite3, json, os, re, urllib, datetime)
 * so no remote packages or sqlite3 CLI binaries are required.
 */
export const REMOTE_COLLECTOR_SCRIPT = `
import datetime, json, os, re, sqlite3, sys
from urllib.parse import unquote, urlparse

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
SKIP_TAG_RE = re.compile(r'^<(?:local-command|command-|system-reminder|hook)')
USER_QUERY_RE = re.compile(r'<user_query>\\s*([\\s\\S]*?)\\s*</user_query>')
CODEX_SOURCES = ('cli', 'vscode', '{"custom":"atlas"}', '{"custom":"chatgpt"}')

def clean_label(value):
    if isinstance(value, str):
        t = value.strip()
        return t if t else None
    return None

def clean_prompt(value):
    t = clean_label(value)
    if t is None:
        return None
    return clean_label(t[:200])

def parse_iso_ms(ts):
    if not isinstance(ts, str) or not ts:
        return None
    try:
        s = ts.replace('Z', '+00:00')
        return int(datetime.datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return None

def claude_user_text(rec):
    if (rec.get('type') != 'user' or rec.get('isSidechain') is True
            or rec.get('agentName') or rec.get('isMeta') is True
            or (rec.get('promptSource') is not None and rec.get('promptSource') != 'typed')):
        return None
    content = (rec.get('message') or {}).get('content')
    if isinstance(content, str):
        return None if SKIP_TAG_RE.match(content.strip()) else clean_prompt(content)
    if isinstance(content, list):
        parts = [x.get('text', '') for x in content if isinstance(x, dict) and x.get('type') == 'text' and isinstance(x.get('text'), str)]
        text = '\\n'.join(parts).strip()
        return None if SKIP_TAG_RE.match(text) else clean_prompt(text)
    return None

def read_claude(home, cwds):
    root = os.path.join(home, '.claude', 'projects')
    if not os.path.exists(root):
        return {'cli': 'claude', 'available': False, 'records': []}
    records = []
    for cwd in cwds:
        enc = re.sub(r'[^a-zA-Z0-9]', '-', cwd)
        proj_dir = os.path.join(root, enc)
        if not os.path.isdir(proj_dir):
            continue
        try:
            entries = os.scandir(proj_dir)
        except OSError:
            continue
        with entries:
            for entry in entries:
                if not entry.is_file() or not entry.name.endswith('.jsonl'):
                    continue
                conv_id = entry.name[:-6]
                if not UUID_RE.match(conv_id):
                    continue
                title = None
                custom = None
                first_prompt = None
                updated_at = 0
                interactive = False
                actual_cwd = None
                try:
                    with open(entry.path, 'r', encoding='utf-8', errors='replace') as fh:
                        lines = fh.read().split('\\n')
                except OSError:
                    continue
                for idx, line in enumerate(lines):
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except Exception:
                        if idx == len(lines) - 1:
                            break
                        continue
                    if not isinstance(row, dict):
                        continue
                    if row.get('entrypoint') == 'cli' and row.get('isSidechain') is not True and not row.get('agentName') and row.get('cwd') == cwd:
                        interactive = True
                        actual_cwd = row.get('cwd')
                    if row.get('type') == 'ai-title' and row.get('sessionId') == conv_id:
                        title = clean_label(row.get('aiTitle'))
                    if row.get('type') == 'custom-title' and row.get('sessionId') == conv_id:
                        custom = clean_label(row.get('customTitle'))
                    if row.get('entrypoint') == 'cli' and not row.get('agentName') and row.get('cwd') == cwd and first_prompt is None:
                        first_prompt = claude_user_text(row)
                    if row.get('entrypoint') == 'cli' and row.get('cwd') == cwd and row.get('timestamp') is not None:
                        ms = parse_iso_ms(row.get('timestamp'))
                        if ms is not None and ms > updated_at:
                            updated_at = ms
                final_title = custom if custom is not None else title
                if interactive and actual_cwd and updated_at and (final_title or first_prompt):
                    records.append({
                        'cli': 'claude',
                        'conversationId': conv_id,
                        'title': final_title,
                        'firstPrompt': first_prompt,
                        'cwd': actual_cwd,
                        'updatedAt': updated_at,
                    })
    return {'cli': 'claude', 'available': True, 'records': records}

def read_codex(home, cwds):
    db_file = os.path.join(home, '.codex', 'state_5.sqlite')
    if not os.path.exists(db_file):
        return {'cli': 'codex', 'available': False, 'records': []}
    if not cwds:
        return {'cli': 'codex', 'available': True, 'records': []}
    records = []
    conn = sqlite3.connect(f'file:{db_file}?mode=ro', uri=True, timeout=2.0)
    try:
        placeholders = ','.join('?' for _ in cwds)
        src_placeholders = ','.join('?' for _ in CODEX_SOURCES)
        sql = f'SELECT id, cwd, name, first_user_message, recency_at_ms FROM threads WHERE source IN ({src_placeholders}) AND archived = 0 AND cwd IN ({placeholders})'
        cur = conn.execute(sql, list(CODEX_SOURCES) + list(cwds))
        for row in cur.fetchall():
            cid, cwd, name, first_msg, recency = row
            if not isinstance(cid, str) or not UUID_RE.match(cid):
                continue
            title = clean_label(name)
            first_prompt = clean_prompt(first_msg)
            if not title and not first_prompt:
                continue
            if not isinstance(recency, int) or recency < 0:
                continue
            records.append({
                'cli': 'codex',
                'conversationId': cid,
                'title': title,
                'firstPrompt': first_prompt,
                'cwd': cwd,
                'updatedAt': recency,
            })
    finally:
        conn.close()
    return {'cli': 'codex', 'available': True, 'records': records}

def read_cursor_first_prompt(transcript_path):
    if not os.path.isfile(transcript_path):
        return None
    try:
        with open(transcript_path, 'r', encoding='utf-8', errors='replace') as fh:
            first = fh.readline()
        row = json.loads(first)
    except Exception:
        return None
    if not isinstance(row, dict) or row.get('role') != 'user':
        return None
    content = (row.get('message') or {}).get('content')
    if not isinstance(content, list):
        return None
    text = '\\n'.join(x.get('text', '') for x in content if isinstance(x, dict) and x.get('type') == 'text' and isinstance(x.get('text'), str))
    m = USER_QUERY_RE.search(text)
    return clean_prompt(m.group(1) if m else text)

def read_cursor(home, cwds):
    root = os.path.join(home, '.cursor', 'chats')
    if not os.path.isdir(root):
        return {'cli': 'cursor', 'available': False, 'records': []}
    cwd_set = set(cwds)
    records = []
    try:
        groups = list(os.scandir(root))
    except OSError:
        return {'cli': 'cursor', 'available': True, 'records': []}
    for group in groups:
        if not group.is_dir():
            continue
        try:
            entries = list(os.scandir(group.path))
        except OSError:
            continue
        for entry in entries:
            if not entry.is_dir() or not UUID_RE.match(entry.name):
                continue
            meta_file = os.path.join(entry.path, 'meta.json')
            if not os.path.isfile(meta_file):
                continue
            try:
                with open(meta_file, 'r', encoding='utf-8') as fh:
                    meta = json.load(fh)
            except Exception:
                continue
            if not isinstance(meta, dict):
                continue
            if meta.get('isSubagent') is True or meta.get('hasConversation') is False:
                continue
            cwd = meta.get('cwd')
            if not isinstance(cwd, str) or cwd not in cwd_set:
                continue
            enc = re.sub(r'[^a-zA-Z0-9]', '-', cwd.lstrip('/'))
            transcript = os.path.join(home, '.cursor', 'projects', enc, 'agent-transcripts', entry.name, f'{entry.name}.jsonl')
            title = clean_label(meta.get('title'))
            first = read_cursor_first_prompt(transcript)
            updated_at = meta.get('updatedAtMs')
            if (not title and not first) or not isinstance(updated_at, int) or updated_at < 0:
                continue
            records.append({
                'cli': 'cursor',
                'conversationId': entry.name,
                'title': title,
                'firstPrompt': first,
                'cwd': cwd,
                'updatedAt': updated_at,
            })
    return {'cli': 'cursor', 'available': True, 'records': records}

def read_agy(home, cwds):
    db_file = os.path.join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db')
    if not os.path.isfile(db_file):
        return {'cli': 'agy', 'available': False, 'records': []}
    cwd_set = set(cwds)
    prompts = {}
    hist_file = os.path.join(home, '.gemini', 'antigravity-cli', 'history.jsonl')
    if os.path.isfile(hist_file):
        try:
            with open(hist_file, 'r', encoding='utf-8', errors='replace') as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except Exception:
                        continue
                    cid = row.get('conversationId')
                    if not cid or row.get('type') == 'slash_command' or not clean_label(row.get('display')):
                        continue
                    ts = row.get('timestamp')
                    if not isinstance(ts, int):
                        continue
                    prior = prompts.get(cid)
                    if prior is None or ts < prior[0]:
                        prompts[cid] = (ts, clean_prompt(row.get('display')))
        except OSError:
            pass
    records = []
    conn = sqlite3.connect(f'file:{db_file}?mode=ro', uri=True, timeout=2.0)
    try:
        cur = conn.execute('SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries WHERE nesting_depth = 0')
        for cid, raw_title, raw_uris, raw_mod in cur.fetchall():
            if not isinstance(cid, str) or not UUID_RE.match(cid):
                continue
            title = clean_label(raw_title)
            first_prompt = prompts[cid][1] if cid in prompts else None
            if not title and not first_prompt:
                continue
            if not raw_uris:
                continue
            try:
                uris = json.loads(raw_uris)
            except Exception:
                continue
            if not isinstance(uris, list):
                continue
            updated_at = parse_iso_ms(raw_mod)
            if updated_at is None or updated_at < 0:
                continue
            for uri in uris:
                if not isinstance(uri, str) or not uri.startswith('file://'):
                    continue
                cwd = unquote(urlparse(uri).path)
                if cwd in cwd_set:
                    records.append({
                        'cli': 'agy',
                        'conversationId': cid,
                        'title': title,
                        'firstPrompt': first_prompt,
                        'cwd': cwd,
                        'updatedAt': updated_at,
                    })
    finally:
        conn.close()
    return {'cli': 'agy', 'available': True, 'records': records}

def main():
    payload = json.loads(sys.argv[1])
    cwds = payload.get('cwds', [])
    home = os.path.expanduser('~')
    results = [
        read_claude(home, cwds),
        read_codex(home, cwds),
        read_cursor(home, cwds),
        read_agy(home, cwds),
    ]
    sources = [{'cli': r['cli'], 'available': r['available']} for r in results]
    records = [rec for r in results for rec in r['records']]
    print(json.dumps({'sources': sources, 'records': records}))

if __name__ == '__main__':
    main()
`;

function cacheKey(hostName, cwds) {
  const digest = createHash('sha256')
    .update([...new Set(cwds)].sort().join('\0'))
    .digest('hex')
    .slice(0, 16);
  return `${hostName}:${digest}`;
}

export function createRemoteAgentHistory({
  resolveHostRunner,
  ttlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_REMOTE_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  if (typeof resolveHostRunner !== 'function') {
    throw new Error('Remote agent history requires resolveHostRunner');
  }
  const cache = new Map();
  const inflight = new Map();

  async function fetchHost(hostName, cwds) {
    if (!Array.isArray(cwds) || cwds.some(cwd => typeof cwd !== 'string' || !path.isAbsolute(cwd))) {
      throw new Error('Invalid cwd set');
    }
    const uniqueCwds = [...new Set(cwds)];
    if (uniqueCwds.length === 0) {
      return { host: hostName, available: true, error: null, sources: [], records: [] };
    }

    const { runner } = resolveHostRunner(hostName);
    const { stdout } = await runner.run(
      'python3',
      ['-c', REMOTE_COLLECTOR_SCRIPT, JSON.stringify({ cwds: uniqueCwds })],
      { timeout: timeoutMs },
    );

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`Remote history on ${hostName}: invalid JSON response`);
    }
    if (!Array.isArray(parsed?.sources) || !Array.isArray(parsed?.records)) {
      throw new Error(`Remote history on ${hostName}: malformed collector response`);
    }
    const scope = new Set(uniqueCwds);
    const records = [];
    for (const record of parsed.records) {
      validateRecord(record, `${hostName}:${record?.cli ?? 'unknown'}`);
      if (scope.has(record.cwd)) {
        records.push({ ...record, host: hostName });
      }
    }
    return { host: hostName, available: true, error: null, sources: parsed.sources, records };
  }

  return {
    async listHost(hostName, cwds, { refresh = false } = {}) {
      const key = cacheKey(hostName, cwds);
      if (!refresh) {
        const hit = cache.get(key);
        if (hit && now() - hit.at < ttlMs) return hit.value;
      }
      const existing = inflight.get(key);
      if (existing) return existing;

      const pending = fetchHost(hostName, cwds)
        .then(value => {
          cache.set(key, { at: now(), value });
          return value;
        })
        .finally(() => {
          if (inflight.get(key) === pending) inflight.delete(key);
        });
      inflight.set(key, pending);
      return pending;
    },

    invalidate(hostName) {
      if (!hostName) {
        cache.clear();
        return;
      }
      const prefix = `${hostName}:`;
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
    },
  };
}
