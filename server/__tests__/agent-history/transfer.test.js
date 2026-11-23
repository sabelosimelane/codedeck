import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalRunner } from '../../command-runner.js';
import { createSessionMaterializer } from '../../agent-history/transfer.js';

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';
const UUID_4 = '44444444-4444-4444-8444-444444444444';

const tempDirs = [];
function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function createMaterializer() {
  const runner = createLocalRunner();
  return createSessionMaterializer({
    resolveHostRunner: hostName => ({ hostName, host: null, runner }),
  });
}

describe('cross-host session materializer (real Python round-trips)', () => {
  it('ports a Claude conversation and rewrites top-level cwd fields + copies subagent dir', async () => {
    const srcHome = makeTmp('claude-src-');
    const dstHome = makeTmp('claude-dst-');
    const srcCwd = '/Users/dev/app';
    const dstCwd = '/home/dev/app';

    const srcDir = path.join(srcHome, '.claude', 'projects', '-Users-dev-app');
    fs.mkdirSync(path.join(srcDir, UUID_1), { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, `${UUID_1}.jsonl`),
      [
        JSON.stringify({ type: 'user', entrypoint: 'cli', cwd: srcCwd, timestamp: '2026-11-22T10:00:00.000Z', message: { content: 'Fix bug' } }),
        JSON.stringify({ type: 'ai-title', sessionId: UUID_1, aiTitle: 'Bug fix' }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(srcDir, UUID_1, 'note.txt'), 'subagent-data');

    const materialize = createMaterializer();
    const res = await materialize({
      cli: 'claude',
      conversationId: UUID_1,
      sourceHost: 'local',
      sourceCwd: srcCwd,
      targetHost: 'devbox',
      targetCwd: dstCwd,
      sourceHomeOverride: srcHome,
      targetHomeOverride: dstHome,
    });

    expect(res.synced).toBe(true);
    const dstDir = path.join(dstHome, '.claude', 'projects', '-home-dev-app');
    const lines = fs.readFileSync(path.join(dstDir, `${UUID_1}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0].cwd).toBe(dstCwd);
    expect(lines[1].aiTitle).toBe('Bug fix');
    expect(fs.readFileSync(path.join(dstDir, UUID_1, 'note.txt'), 'utf8')).toBe('subagent-data');
  });

  it('ports a Codex thread, rewrites rollout session_meta.payload.cwd, and upserts state_5.sqlite', async () => {
    const srcHome = makeTmp('codex-src-');
    const dstHome = makeTmp('codex-dst-');
    const srcCwd = '/Users/dev/app';
    const dstCwd = '/home/dev/app';

    const initCodexDb = (home) => {
      const dbPath = path.join(home, '.codex', 'state_5.sqlite');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          model_provider TEXT NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          sandbox_policy TEXT NOT NULL,
          approval_mode TEXT NOT NULL,
          name TEXT,
          first_user_message TEXT NOT NULL DEFAULT '',
          recency_at_ms INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          project_id TEXT,
          thread_section_id TEXT
        );
      `);
      return db;
    };

    const srcRollout = path.join(srcHome, '.codex', 'sessions', '2026', '11', '22', `rollout-${UUID_2}.jsonl`);
    fs.mkdirSync(path.dirname(srcRollout), { recursive: true });
    fs.writeFileSync(
      srcRollout,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: UUID_2, cwd: srcCwd } }),
        JSON.stringify({ type: 'message', text: 'hello' }),
      ].join('\n') + '\n',
    );

    const srcDb = initCodexDb(srcHome);
    srcDb.prepare(`
      INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, name, first_user_message, recency_at_ms, archived, project_id)
      VALUES (?, ?, 100, 200, 'cli', 'openai', ?, 'Codex task', 'none', 'auto', 'Codex task', 'Do work', 200000, 0, 'host-local-proj')
    `).run(UUID_2, srcRollout, srcCwd);
    srcDb.close();

    const dstDbInit = initCodexDb(dstHome);
    dstDbInit.close();

    const materialize = createMaterializer();
    await materialize({
      cli: 'codex',
      conversationId: UUID_2,
      sourceHost: 'local',
      sourceCwd: srcCwd,
      targetHost: 'devbox',
      targetCwd: dstCwd,
      sourceHomeOverride: srcHome,
      targetHomeOverride: dstHome,
    });

    const dstDb = new Database(path.join(dstHome, '.codex', 'state_5.sqlite'), { readonly: true });
    const row = dstDb.prepare('SELECT * FROM threads WHERE id = ?').get(UUID_2);
    dstDb.close();

    expect(row.cwd).toBe(dstCwd);
    expect(row.project_id).toBeNull();
    expect(row.rollout_path).toBe(path.join(dstHome, '.codex', 'sessions', '2026', '11', '22', `rollout-${UUID_2}.jsonl`));
    const firstLine = JSON.parse(fs.readFileSync(row.rollout_path, 'utf8').split('\n')[0]);
    expect(firstLine.payload.cwd).toBe(dstCwd);
  });

  it('ports a Cursor chat to md5(targetCwd), snapshots store.db, rewrites meta.json, and copies transcript', async () => {
    const srcHome = makeTmp('cursor-src-');
    const dstHome = makeTmp('cursor-dst-');
    const srcCwd = '/Users/dev/app';
    const dstCwd = '/home/dev/app';

    const srcHash = createHash('md5').update(srcCwd).digest('hex');
    const srcChat = path.join(srcHome, '.cursor', 'chats', srcHash, UUID_3);
    fs.mkdirSync(srcChat, { recursive: true });
    fs.writeFileSync(path.join(srcChat, 'meta.json'), JSON.stringify({ title: 'Cursor chat', cwd: srcCwd, updatedAtMs: 5000 }));
    const store = new Database(path.join(srcChat, 'store.db'));
    store.pragma('journal_mode = WAL');
    store.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); INSERT INTO blobs VALUES ('k1', X'DEADBEEF');");
    store.close();

    const srcTranscript = path.join(srcHome, '.cursor', 'projects', 'Users-dev-app', 'agent-transcripts', UUID_3, `${UUID_3}.jsonl`);
    fs.mkdirSync(path.dirname(srcTranscript), { recursive: true });
    fs.writeFileSync(srcTranscript, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n');

    const materialize = createMaterializer();
    await materialize({
      cli: 'cursor',
      conversationId: UUID_3,
      sourceHost: 'local',
      sourceCwd: srcCwd,
      targetHost: 'devbox',
      targetCwd: dstCwd,
      sourceHomeOverride: srcHome,
      targetHomeOverride: dstHome,
    });

    const dstHash = createHash('md5').update(dstCwd).digest('hex');
    const dstChat = path.join(dstHome, '.cursor', 'chats', dstHash, UUID_3);
    const meta = JSON.parse(fs.readFileSync(path.join(dstChat, 'meta.json'), 'utf8'));
    expect(meta.cwd).toBe(dstCwd);

    const dstStore = new Database(path.join(dstChat, 'store.db'), { readonly: true });
    const blobRow = dstStore.prepare('SELECT id FROM blobs WHERE id = ?').get('k1');
    dstStore.close();
    expect(blobRow).toEqual({ id: 'k1' });

    const dstTranscript = path.join(dstHome, '.cursor', 'projects', 'home-dev-app', 'agent-transcripts', UUID_3, `${UUID_3}.jsonl`);
    expect(fs.existsSync(dstTranscript)).toBe(true);
  });

  it('ports an Antigravity conversation DB, brain dir, and upserts conversation_summaries.db with target file:// URI', async () => {
    const srcHome = makeTmp('agy-src-');
    const dstHome = makeTmp('agy-dst-');
    const srcCwd = '/Users/dev/app';
    const dstCwd = '/home/dev/app';

    const initSummaryDb = (home) => {
      const root = path.join(home, '.gemini', 'antigravity-cli');
      fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
      const db = new Database(path.join(root, 'conversation_summaries.db'));
      db.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          last_modified_time DATETIME NOT NULL,
          workspace_uris TEXT NOT NULL,
          nesting_depth INTEGER NOT NULL DEFAULT 0,
          app_data_dir TEXT NOT NULL DEFAULT '',
          raw_summary BLOB
        );
      `);
      return db;
    };

    const srcRoot = path.join(srcHome, '.gemini', 'antigravity-cli');
    const srcSum = initSummaryDb(srcHome);
    srcSum.prepare(`
      INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, nesting_depth, app_data_dir, raw_summary)
      VALUES (?, 'Agy session', '2026-11-22T12:00:00.000Z', ?, 0, ?, ?)
    `).run(UUID_4, JSON.stringify([`file://${srcCwd}`]), srcRoot, Buffer.from([1, 2, 3]));
    srcSum.close();

    const srcConv = new Database(path.join(srcRoot, 'conversations', `${UUID_4}.db`));
    srcConv.exec("CREATE TABLE steps (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO steps VALUES (1, 'ok');");
    srcConv.close();

    fs.mkdirSync(path.join(srcRoot, 'brain', UUID_4), { recursive: true });
    fs.writeFileSync(path.join(srcRoot, 'brain', UUID_4, 'plan.md'), '# Plan');

    const dstSumInit = initSummaryDb(dstHome);
    dstSumInit.close();

    const materialize = createMaterializer();
    await materialize({
      cli: 'agy',
      conversationId: UUID_4,
      sourceHost: 'local',
      sourceCwd: srcCwd,
      targetHost: 'devbox',
      targetCwd: dstCwd,
      sourceHomeOverride: srcHome,
      targetHomeOverride: dstHome,
    });

    const dstRoot = path.join(dstHome, '.gemini', 'antigravity-cli');
    const dstConv = new Database(path.join(dstRoot, 'conversations', `${UUID_4}.db`), { readonly: true });
    expect(dstConv.prepare('SELECT body FROM steps WHERE id = 1').get()).toEqual({ body: 'ok' });
    dstConv.close();

    const dstSum = new Database(path.join(dstRoot, 'conversation_summaries.db'), { readonly: true });
    const row = dstSum.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(UUID_4);
    dstSum.close();
    expect(JSON.parse(row.workspace_uris)).toEqual([`file://${dstCwd}`]);
    expect(row.app_data_dir).toBe(dstRoot);
    expect(Buffer.from(row.raw_summary)).toEqual(Buffer.from([1, 2, 3]));
    expect(fs.readFileSync(path.join(dstRoot, 'brain', UUID_4, 'plan.md'), 'utf8')).toBe('# Plan');
  });
});
