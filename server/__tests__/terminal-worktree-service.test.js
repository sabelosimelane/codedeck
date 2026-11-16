import { describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTerminalWorktreeService } from '../terminal-worktree-service.js';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-worktree-')));
  const home = path.join(root, 'repo');
  mkdirSync(home);
  git(home, 'init');
  git(home, 'config', 'user.email', 'test@example.org');
  git(home, 'config', 'user.name', 'Test');
  writeFileSync(path.join(home, 'README.md'), 'test\n');
  git(home, 'add', '.');
  git(home, 'commit', '-m', 'initial');
  const project = { name: 'Demo', path: home, host: 'local' };
  const startSession = vi.fn(async () => ({ id: 'Demo-1' }));
  const service = createTerminalWorktreeService({
    findProject: name => name === 'Demo' ? project : null,
    execFile,
    startSession,
    pathExists: existsSync,
  });
  return { root, home, project, startSession, service, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('terminal worktree service', () => {
  it('creates a branch and worktree from current HEAD, then starts a terminal in it', async () => {
    const f = fixture();
    try {
      const result = await f.service.open({ project: 'Demo', branch: 'Feature/New_Tab' });
      expect(result).toEqual({ sessionId: 'Demo-1', project: 'Demo', branch: 'Feature/New_Tab', worktreePath: path.join(f.root, 'worktrees', 'repo-feature-new-tab'), baseCommit: git(f.home, 'rev-parse', 'HEAD') });
      expect(git(result.worktreePath, 'branch', '--show-current')).toBe('Feature/New_Tab');
      expect(f.startSession).toHaveBeenCalledWith('Demo', { cwd: result.worktreePath });
    } finally { f.cleanup(); }
  });

  it.each(['-b', '--upload-pack=x', 'a b', 'a..b', 'x; rm -rf ~', '<script>alert(1)</script>', '../../etc', '@{-1}', 'a\0b', 'a'.repeat(101), '---', '_'])('rejects invalid branch %j without creating a worktree', async branch => {
    const f = fixture();
    try {
      await expect(f.service.open({ project: 'Demo', branch })).rejects.toMatchObject({ status: 400, errors: [{ field: 'branch' }] });
      expect(existsSync(path.join(f.root, 'worktrees'))).toBe(false);
      expect(f.startSession).not.toHaveBeenCalled();
    } finally { f.cleanup(); }
  });

  it.each(['a', 'a'.repeat(100)])('accepts boundary branch length %s', async branch => {
    const f = fixture();
    try { expect((await f.service.open({ project: 'Demo', branch })).sessionId).toBe('Demo-1'); }
    finally { f.cleanup(); }
  });

  it('serializes identical requests and leaves one worktree', async () => {
    const f = fixture();
    try {
      const results = await Promise.allSettled([f.service.open({ project: 'Demo', branch: 'new' }), f.service.open({ project: 'Demo', branch: 'new' })]);
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
      expect(results[1].reason).toMatchObject({ status: 409 });
      expect(f.startSession).toHaveBeenCalledTimes(1);
    } finally { f.cleanup(); }
  });

  it('keeps the worktree when terminal start fails', async () => {
    const f = fixture();
    const cause = Object.assign(new Error('offline'), { status: 503 });
    f.startSession.mockRejectedValue(cause);
    try {
      await expect(f.service.open({ project: 'Demo', branch: 'new' })).rejects.toMatchObject({ status: 503, cause, message: `The worktree was created at ${path.join(f.root, 'worktrees', 'repo-new')} on branch new, but its terminal could not be opened.` });
      expect(existsSync(path.join(f.root, 'worktrees', 'repo-new'))).toBe(true);
    } finally { f.cleanup(); }
  });

  it('reports a non-503 terminal failure as 500 and retains the worktree', async () => {
    const f = fixture();
    const cause = new Error('start failed');
    f.startSession.mockRejectedValue(cause);
    try {
      await expect(f.service.open({ project: 'Demo', branch: 'new' })).rejects.toMatchObject({ status: 500, cause });
      expect(existsSync(path.join(f.root, 'worktrees', 'repo-new'))).toBe(true);
    } finally { f.cleanup(); }
  });

  it('requires all dependencies at construction', () => {
    expect(() => createTerminalWorktreeService({})).toThrow('findProject');
  });

  it('rejects unknown, remote, non-top-level, existing branch and existing directory', async () => {
    const f = fixture();
    try {
      await expect(f.service.open({ project: 'Missing', branch: 'new' })).rejects.toMatchObject({ status: 404 });
      f.project.host = 'remote';
      await expect(f.service.open({ project: 'Demo', branch: 'new' })).rejects.toMatchObject({ status: 409 });
      f.project.host = 'local';
      mkdirSync(path.join(f.home, 'sub'));
      f.project.path = path.join(f.home, 'sub');
      await expect(f.service.open({ project: 'Demo', branch: 'new' })).rejects.toMatchObject({ status: 409 });
      f.project.path = f.home;
      git(f.home, 'branch', 'existing');
      await expect(f.service.open({ project: 'Demo', branch: 'existing' })).rejects.toMatchObject({ status: 409 });
      mkdirSync(path.join(f.root, 'worktrees', 'repo-new'), { recursive: true });
      await expect(f.service.open({ project: 'Demo', branch: 'new' })).rejects.toMatchObject({ status: 409 });
    } finally { f.cleanup(); }
  });
});
