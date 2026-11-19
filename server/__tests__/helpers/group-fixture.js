import { afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectRepositories } from '../../project-repositories.js';
import { normalizeProjects } from '../../project-config.js';

const cleanups = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));

export function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function repository(folder) {
  mkdirSync(folder, { recursive: true });
  git(folder, ['init', '-b', 'main']);
  git(folder, ['config', 'user.email', 'repo@test.local']);
  git(folder, ['config', 'user.name', 'Repo Test']);
  writeFileSync(path.join(folder, 'README.md'), `# ${path.basename(folder)}\n`);
  git(folder, ['add', 'README.md']);
  git(folder, ['commit', '-m', 'init']);
  return folder;
}

/**
 * A group folder as the owner keeps them: repositories side by side, a `worktrees` folder
 * holding a worktree of one of them, and a folder that is not a repository.
 */
export function groupFixture({ exec = execFile } = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codedeck-repos-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const group = path.join(base, 'group');
  const backend = repository(path.join(group, 'backend'));
  const mobile = repository(path.join(group, 'mobile-app'));
  const frontend = repository(path.join(group, 'frontend'));
  git(frontend, ['checkout', '-q', '-b', 'feat/setup']);
  const frontendMain = path.join(group, 'worktrees', 'frontend-main');
  mkdirSync(path.dirname(frontendMain), { recursive: true });
  git(frontend, ['worktree', 'add', '-q', frontendMain, 'main']);
  const notes = path.join(group, 'notes');
  mkdirSync(notes);
  repository(path.join(group, '.hidden'));
  const tools = repository(path.join(base, 'elsewhere', 'tools'));
  const otherBackend = repository(path.join(base, 'elsewhere', 'backend'));

  let projects = [
    { name: 'Demo', path: backend },
    { name: 'Remote', path: '/srv/app', host: 'devbox' },
    { name: 'Plain', path: notes },
  ];
  const starts = [];
  const service = createProjectRepositories({
    loadProjects: () => normalizeProjects(projects),
    saveProjects: next => { projects = next; },
    execFile: exec,
    // Stands in for the terminal runtime: records what was asked and hands out the next session id.
    startSession: async (project, options) => {
      starts.push([project, options]);
      return { id: `${project}-${starts.length}` };
    },
  });
  return {
    base, group, backend, mobile, frontend, frontendMain, notes, tools, otherBackend, service,
    stored: () => projects,
    starts,
    setProjects: next => { projects = next; },
    // A project as the rest of the backend is given it: with every field a stored project has.
    findProject: name => normalizeProjects(projects).find(project => project.name === name) ?? null,
  };
}
