/**
 * Automatic Git synchronization (`git pull --ff-only`) and remote auto-clone.
 *
 * Runs through `command-runner.js` so the exact same logic works identically on
 * `local` and remote SSH hosts. Never modifies dirty working trees or creates
 * merge commits; surfaces structured block reasons so the UI can warn-and-confirm.
 */

import path from 'node:path';
import { isTransportFailure } from './command-runner.js';
import { createHostExecFile } from './host-exec.js';
import { getProjectLocation } from './project-config.js';
import { runGit } from './pipelines/run-worktree.js';

const SYNC_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;

// Safe Git URLs: https://, http://, ssh://, git://, or SCP-style user@host:path.
// Must never start with `-` or contain whitespace/shell metacharacters.
export const GIT_URL_REGEX = /^(?:(?:https?|ssh|git):\/\/[^\s'"`$;&|<>\\]+|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s'"`$;&|<>\\]+)$/;

export function isValidGitUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('-') || trimmed.length > 2048) return false;
  return GIT_URL_REGEX.test(trimmed);
}

/** Derive a safe folder name from a Git URL (e.g. `git@github.com:org/app.git` -> `app`). */
export function repoFolderNameFromGitUrl(url) {
  const cleaned = String(url ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const tail = cleaned.split(/[/:]/).pop() || '';
  const safe = tail.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'repo';
}

function firstLine(text) {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const fatal = lines.find(l => /^(fatal|error):\s*/i.test(l));
  return (fatal ? fatal.replace(/^(fatal|error):\s*/i, '') : lines[0] ?? '').slice(0, 300);
}

/**
 * Detect `origin` remote URL of an existing checkout on `runner`.
 * Returns the URL string or `null` if not a git repo or no `origin` remote.
 */
export async function detectGitOriginUrl({ repoPath, runner, execFile } = {}) {
  const exec = execFile ?? createHostExecFile(runner);
  try {
    const { stdout } = await runGit(exec, ['-C', repoPath, 'remote', 'get-url', 'origin'], { timeout: 10_000 });
    const url = stdout.trim();
    return isValidGitUrl(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Run a safe `git pull --ff-only` on a single repository checkout.
 *
 * Possible return statuses:
 * - `{ status: 'skipped', reason: 'not_git_repo', repoPath, repository }`
 * - `{ status: 'synced', repository, repoPath, branch, updated, commitsPulled, beforeHead, afterHead }`
 * - `{ status: 'blocked', code, message, detail?, httpStatus, repository, repoPath, branch? }`
 */
export async function syncCheckout({
  host = 'local',
  repository = null,
  repoPath,
  runner,
  execFile,
  timeout = SYNC_TIMEOUT_MS,
} = {}) {
  const exec = execFile ?? createHostExecFile(runner);
  const repoLabel = repository || path.basename(repoPath);

  // 1. Check if this folder is inside a Git working tree.
  try {
    const { stdout } = await runGit(exec, ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], { timeout: 10_000 });
    if (stdout.trim() !== 'true') {
      return { status: 'skipped', reason: 'not_git_repo', host, repository: repoLabel, repoPath };
    }
  } catch (err) {
    if (isTransportFailure(err)) {
      return {
        status: 'blocked',
        code: 'host_unreachable',
        httpStatus: 503,
        host,
        repository: repoLabel,
        repoPath,
        message: `Host "${host}" is unreachable.`,
        detail: firstLine(err.stderr || err.message),
      };
    }
    return { status: 'skipped', reason: 'not_git_repo', host, repository: repoLabel, repoPath };
  }

  // 2. Ensure working tree is clean so we never clobber uncommitted work.
  try {
    const { stdout: dirty } = await runGit(exec, ['-C', repoPath, 'status', '--porcelain'], { timeout: 10_000 });
    if (dirty.trim().length > 0) {
      return {
        status: 'blocked',
        code: 'dirty',
        httpStatus: 409,
        host,
        repository: repoLabel,
        repoPath,
        message: 'Working tree has uncommitted changes.',
      };
    }
  } catch (err) {
    if (isTransportFailure(err)) {
      return {
        status: 'blocked',
        code: 'host_unreachable',
        httpStatus: 503,
        host,
        repository: repoLabel,
        repoPath,
        message: `Host "${host}" is unreachable.`,
        detail: firstLine(err.stderr || err.message),
      };
    }
    return {
      status: 'blocked',
      code: 'git_error',
      httpStatus: 409,
      host,
      repository: repoLabel,
      repoPath,
      message: 'Could not read git status.',
      detail: firstLine(err.stderr || err.message),
    };
  }

  // 3. Check branch & upstream tracking branch.
  let branch;
  let beforeHead;
  try {
    const [{ stdout: branchOut }, { stdout: headOut }] = await Promise.all([
      runGit(exec, ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 10_000 }),
      runGit(exec, ['-C', repoPath, 'rev-parse', 'HEAD'], { timeout: 10_000 }),
    ]);
    branch = branchOut.trim();
    beforeHead = headOut.trim();
    if (!branch || branch === 'HEAD') {
      return {
        status: 'blocked',
        code: 'detached_head',
        httpStatus: 409,
        host,
        repository: repoLabel,
        repoPath,
        message: 'HEAD is detached; cannot pull.',
      };
    }
  } catch (err) {
    if (isTransportFailure(err)) {
      return {
        status: 'blocked',
        code: 'host_unreachable',
        httpStatus: 503,
        host,
        repository: repoLabel,
        repoPath,
        message: `Host "${host}" is unreachable.`,
        detail: firstLine(err.stderr || err.message),
      };
    }
    return {
      status: 'blocked',
      code: 'git_error',
      httpStatus: 409,
      host,
      repository: repoLabel,
      repoPath,
      message: 'Could not determine current branch.',
      detail: firstLine(err.stderr || err.message),
    };
  }

  try {
    await runGit(exec, ['-C', repoPath, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeout: 10_000 });
  } catch (err) {
    if (isTransportFailure(err)) {
      return {
        status: 'blocked',
        code: 'host_unreachable',
        httpStatus: 503,
        host,
        repository: repoLabel,
        repoPath,
        branch,
        message: `Host "${host}" is unreachable.`,
        detail: firstLine(err.stderr || err.message),
      };
    }
    return {
      status: 'blocked',
      code: 'no_upstream',
      httpStatus: 409,
      host,
      repository: repoLabel,
      repoPath,
      branch,
      message: `Branch "${branch}" has no upstream tracking branch.`,
    };
  }

  // 4. Execute `git pull --ff-only`.
  try {
    await runGit(exec, ['-C', repoPath, 'pull', '--ff-only'], { timeout });
    const { stdout: afterHeadRaw } = await runGit(exec, ['-C', repoPath, 'rev-parse', 'HEAD'], { timeout: 10_000 });
    const afterHead = afterHeadRaw.trim();
    const updated = afterHead !== beforeHead;
    let commitsPulled = 0;
    if (updated) {
      try {
        const { stdout: countRaw } = await runGit(exec, ['-C', repoPath, 'rev-list', '--count', `${beforeHead}..${afterHead}`], { timeout: 10_000 });
        commitsPulled = Number.parseInt(countRaw.trim(), 10) || 1;
      } catch {
        commitsPulled = 1;
      }
    }
    return {
      status: 'synced',
      host,
      repository: repoLabel,
      repoPath,
      branch,
      updated,
      commitsPulled,
      beforeHead,
      afterHead,
    };
  } catch (err) {
    if (isTransportFailure(err)) {
      return {
        status: 'blocked',
        code: 'host_unreachable',
        httpStatus: 503,
        host,
        repository: repoLabel,
        repoPath,
        branch,
        message: `Host "${host}" is unreachable.`,
        detail: firstLine(err.stderr || err.message),
      };
    }
    const combined = `${err?.stderr ?? ''}\n${err?.stdout ?? ''}\n${err?.message ?? ''}`;
    if (/not possible to fast-forward|divergent branches|cannot fast-forward/i.test(combined)) {
      return {
        status: 'blocked',
        code: 'diverged',
        httpStatus: 409,
        host,
        repository: repoLabel,
        repoPath,
        branch,
        message: `Branch "${branch}" has diverged from upstream and cannot be fast-forwarded.`,
        detail: firstLine(err.stderr || err.message),
      };
    }
    return {
      status: 'blocked',
      code: 'network_or_auth',
      httpStatus: 409,
      host,
      repository: repoLabel,
      repoPath,
      branch,
      message: `git pull failed on "${branch}".`,
      detail: firstLine(err.stderr || err.message),
    };
  }
}

/**
 * Sync one or more repositories for a project on a specific host.
 * If `repoPaths` is omitted, syncs the location's own checkout.
 */
export async function syncProjectLocation({
  project,
  host,
  repoPaths = null,
  runner,
  execFile,
  timeout = SYNC_TIMEOUT_MS,
} = {}) {
  const location = getProjectLocation(project, host);
  if (!location) {
    return {
      ok: false,
      status: 404,
      code: 'location_not_found',
      host,
      message: `Project "${project?.name}" has no checkout configured on host "${host}".`,
      results: [],
    };
  }

  let targets;
  if (Array.isArray(repoPaths) && repoPaths.length > 0) {
    targets = repoPaths;
  } else {
    const list = [];
    const seen = new Set();
    const pushTarget = (repository, repoPath) => {
      if (!repoPath || seen.has(repoPath)) return;
      seen.add(repoPath);
      list.push({ repository, repoPath });
    };
    if (project?.workspaceMode !== 'folder') {
      pushTarget(path.basename(location.path), location.path);
    }
    for (const repo of location.repositories ?? []) {
      pushTarget(repo.name, repo.path);
    }
    if (list.length === 0) {
      pushTarget(path.basename(location.path), location.path);
    }
    targets = list;
  }

  const results = [];
  for (const target of targets) {
    const res = await syncCheckout({
      host: location.host,
      repository: target.repository,
      repoPath: target.repoPath,
      runner,
      execFile,
      timeout,
    });
    results.push(res);
  }

  const blocked = results.filter(r => r.status === 'blocked');
  if (blocked.length > 0) {
    const unreachable = blocked.find(r => r.code === 'host_unreachable');
    return {
      ok: false,
      status: unreachable ? 503 : 409,
      code: unreachable ? 'host_unreachable' : 'sync_blocked',
      host: location.host,
      message: unreachable
        ? unreachable.message
        : `Could not sync ${blocked.map(b => b.repository).join(', ')} on ${location.host}.`,
      results,
    };
  }

  const totalCommits = results.reduce((sum, r) => sum + (r.commitsPulled || 0), 0);
  return {
    ok: true,
    status: 200,
    host: location.host,
    updated: results.some(r => r.updated),
    commitsPulled: totalCommits,
    results,
  };
}

/**
 * Clone `gitUrl` into `targetPath` on the target host via `runner`.
 */
export async function cloneToHost({ gitUrl, targetPath, runner, execFile, timeout = CLONE_TIMEOUT_MS } = {}) {
  if (!isValidGitUrl(gitUrl)) {
    const err = new Error('Invalid Git URL');
    err.status = 400;
    throw err;
  }
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath) || /[\x00-\x1f\x7f]/.test(targetPath)) {
    const err = new Error('targetPath must be an absolute path');
    err.status = 400;
    throw err;
  }

  const exec = execFile ?? createHostExecFile(runner);
  const parent = path.dirname(targetPath);

  if (runner && runner.kind !== 'local') {
    await runner.run('mkdir', ['-p', '--', parent], { timeout: 10_000 });
  } else {
    const fs = await import('node:fs/promises');
    await fs.mkdir(parent, { recursive: true });
  }

  try {
    await runGit(exec, ['clone', '--', gitUrl.trim(), targetPath], { timeout });
    return { path: targetPath, gitUrl: gitUrl.trim() };
  } catch (err) {
    if (isTransportFailure(err)) {
      const wrapped = new Error(`Host unreachable while cloning: ${firstLine(err.stderr || err.message)}`);
      wrapped.status = 503;
      wrapped.cause = err;
      throw wrapped;
    }
    const wrapped = new Error(`git clone failed: ${firstLine(err.stderr || err.message)}`);
    wrapped.status = 409;
    wrapped.cause = err;
    throw wrapped;
  }
}
