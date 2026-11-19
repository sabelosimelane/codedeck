/**
 * Git worktree helpers for workflow pipeline runs (Spec §8.1, §8.2).
 * All git invocations use an injected execFile with argv arrays — never a shell.
 */

import path from 'node:path';
import fs from 'node:fs';
import { isProgressFilePath } from '../../shared/pipeline-definitions.mjs';

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
export function planNames({ runId, workflowName, homeRepoPath, branchPrefix = 'workflow' }) {
  if (typeof branchPrefix !== 'string' || !/^[a-z]+$/.test(branchPrefix)) throw new TypeError('branchPrefix must be lowercase letters');
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
    branch: `${branchPrefix}/${nameSuffix}`,
  };
}

/**
 * Plan the folder of a task in a project with several repositories: one folder for the task,
 * holding one worktree per repository under the repository's own folder name, so that a
 * reference from one repository to the one beside it resolves inside the task as it does
 * beside the repositories themselves. Every worktree gets the same branch name.
 * `ownHomePath` is the home repository of the project's own repository.
 */
export function planTaskFolder({ taskId, title, ownHomePath, repositories } = {}) {
  const shortId = shortIdFromRunId(taskId);
  if (shortId.length !== 8) throw new TypeError('taskId must be a UUID');
  if (typeof title !== 'string') throw new TypeError('title must be a string');
  if (typeof ownHomePath !== 'string' || !path.isAbsolute(ownHomePath)) throw new TypeError('ownHomePath must be an absolute path');
  if (!Array.isArray(repositories) || repositories.length === 0 || new Set(repositories).size !== repositories.length
    || repositories.some(name => typeof name !== 'string' || !name || name.includes('/') || name === '.' || name === '..')) {
    throw new TypeError('repositories must be distinct folder names');
  }
  const slug = slugifyWorkflowName(title);
  const suffix = slug ? `${slug}-${shortId}` : shortId;
  const folder = path.join(path.dirname(ownHomePath), 'worktrees', suffix);
  return {
    folder,
    branch: `task/${suffix}`,
    worktrees: repositories.map(repository => ({ repository, worktreePath: path.join(folder, repository) })),
  };
}

/** Invoke injected execFile with argv arrays; supports callback-style and promise-returning fakes. */
export function runGit(execFile, args, { timeout = GIT_TIMEOUT_MS } = {}) {
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

/** A new worktree copies HEAD, so only a blob in that commit qualifies. */
export async function hasCommittedFile({ repoPath, progressFile, execFile } = {}) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw new TypeError('repoPath must be an absolute path');
  if (typeof progressFile !== 'string' || !progressFile) throw new TypeError('progressFile must be a non-empty string');
  const { stdout } = await runGit(execFile, ['-C', repoPath, 'ls-tree', '-z', 'HEAD', '--', progressFile]);
  return stdout.split('\0').some(entry => entry.split('\t')[1] === progressFile && /^100(?:644|755) blob /.test(entry));
}

/** The text of a Markdown file as it is at HEAD in `repoPath`. The caller has checked that it is there. */
export async function readCommittedFile({ repoPath, file, execFile } = {}) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw new TypeError('repoPath must be an absolute path');
  if (!isProgressFilePath(file, 512)) throw new TypeError('file must be the path of a .md file inside the repository');
  const { stdout } = await runGit(execFile, ['-C', repoPath, 'cat-file', 'blob', `HEAD:${file}`]);
  return stdout;
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
 * Create a worktree at the supplied base commit or at HEAD of projectPath.
 * @returns {{ baseCommit: string }}
 */
export async function create({
  homePath,
  worktreePath,
  branch,
  projectPath,
  baseCommit,
  execFile,
  mkdir = (dir, opts) => fs.promises.mkdir(dir, opts),
} = {}) {
  if (baseCommit === undefined) {
    const { stdout } = await runGit(execFile, ['-C', projectPath, 'rev-parse', 'HEAD']);
    baseCommit = stdout.trim();
  } else if (typeof baseCommit !== 'string' || !COMMIT_ID.test(baseCommit)) {
    throw new TypeError('worktree create: baseCommit must be a commit id');
  }
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

const COMMIT_ID = /^[0-9a-f]{40}$/;
const LOCAL_BRANCH_PREFIX = 'refs/heads/';

/**
 * The working trees of the repository `projectPath` belongs to: the home checkout and every
 * linked worktree, as git reports them. A bare repository entry has no working tree and is left out.
 * @returns {Promise<Array<{ path: string, head: string, branch: string | null, missing: boolean }>>}
 */
export async function listWorktrees({ projectPath, execFile } = {}) {
  const { stdout } = await runGit(execFile, ['-C', projectPath, 'worktree', 'list', '--porcelain']);
  const worktrees = [];
  const blocks = stdout.split(/\n\n+/).map(block => block.trim()).filter(Boolean);
  blocks.forEach((block, index) => {
    const attributes = new Map();
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ');
      attributes.set(space === -1 ? line : line.slice(0, space), space === -1 ? '' : line.slice(space + 1));
    }
    const fail = message => { throw new Error(`git worktree list: entry ${index} ${message}`); };

    const worktreePath = attributes.get('worktree');
    if (!worktreePath) fail('has no path');
    if (!path.isAbsolute(worktreePath)) fail('path is not absolute');
    if (attributes.has('bare')) return;

    const head = attributes.get('HEAD');
    if (typeof head !== 'string' || !COMMIT_ID.test(head)) fail('HEAD is not a commit id');

    let branch = null;
    if (attributes.has('branch')) {
      const ref = attributes.get('branch');
      if (!ref.startsWith(LOCAL_BRANCH_PREFIX) || ref.length === LOCAL_BRANCH_PREFIX.length) fail('branch is not a local branch');
      branch = ref.slice(LOCAL_BRANCH_PREFIX.length);
    } else if (!attributes.has('detached')) {
      fail('has neither a branch nor detached');
    }

    worktrees.push({ path: worktreePath, head, branch, missing: attributes.has('prunable') });
  });
  return worktrees;
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
 * Whether a listed worktree has uncommitted changes. A directory git cannot open as a
 * working tree (its link to the repository is broken, for example after the repository
 * moved) is reported as unreadable; any other git failure is thrown.
 * @returns {Promise<{ readable: true, dirty: boolean } | { readable: false }>}
 */
export async function readWorktreeChanges({ worktreePath, execFile } = {}) {
  try {
    return { readable: true, dirty: (await listDirtyPaths({ worktreePath, execFile })).length > 0 };
  } catch (err) {
    if (String(err?.stderr ?? '').includes('not a git repository')) return { readable: false };
    throw err;
  }
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
   directories; install or build those in the worktree instead. Do not copy .codedeck/ from the home checkout.
3. Never print, summarise or log the contents of a copied file. Copy with file operations only.
4. Do not create, modify or delete tracked files, do not commit, and change nothing in the home
   checkout.
5. Finish by running \`git status --short\` in the worktree. It must print nothing.

If you cannot tell what the project needs, or a step fails, report NEEDS_INPUT and say what is missing.`;
}

/**
 * The Setup prompt for a task created with its run: the same rules, for every worktree of the
 * task. `pairs`: `{ repository, homePath, worktreePath }`, the worktree the run works in first.
 */
export function buildSetupPromptForRepositories(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0 || pairs.some(pair => typeof pair?.repository !== 'string' || !pair.repository
    || typeof pair.homePath !== 'string' || !path.isAbsolute(pair.homePath) || typeof pair.worktreePath !== 'string' || !path.isAbsolute(pair.worktreePath))) {
    throw new TypeError('pairs must name each repository with its home checkout and its worktree');
  }
  if (pairs.length === 1) return buildSetupPrompt(pairs[0].homePath, pairs[0].worktreePath);
  const listed = pairs.map((pair, index) => `- ${pair.repository}: home checkout ${pair.homePath}, worktree ${pair.worktreePath}${index === 0 ? ' (your current directory)' : ''}`).join('\n');
  return `You are preparing ${pairs.length} fresh git worktrees of one task so that work can be built and tested in them.
A home checkout is a read-only source of local files; a worktree is the only place you may change.
${listed}

Do the following for each repository, in its own worktree:
1. Work out how the repository installs its dependencies (lock files, build files, README, agent
   instruction files) and install them in its worktree.
2. Find files in its home checkout that git ignores and that the repository needs locally to build,
   test or run (for example .env.local, local.properties, service-account files). Copy each one to
   the same relative path and the same name in its worktree. Do not copy dependency or build output
   directories; install or build those in the worktree instead. Do not copy .codedeck/ from a home checkout.
3. Never print, summarise or log the contents of a copied file. Copy with file operations only.
4. Do not create, modify or delete tracked files, do not commit, and change nothing in any home
   checkout.
5. Finish by running \`git status --short\` in every worktree. Each must print nothing.

If you cannot tell what a repository needs, or a step fails, report NEEDS_INPUT and say which repository and what is missing.`;
}
