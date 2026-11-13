/**
 * Git worktree helpers for workflow pipeline runs (Spec §8.1, §8.2).
 * All git invocations use an injected execFile with argv arrays — never a shell.
 */

import path from 'node:path';
import fs from 'node:fs';

const GIT_TIMEOUT_MS = 30_000;

const REASON_MESSAGES = {
  project_remote: 'Workflows can only run on local projects.',
  not_git_toplevel: 'The project path must be the top level of a git working tree.',
  setup_agent_missing: 'Choose a setup agent in Settings → Workflows.',
};

function isLocalHost(projectHost) {
  return !projectHost || projectHost === 'local';
}

function hasSetupAgent(setupAgentId) {
  return typeof setupAgentId === 'string' && setupAgentId.trim().length > 0;
}

function reason(code) {
  return { code, message: REASON_MESSAGES[code] };
}

function slugifyWorkflowName(workflowName) {
  return String(workflowName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function shortIdFromRunId(runId) {
  const hex = String(runId ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.slice(0, 8);
}

/**
 * Plan worktree path and branch names for a run.
 * `homeRepoPath` is the home repository (parent of absolute `--git-common-dir`).
 */
export function planNames({ runId, workflowName, homeRepoPath }) {
  const shortId = shortIdFromRunId(runId);
  const slug = slugifyWorkflowName(workflowName);
  const homeFolder = path.basename(homeRepoPath);
  const worktreesParent = path.join(path.dirname(homeRepoPath), 'worktrees');
  const nameSuffix = slug ? `${slug}-${shortId}` : shortId;
  return {
    shortId,
    slug,
    homeRepoPath,
    worktreePath: path.join(worktreesParent, `${homeFolder}-${nameSuffix}`),
    branch: `workflow/${nameSuffix}`,
  };
}

/** Invoke injected execFile with argv arrays; supports callback-style and promise-returning fakes. */
function runGit(execFile, args, { timeout = GIT_TIMEOUT_MS } = {}) {
  if (typeof execFile !== 'function') throw new Error('execFile is required');
  const options = { timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (err) {
        if (stdout !== undefined) err.stdout = stdout;
        if (stderr !== undefined) err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    };

    let returned;
    try {
      returned = execFile('git', args, options, finish);
    } catch (err) {
      finish(err);
      return;
    }

    if (returned && typeof returned.then === 'function') {
      returned.then(
        (value) => {
          if (typeof value === 'string') finish(null, value, '');
          else finish(null, value?.stdout ?? '', value?.stderr ?? '');
        },
        (err) => finish(err, err?.stdout, err?.stderr),
      );
    }
  });
}

async function resolveRealpath(realpath, target) {
  if (typeof realpath === 'function') return realpath(target);
  return fs.promises.realpath(target);
}

/**
 * Evaluate start checks 3–5 for GET /preflight.
 * Returns { eligible, reasons, branch, head, dirty }.
 */
export async function preflight({
  projectPath,
  projectHost,
  setupAgentId,
  execFile,
  realpath,
} = {}) {
  const reasons = [];

  if (!isLocalHost(projectHost)) {
    reasons.push(reason('project_remote'));
    if (!hasSetupAgent(setupAgentId)) reasons.push(reason('setup_agent_missing'));
    return { eligible: false, reasons, branch: null, head: null, dirty: null };
  }

  let branch = null;
  let head = null;
  let dirty = null;
  let gitOk = false;

  try {
    const { stdout: toplevelRaw } = await runGit(execFile, [
      '-C', projectPath, 'rev-parse', '--show-toplevel',
    ]);
    const toplevel = toplevelRaw.trim();
    const realProject = await resolveRealpath(realpath, projectPath);
    const realTop = await resolveRealpath(realpath, toplevel);
    if (realTop !== realProject) {
      reasons.push(reason('not_git_toplevel'));
    } else {
      gitOk = true;
      const [{ stdout: branchRaw }, { stdout: headRaw }, { stdout: statusRaw }] = await Promise.all([
        runGit(execFile, ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD']),
        runGit(execFile, ['-C', projectPath, 'rev-parse', 'HEAD']),
        runGit(execFile, ['-C', projectPath, 'status', '--porcelain']),
      ]);
      const branchName = branchRaw.trim();
      branch = branchName === 'HEAD' ? null : branchName;
      head = headRaw.trim();
      dirty = statusRaw.length > 0;
    }
  } catch {
    reasons.push(reason('not_git_toplevel'));
  }

  if (!hasSetupAgent(setupAgentId)) {
    reasons.push(reason('setup_agent_missing'));
  }

  if (!gitOk) {
    branch = null;
    head = null;
    dirty = null;
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    branch,
    head,
    dirty,
  };
}

/**
 * Create a run worktree at base_commit = HEAD of projectPath.
 * @returns {{ baseCommit: string }}
 */
export async function create({
  homePath,
  worktreePath,
  branch,
  projectPath,
  execFile,
  mkdir = (dir, opts) => fs.promises.mkdir(dir, opts),
} = {}) {
  const { stdout: headRaw } = await runGit(execFile, [
    '-C', projectPath, 'rev-parse', 'HEAD',
  ]);
  const baseCommit = headRaw.trim();
  await mkdir(path.dirname(worktreePath), { recursive: true });
  try {
    await runGit(execFile, [
      '-C', homePath,
      'worktree', 'add',
      worktreePath,
      '-b', branch,
      baseCommit,
    ]);
  } catch (err) {
    const detail = String(err?.stderr || err?.message || 'git worktree add failed').trim();
    const wrapped = new Error(detail);
    wrapped.cause = err;
    throw wrapped;
  }
  return { baseCommit };
}

/**
 * Resolve the home repository path: parent of absolute --git-common-dir.
 */
export async function resolveHomeRepoPath({ projectPath, execFile } = {}) {
  const { stdout } = await runGit(execFile, [
    '-C', projectPath, 'rev-parse', '--path-format=absolute', '--git-common-dir',
  ]);
  return path.dirname(stdout.trim());
}

/**
 * Parse `git status --porcelain` into path strings only (no statuses, no contents).
 */
function parsePorcelainPaths(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      // XY␠path or XY␠orig -> path
      const rest = line.length >= 3 ? line.slice(3) : line;
      const arrow = rest.lastIndexOf(' -> ');
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
    })
    .filter(Boolean);
}

/**
 * List dirty paths in a worktree (Setup guard, Spec §8.5).
 * @returns {Promise<string[]>}
 */
export async function listDirtyPaths({ worktreePath, execFile } = {}) {
  const { stdout } = await runGit(execFile, [
    '-C', worktreePath, 'status', '--porcelain',
  ]);
  return parsePorcelainPaths(stdout);
}

/**
 * Remove a worktree (Spec §8.2). Never passes --force.
 * @returns {Promise<{ ok: true } | { ok: false, detail: string }>}
 */
export async function remove({ homePath, worktreePath, execFile } = {}) {
  try {
    await runGit(execFile, [
      '-C', homePath, 'worktree', 'remove', worktreePath,
    ]);
    return { ok: true };
  } catch (err) {
    const gitMessage = String(err?.stderr || err?.message || 'git worktree remove failed')
      .trim()
      .split('\n')[0];
    let paths = [];
    try {
      paths = (await listDirtyPaths({ worktreePath, execFile })).slice(0, 20);
    } catch (statusErr) {
      // Removal already failed; status is best-effort for the detail message.
      console.warn('[pipeline-worktree] status after remove failure:', statusErr?.message || statusErr);
    }
    const detail = [gitMessage, ...paths].filter(Boolean).join('\n').slice(0, 2000);
    return { ok: false, detail };
  }
}

/**
 * Built-in Setup prompt with home/worktree paths substituted (Spec §8.5).
 */
export function buildSetupPrompt(homePath, worktreePath) {
  return `You are preparing a fresh git worktree so that work can be built and tested in it.
Home checkout (read-only source of local files): ${homePath}
Worktree (your current directory, the only place you may change): ${worktreePath}

1. Work out how this project installs its dependencies (lock files, build files, README, agent
   instruction files) and install them in the worktree.
2. Find files in the home checkout that git ignores and that the project needs locally to build,
   test or run (for example .env.local, local.properties, service-account files). Copy each one to
   the same relative path and the same name in the worktree. Do not copy dependency or build output
   directories; install or build those in the worktree instead.
3. Never print, summarise or log the contents of a copied file. Copy with file operations only.
4. Do not create, modify or delete tracked files, do not commit, and change nothing in the home
   checkout.
5. Finish by running \`git status --short\` in the worktree. It must print nothing.

If you cannot tell what the project needs, or a step fails, report NEEDS_INPUT and say what is missing.`;
}
