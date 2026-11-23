import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLIS, UUID } from './index.js';
import { LOCAL_HOST, normalizeHostName } from '../project-config.js';

const TRANSFER_TIMEOUT_MS = 60_000;

/**
 * Python 3 script run on the source host to export one conversation's files and
 * metadata into a self-contained `.tar.gz` bundle using SQLite `.backup()` for
 * WAL-safe snapshots.
 */
export const EXPORT_SESSION_SCRIPT = `
import hashlib, json, os, re, shutil, sqlite3, sys, tarfile, tempfile

def backup_sqlite(src, dst):
    src_conn = sqlite3.connect(f'file:{src}?mode=ro', uri=True, timeout=5.0)
    dst_conn = sqlite3.connect(dst)
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()

def export_claude(home, cid, source_cwd, stage):
    enc = re.sub(r'[^a-zA-Z0-9]', '-', source_cwd)
    proj_dir = os.path.join(home, '.claude', 'projects', enc)
    jsonl = os.path.join(proj_dir, f'{cid}.jsonl')
    if not os.path.isfile(jsonl):
        raise FileNotFoundError(f'Claude conversation file not found: {jsonl}')
    shutil.copy2(jsonl, os.path.join(stage, f'{cid}.jsonl'))
    sub_dir = os.path.join(proj_dir, cid)
    if os.path.isdir(sub_dir):
        shutil.copytree(sub_dir, os.path.join(stage, cid))
    return {'hasSubdir': os.path.isdir(sub_dir)}

def export_codex(home, cid, source_cwd, stage):
    db_file = os.path.join(home, '.codex', 'state_5.sqlite')
    if not os.path.isfile(db_file):
        raise FileNotFoundError(f'Codex DB not found: {db_file}')
    conn = sqlite3.connect(f'file:{db_file}?mode=ro', uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute('SELECT * FROM threads WHERE id = ?', (cid,)).fetchone()
        if row is None:
            raise FileNotFoundError(f'Codex thread not found: {cid}')
        row_dict = dict(row)
    finally:
        conn.close()
    rollout_path = row_dict.get('rollout_path')
    if not rollout_path or not os.path.isfile(rollout_path):
        raise FileNotFoundError(f'Codex rollout file not found: {rollout_path}')
    sessions_root = os.path.join(home, '.codex', 'sessions')
    try:
        rel_rollout = os.path.relpath(rollout_path, sessions_root)
        if rel_rollout.startswith('..'):
            rel_rollout = os.path.basename(rollout_path)
    except ValueError:
        rel_rollout = os.path.basename(rollout_path)
    shutil.copy2(rollout_path, os.path.join(stage, 'rollout.jsonl'))
    return {'row': row_dict, 'relRollout': rel_rollout}

def export_cursor(home, cid, source_cwd, stage):
    cwd_hash = hashlib.md5(source_cwd.encode('utf-8')).hexdigest()
    chat_dir = os.path.join(home, '.cursor', 'chats', cwd_hash, cid)
    if not os.path.isdir(chat_dir):
        # Fallback scan if hash differs (e.g. symlinked cwd)
        root = os.path.join(home, '.cursor', 'chats')
        found = None
        if os.path.isdir(root):
            for group in os.scandir(root):
                cand = os.path.join(group.path, cid)
                if group.is_dir() and os.path.isdir(cand):
                    found = cand
                    break
        if not found:
            raise FileNotFoundError(f'Cursor chat dir not found for {cid}')
        chat_dir = found
    out_chat = os.path.join(stage, 'chat')
    os.makedirs(out_chat, exist_ok=True)
    for entry in os.scandir(chat_dir):
        if not entry.is_file():
            continue
        if entry.name in ('store.db-wal', 'store.db-shm'):
            continue
        if entry.name == 'store.db':
            backup_sqlite(entry.path, os.path.join(out_chat, 'store.db'))
        else:
            shutil.copy2(entry.path, os.path.join(out_chat, entry.name))
    enc = re.sub(r'[^a-zA-Z0-9]', '-', source_cwd.lstrip('/'))
    transcript = os.path.join(home, '.cursor', 'projects', enc, 'agent-transcripts', cid, f'{cid}.jsonl')
    has_transcript = os.path.isfile(transcript)
    if has_transcript:
        shutil.copy2(transcript, os.path.join(stage, 'transcript.jsonl'))
    return {'hasTranscript': has_transcript}

def export_agy(home, cid, source_cwd, stage):
    root = os.path.join(home, '.gemini', 'antigravity-cli')
    conv_db = os.path.join(root, 'conversations', f'{cid}.db')
    if not os.path.isfile(conv_db):
        raise FileNotFoundError(f'Antigravity conversation DB not found: {conv_db}')
    backup_sqlite(conv_db, os.path.join(stage, f'{cid}.db'))
    summary_db = os.path.join(root, 'conversation_summaries.db')
    summary_row = None
    if os.path.isfile(summary_db):
        conn = sqlite3.connect(f'file:{summary_db}?mode=ro', uri=True, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute('SELECT * FROM conversation_summaries WHERE conversation_id = ?', (cid,)).fetchone()
            if row is not None:
                d = dict(row)
                raw = d.pop('raw_summary', None)
                if raw is not None:
                    with open(os.path.join(stage, 'raw_summary.bin'), 'wb') as fh:
                        fh.write(raw)
                    d['_has_raw_summary'] = True
                summary_row = d
        finally:
            conn.close()
    brain_dir = os.path.join(root, 'brain', cid)
    has_brain = os.path.isdir(brain_dir)
    if has_brain:
        shutil.copytree(brain_dir, os.path.join(stage, 'brain'))
    return {'summaryRow': summary_row, 'hasBrain': has_brain}

def main():
    cfg = json.loads(sys.argv[1])
    cli = cfg['cli']
    cid = cfg['conversationId']
    source_cwd = cfg['sourceCwd']
    out_path = cfg['outPath']
    home = os.path.expanduser(cfg.get('homeOverride') or '~')
    stage = tempfile.mkdtemp(prefix='codedeck-export-')
    try:
        exporters = {
            'claude': export_claude,
            'codex': export_codex,
            'cursor': export_cursor,
            'agy': export_agy,
        }
        meta = exporters[cli](home, cid, source_cwd, stage)
        manifest = {'cli': cli, 'conversationId': cid, 'sourceCwd': source_cwd, 'meta': meta}
        with open(os.path.join(stage, 'manifest.json'), 'w', encoding='utf-8') as fh:
            json.dump(manifest, fh)
        with tarfile.open(out_path, 'w:gz') as tar:
            for name in os.listdir(stage):
                tar.add(os.path.join(stage, name), arcname=name)
        print(json.dumps({'ok': True, 'size': os.path.getsize(out_path)}))
    finally:
        shutil.rmtree(stage, ignore_errors=True)

if __name__ == '__main__':
    main()
`;

/**
 * Python 3 script run on the target host to unpack a `.tar.gz` bundle, rewrite
 * paths to `targetCwd`, and atomically install into the target CLI's history store.
 */
export const IMPORT_SESSION_SCRIPT = `
import hashlib, json, os, re, shutil, sqlite3, sys, tarfile, tempfile
from urllib.parse import quote

def atomic_replace(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = f'{dst}.tmp.{os.getpid()}'
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)

def import_claude(home, cid, source_cwd, target_cwd, stage, meta):
    enc = re.sub(r'[^a-zA-Z0-9]', '-', target_cwd)
    proj_dir = os.path.join(home, '.claude', 'projects', enc)
    os.makedirs(proj_dir, exist_ok=True)
    src_jsonl = os.path.join(stage, f'{cid}.jsonl')
    dst_jsonl = os.path.join(proj_dir, f'{cid}.jsonl')
    rewritten = os.path.join(stage, f'{cid}.rewritten.jsonl')
    with open(src_jsonl, 'r', encoding='utf-8', errors='replace') as fin, open(rewritten, 'w', encoding='utf-8') as fout:
        for line in fin:
            if not line.strip():
                fout.write(line)
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict) and obj.get('cwd') == source_cwd:
                    obj['cwd'] = target_cwd
                    fout.write(json.dumps(obj, ensure_ascii=False) + '\\n')
                    continue
            except Exception:
                pass
            fout.write(line)
    atomic_replace(rewritten, dst_jsonl)
    src_sub = os.path.join(stage, cid)
    if meta.get('hasSubdir') and os.path.isdir(src_sub):
        dst_sub = os.path.join(proj_dir, cid)
        if os.path.isdir(dst_sub):
            shutil.rmtree(dst_sub)
        shutil.copytree(src_sub, dst_sub)

def import_codex(home, cid, source_cwd, target_cwd, stage, meta):
    rel_rollout = meta['relRollout'].lstrip('/\\\\')
    dst_rollout = os.path.join(home, '.codex', 'sessions', rel_rollout)
    os.makedirs(os.path.dirname(dst_rollout), exist_ok=True)
    src_rollout = os.path.join(stage, 'rollout.jsonl')
    rewritten = os.path.join(stage, 'rollout.rewritten.jsonl')
    with open(src_rollout, 'r', encoding='utf-8', errors='replace') as fin, open(rewritten, 'w', encoding='utf-8') as fout:
        for idx, line in enumerate(fin):
            if idx == 0 and line.strip():
                try:
                    obj = json.loads(line)
                    if isinstance(obj, dict) and isinstance(obj.get('payload'), dict) and obj['payload'].get('cwd') == source_cwd:
                        obj['payload']['cwd'] = target_cwd
                        fout.write(json.dumps(obj, ensure_ascii=False) + '\\n')
                        continue
                except Exception:
                    pass
            fout.write(line)
    atomic_replace(rewritten, dst_rollout)
    db_file = os.path.join(home, '.codex', 'state_5.sqlite')
    if not os.path.isfile(db_file):
        raise FileNotFoundError(f'Target Codex DB not initialized: {db_file}')
    conn = sqlite3.connect(db_file, timeout=5.0)
    try:
        target_cols = {r[1] for r in conn.execute('PRAGMA table_info(threads)').fetchall()}
        row = dict(meta['row'])
        row['cwd'] = target_cwd
        row['rollout_path'] = dst_rollout
        if 'project_id' in row:
            row['project_id'] = None
        if 'thread_section_id' in row:
            row['thread_section_id'] = None
        cols = [c for c in row.keys() if c in target_cols]
        placeholders = ','.join('?' for _ in cols)
        col_list = ','.join(f'"{c}"' for c in cols)
        conn.execute(f'INSERT OR REPLACE INTO threads ({col_list}) VALUES ({placeholders})', [row[c] for c in cols])
        conn.commit()
    finally:
        conn.close()

def import_cursor(home, cid, source_cwd, target_cwd, stage, meta):
    cwd_hash = hashlib.md5(target_cwd.encode('utf-8')).hexdigest()
    dst_chat = os.path.join(home, '.cursor', 'chats', cwd_hash, cid)
    os.makedirs(dst_chat, exist_ok=True)
    src_chat = os.path.join(stage, 'chat')
    for entry in os.scandir(src_chat):
        if not entry.is_file():
            continue
        dst_file = os.path.join(dst_chat, entry.name)
        if entry.name == 'meta.json':
            with open(entry.path, 'r', encoding='utf-8') as fh:
                m = json.load(fh)
            m['cwd'] = target_cwd
            tmp = os.path.join(stage, 'meta.rewritten.json')
            with open(tmp, 'w', encoding='utf-8') as fh:
                json.dump(m, fh)
            atomic_replace(tmp, dst_file)
        else:
            if entry.name == 'store.db':
                for suffix in ('-wal', '-shm'):
                    wal = dst_file + suffix
                    if os.path.exists(wal):
                        os.remove(wal)
            atomic_replace(entry.path, dst_file)
    src_transcript = os.path.join(stage, 'transcript.jsonl')
    if meta.get('hasTranscript') and os.path.isfile(src_transcript):
        enc = re.sub(r'[^a-zA-Z0-9]', '-', target_cwd.lstrip('/'))
        dst_transcript = os.path.join(home, '.cursor', 'projects', enc, 'agent-transcripts', cid, f'{cid}.jsonl')
        atomic_replace(src_transcript, dst_transcript)

def import_agy(home, cid, source_cwd, target_cwd, stage, meta):
    root = os.path.join(home, '.gemini', 'antigravity-cli')
    dst_conv = os.path.join(root, 'conversations', f'{cid}.db')
    os.makedirs(os.path.dirname(dst_conv), exist_ok=True)
    for suffix in ('-wal', '-shm'):
        wal = dst_conv + suffix
        if os.path.exists(wal):
            os.remove(wal)
    atomic_replace(os.path.join(stage, f'{cid}.db'), dst_conv)
    src_brain = os.path.join(stage, 'brain')
    if meta.get('hasBrain') and os.path.isdir(src_brain):
        dst_brain = os.path.join(root, 'brain', cid)
        if os.path.isdir(dst_brain):
            shutil.rmtree(dst_brain)
        shutil.copytree(src_brain, dst_brain)
    summary_row = meta.get('summaryRow')
    summary_db = os.path.join(root, 'conversation_summaries.db')
    if summary_row and os.path.isfile(summary_db):
        row = dict(summary_row)
        has_raw = row.pop('_has_raw_summary', False)
        if has_raw and os.path.isfile(os.path.join(stage, 'raw_summary.bin')):
            with open(os.path.join(stage, 'raw_summary.bin'), 'rb') as fh:
                row['raw_summary'] = fh.read()
        row['workspace_uris'] = json.dumps([f'file://{quote(target_cwd)}'])
        row['app_data_dir'] = root
        conn = sqlite3.connect(summary_db, timeout=5.0)
        try:
            target_cols = {r[1] for r in conn.execute('PRAGMA table_info(conversation_summaries)').fetchall()}
            cols = [c for c in row.keys() if c in target_cols]
            placeholders = ','.join('?' for _ in cols)
            col_list = ','.join(f'"{c}"' for c in cols)
            conn.execute(f'INSERT OR REPLACE INTO conversation_summaries ({col_list}) VALUES ({placeholders})', [row[c] for c in cols])
            conn.commit()
        finally:
            conn.close()

def main():
    cfg = json.loads(sys.argv[1])
    target_cwd = cfg['targetCwd']
    in_path = cfg['inPath']
    home = os.path.expanduser(cfg.get('homeOverride') or '~')
    stage = tempfile.mkdtemp(prefix='codedeck-import-')
    try:
        with tarfile.open(in_path, 'r:gz') as tar:
            tar.extractall(stage)
        with open(os.path.join(stage, 'manifest.json'), 'r', encoding='utf-8') as fh:
            manifest = json.load(fh)
        cli = manifest['cli']
        cid = manifest['conversationId']
        source_cwd = manifest['sourceCwd']
        meta = manifest['meta']
        importers = {
            'claude': import_claude,
            'codex': import_codex,
            'cursor': import_cursor,
            'agy': import_agy,
        }
        importers[cli](home, cid, source_cwd, target_cwd, stage, meta)
        print(json.dumps({'ok': True}))
    finally:
        shutil.rmtree(stage, ignore_errors=True)

if __name__ == '__main__':
    main()
`;

async function removeRemoteTemp(runner, filePath) {
  if (!filePath) return;
  try {
    if (runner.kind === 'local') await fs.rm(filePath, { force: true });
    else await runner.run('rm', ['-f', filePath], { timeout: 5000 });
  } catch (err) {
    console.warn(`[agent-history] failed to clean temp bundle ${filePath}: ${err.message}`);
  }
}

export function createSessionMaterializer({ resolveHostRunner, tmpDir = os.tmpdir() }) {
  if (typeof resolveHostRunner !== 'function') {
    throw new Error('Session materializer requires resolveHostRunner');
  }

  return async function materializeSession({
    cli,
    conversationId,
    sourceHost,
    sourceCwd,
    targetHost,
    targetCwd,
    sourceHomeOverride,
    targetHomeOverride,
  }) {
    if (!CLIS.includes(cli)) throw new Error(`Invalid cli: ${cli}`);
    if (typeof conversationId !== 'string' || !UUID.test(conversationId)) throw new Error('Invalid conversationId');
    if (typeof sourceCwd !== 'string' || !path.isAbsolute(sourceCwd)) throw new Error('Invalid sourceCwd');
    if (typeof targetCwd !== 'string' || !path.isAbsolute(targetCwd)) throw new Error('Invalid targetCwd');

    const srcHost = normalizeHostName(sourceHost);
    const dstHost = normalizeHostName(targetHost);
    if (srcHost === dstHost && sourceCwd === targetCwd && !sourceHomeOverride && !targetHomeOverride) {
      return { synced: false };
    }

    const { runner: srcRunner } = resolveHostRunner(srcHost);
    const { runner: dstRunner } = resolveHostRunner(dstHost);
    const nonce = randomUUID();
    const localBundle = path.join(tmpDir, `codedeck-session-${nonce}.tar.gz`);
    const srcBundle = srcRunner.kind === 'local' ? localBundle : `/tmp/codedeck-session-src-${nonce}.tar.gz`;
    const dstBundle = dstRunner.kind === 'local' ? localBundle : `/tmp/codedeck-session-dst-${nonce}.tar.gz`;

    try {
      await srcRunner.run(
        'python3',
        ['-c', EXPORT_SESSION_SCRIPT, JSON.stringify({
          cli,
          conversationId,
          sourceCwd,
          outPath: srcBundle,
          ...(sourceHomeOverride ? { homeOverride: sourceHomeOverride } : {}),
        })],
        { timeout: TRANSFER_TIMEOUT_MS },
      );

      if (srcRunner.kind !== 'local') {
        await srcRunner.copyFrom(srcBundle, localBundle, { timeout: TRANSFER_TIMEOUT_MS });
      }
      if (dstRunner.kind !== 'local') {
        await dstRunner.copyTo(localBundle, dstBundle, { timeout: TRANSFER_TIMEOUT_MS });
      }

      await dstRunner.run(
        'python3',
        ['-c', IMPORT_SESSION_SCRIPT, JSON.stringify({
          targetCwd,
          inPath: dstBundle,
          ...(targetHomeOverride ? { homeOverride: targetHomeOverride } : {}),
        })],
        { timeout: TRANSFER_TIMEOUT_MS },
      );

      return { synced: true, sourceHost: srcHost, targetHost: dstHost };
    } finally {
      await removeRemoteTemp(srcRunner, srcBundle);
      if (dstBundle !== srcBundle) await removeRemoteTemp(dstRunner, dstBundle);
      if (localBundle !== srcBundle && localBundle !== dstBundle) {
        await removeRemoteTemp({ kind: 'local' }, localBundle);
      }
    }
  };
}
