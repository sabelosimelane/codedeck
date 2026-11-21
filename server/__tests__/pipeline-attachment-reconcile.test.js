import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequestStore, PROVISIONING_STATES, serializeStartParams } from '../pipelines/request-store.js';
import { publishAttachmentBatch } from '../pipelines/attachment-publisher.js';
import { attachmentStagingRootFor, reconcileAttachmentStarts } from '../pipelines/attachment-reconcile.js';

const WORKFLOW_ID = 'a2d0b1c2-3456-4789-8abc-def012345678';
const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });

function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup() {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  const requestStore = createRequestStore(db);
  const runs = new Map();
  const runStore = { get: id => runs.get(id) ?? null };
  const repo = tempDir('cd-reconcile-repo-');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('-c', 'user.name=T', '-c', 'user.email=t@test.local', 'commit', '--allow-empty', '-m', 'init');
  const stagingRoot = tempDir('cd-reconcile-staging-');
  const bytes = Buffer.from('alpha');
  const file = { name: 'a.txt', sizeBytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') };

  /** A reservation as an attached start leaves it at the point it was interrupted. */
  function reserve(requestId, { placement = true, state = PROVISIONING_STATES.RESERVED } = {}) {
    requestStore.reserve(requestId, serializeStartParams({ workflowId: WORKFLOW_ID, project: 'Demo', input: 'brief', worktreePath: repo, attachments: [file] }));
    const { runId } = requestStore.assignRunId(requestId, randomUUID());
    if (placement) requestStore.setPlacement(requestId, { worktreePath: repo, homePath: repo, startRepository: 'repo' }, { from: PROVISIONING_STATES.RESERVED });
    if (state !== PROVISIONING_STATES.RESERVED) requestStore.transition(requestId, { from: PROVISIONING_STATES.RESERVED, to: state });
    return { runId, notesDir: `.codedeck/runs/${runId.slice(0, 8)}` };
  }

  async function promote(notesDir) {
    const stagingPath = path.join(stagingRoot, 'staged');
    writeFileSync(stagingPath, bytes);
    return publishAttachmentBatch({ checkoutPath: repo, notesDir, attemptId: randomUUID(), files: [{ ...file, stagingPath }], execFile });
  }

  const reconcile = () => reconcileAttachmentStarts({ requestStore, runStore, stagingRoot });
  return { requestStore, runs, repo, git, stagingRoot, reserve, promote, reconcile };
}

describe('attachmentStagingRootFor', () => {
  it('gives each database its own staging root, so one instance starting never clears another instance\'s uploads', () => {
    const first = attachmentStagingRootFor('/home/a/.codedeck.db');
    expect(first).toBe(attachmentStagingRootFor('/home/a/.codedeck.db'));
    expect(first).not.toBe(attachmentStagingRootFor('/qa/home/.codedeck.db'));
    expect(path.dirname(first)).toBe(os.tmpdir());
    expect(path.basename(first)).toMatch(/^codedeck-pipeline-attachments-[0-9a-f]{16}$/);
  });

  it('refuses a database path that is not absolute', () => {
    for (const bad of [undefined, null, '', 'relative.db', ':memory:']) {
      expect(() => attachmentStagingRootFor(bad)).toThrow(/databasePath must be an absolute path/);
    }
  });
});

describe('reconcileAttachmentStarts', () => {
  it('removes every abandoned staging attempt', async () => {
    const ctx = setup();
    mkdirSync(path.join(ctx.stagingRoot, 'attempts', randomUUID()), { recursive: true });
    writeFileSync(path.join(ctx.stagingRoot, 'attempts', 'stray'), 'x');
    await ctx.reconcile();
    expect(existsSync(path.join(ctx.stagingRoot, 'attempts'))).toBe(false);
  });

  it('removes a batch promoted before its manifest was persisted and marks the start failed', async () => {
    const ctx = setup();
    const { notesDir } = ctx.reserve('promoted');
    await ctx.promote(notesDir);
    mkdirSync(path.join(ctx.repo, notesDir, `.attachments-${randomUUID()}.tmp`));
    writeFileSync(path.join(ctx.repo, notesDir, 'README.md'), 'notes');
    const summary = await ctx.reconcile();
    expect(summary).toEqual({ published: [], failed: ['promoted'] });
    expect(readdirSync(path.join(ctx.repo, notesDir))).toEqual(['README.md']);
    expect(ctx.requestStore.get('promoted')).toMatchObject({ provisioningState: PROVISIONING_STATES.FAILED, placement: { worktreePath: ctx.repo } });
    expect(ctx.git('status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('cleans a failed start interrupted again and keeps it failed for the owner to retry or close', async () => {
    const ctx = setup();
    const { notesDir } = ctx.reserve('failed', { state: PROVISIONING_STATES.FAILED });
    mkdirSync(path.join(ctx.repo, notesDir, `.attachments-${randomUUID()}.tmp`), { recursive: true });
    expect(await ctx.reconcile()).toEqual({ published: [], failed: ['failed'] });
    expect(readdirSync(path.join(ctx.repo, notesDir))).toEqual([]);
    expect(ctx.requestStore.get('failed').provisioningState).toBe(PROVISIONING_STATES.FAILED);
  });

  it('preserves the batch of a run recorded with its manifest and marks the start published', async () => {
    const ctx = setup();
    const { runId, notesDir } = ctx.reserve('recorded');
    const { attachments } = await ctx.promote(notesDir);
    ctx.runs.set(runId, { id: runId, attachments });
    const inode = statSync(path.join(ctx.repo, attachments[0].path)).ino;
    expect(await ctx.reconcile()).toEqual({ published: ['recorded'], failed: [] });
    expect(ctx.requestStore.get('recorded').provisioningState).toBe(PROVISIONING_STATES.PUBLISHED);
    expect(statSync(path.join(ctx.repo, attachments[0].path)).ino).toBe(inode);
  });

  it('leaves a start interrupted before it recorded a checkout as it was', async () => {
    const ctx = setup();
    ctx.reserve('early', { placement: false });
    expect(await ctx.reconcile()).toEqual({ published: [], failed: [] });
    expect(ctx.requestStore.get('early').provisioningState).toBe(PROVISIONING_STATES.RESERVED);
  });

  it('reports a checkout it cannot clean safely, still fails the start, and goes on with the others', async () => {
    const ctx = setup();
    const outside = tempDir('cd-reconcile-outside-');
    symlinkSync(outside, path.join(ctx.repo, '.codedeck'));
    ctx.reserve('unsafe');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await ctx.reconcile()).toEqual({ published: [], failed: ['unsafe'] });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('requestId=unsafe'), expect.objectContaining({ code: 'unsafe_location' }));
    } finally {
      error.mockRestore();
    }
    expect(ctx.requestStore.get('unsafe').provisioningState).toBe(PROVISIONING_STATES.FAILED);
  });
});
