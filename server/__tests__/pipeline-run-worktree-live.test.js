import { describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  create,
  listDirtyPaths,
  listWorktrees,
  planNames,
  preflight,
  readWorktreeChanges,
  remove,
  resolveHomeRepoPath,
  hasCommittedFile,
} from '../pipelines/run-worktree.js';
import { prepare as prepareNotes } from '../pipelines/run-notes.js';

const SETUP_AGENT = 'c4100000-0000-4000-8000-000000000001';
const RUN_ID = '0d9e4b1a-1111-4111-8111-111111111111';

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const describeLive = hasGit() ? describe : describe.skip;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(root) {
  mkdirSync(root, { recursive: true });
  git(root, ['init']);
  git(root, ['config', 'user.email', 'pipeline@test.local']);
  git(root, ['config', 'user.name', 'Pipeline Test']);
  writeFileSync(path.join(root, 'README.md'), '# live worktree test\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'init']);
  return git(root, ['rev-parse', 'HEAD']);
}

describeLive('pipeline run-worktree live', () => {
  it('removes a worktree with prepared ignored run notes without force', async () => {
    const base = mkdtempSync(path.join(process.cwd(), '.run-worktree-notes-'));
    const home = path.join(base, 'repo');
    const run = path.join(base, 'run');
    try {
      initRepo(home);
      git(home, ['worktree', 'add', '-b', 'workflow/notes', run]);
      await prepareNotes({ worktreePath: run, definition: { workflowName: 'Feature', notesDir: '.codedeck/runs/abcdef12', steps: [{ kind: 'node', role: '', name: 'Build', agent: { name: 'Codex' } }] }, input: 'x' });
      expect(git(run, ['status', '--porcelain'])).toBe('');
      git(home, ['worktree', 'remove', run]);
      expect(existsSync(run)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  it('accepts a committed progress file and refuses an untracked one at HEAD', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-progress-head-'));
    const home = path.join(base, 'repo');
    try {
      initRepo(home);
      mkdirSync(path.join(home, 'docs'));
      writeFileSync(path.join(home, 'docs/todo.md'), '# committed\n');
      git(home, ['add', 'docs/todo.md']);
      git(home, ['commit', '-m', 'todo']);
      writeFileSync(path.join(home, 'docs/untracked.md'), '# untracked\n');
      expect(await hasCommittedFile({ repoPath: home, progressFile: 'docs/todo.md', execFile })).toBe(true);
      expect(await hasCommittedFile({ repoPath: home, progressFile: 'docs/untracked.md', execFile })).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  it('uses a linked project commit for the guard and new worktree', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-progress-linked-'));
    const home = path.join(base, 'repo');
    const linked = path.join(base, 'linked');
    const run = path.join(base, 'run');
    try {
      initRepo(home);
      git(home, ['worktree', 'add', '-b', 'feature/progress', linked]);
      mkdirSync(path.join(linked, 'docs'));
      writeFileSync(path.join(linked, 'docs/todo.md'), '# linked progress\n');
      git(linked, ['add', 'docs/todo.md']);
      git(linked, ['commit', '-m', 'linked progress']);
      expect(await hasCommittedFile({ repoPath: linked, progressFile: 'docs/todo.md', execFile })).toBe(true);
      expect(await hasCommittedFile({ repoPath: home, progressFile: 'docs/todo.md', execFile })).toBe(false);
      const result = await create({ homePath: home, projectPath: linked, worktreePath: run, branch: 'workflow/run', execFile });
      expect(result.baseCommit).toBe(git(linked, ['rev-parse', 'HEAD']));
      expect(existsSync(path.join(run, 'docs/todo.md'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  it('create adds a worktree and branch at base_commit', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-wt-home-'));
    const home = path.join(base, 'codedeck');
    let names;

    try {
      const head = initRepo(home);
      const homeRepoPath = await resolveHomeRepoPath({ projectPath: home, execFile });
      expect(homeRepoPath).toBe(realpathSync(home));

      names = planNames({
        runId: RUN_ID,
        workflowName: 'Feature',
        homeRepoPath,
      });
      mkdirSync(path.dirname(names.worktreePath), { recursive: true });
      expect(names.worktreePath).toBe(
        path.join(path.dirname(homeRepoPath), 'worktrees', 'codedeck-feature-0d9e4b1a'),
      );
      expect(names.branch).toBe('workflow/feature-0d9e4b1a');

      const result = await create({
        homePath: homeRepoPath,
        worktreePath: names.worktreePath,
        branch: names.branch,
        projectPath: home,
        execFile,
      });
      expect(result.baseCommit).toBe(head);
      expect(existsSync(names.worktreePath)).toBe(true);
      expect(git(names.worktreePath, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(names.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(names.branch);
      expect(git(home, ['rev-parse', names.branch])).toBe(head);
    } finally {
      if (names?.worktreePath) {
        try {
          execFileSync('git', ['-C', home, 'worktree', 'remove', '--force', names.worktreePath], { stdio: 'pipe' });
        } catch { /* worktree may not exist */ }
      }
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('marks subdirectory and non-repo paths as not_git_toplevel', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-wt-pre-'));
    const home = path.join(base, 'repo');
    const sub = path.join(home, 'server');
    const notRepo = path.join(base, 'plain');
    mkdirSync(sub, { recursive: true });
    mkdirSync(notRepo, { recursive: true });

    try {
      initRepo(home);
      writeFileSync(path.join(sub, 'index.js'), 'export {};\n');

      const subResult = await preflight({
        projectPath: sub,
        projectHost: 'local',
        setupAgentId: SETUP_AGENT,
        execFile,
      });
      expect(subResult.eligible).toBe(false);
      expect(subResult.reasons.map(r => r.code)).toContain('not_git_toplevel');
      expect(subResult.branch).toBeNull();
      expect(subResult.head).toBeNull();
      expect(subResult.dirty).toBeNull();

      const plainResult = await preflight({
        projectPath: notRepo,
        projectHost: null,
        setupAgentId: SETUP_AGENT,
        execFile,
      });
      expect(plainResult.eligible).toBe(false);
      expect(plainResult.reasons.map(r => r.code)).toContain('not_git_toplevel');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reports dirty when the checkout has uncommitted changes', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-wt-dirty-'));
    const home = path.join(base, 'repo');

    try {
      initRepo(home);
      writeFileSync(path.join(home, 'dirty.txt'), 'uncommitted\n');

      const result = await preflight({
        projectPath: home,
        projectHost: 'local',
        setupAgentId: SETUP_AGENT,
        execFile,
      });
      expect(result.eligible).toBe(true);
      expect(result.dirty).toBe(true);
      expect(result.reasons).toEqual([]);
      expect(result.head).toMatch(/^[0-9a-f]{40}$/);
      expect(result.branch).toBeTruthy();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('remove succeeds with only ignored files and keeps the branch', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-wt-rm-'));
    const home = path.join(base, 'codedeck');
    let names;
    try {
      initRepo(home);
      writeFileSync(path.join(home, '.gitignore'), 'ignored.txt\n');
      git(home, ['add', '.gitignore']);
      git(home, ['commit', '-m', 'ignore']);
      const homeRepoPath = await resolveHomeRepoPath({ projectPath: home, execFile });
      names = planNames({ runId: RUN_ID, workflowName: 'Clean', homeRepoPath });
      await create({
        homePath: homeRepoPath,
        worktreePath: names.worktreePath,
        branch: names.branch,
        projectPath: home,
        execFile,
      });
      writeFileSync(path.join(names.worktreePath, 'ignored.txt'), 'noise\n');

      const result = await remove({
        homePath: homeRepoPath,
        worktreePath: names.worktreePath,
        execFile,
      });
      expect(result).toEqual({ ok: true });
      expect(existsSync(names.worktreePath)).toBe(false);
      expect(git(home, ['rev-parse', '--verify', names.branch])).toBeTruthy();
    } finally {
      if (names?.worktreePath) {
        try {
          execFileSync('git', ['-C', home, 'worktree', 'remove', '--force', names.worktreePath], { stdio: 'pipe' });
        } catch { /* ignore */ }
      }
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('remove refuses untracked, modified and staged files then succeeds after resolve', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-wt-block-'));
    const home = path.join(base, 'codedeck');
    let names;
    try {
      initRepo(home);
      const homeRepoPath = await resolveHomeRepoPath({ projectPath: home, execFile });
      names = planNames({ runId: RUN_ID, workflowName: 'Blocked', homeRepoPath });
      await create({
        homePath: homeRepoPath,
        worktreePath: names.worktreePath,
        branch: names.branch,
        projectPath: home,
        execFile,
      });

      writeFileSync(path.join(names.worktreePath, 'untracked.txt'), 'new\n');
      writeFileSync(path.join(names.worktreePath, 'README.md'), '# changed\n');
      writeFileSync(path.join(names.worktreePath, 'staged.txt'), 'staged\n');
      git(names.worktreePath, ['add', 'staged.txt']);

      const blocked = await remove({
        homePath: homeRepoPath,
        worktreePath: names.worktreePath,
        execFile,
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.detail).toMatch(/modified or untracked/i);
      expect(blocked.detail).toMatch(/untracked\.txt|README\.md|staged\.txt/);

      git(names.worktreePath, ['checkout', '--', 'README.md']);
      git(names.worktreePath, ['reset', 'HEAD', 'staged.txt']);
      rmSync(path.join(names.worktreePath, 'untracked.txt'));
      rmSync(path.join(names.worktreePath, 'staged.txt'));

      const cleared = await remove({
        homePath: homeRepoPath,
        worktreePath: names.worktreePath,
        execFile,
      });
      expect(cleared).toEqual({ ok: true });
      expect(existsSync(names.worktreePath)).toBe(false);
      expect(git(home, ['rev-parse', '--verify', names.branch])).toBeTruthy();
    } finally {
      if (names?.worktreePath) {
        try {
          execFileSync('git', ['-C', home, 'worktree', 'remove', '--force', names.worktreePath], { stdio: 'pipe' });
        } catch { /* ignore */ }
      }
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('remove succeeds when the worktree has unmerged commits', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-wt-unmerged-'));
    const home = path.join(base, 'codedeck');
    let names;
    try {
      initRepo(home);
      const homeRepoPath = await resolveHomeRepoPath({ projectPath: home, execFile });
      names = planNames({ runId: RUN_ID, workflowName: 'Ahead', homeRepoPath });
      await create({
        homePath: homeRepoPath,
        worktreePath: names.worktreePath,
        branch: names.branch,
        projectPath: home,
        execFile,
      });
      writeFileSync(path.join(names.worktreePath, 'extra.md'), 'ahead\n');
      git(names.worktreePath, ['add', 'extra.md']);
      git(names.worktreePath, ['commit', '-m', 'ahead of home']);

      const result = await remove({
        homePath: homeRepoPath,
        worktreePath: names.worktreePath,
        execFile,
      });
      expect(result).toEqual({ ok: true });
      expect(existsSync(names.worktreePath)).toBe(false);
      expect(git(home, ['rev-parse', '--verify', names.branch])).toBeTruthy();
      expect(git(home, ['log', '-1', '--pretty=%s', names.branch])).toBe('ahead of home');
    } finally {
      if (names?.worktreePath) {
        try {
          execFileSync('git', ['-C', home, 'worktree', 'remove', '--force', names.worktreePath], { stdio: 'pipe' });
        } catch { /* ignore */ }
      }
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('lists the home checkout, a linked worktree, a detached one and a deleted one as real git reports them', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-wt-list-'));
    const home = path.join(base, 'codedeck');
    try {
      const head = initRepo(home);
      const homeReal = realpathSync(home);
      const branchName = git(home, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const linked = path.join(realpathSync(base), 'worktrees', 'codedeck-feature');
      const detached = path.join(realpathSync(base), 'worktrees', 'codedeck-detached');
      const gone = path.join(realpathSync(base), 'worktrees', 'codedeck-gone');
      git(home, ['worktree', 'add', linked, '-b', 'feature/list', head]);
      git(home, ['worktree', 'add', '--detach', detached, head]);
      git(home, ['worktree', 'add', gone, '-b', 'gone', head]);
      rmSync(gone, { recursive: true, force: true });
      writeFileSync(path.join(linked, 'notes.txt'), 'untracked\n');

      const expected = [
        { path: homeReal, head, branch: branchName, missing: false },
        { path: linked, head, branch: 'feature/list', missing: false },
        { path: detached, head, branch: null, missing: false },
        { path: gone, head, branch: 'gone', missing: true },
      ];
      const byPath = (a, b) => a.path.localeCompare(b.path);
      // Asking from a linked worktree gives the same list as asking from the home checkout.
      expect((await listWorktrees({ projectPath: home, execFile })).sort(byPath)).toEqual([...expected].sort(byPath));
      expect((await listWorktrees({ projectPath: linked, execFile })).sort(byPath)).toEqual([...expected].sort(byPath));

      expect(await listDirtyPaths({ worktreePath: linked, execFile })).toEqual(['notes.txt']);
      expect(await listDirtyPaths({ worktreePath: detached, execFile })).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reads a worktree as clean, dirty, or unreadable when its link to the repository is broken', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-wt-read-'));
    const home = path.join(base, 'codedeck');
    try {
      const head = initRepo(home);
      const clean = path.join(realpathSync(base), 'worktrees', 'codedeck-clean');
      const dirty = path.join(realpathSync(base), 'worktrees', 'codedeck-dirty');
      const broken = path.join(realpathSync(base), 'worktrees', 'codedeck-broken');
      git(home, ['worktree', 'add', clean, '-b', 'clean', head]);
      git(home, ['worktree', 'add', dirty, '-b', 'dirty', head]);
      git(home, ['worktree', 'add', broken, '-b', 'broken', head]);
      writeFileSync(path.join(dirty, 'notes.txt'), 'untracked\n');
      // The directory stays, so git still lists it and does not call it prunable.
      writeFileSync(path.join(broken, '.git'), `gitdir: ${path.join(base, 'moved-away')}\n`);

      const listed = await listWorktrees({ projectPath: home, execFile });
      expect(listed.find(worktree => worktree.path === broken)).toEqual({ path: broken, head, branch: 'broken', missing: false });

      expect(await readWorktreeChanges({ worktreePath: clean, execFile })).toEqual({ readable: true, dirty: false });
      expect(await readWorktreeChanges({ worktreePath: dirty, execFile })).toEqual({ readable: true, dirty: true });
      expect(await readWorktreeChanges({ worktreePath: broken, execFile })).toEqual({ readable: false });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
