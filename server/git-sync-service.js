/**
 * Automatic Git synchronization (`git pull --ff-only`) and remote auto-clone.
 *
 * Runs through `command-runner.js` so the exact same logic works identically on
 * `local` and remote SSH hosts. Never modifies dirty working trees or creates
 * merge commits; surfaces structured block reasons so the UI can warn-and-confirm.
 */

import path from 'node:path';
import nodeFs from 'node:fs/promises';
import { createCommandRunner, isTransportFailure, shellQuote } from './command-runner.js';
import { createHostExecFile } from './host-exec.js';
import { createHostFs } from './host-fs.js';
import { getProjectLocation, normalizeProject } from './project-config.js';
import { runGit } from './pipelines/run-worktree.js';

const SYNC_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

const EXCLUDED_ARTIFACT_DIRS = new Set([
  'node_modules', 'target', 'build', 'dist', 'out',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache',
  '.gradle', '.kotlin', '.m2', '.ivy2', '.cargo', 'vendor',
  'coverage', 'test-results', 'playwright-report', 'logs', 'tmp', 'temp',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  '.venv', 'venv', '.git', '.codedeck', '.claude', '.omx', '.remember',
  '.issues', '.idea', '.vscode', '.settings', 'xcuserdata',
  'Pods', 'DerivedData', '.build', '.swiftpm', 'worktrees',
]);

const EXCLUDED_ARTIFACT_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.project', '.classpath', '.factorypath',
  '.mcp-bash-config.json',
]);

const EXCLUDED_ARTIFACT_SUFFIXES = [
  '.hprof', '.log', '.tsbuildinfo', '.pid', '.lock', '.sock', '.swp', '.tmp',
];

export function isExcludedArtifactPath(relPath) {
  if (typeof relPath !== 'string') return true;
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!cleaned || cleaned.startsWith('/') || /[\x00-\x1f\x7f]/.test(cleaned)) return true;
  const segments = cleaned.split('/');
  if (segments.some(seg => !seg || seg === '.' || seg === '..' || EXCLUDED_ARTIFACT_DIRS.has(seg))) {
    return true;
  }
  const base = segments[segments.length - 1];
  if (EXCLUDED_ARTIFACT_FILES.has(base)) return true;
  if (EXCLUDED_ARTIFACT_SUFFIXES.some(ext => base.toLowerCase().endsWith(ext))) return true;
  return false;
}

/**
 * Discover portable git-ignored local files in `repoPath` (e.g. `.env.local`,
 * `.local-secrets/*`, `app/google-services.json`, `GoogleService-Info.plist`,
 * `Local.xcconfig`) while excluding build outputs, dependency caches, IDE/tool
 * metadata, and files larger than `maxBytes`.
 */
export async function discoverIgnoredArtifacts({
  repoPath,
  runner,
  execFile,
  fs: fsOverride,
  maxBytes = MAX_ARTIFACT_BYTES,
} = {}) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) return [];
  const exec = execFile ?? createHostExecFile(runner);
  const fsApi = fsOverride ?? createHostFs(runner);

  let stdout;
  try {
    ({ stdout } = await runGit(
      exec,
      ['-C', repoPath, 'status', '--porcelain=v1', '-z', '--ignored=traditional', '--untracked-files=normal'],
      { timeout: 10_000 },
    ));
  } catch {
    return [];
  }

  const ignoredEntries = stdout
    .split('\0')
    .filter(entry => entry.startsWith('!! '))
    .map(entry => entry.slice(3).replace(/\/+$/, ''))
    .filter(rel => rel && !isExcludedArtifactPath(rel));

  const results = [];

  async function walkAllowedDir(relDir) {
    const absDir = path.posix.join(repoPath, relDir);
    let entries;
    try {
      entries = await fsApi.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = `${relDir}/${entry.name}`;
      if (isExcludedArtifactPath(childRel)) continue;
      if (entry.isDirectory?.()) {
        await walkAllowedDir(childRel);
      } else if (entry.isFile?.()) {
        try {
          const st = await fsApi.stat(path.posix.join(repoPath, childRel));
          if (st.isFile() && st.size <= maxBytes) {
            results.push(childRel);
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  for (const rel of ignoredEntries) {
    const absPath = path.posix.join(repoPath, rel);
    let st;
    try {
      st = await fsApi.stat(absPath);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walkAllowedDir(rel);
    } else if (st.isFile() && st.size <= maxBytes) {
      results.push(rel);
    }
  }

  return [...new Set(results)].sort((a, b) => a.localeCompare(b));
}

/**
 * Adapt Android `local.properties` content for a target host so a macOS
 * `sdk.dir=/Users/.../Library/Android/sdk` is rewritten to the target host's
 * SDK path (e.g. `/home/.../Android/Sdk`) or omitted if unresolvable.
 */
export function adaptLocalPropertiesContent(content, targetSdkDir) {
  const lines = String(content ?? '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*sdk\.dir\s*=/.test(line)) {
      if (targetSdkDir) {
        out.push(`sdk.dir=${targetSdkDir}`);
      }
      continue;
    }
    out.push(line);
  }
  const hasActiveProperty = out.some(line => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed.includes('=');
  });
  if (!hasActiveProperty) return null;
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

async function detectTargetAndroidSdk(targetRunner, sourceSdkPath) {
  if (!targetRunner) return null;
  const candidateCheck = [
    ...(sourceSdkPath ? [shellQuote(sourceSdkPath)] : []),
    '"$ANDROID_HOME"',
    '"$ANDROID_SDK_ROOT"',
    '"$HOME/Android/Sdk"',
    '"$HOME/Library/Android/sdk"',
  ].join(' ');
  const script = `for d in ${candidateCheck}; do if [ -n "$d" ] && [ -d "$d" ]; then printf '%s\\n' "$d"; exit 0; fi; done`;
  try {
    const { stdout } = await targetRunner.run('sh', ['-c', script], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the best source checkout on another bound location of `project` to
 * copy git-ignored artifacts from for `repository`.
 */
export function resolveArtifactSourceRepo({ project, targetHost, repository } = {}) {
  if (!project || !repository) return null;
  const normalized = normalizeProject(project);
  const targetLower = String(targetHost || 'local').toLowerCase();
  const candidates = normalized.locations.filter(loc => loc.host.toLowerCase() !== targetLower && loc.path);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aLocal = a.host.toLowerCase() === 'local' ? 0 : 1;
    const bLocal = b.host.toLowerCase() === 'local' ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    const aDef = a.host.toLowerCase() === normalized.defaultHost.toLowerCase() ? 0 : 1;
    const bDef = b.host.toLowerCase() === normalized.defaultHost.toLowerCase() ? 0 : 1;
    return aDef - bDef;
  });

  const repoLower = String(repository).toLowerCase();
  for (const loc of candidates) {
    if (normalized.workspaceMode !== 'folder') {
      const ownName = path.basename(loc.path).toLowerCase();
      if (ownName === repoLower) {
        return { sourceHost: loc.host, sourceRepoPath: loc.path };
      }
    }
    const matched = (loc.repositories ?? []).find(r => r.name?.toLowerCase() === repoLower);
    if (matched?.path) {
      return { sourceHost: loc.host, sourceRepoPath: matched.path };
    }
    if (normalized.workspaceMode !== 'folder' && (normalized.repoManifest?.length ?? 0) <= 1 && (loc.repositories ?? []).length === 0) {
      return { sourceHost: loc.host, sourceRepoPath: loc.path };
    }
  }
  return null;
}

/**
 * Sync missing git-ignored local artifacts from `sourceRepoPath` to `targetRepoPath`.
 */
export async function syncRepoArtifacts({
  sourceRepoPath,
  sourceRunner,
  sourceExecFile,
  sourceFs: sourceFsOverride,
  targetRepoPath,
  targetRunner,
  targetFs: targetFsOverride,
  overwrite = false,
} = {}) {
  if (!sourceRepoPath || !targetRepoPath) return { synced: [], skipped: [] };
  const sRunner = sourceRunner ?? createCommandRunner('local');
  const tRunner = targetRunner ?? createCommandRunner('local');
  if (sRunner.host === tRunner.host && sourceRepoPath === targetRepoPath) {
    return { synced: [], skipped: [] };
  }

  const sourceFs = sourceFsOverride ?? createHostFs(sRunner);
  const targetFs = targetFsOverride ?? createHostFs(tRunner);

  const artifacts = await discoverIgnoredArtifacts({
    repoPath: sourceRepoPath,
    runner: sRunner,
    execFile: sourceExecFile,
    fs: sourceFs,
  });
  if (artifacts.length === 0) return { synced: [], skipped: [] };

  let resolvedTargetSdk;
  const synced = [];
  const skipped = [];

  for (const rel of artifacts) {
    const srcFull = path.posix.join(sourceRepoPath, rel);
    const dstFull = path.posix.join(targetRepoPath, rel);

    if (!overwrite) {
      try {
        await targetFs.access(dstFull);
        skipped.push(rel);
        continue;
      } catch {
        // Missing on target — proceed to copy
      }
    }

    let rawBuf;
    try {
      rawBuf = await sourceFs.readFile(srcFull);
    } catch {
      skipped.push(rel);
      continue;
    }

    let mode = null;
    if (sRunner.kind === 'local') {
      try {
        const st = await nodeFs.stat(srcFull);
        mode = st.mode & 0o777;
      } catch {
        mode = null;
      }
    }

    let payload = rawBuf;
    if (path.posix.basename(rel) === 'local.properties') {
      const text = Buffer.isBuffer(rawBuf) ? rawBuf.toString('utf8') : String(rawBuf);
      const sdkMatch = text.match(/^\s*sdk\.dir\s*=\s*(.+)$/m);
      if (sdkMatch) {
        if (resolvedTargetSdk === undefined) {
          const rawSdk = sdkMatch[1].trim().replace(/\\:/g, ':');
          resolvedTargetSdk = await detectTargetAndroidSdk(tRunner, rawSdk);
        }
        const adapted = adaptLocalPropertiesContent(text, resolvedTargetSdk);
        if (adapted === null) {
          skipped.push(rel);
          continue;
        }
        payload = Buffer.from(adapted, 'utf8');
      }
    }

    try {
      await targetFs.writeFile(dstFull, payload);
      if (mode !== null && (mode & 0o077) === 0) {
        const octal = (mode & 0o777).toString(8).padStart(4, '0');
        if (tRunner.kind === 'local') {
          await nodeFs.chmod(dstFull, mode);
        } else if (typeof tRunner.run === 'function') {
          await tRunner.run('chmod', [octal, '--', dstFull], { timeout: 5_000 });
        }
      }
      synced.push(rel);
    } catch {
      skipped.push(rel);
    }
  }

  return { synced, skipped };
}

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
  resolveRunner = null,
  syncArtifacts = true,
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
    if (res.status === 'synced' && syncArtifacts && runner) {
      const source = resolveArtifactSourceRepo({
        project,
        targetHost: location.host,
        repository: target.repository,
      });
      if (source) {
        try {
          const sourceRunner = typeof resolveRunner === 'function'
            ? resolveRunner(source.sourceHost)
            : (source.sourceHost === 'local' ? createCommandRunner('local') : null);
          if (sourceRunner) {
            const artifactRes = await syncRepoArtifacts({
              sourceRepoPath: source.sourceRepoPath,
              sourceRunner,
              targetRepoPath: target.repoPath,
              targetRunner: runner,
            });
            res.artifactsSynced = artifactRes.synced;
          }
        } catch {
          // Non-fatal: git pull already succeeded.
        }
      }
    }
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
  const totalArtifacts = results.reduce((sum, r) => sum + (r.artifactsSynced?.length || 0), 0);
  return {
    ok: true,
    status: 200,
    host: location.host,
    updated: results.some(r => r.updated) || totalArtifacts > 0,
    commitsPulled: totalCommits,
    artifactsSynced: totalArtifacts,
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
