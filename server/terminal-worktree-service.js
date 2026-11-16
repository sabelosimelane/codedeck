import path from 'node:path';
import { create, preflight, resolveHomeRepoPath } from './pipelines/run-worktree.js';

export class TerminalWorktreeError extends Error {
  constructor(message, status, errors, options) {
    super(message, options);
    this.status = status;
    this.errors = errors;
  }
}

const invalidBranch = message => new TerminalWorktreeError('One or more fields failed validation.', 400, [{ field: 'branch', message }]);

export function validateBranchSyntax(branch) {
  if (typeof branch !== 'string' || branch.length < 1 || branch.length > 100 || branch.startsWith('-') || /[\s\x00-\x1f\x7f<>]/.test(branch)) {
    throw invalidBranch('Branch must be a string of 1 to 100 characters with no leading dash, whitespace, control characters, <, or >');
  }
}

function git(execFile, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: 30_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

function exitCode(error) {
  return typeof error?.code === 'number' ? error.code : null;
}

export function createTerminalWorktreeService({ findProject, execFile, startSession, pathExists, realpath } = {}) {
  for (const [name, value] of Object.entries({ findProject, execFile, startSession, pathExists })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (realpath !== undefined && typeof realpath !== 'function') throw new TypeError('realpath must be a function');

  async function openNow({ project: projectName, branch } = {}) {
    if (typeof projectName !== 'string' || projectName.length === 0) {
      throw new TerminalWorktreeError('One or more fields failed validation.', 400, [{ field: 'project', message: 'A project name is required' }]);
    }
    validateBranchSyntax(branch);
    const project = await findProject(projectName);
    if (project === null || project === undefined) throw new TerminalWorktreeError('Project not found', 404);
    if (typeof project.name !== 'string' || project.name.length === 0) throw new Error('Stored project name is invalid');
    if (typeof project.path !== 'string' || !path.isAbsolute(project.path)) throw new Error('Stored project path is invalid');
    if (project.host !== undefined && project.host !== null && typeof project.host !== 'string') throw new Error('Stored project host is invalid');
    if (project.host && project.host !== 'local') throw new TerminalWorktreeError('Worktree terminals are only available for local projects.', 409);

    const eligibility = await preflight({ projectPath: project.path, projectHost: project.host, setupAgentId: undefined, execFile, realpath });
    if (!Array.isArray(eligibility.reasons)) throw new Error('Git preflight reasons are invalid');
    for (const reason of eligibility.reasons) {
      if (typeof reason?.code !== 'string' || typeof reason?.message !== 'string') throw new Error('Git preflight reason is invalid');
      if (reason.code !== 'setup_agent_missing') throw new TerminalWorktreeError(reason.message, 409);
    }

    try {
      await git(execFile, ['check-ref-format', `refs/heads/${branch}`]);
    } catch (error) {
      if (exitCode(error) === 1) throw invalidBranch('Use a valid Git branch name');
      throw error;
    }
    const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (!slug) throw invalidBranch('Branch name must contain a letter or number for its directory name');

    const home = await resolveHomeRepoPath({ projectPath: project.path, execFile });
    if (typeof home !== 'string' || !path.isAbsolute(home) || home === path.parse(home).root) throw new Error('Git home repository path is invalid');
    const worktreePath = path.join(path.dirname(home), 'worktrees', `${path.basename(home)}-${slug}`);
    try {
      await git(execFile, ['-C', home, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      throw new TerminalWorktreeError(`Branch ${branch} already exists.`, 409);
    } catch (error) {
      if (error instanceof TerminalWorktreeError) throw error;
      if (exitCode(error) !== 1) throw error;
    }
    const exists = await pathExists(worktreePath);
    if (typeof exists !== 'boolean') throw new Error('pathExists must return a boolean');
    if (exists) throw new TerminalWorktreeError(`A directory already exists at ${worktreePath}.`, 409);

    const created = await create({ homePath: home, worktreePath, branch, projectPath: project.path, execFile });
    if (typeof created?.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(created.baseCommit)) throw new Error('Git base commit is invalid');
    let started;
    try {
      started = await startSession(project.name, { cwd: worktreePath });
      if (typeof started?.id !== 'string' || started.id.length === 0) throw new Error('Terminal session ID is invalid');
    } catch (error) {
      throw new TerminalWorktreeError(`The worktree was created at ${worktreePath} on branch ${branch}, but its terminal could not be opened.`, error?.status === 503 ? 503 : 500, undefined, { cause: error });
    }
    return { sessionId: started.id, project: project.name, branch, worktreePath, baseCommit: created.baseCommit };
  }

  let queue = Promise.resolve();
  return {
    open(input) {
      const run = queue.then(() => openNow(input));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
