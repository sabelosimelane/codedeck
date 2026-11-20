/**
 * Landing a task: how its work gets back into the project. A task has one worktree in each
 * repository it includes, and each is landed on its own: status, commit, merge, pull request
 * and close act on one repository, against the checkout that repository is listed with. The
 * task is finished when its last repository is merged or closed.
 *
 * Everything here is read live from Git or done only on the owner's request. Nothing is
 * forced: a worktree with uncommitted work is never removed, a conflicting merge is aborted
 * and reported, and a branch is deleted only once Git agrees it is merged.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, rmdir as removeDirectory } from 'node:fs/promises';
import path from 'node:path';
import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { listDirtyPaths, remove as removeWorktree, resolveHomeRepoPath } from '../pipelines/run-worktree.js';
import { TaskError } from './task-service.js';

const GIT_TIMEOUT_MS = 30_000;
// Pushing and opening a pull request talk to a remote host; they get a longer, explicit limit.
const REMOTE_TIMEOUT_MS = 90_000;
const MAX_LISTED = 50;
const OPEN_STATES = ['active', 'pr_open'];
const FINISHED_STATES = ['merged', 'closed'];
const MESSAGE_MAX = 200;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Why an action is refused, in words. A task with one worktree is spoken of as the task; in a
 * task with several, the repository is named.
 */
function blockerMessage(code, { several, repository, worktree, checkoutBranch, mainBranch, ignoredAtRisk }) {
  const listed = () => `${ignoredAtRisk.slice(0, 5).join(', ')}${ignoredAtRisk.length > 5 ? ', …' : ''}`;
  if (!several) {
    return {
      finished: 'This task is finished.',
      files_missing: "This task's files are no longer on disk.",
      run_active: 'A workflow run is still working in this task. Stop it or let it finish first.',
      uncommitted: 'This task has uncommitted changes. Commit them first.',
      nothing_to_land: 'This task has no commits of its own yet.',
      already_in_base: () => `This task's commits are already in ${worktree.baseBranch}, so there is nothing left to merge. Close the task to finish it.`,
      no_base_branch: 'This task was started from a commit, not a branch, so there is no branch to merge it into.',
      main_not_on_base: () => `Main is on ${mainBranch ?? 'no branch'}, but this task was started from ${worktree.baseBranch}. Switch Main to ${worktree.baseBranch} to merge.`,
      main_dirty: 'Main has uncommitted changes. Commit or stash them before merging.',
      no_remote: 'This project has no remote to push to.',
      branch_switched: () => `This task's folder is on ${checkoutBranch ?? 'no branch'}, not on its branch ${worktree.branch}. Switch it back to ${worktree.branch} first.`,
      ignored_files: () => `This task has files Git ignores that exist nowhere else: ${listed()}. Move or delete them first.`,
    }[code];
  }
  return {
    finished: 'This repository of the task is finished.',
    files_missing: `The files of ${repository} in this task are no longer on disk.`,
    run_active: 'A workflow run is still working in this task. Stop it or let it finish first.',
    uncommitted: `${repository} has uncommitted changes in this task. Commit them first.`,
    nothing_to_land: `${repository} has no commits of its own in this task yet.`,
    already_in_base: () => `${repository}'s commits in this task are already in ${worktree.baseBranch}, so there is nothing left to merge. Close ${repository} to finish it.`,
    no_base_branch: `${repository} was started from a commit, not a branch, so there is no branch to merge it into.`,
    main_not_on_base: () => `${repository}'s checkout is on ${mainBranch ?? 'no branch'}, but this task started from ${worktree.baseBranch} there. Switch it to ${worktree.baseBranch} to merge.`,
    main_dirty: `${repository}'s checkout has uncommitted changes. Commit or stash them before merging.`,
    no_remote: `${repository} has no remote to push to.`,
    branch_switched: () => `The task's copy of ${repository} is on ${checkoutBranch ?? 'no branch'}, not on its branch ${worktree.branch}. Switch it back to ${worktree.branch} first.`,
    ignored_files: () => `The task's copy of ${repository} has files Git ignores that exist nowhere else: ${listed()}. Move or delete them first.`,
  }[code];
}

// Ignored files the owner agreed may go with a task's folder; any other ignored file is kept.
const DISPOSABLE = new Set(['node_modules', 'dist', 'build', 'target', '.gradle', '.codedeck']);

function run(execFile, file, args, { cwd, timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout ?? '');
        error.stderr = String(stderr ?? '');
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

const git = (execFile, cwd, args, options) => run(execFile, 'git', ['-C', cwd, ...args], options);

/** The SHA-256 of a file's bytes, read as a stream so a large file is never held in memory. */
function digest(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}
const firstLine = text => String(text ?? '').trim().split('\n')[0].slice(0, 300);

/** Which hosting CLI opens a pull request for a remote URL, and the repository it names. */
export function describeRemote(url) {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:\s]+)[:/](.+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  if (!match) return { host: null, repository: null, tool: null };
  const host = match[1].toLowerCase();
  const repository = match[2].replace(/^\d+\//, '');
  return { host, repository, tool: host === 'github.com' || host.endsWith('.github.com') ? 'gh' : host.includes('gitlab') ? 'glab' : null };
}

export function createTaskLanding({
  taskStore, findProject, execFile, pathExists, hasActiveRun, onTaskFinished, onWorktreeFinished, closeTerminals,
  rmdir = removeDirectory,
  // Runs that published attachments into a worktree: only their verified copies are disposable.
  listRunAttachmentsForWorktree = async () => [],
} = {}) {
  if (typeof taskStore?.get !== 'function' || typeof taskStore?.setWorktreeState !== 'function') throw new TypeError('taskStore is required');
  if (typeof listRunAttachmentsForWorktree !== 'function') throw new TypeError('listRunAttachmentsForWorktree must be a function');
  for (const [name, value] of Object.entries({ findProject, execFile, pathExists, hasActiveRun, onTaskFinished, onWorktreeFinished, closeTerminals, rmdir })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  async function load(id) {
    if (!isUuid(id)) throw new TaskError('Task not found', 404);
    const task = taskStore.get(id);
    if (!task) throw new TaskError('Task not found', 404);
    const project = await findProject(task.project);
    if (!project || typeof project.path !== 'string' || !path.isAbsolute(project.path)) throw new TaskError('The project of this task no longer exists.', 409);
    return { task, project };
  }

  /** The worktree an action is about: the one named, or the one the task started in. */
  function pick(task, worktreeId) {
    const worktree = worktreeId === undefined
      ? task.worktrees.find(candidate => candidate.first)
      : isUuid(worktreeId) ? task.worktrees.find(candidate => candidate.id === worktreeId) : undefined;
    if (!worktree) throw new TaskError('This task has no such repository.', 404);
    return worktree;
  }

  async function remotes(checkout) {
    const { stdout } = await git(execFile, checkout, ['remote']);
    const names = stdout.split('\n').map(name => name.trim()).filter(name => REMOTE_NAME.test(name));
    return Promise.all(names.map(async name => {
      // The configured address names the host; `remote get-url` would apply the owner's URL rewrites.
      const { stdout: url } = await git(execFile, checkout, ['config', '--get', `remote.${name}.url`]);
      const { host, tool } = describeRemote(url);
      return { name, host, tool };
    }));
  }

  /** The checkout's branch now, or null when its HEAD is detached. */
  async function currentBranch(cwd) {
    const { stdout } = await git(execFile, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim() === 'HEAD' ? null : stdout.trim();
  }

  /**
   * Whether the checkout has commits made since the commit its task started from. With no
   * commit that its base lacks, such a task is not untouched: its work is already in the base.
   */
  async function movedPast(cwd, baseCommit) {
    const { stdout } = await git(execFile, cwd, ['rev-list', '--count', `${baseCommit}..HEAD`]);
    const made = Number(stdout.trim());
    if (stdout.trim() === '' || !Number.isSafeInteger(made) || made < 0) throw new Error('git rev-list returned an unexpected count');
    return made > 0;
  }

  async function sameBytes(worktreePath, checkout, file) {
    // Git lists a wholly ignored folder as one entry; it is a copy when everything in it is.
    if (file.endsWith('/')) return sameFolder(path.join(worktreePath, file), path.join(checkout, file));
    // Only a regular file in the checkout can hold the same bytes; a folder or link of that name cannot.
    const home = await lstat(path.join(checkout, file)).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!home?.isFile()) return false;
    const hash = async cwd => (await git(execFile, cwd, ['hash-object', '--no-filters', '--', file])).stdout.trim();
    return (await hash(worktreePath)) === (await hash(checkout));
  }

  /**
   * Whether removing a worktree's folder loses nothing: every regular file in it, at any depth,
   * is a regular file of the same bytes at the same place in the checkout. A link or any other
   * kind of entry cannot be shown to be a copy, so it counts as one that would be lost. Disposable
   * folders inside are not looked into, as at the top level. Stops at the first difference.
   */
  async function sameFolder(taskDir, homeDir) {
    for (const entry of await readdir(taskDir, { withFileTypes: true })) {
      if (DISPOSABLE.has(entry.name)) continue;
      const inTask = path.join(taskDir, entry.name);
      const inHome = path.join(homeDir, entry.name);
      if (entry.isDirectory()) {
        if (!(await sameFolder(inTask, inHome))) return false;
      } else if (!entry.isFile() || !(await sameFile(inTask, inHome))) {
        return false;
      }
    }
    return true;
  }

  async function sameFile(inTask, inHome) {
    const home = await lstat(inHome).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!home?.isFile() || home.size !== (await lstat(inTask)).size) return false;
    const [task, main] = await Promise.all([digest(inTask), digest(inHome)]);
    return task === main;
  }

  /**
   * Whether an ignored path under `.codedeck/.../attachments/` still matches a published
   * run manifest for this worktree (readable regular file, recorded size and digest).
   */
  async function isVerifiedRunAttachment(worktreePath, relativePath) {
    const manifests = await listRunAttachmentsForWorktree(worktreePath);
    if (!Array.isArray(manifests)) throw new TypeError('listRunAttachmentsForWorktree must return an array');
    const expected = manifests.flatMap(entry => Array.isArray(entry?.attachments) ? entry.attachments : [])
      .find(attachment => attachment?.path === relativePath);
    if (!expected || !Number.isInteger(expected.sizeBytes) || typeof expected.digest !== 'string') return false;
    const target = path.join(worktreePath, relativePath);
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.sizeBytes) return false;
      return (await digest(target)) === expected.digest;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ELOOP' || error?.code === 'EISDIR') return false;
      throw error;
    }
  }

  /** Attachment copies under `.codedeck` that are missing from every run manifest or no longer match. */
  async function listUnverifiedAttachments(worktreePath) {
    const attachmentsRoot = path.join(worktreePath, '.codedeck', 'runs');
    let runDirs = [];
    try {
      runDirs = await readdir(attachmentsRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const atRisk = [];
    for (const runDir of runDirs) {
      if (!runDir.isDirectory() || !/^[0-9a-f]{8}$/.test(runDir.name)) continue;
      const folder = path.join(attachmentsRoot, runDir.name, 'attachments');
      let entries = [];
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        const relative = `.codedeck/runs/${runDir.name}/attachments/${entry.name}`;
        if (!entry.isFile() || !(await isVerifiedRunAttachment(worktreePath, relative))) {
          atRisk.push(relative);
        }
      }
    }
    return atRisk;
  }

  /** Ignored files in the worktree that removing its folder would lose: not disposable, and not copied byte for byte in the checkout. */
  async function listIgnoredAtRisk(worktreePath, checkout) {
    const { stdout } = await git(execFile, worktreePath, ['status', '--porcelain', '-z', '--ignored']);
    const ignored = stdout.split('\0').filter(entry => entry.startsWith('!! ')).map(entry => entry.slice(3));
    const atRisk = [];
    let scannedAttachments = false;
    for (const file of ignored) {
      // Run notes stay disposable, but attachment copies must match a recorded manifest.
      if (file === '.codedeck/' || file.startsWith('.codedeck/')) {
        if (!scannedAttachments) {
          atRisk.push(...await listUnverifiedAttachments(worktreePath));
          scannedAttachments = true;
        }
        continue;
      }
      if (file.split('/').some(segment => DISPOSABLE.has(segment))) continue;
      if (!(await sameBytes(worktreePath, checkout, file))) atRisk.push(file);
    }
    return atRisk;
  }

  /** Everything the owner needs to decide how to land one repository of the task, read from Git now. */
  async function inspect(id, worktreeId) {
    const { task, project } = await load(id);
    const worktree = pick(task, worktreeId);
    // The checkout this repository merges into: the project's path for its own repository, else the one it is listed with.
    const checkout = worktree.own ? project.path : worktree.repositoryPath;
    const open = OPEN_STATES.includes(worktree.state);
    const present = open && await pathExists(worktree.worktreePath);
    if (typeof present !== 'boolean') throw new Error('pathExists must return a boolean');
    const active = open && hasActiveRun(task.id) === true;

    let uncommitted = [];
    let ahead = null;
    let behind = null;
    // Whether the task's work is already in its base branch; null when Git could not be asked.
    let alreadyInBase = null;
    let checkoutBranch = null;
    let ignoredAtRisk = [];
    if (present) {
      uncommitted = await listDirtyPaths({ worktreePath: worktree.worktreePath, execFile });
      checkoutBranch = await currentBranch(worktree.worktreePath);
      ignoredAtRisk = await listIgnoredAtRisk(worktree.worktreePath, checkout);
      const base = worktree.baseBranch ?? worktree.baseCommit;
      const { stdout } = await git(execFile, worktree.worktreePath, ['rev-list', '--left-right', '--count', `${base}...HEAD`]);
      const counts = stdout.trim().split(/\s+/).map(Number);
      if (counts.length !== 2 || counts.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('git rev-list returned unexpected counts');
      [behind, ahead] = counts;
      alreadyInBase = ahead === 0 && await movedPast(worktree.worktreePath, worktree.baseCommit);
    }

    const mainBranch = await currentBranch(checkout);
    const mainDirty = (await listDirtyPaths({ worktreePath: checkout, execFile })).length > 0;
    const remoteList = await remotes(checkout);

    const common = [];
    if (!open) common.push('finished');
    else if (!present) common.push('files_missing');
    if (active) common.push('run_active');
    const withWork = [...common];
    if (present && uncommitted.length > 0) withWork.push('uncommitted');
    // No commit the base lacks is one of two things: the task has done nothing, or its work was merged outside CodeDeck.
    if (present && ahead === 0) withWork.push(alreadyInBase ? 'already_in_base' : 'nothing_to_land');
    // Landing acts on the worktree's stored branch; work committed on another branch would not go with it.
    if (present && checkoutBranch !== worktree.branch) withWork.push('branch_switched');

    const merge = [...withWork];
    if (open && worktree.baseBranch === null) merge.push('no_base_branch');
    else if (open && mainBranch !== worktree.baseBranch) merge.push('main_not_on_base');
    if (open && mainDirty) merge.push('main_dirty');

    const words = { several: task.worktrees.length > 1, repository: worktree.repository, worktree, checkoutBranch, mainBranch, ignoredAtRisk };
    const describe = (code) => {
      const message = blockerMessage(code, words);
      return { code, message: typeof message === 'function' ? message() : message };
    };
    const pullRequest = [...withWork];
    if (remoteList.length === 0) pullRequest.push('no_remote');

    // A worktree whose files are already gone can still be closed; there is nothing left to lose.
    const close = common.filter(code => code !== 'files_missing');
    if (present && uncommitted.length > 0) close.push('uncommitted');
    // Closing removes the folder and keeps only the stored branch; commits on another branch or a detached HEAD would be lost with it.
    if (present && checkoutBranch !== worktree.branch) close.push('branch_switched');
    if (present && ignoredAtRisk.length > 0) close.push('ignored_files');

    return {
      task,
      project,
      worktree,
      checkout,
      ignoredAtRisk: ignoredAtRisk.length > 0 ? describe('ignored_files') : null,
      view: {
        taskId: task.id,
        worktreeId: worktree.id,
        repository: worktree.repository,
        own: worktree.own,
        first: worktree.first,
        worktreePath: worktree.worktreePath,
        state: worktree.state,
        branch: worktree.branch,
        baseBranch: worktree.baseBranch,
        prUrl: worktree.prUrl,
        filesPresent: present,
        runActive: active,
        uncommitted: uncommitted.slice(0, MAX_LISTED),
        uncommittedCount: uncommitted.length,
        commitsAhead: ahead,
        commitsBehind: behind,
        alreadyInBase,
        // Ignored files that exist only here; Close deletes them with the folder once the owner says so.
        ignoredAtRisk: ignoredAtRisk.slice(0, MAX_LISTED),
        ignoredAtRiskCount: ignoredAtRisk.length,
        main: { branch: mainBranch, dirty: mainDirty },
        remotes: remoteList,
        blockers: {
          commit: [...common, ...(present && uncommitted.length === 0 ? ['nothing_to_commit'] : [])].map(code => (code === 'nothing_to_commit' ? { code, message: 'There is nothing to commit.' } : describe(code))),
          merge: merge.map(describe),
          pullRequest: pullRequest.map(describe),
          close: close.map(describe),
        },
      },
    };
  }

  const withExtra = (error, extra) => Object.assign(error, { extra });

  /** The owner's word that ignored files only the task holds may be deleted with its folder; left out, they may not. */
  function requireDeleteIgnored(options) {
    const value = options?.deleteIgnored;
    if (value !== undefined && typeof value !== 'boolean') {
      throw new TaskError('One or more fields failed validation.', 400, [{ field: 'deleteIgnored', message: 'Use true or false' }]);
    }
    return value === true;
  }
  /** What refuses a close. The owner's word lifts only the ignored files; uncommitted work and the rest still refuse. */
  const closeBlockers = (view, deleteIgnored) => view.blockers.close.filter(blocker => !(deleteIgnored && blocker.code === 'ignored_files'));
  const refuse = blockers => withExtra(new TaskError(blockers[0].message, 409), { reasons: blockers });

  const requireClosed = (result) => {
    for (const field of ['closed', 'notClosed']) {
      if (!Array.isArray(result?.[field]) || result[field].some(id => typeof id !== 'string' || id.length === 0)) throw new TypeError(`closeTerminals: ${field} must be an array of session ids`);
    }
    return { terminalsClosed: result.closed, terminalsNotClosed: result.notClosed };
  };

  /** The folder that held the task's worktrees goes when it is empty; one that holds something else stays. Says whether it is gone. */
  async function removeFolder(folder) {
    try {
      await rmdir(folder);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false;
      throw error;
    }
  }

  /**
   * After one repository of a task was merged or closed. When that finished the task, its runs
   * are released and all its terminals closed; otherwise only the runs and terminals of that
   * one worktree, and the rest of the task is left as it is.
   */
  async function afterFinished(task, worktree) {
    if (FINISHED_STATES.includes(task.state)) {
      const folderRemoved = task.folder === null ? {} : { folderRemoved: await removeFolder(task.folder) };
      onTaskFinished(task);
      return { taskFinished: true, ...folderRemoved, ...requireClosed(await closeTerminals(task)) };
    }
    onWorktreeFinished(task, worktree);
    return { taskFinished: false, ...requireClosed(await closeTerminals(task, worktree)) };
  }

  async function removeFiles(worktree, checkout) {
    const home = await resolveHomeRepoPath({ projectPath: checkout, execFile });
    const removed = await removeWorktree({ homePath: home, worktreePath: worktree.worktreePath, execFile });
    return { home, removed };
  }

  /** Closes one worktree whose blockers were already checked. */
  async function closeInspected({ task, worktree, checkout, view }) {
    if (view.filesPresent) {
      const { removed } = await removeFiles(worktree, checkout);
      if (!removed.ok) {
        throw new TaskError(task.worktrees.length > 1
          ? `The files of ${worktree.repository} in this task could not be removed: ${firstLine(removed.detail)}`
          : `The task's files could not be removed: ${firstLine(removed.detail)}`, 409);
      }
    }
    // The branch stays: it may hold commits that are not merged anywhere.
    const after = taskStore.setWorktreeState(task.id, worktree.id, { state: 'closed' });
    return { after, closed: { repository: worktree.repository, branchKept: worktree.branch, unmergedCommits: view.commitsAhead ?? 0 }, finish: await afterFinished(after, worktree) };
  }

  // Git refuses two operations at once in one repository; landing actions run one at a time.
  let queue = Promise.resolve();
  const serial = action => {
    const result = queue.then(action);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    /** How one repository of the task stands: the one named, or the one the task started in. */
    async status(id, { worktreeId } = {}) {
      return (await inspect(id, worktreeId)).view;
    },

    /** How every repository of the task stands, the one it started in first. */
    async worktrees(id) {
      const { task } = await load(id);
      const views = [];
      for (const worktree of task.worktrees) views.push((await inspect(id, worktree.id)).view);
      return views;
    },

    commit(id, { message, worktreeId } = {}) {
      if (typeof message !== 'string' || message.trim().length < 1 || message.trim().length > MESSAGE_MAX || /[\x00-\x1f\x7f]/.test(message)) {
        throw new TaskError('One or more fields failed validation.', 400, [{ field: 'message', message: `Use 1–${MESSAGE_MAX} characters on one line` }]);
      }
      return serial(async () => {
        const { worktree, view } = await inspect(id, worktreeId);
        if (view.blockers.commit.length) throw refuse(view.blockers.commit);
        await git(execFile, worktree.worktreePath, ['add', '--all']);
        try {
          await git(execFile, worktree.worktreePath, ['commit', '--message', message.trim()]);
        } catch (error) {
          throw new TaskError(`Git could not commit: ${firstLine(error.stderr || error.stdout || error.message)}`, 409, undefined, { cause: error });
        }
        return (await inspect(id, worktree.id)).view;
      });
    },

    merge(id, { worktreeId } = {}) {
      return serial(async () => {
        const { task, worktree, checkout, view, ignoredAtRisk } = await inspect(id, worktreeId);
        if (view.blockers.merge.length) throw refuse(view.blockers.merge);
        try {
          await git(execFile, checkout, ['merge', '--no-edit', worktree.branch]);
        } catch (error) {
          const { stdout } = await git(execFile, checkout, ['diff', '--name-only', '--diff-filter=U']);
          const conflicts = stdout.split('\n').map(line => line.trim()).filter(Boolean).slice(0, MAX_LISTED);
          // Leave the checkout exactly as it was; a merge that never started has nothing to abort.
          await git(execFile, checkout, ['merge', '--abort']).catch(() => undefined);
          const message = conflicts.length
            ? `${task.worktrees.length > 1 ? worktree.repository : 'This task'} conflicts with ${worktree.baseBranch} in ${conflicts.length} ${conflicts.length === 1 ? 'file' : 'files'}. Nothing was merged.`
            : `Git could not merge: ${firstLine(error.stderr || error.stdout || error.message)}`;
          throw withExtra(new TaskError(message, 409, undefined, { cause: error }), { conflicts });
        }
        // The work is merged either way; a folder holding ignored files that exist nowhere else is kept and reported.
        const { removed } = ignoredAtRisk
          ? { removed: { ok: false, detail: `The task's folder was kept. ${ignoredAtRisk.message}` } }
          : await removeFiles(worktree, checkout);
        let branchDeleted = false;
        if (removed.ok) {
          try {
            // Asked in the checkout that was merged into: Git deletes a branch only when it is merged into the branch checked out where it is asked.
            await git(execFile, checkout, ['branch', '-d', worktree.branch]);
            branchDeleted = true;
          } catch (error) {
            console.warn(`[tasks] merged branch kept task=${task.id} repository=${worktree.repository}: ${firstLine(error.stderr || error.message)}`);
          }
        }
        // Where the checkout stands now: the merge commit, or the task's last commit when Git fast-forwarded.
        const mergedCommit = (await git(execFile, checkout, ['rev-parse', 'HEAD'])).stdout.trim();
        const after = taskStore.setWorktreeState(task.id, worktree.id, { state: 'merged', mergedCommit });
        // Runs and terminals that worked in what is now gone have nothing left to work in; they are closed with it.
        const finish = await afterFinished(after, worktree);
        return { task: after, repository: worktree.repository, mergedInto: worktree.baseBranch, filesRemoved: removed.ok, filesDetail: removed.ok ? null : removed.detail, branchDeleted, ...finish };
      });
    },

    pullRequest(id, { remote, worktreeId } = {}) {
      if (typeof remote !== 'string' || !REMOTE_NAME.test(remote)) {
        throw new TaskError('One or more fields failed validation.', 400, [{ field: 'remote', message: 'Use the name of one of the project remotes' }]);
      }
      return serial(async () => {
        const { task, worktree, checkout, view } = await inspect(id, worktreeId);
        if (view.blockers.pullRequest.length) throw refuse(view.blockers.pullRequest);
        const chosen = view.remotes.find(candidate => candidate.name === remote);
        if (!chosen) throw new TaskError('One or more fields failed validation.', 400, [{ field: 'remote', message: 'Use the name of one of the project remotes' }]);
        if (chosen.tool === null) throw new TaskError(`CodeDeck can open pull requests on GitHub and GitLab only; ${remote} is on ${chosen.host ?? 'an unknown host'}.`, 409);
        if (worktree.baseBranch === null) throw new TaskError(blockerMessage('no_base_branch', { several: task.worktrees.length > 1, repository: worktree.repository }), 409);
        try {
          await run(execFile, chosen.tool, ['--version'], { timeout: GIT_TIMEOUT_MS });
        } catch (error) {
          throw new TaskError(`Install ${chosen.tool === 'gh' ? 'the GitHub CLI (gh)' : 'the GitLab CLI (glab)'} and sign in to open a pull request from here.`, 409, undefined, { cause: error });
        }
        const { stdout: url } = await git(execFile, checkout, ['config', '--get', `remote.${remote}.url`]);
        const { repository } = describeRemote(url);
        if (!repository) throw new Error('Remote repository could not be read');
        try {
          await git(execFile, worktree.worktreePath, ['push', '--set-upstream', remote, worktree.branch], { timeout: REMOTE_TIMEOUT_MS });
        } catch (error) {
          throw new TaskError(`The branch could not be pushed to ${remote}: ${firstLine(error.stderr || error.message)}`, 503, undefined, { cause: error });
        }
        const args = chosen.tool === 'gh'
          ? ['pr', 'create', '--fill', '--repo', repository, '--head', worktree.branch, '--base', worktree.baseBranch]
          : ['mr', 'create', '--fill', '--yes', '--repo', repository, '--source-branch', worktree.branch, '--target-branch', worktree.baseBranch];
        let output;
        try {
          output = await run(execFile, chosen.tool, args, { cwd: worktree.worktreePath, timeout: REMOTE_TIMEOUT_MS });
        } catch (error) {
          throw new TaskError(`The branch was pushed to ${remote}, but the pull request could not be opened: ${firstLine(error.stderr || error.message)}`, 503, undefined, { cause: error });
        }
        const prUrl = /https?:\/\/[^\s"'<>]+/.exec(`${output.stdout}\n${output.stderr}`)?.[0];
        if (!prUrl) throw new TaskError(`The branch was pushed to ${remote}, but ${chosen.tool} did not report the pull request's address.`, 503);
        return { task: taskStore.setWorktreeState(task.id, worktree.id, { state: 'pr_open', prUrl }), repository: worktree.repository, prUrl, remote };
      });
    },

    /** Closes one repository of the task: its worktree goes, its branch stays. */
    closeWorktree(id, worktreeId, options) {
      const deleteIgnored = requireDeleteIgnored(options);
      return serial(async () => {
        const inspection = await inspect(id, worktreeId);
        const blockers = closeBlockers(inspection.view, deleteIgnored);
        if (blockers.length) throw refuse(blockers);
        const { after, closed, finish } = await closeInspected(inspection);
        return { task: after, ...closed, ...finish };
      });
    },

    /** Closes the task: every repository that is still open, or none of them. */
    close(id, options) {
      const deleteIgnored = requireDeleteIgnored(options);
      return serial(async () => {
        const { task } = await load(id);
        const open = task.worktrees.filter(worktree => OPEN_STATES.includes(worktree.state));
        if (open.length <= 1) {
          // One repository is left, or none: the task is closed with it, or refused as finished.
          const inspection = await inspect(id, open[0]?.id);
          const blockers = closeBlockers(inspection.view, deleteIgnored);
          if (blockers.length) throw refuse(blockers);
          const { after, closed, finish } = await closeInspected(inspection);
          return { task: after, ...closed, repositories: [closed], ...finish };
        }

        // Everything is checked before anything is removed.
        const inspections = [];
        for (const worktree of open) inspections.push(await inspect(id, worktree.id));
        const reasons = [];
        for (const inspection of inspections) {
          for (const blocker of closeBlockers(inspection.view, deleteIgnored)) {
            // A working run blocks the whole task; it is said once.
            if (blocker.code === 'run_active' && reasons.some(reason => reason.code === 'run_active')) continue;
            reasons.push({ ...blocker, repository: inspection.worktree.repository });
          }
        }
        if (reasons.length) throw withExtra(new TaskError(`Nothing was closed. ${reasons[0].message}`, 409), { reasons });

        const repositories = [];
        const terminals = { terminalsClosed: [], terminalsNotClosed: [] };
        let after = task;
        let finish = null;
        for (const inspection of inspections) {
          let outcome;
          try {
            outcome = await closeInspected(inspection);
          } catch (error) {
            if (!(error instanceof TaskError) || repositories.length === 0) throw error;
            throw new TaskError(`${error.message}. Already closed: ${repositories.map(entry => entry.repository).join(', ')}.`, error.status, undefined, { cause: error });
          }
          after = outcome.after;
          finish = outcome.finish;
          repositories.push(outcome.closed);
          terminals.terminalsClosed.push(...finish.terminalsClosed);
          terminals.terminalsNotClosed.push(...finish.terminalsNotClosed);
        }
        return {
          task: after,
          branchKept: repositories[0].branchKept,
          unmergedCommits: repositories.reduce((sum, entry) => sum + entry.unmergedCommits, 0),
          repositories,
          ...finish,
          ...terminals,
        };
      });
    },
  };
}
