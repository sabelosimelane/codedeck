/**
 * Landing a task: how its work gets back into the project. Everything here is read live
 * from Git or done only on the owner's request. Nothing is forced: a worktree with
 * uncommitted work is never removed, a conflicting merge is aborted and reported, and a
 * branch is deleted only once Git agrees it is merged.
 */

import path from 'node:path';
import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { listDirtyPaths, remove as removeWorktree, resolveHomeRepoPath } from '../pipelines/run-worktree.js';
import { TaskError } from './task-service.js';

const GIT_TIMEOUT_MS = 30_000;
// Pushing and opening a pull request talk to a remote host; they get a longer, explicit limit.
const REMOTE_TIMEOUT_MS = 90_000;
const MAX_LISTED = 50;
const OPEN_STATES = ['active', 'pr_open'];
const MESSAGE_MAX = 200;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const BLOCKERS = {
  finished: 'This task is finished.',
  files_missing: "This task's files are no longer on disk.",
  run_active: 'A workflow run is still working in this task. Stop it or let it finish first.',
  uncommitted: 'This task has uncommitted changes. Commit them first.',
  nothing_to_land: 'This task has no commits of its own yet.',
  no_base_branch: 'This task was started from a commit, not a branch, so there is no branch to merge it into.',
  main_not_on_base: null, // message names the branches
  main_dirty: 'Main has uncommitted changes. Commit or stash them before merging.',
  no_remote: 'This project has no remote to push to.',
  no_pr_tool: null, // message names the tool
};

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
const firstLine = text => String(text ?? '').trim().split('\n')[0].slice(0, 300);

/** Which hosting CLI opens a pull request for a remote URL, and the repository it names. */
export function describeRemote(url) {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:\s]+)[:/](.+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  if (!match) return { host: null, repository: null, tool: null };
  const host = match[1].toLowerCase();
  const repository = match[2].replace(/^\d+\//, '');
  return { host, repository, tool: host === 'github.com' || host.endsWith('.github.com') ? 'gh' : host.includes('gitlab') ? 'glab' : null };
}

export function createTaskLanding({ taskStore, findProject, execFile, pathExists, hasActiveRun, onTaskFinished } = {}) {
  if (typeof taskStore?.get !== 'function' || typeof taskStore?.setState !== 'function') throw new TypeError('taskStore is required');
  for (const [name, value] of Object.entries({ findProject, execFile, pathExists, hasActiveRun, onTaskFinished })) {
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

  async function remotes(projectPath) {
    const { stdout } = await git(execFile, projectPath, ['remote']);
    const names = stdout.split('\n').map(name => name.trim()).filter(name => REMOTE_NAME.test(name));
    return Promise.all(names.map(async name => {
      // The configured address names the host; `remote get-url` would apply the owner's URL rewrites.
      const { stdout: url } = await git(execFile, projectPath, ['config', '--get', `remote.${name}.url`]);
      const { host, tool } = describeRemote(url);
      return { name, host, tool };
    }));
  }

  /** Everything the owner needs to decide how to land the task, read from Git now. */
  async function inspect(id) {
    const { task, project } = await load(id);
    const open = OPEN_STATES.includes(task.state);
    const present = open && await pathExists(task.worktreePath);
    if (typeof present !== 'boolean') throw new Error('pathExists must return a boolean');
    const active = open && hasActiveRun(task.id) === true;

    let uncommitted = [];
    let ahead = null;
    let behind = null;
    if (present) {
      uncommitted = await listDirtyPaths({ worktreePath: task.worktreePath, execFile });
      const base = task.baseBranch ?? task.baseCommit;
      const { stdout } = await git(execFile, task.worktreePath, ['rev-list', '--left-right', '--count', `${base}...HEAD`]);
      const counts = stdout.trim().split(/\s+/).map(Number);
      if (counts.length !== 2 || counts.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('git rev-list returned unexpected counts');
      [behind, ahead] = counts;
    }

    const { stdout: branchRaw } = await git(execFile, project.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const mainBranch = branchRaw.trim() === 'HEAD' ? null : branchRaw.trim();
    const mainDirty = (await listDirtyPaths({ worktreePath: project.path, execFile })).length > 0;
    const remoteList = await remotes(project.path);

    const common = [];
    if (!open) common.push('finished');
    else if (!present) common.push('files_missing');
    if (active) common.push('run_active');
    const withWork = [...common];
    if (present && uncommitted.length > 0) withWork.push('uncommitted');
    if (present && ahead === 0) withWork.push('nothing_to_land');

    const merge = [...withWork];
    if (open && task.baseBranch === null) merge.push('no_base_branch');
    else if (open && mainBranch !== task.baseBranch) merge.push('main_not_on_base');
    if (open && mainDirty) merge.push('main_dirty');

    const describe = code => ({
      code,
      message: code === 'main_not_on_base'
        ? `Main is on ${mainBranch ?? 'no branch'}, but this task was started from ${task.baseBranch}. Switch Main to ${task.baseBranch} to merge.`
        : BLOCKERS[code],
    });
    const pullRequest = [...withWork];
    if (remoteList.length === 0) pullRequest.push('no_remote');

    // A task whose files are already gone can still be closed; there is nothing left to lose.
    const close = common.filter(code => code !== 'files_missing');
    if (present && uncommitted.length > 0) close.push('uncommitted');

    return {
      task,
      project,
      view: {
        taskId: task.id,
        state: task.state,
        branch: task.branch,
        baseBranch: task.baseBranch,
        prUrl: task.prUrl,
        filesPresent: present,
        runActive: active,
        uncommitted: uncommitted.slice(0, MAX_LISTED),
        uncommittedCount: uncommitted.length,
        commitsAhead: ahead,
        commitsBehind: behind,
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
  const refuse = blockers => withExtra(new TaskError(blockers[0].message, 409), { reasons: blockers });

  async function finishWorktree(task, project) {
    const home = await resolveHomeRepoPath({ projectPath: project.path, execFile });
    const removed = await removeWorktree({ homePath: home, worktreePath: task.worktreePath, execFile });
    return { home, removed };
  }

  // Git refuses two operations at once in one repository; landing actions run one at a time.
  let queue = Promise.resolve();
  const serial = action => {
    const result = queue.then(action);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    async status(id) {
      return (await inspect(id)).view;
    },

    commit(id, { message } = {}) {
      if (typeof message !== 'string' || message.trim().length < 1 || message.trim().length > MESSAGE_MAX || /[\x00-\x1f\x7f]/.test(message)) {
        throw new TaskError('One or more fields failed validation.', 400, [{ field: 'message', message: `Use 1–${MESSAGE_MAX} characters on one line` }]);
      }
      return serial(async () => {
        const { task, view } = await inspect(id);
        if (view.blockers.commit.length) throw refuse(view.blockers.commit);
        await git(execFile, task.worktreePath, ['add', '--all']);
        try {
          await git(execFile, task.worktreePath, ['commit', '--message', message.trim()]);
        } catch (error) {
          throw new TaskError(`Git could not commit: ${firstLine(error.stderr || error.stdout || error.message)}`, 409, undefined, { cause: error });
        }
        return (await inspect(id)).view;
      });
    },

    merge(id) {
      return serial(async () => {
        const { task, project, view } = await inspect(id);
        if (view.blockers.merge.length) throw refuse(view.blockers.merge);
        try {
          await git(execFile, project.path, ['merge', '--no-edit', task.branch]);
        } catch (error) {
          const { stdout } = await git(execFile, project.path, ['diff', '--name-only', '--diff-filter=U']);
          const conflicts = stdout.split('\n').map(line => line.trim()).filter(Boolean).slice(0, MAX_LISTED);
          // Leave Main exactly as it was; a merge that never started has nothing to abort.
          await git(execFile, project.path, ['merge', '--abort']).catch(() => undefined);
          const message = conflicts.length
            ? `This task conflicts with ${task.baseBranch} in ${conflicts.length} ${conflicts.length === 1 ? 'file' : 'files'}. Nothing was merged.`
            : `Git could not merge: ${firstLine(error.stderr || error.stdout || error.message)}`;
          throw withExtra(new TaskError(message, 409, undefined, { cause: error }), { conflicts });
        }
        const { home, removed } = await finishWorktree(task, project);
        let branchDeleted = false;
        if (removed.ok) {
          try {
            await git(execFile, home, ['branch', '-d', task.branch]);
            branchDeleted = true;
          } catch (error) {
            console.warn(`[tasks] merged branch kept task=${task.id}: ${firstLine(error.stderr || error.message)}`);
          }
        }
        const finished = taskStore.setState(task.id, { state: 'merged' });
        // Runs that worked in the task have nothing left to work in; they are closed with it.
        onTaskFinished(finished);
        return { task: finished, mergedInto: task.baseBranch, filesRemoved: removed.ok, filesDetail: removed.ok ? null : removed.detail, branchDeleted };
      });
    },

    pullRequest(id, { remote } = {}) {
      if (typeof remote !== 'string' || !REMOTE_NAME.test(remote)) {
        throw new TaskError('One or more fields failed validation.', 400, [{ field: 'remote', message: 'Use the name of one of the project remotes' }]);
      }
      return serial(async () => {
        const { task, project, view } = await inspect(id);
        if (view.blockers.pullRequest.length) throw refuse(view.blockers.pullRequest);
        const chosen = view.remotes.find(candidate => candidate.name === remote);
        if (!chosen) throw new TaskError('One or more fields failed validation.', 400, [{ field: 'remote', message: 'Use the name of one of the project remotes' }]);
        if (chosen.tool === null) throw new TaskError(`CodeDeck can open pull requests on GitHub and GitLab only; ${remote} is on ${chosen.host ?? 'an unknown host'}.`, 409);
        if (task.baseBranch === null) throw new TaskError(BLOCKERS.no_base_branch, 409);
        try {
          await run(execFile, chosen.tool, ['--version'], { timeout: GIT_TIMEOUT_MS });
        } catch (error) {
          throw new TaskError(`Install ${chosen.tool === 'gh' ? 'the GitHub CLI (gh)' : 'the GitLab CLI (glab)'} and sign in to open a pull request from here.`, 409, undefined, { cause: error });
        }
        const { stdout: url } = await git(execFile, project.path, ['config', '--get', `remote.${remote}.url`]);
        const { repository } = describeRemote(url);
        if (!repository) throw new Error('Remote repository could not be read');
        try {
          await git(execFile, task.worktreePath, ['push', '--set-upstream', remote, task.branch], { timeout: REMOTE_TIMEOUT_MS });
        } catch (error) {
          throw new TaskError(`The branch could not be pushed to ${remote}: ${firstLine(error.stderr || error.message)}`, 503, undefined, { cause: error });
        }
        const args = chosen.tool === 'gh'
          ? ['pr', 'create', '--fill', '--repo', repository, '--head', task.branch, '--base', task.baseBranch]
          : ['mr', 'create', '--fill', '--yes', '--repo', repository, '--source-branch', task.branch, '--target-branch', task.baseBranch];
        let output;
        try {
          output = await run(execFile, chosen.tool, args, { cwd: task.worktreePath, timeout: REMOTE_TIMEOUT_MS });
        } catch (error) {
          throw new TaskError(`The branch was pushed to ${remote}, but the pull request could not be opened: ${firstLine(error.stderr || error.message)}`, 503, undefined, { cause: error });
        }
        const prUrl = /https?:\/\/[^\s"'<>]+/.exec(`${output.stdout}\n${output.stderr}`)?.[0];
        if (!prUrl) throw new TaskError(`The branch was pushed to ${remote}, but ${chosen.tool} did not report the pull request's address.`, 503);
        return { task: taskStore.setState(task.id, { state: 'pr_open', prUrl }), prUrl, remote };
      });
    },

    close(id) {
      return serial(async () => {
        const { task, project, view } = await inspect(id);
        if (view.blockers.close.length) throw refuse(view.blockers.close);
        if (view.filesPresent) {
          const { removed } = await finishWorktree(task, project);
          if (!removed.ok) throw new TaskError(`The task's files could not be removed: ${firstLine(removed.detail)}`, 409);
        }
        // The branch stays: it may hold commits that are not merged anywhere.
        const finished = taskStore.setState(task.id, { state: 'closed' });
        onTaskFinished(finished);
        return { task: finished, branchKept: task.branch, unmergedCommits: view.commitsAhead ?? 0 };
      });
    },
  };
}
