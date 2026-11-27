import { describe, expect, it, vi } from 'vitest';
import { execFile as cbExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  normalizeProject,
  upsertProjectLocation,
  upsertManifestRepo,
  removeManifestRepo,
} from '../project-config.js';
import { createProjectRepositories } from '../project-repositories.js';
import { createTaskService } from '../tasks/task-service.js';
import { syncProjectLocation } from '../git-sync-service.js';
import { createProjectsRouter } from '../routes/projects.js';

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    cbExecFile('git', args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function initRepo(dir, { remoteUrl = null } = {}) {
  await fs.promises.mkdir(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await fs.promises.writeFile(path.join(dir, 'README.md'), '# repo\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  if (remoteUrl) {
    await git(dir, ['remote', 'add', 'origin', remoteUrl]);
  }
}

describe('Phase 2: project-config repoManifest & workspaceMode', () => {
  it('defaults workspaceMode to repo and repoManifest to []', () => {
    const p = normalizeProject({ name: 'codedeck', path: '/local/codedeck' });
    expect(p.workspaceMode).toBe('repo');
    expect(p.repoManifest).toEqual([]);
  });

  it('normalizes workspaceMode=folder and deduplicates repoManifest while syncing primary gitUrl', () => {
    const p = normalizeProject({
      name: 'acme',
      path: '/local/acme',
      workspaceMode: 'folder',
      repoManifest: [
        { name: 'backend', gitUrl: 'git@github.com:org/backend.git', primary: true },
        { name: 'frontend', gitUrl: 'git@github.com:org/frontend.git' },
        { name: 'backend', gitUrl: 'git@github.com:org/dup.git' },
      ],
    });
    expect(p.workspaceMode).toBe('folder');
    expect(p.repoManifest).toEqual([
      { name: 'backend', gitUrl: 'git@github.com:org/backend.git', primary: true },
      { name: 'frontend', gitUrl: 'git@github.com:org/frontend.git', primary: false },
    ]);
    expect(p.gitUrl).toBe('git@github.com:org/backend.git');
  });

  it('upserts and removes manifest entries via helpers', () => {
    let p = normalizeProject({ name: 'acme', path: '/local/acme/backend' });
    p = upsertManifestRepo(p, { name: 'backend', gitUrl: 'git@github.com:org/backend.git', primary: true });
    p = upsertManifestRepo(p, { name: 'frontend', gitUrl: 'git@github.com:org/frontend.git' });
    expect(p.repoManifest).toHaveLength(2);
    p = upsertManifestRepo(p, { name: 'frontend', gitUrl: 'https://github.com/org/frontend.git' });
    expect(p.repoManifest.find(r => r.name === 'frontend')?.gitUrl).toBe('https://github.com/org/frontend.git');
    p = removeManifestRepo(p, 'frontend');
    expect(p.repoManifest.map(r => r.name)).toEqual(['backend']);
  });
});

describe('Phase 2: project-repositories workspace folder mode & auto-detect origin', () => {
  it('lists child repos, discovers unlinked children, and records origin in repoManifest for workspaceMode=folder', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codedeck-ws-'));
    try {
      const wsDir = path.join(tmp, 'acme');
      const backendDir = path.join(wsDir, 'backend');
      const frontendDir = path.join(wsDir, 'frontend');
      const mcpDir = path.join(wsDir, 'mcp');
      await initRepo(backendDir, { remoteUrl: 'git@github.com:org/acme-backend.git' });
      await initRepo(frontendDir, { remoteUrl: 'git@github.com:org/acme-frontend.git' });
      await initRepo(mcpDir, { remoteUrl: 'git@github.com:org/acme-mcp.git' });

      const realWs = await fs.promises.realpath(wsDir);
      const realBackend = await fs.promises.realpath(backendDir);
      const realFrontend = await fs.promises.realpath(frontendDir);
      const realMcp = await fs.promises.realpath(mcpDir);

      let stored = [normalizeProject({
        name: 'acme',
        path: realWs,
        workspaceMode: 'folder',
        locations: [{
          host: 'local',
          path: realWs,
          repositories: [{ name: 'backend', path: realBackend }],
        }],
        repoManifest: [{ name: 'backend', gitUrl: 'git@github.com:org/acme-backend.git', primary: true }],
      })];

      const svc = createProjectRepositories({
        loadProjects: () => stored,
        saveProjects: next => { stored = next; },
        execFile: cbExecFile,
        startSession: vi.fn(async () => ({ id: 'acme-1' })),
      });

      const listed = await svc.list('acme');
      expect(listed.map(r => r.name)).toEqual(['backend']);
      expect(listed[0].usable).toBe(true);

      const candidates = await svc.candidates('acme');
      expect(candidates.map(c => c.name)).toEqual(['frontend', 'mcp']);

      await svc.add('acme', { path: realFrontend });
      expect(stored[0].repoManifest).toContainEqual({
        name: 'frontend',
        gitUrl: 'git@github.com:org/acme-frontend.git',
        primary: false,
      });

      await svc.add('acme', { path: realMcp });
      expect(stored[0].locations[0].repositories.map(r => r.name)).toEqual(['backend', 'frontend', 'mcp']);

      await svc.remove('acme', 'mcp');
      expect(stored[0].repoManifest.map(r => r.name)).toEqual(['backend', 'frontend']);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('auto-detects origin into repoManifest when adding a related repo to a primary-repo project', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codedeck-primary-'));
    try {
      const wsDir = path.join(tmp, 'acme');
      const backendDir = path.join(wsDir, 'backend');
      const mobileDir = path.join(wsDir, 'mobile-app');
      await initRepo(backendDir, { remoteUrl: 'git@github.com:org/backend.git' });
      await initRepo(mobileDir, { remoteUrl: 'git@github.com:org/mobile-app.git' });

      const realBackend = await fs.promises.realpath(backendDir);
      const realMobile = await fs.promises.realpath(mobileDir);

      let stored = [normalizeProject({
        name: 'acme',
        path: realBackend,
        gitUrl: 'git@github.com:org/backend.git',
      })];

      const svc = createProjectRepositories({
        loadProjects: () => stored,
        saveProjects: next => { stored = next; },
        execFile: cbExecFile,
        startSession: vi.fn(async () => ({ id: 'acme-1' })),
      });

      await svc.add('acme', { path: realMobile });
      expect(stored[0].repoManifest).toContainEqual({
        name: 'mobile-app',
        gitUrl: 'git@github.com:org/mobile-app.git',
        primary: false,
      });
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('Phase 2: task-service supports workspaceMode=folder projects', () => {
  it('plans a multi-repo task for a workspace-folder project without requiring location.path to be a git repo', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codedeck-task-ws-'));
    try {
      const wsDir = path.join(tmp, 'acme');
      const backendDir = path.join(wsDir, 'backend');
      const frontendDir = path.join(wsDir, 'frontend');
      await initRepo(backendDir);
      await initRepo(frontendDir);

      const realWs = await fs.promises.realpath(wsDir);
      const realBackend = await fs.promises.realpath(backendDir);
      const realFrontend = await fs.promises.realpath(frontendDir);

      const project = normalizeProject({
        name: 'acme',
        path: realWs,
        workspaceMode: 'folder',
        locations: [{
          host: 'local',
          path: realWs,
          repositories: [
            { name: 'backend', path: realBackend },
            { name: 'frontend', path: realFrontend },
          ],
        }],
      });

      const taskSvc = createTaskService({
        taskStore: { create: vi.fn(), remove: vi.fn(), addWorktree: vi.fn(), removeWorktree: vi.fn() },
        findProject: () => project,
        execFile: cbExecFile,
        startSession: vi.fn(),
        pathExists: p => fs.existsSync(p),
        realpath: p => fs.promises.realpath(p),
        newId: () => '11111111-1111-4111-8111-111111111111',
        isRunWorking: () => false,
      });

      const planned = await taskSvc.plan({
        project: 'acme',
        title: 'Add login',
        titleSource: 'owner',
        repositories: ['backend', 'frontend'],
      });
      expect(planned.worktrees.map(w => w.repository)).toEqual(['backend', 'frontend']);
      expect(planned.folder).toBeTruthy();
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('Phase 3: git-sync-service syncs all repositories of a project location', () => {
  it('syncs primary + related repositories when repoPaths is omitted', async () => {
    const calls = [];
    const fakeExec = vi.fn((_cmd, args, _opts, cb) => {
      const repoPath = args[1];
      const gitCmd = args.slice(2).join(' ');
      calls.push({ repoPath, gitCmd });
      if (gitCmd === 'rev-parse --is-inside-work-tree') return cb(null, 'true\n', '');
      if (gitCmd === 'status --porcelain') return cb(null, '', '');
      if (gitCmd === 'rev-parse --abbrev-ref HEAD') return cb(null, 'main\n', '');
      if (gitCmd === 'rev-parse HEAD') return cb(null, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', '');
      if (gitCmd.startsWith('rev-parse --abbrev-ref --symbolic-full-name')) return cb(null, 'origin/main\n', '');
      if (gitCmd === 'pull --ff-only') return cb(null, 'Already up to date.\n', '');
      return cb(null, '', '');
    });

    const project = normalizeProject({
      name: 'acme',
      path: '/local/acme/backend',
      locations: [{
        host: 'local',
        path: '/local/acme/backend',
        repositories: [
          { name: 'frontend', path: '/local/acme/frontend' },
          { name: 'mobile-app', path: '/local/acme/mobile-app' },
        ],
      }],
    });

    const outcome = await syncProjectLocation({ project, host: 'local', execFile: fakeExec });
    expect(outcome.ok).toBe(true);
    expect(outcome.results.map(r => r.repository)).toEqual(['backend', 'frontend', 'mobile-app']);
  });
});

describe('git-sync-service says why a sync was blocked', () => {
  it('names each blocked repository with its reason and path, not only that it failed', async () => {
    const fakeExec = vi.fn((_cmd, args, _opts, cb) => {
      const repoPath = args[1];
      const gitCmd = args.slice(2).join(' ');
      if (gitCmd === 'rev-parse --is-inside-work-tree') return cb(null, 'true\n', '');
      if (gitCmd === 'status --porcelain') return cb(null, repoPath.endsWith('frontend') ? '?? src/\n' : '', '');
      if (gitCmd === 'rev-parse --abbrev-ref HEAD') return cb(null, 'main\n', '');
      if (gitCmd === 'rev-parse HEAD') return cb(null, 'a'.repeat(40) + '\n', '');
      if (gitCmd.startsWith('rev-parse --abbrev-ref --symbolic-full-name')) return cb(null, 'origin/main\n', '');
      if (gitCmd === 'pull --ff-only') return cb(null, 'Already up to date.\n', '');
      return cb(null, '', '');
    });
    const project = normalizeProject({
      name: 'acme', path: '/local/acme/backend',
      locations: [{ host: 'local', path: '/local/acme/backend', repositories: [{ name: 'frontend', path: '/local/acme/frontend' }] }],
    });
    const outcome = await syncProjectLocation({ project, host: 'local', execFile: fakeExec });
    expect(outcome).toMatchObject({ ok: false, status: 409, code: 'sync_blocked' });
    expect(outcome.message).toBe('Could not sync frontend on local: Working tree has uncommitted changes (/local/acme/frontend).');
  });
});

describe('Phase 3: projects API multi-repo routes', () => {
  function buildApp({ initialProjects = [], hosts = [], detectOrigin, cloneRepo } = {}) {
    let projects = [...initialProjects];
    const app = express();
    app.use(express.json());
    app.use(createProjectsRouter({
      loadProjects: () => projects,
      saveProjects: next => { projects = next; },
      loadHosts: () => hosts,
      localPathExists: p => fs.existsSync(p),
      createRunner: () => ({ kind: 'local', run: vi.fn(async () => ({ stdout: '', stderr: '' })) }),
      getReachability: () => ({ reachability: 'reachable' }),
      deleteProject: vi.fn(async () => ({ ok: true })),
      detectOrigin,
      cloneRepo,
    }));
    return { app, getProjects: () => projects };
  }

  it('POST /api/projects auto-discovers child git repos when pointed at a parent workspace folder', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codedeck-create-ws-'));
    try {
      const wsDir = path.join(tmp, 'acme');
      await initRepo(path.join(wsDir, 'backend'), { remoteUrl: 'git@github.com:org/backend.git' });
      await initRepo(path.join(wsDir, 'frontend'), { remoteUrl: 'git@github.com:org/frontend.git' });

      const { app } = buildApp();
      const res = await request(app).post('/api/projects').send({ name: 'acme', path: wsDir });
      expect(res.status).toBe(201);
      expect(res.body.workspaceMode).toBe('folder');
      expect(res.body.locations[0].repositories.map(r => r.name)).toEqual(['backend', 'frontend']);
      expect(res.body.repoManifest).toEqual([
        { name: 'backend', gitUrl: 'git@github.com:org/backend.git', primary: true },
        { name: 'frontend', gitUrl: 'git@github.com:org/frontend.git', primary: false },
      ]);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('POST /api/projects/:name/discover-remotes backfills repoManifest for existing projects', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codedeck-discover-'));
    try {
      const wsDir = path.join(tmp, 'acme');
      const backendDir = path.join(wsDir, 'backend');
      const frontendDir = path.join(wsDir, 'frontend');
      await initRepo(backendDir, { remoteUrl: 'git@github.com:org/backend.git' });
      await initRepo(frontendDir, { remoteUrl: 'git@github.com:org/frontend.git' });

      const existing = normalizeProject({
        name: 'acme',
        path: backendDir,
        locations: [{
          host: 'local',
          path: backendDir,
          repositories: [{ name: 'frontend', path: frontendDir }],
        }],
      });

      const { app } = buildApp({ initialProjects: [existing] });
      const res = await request(app).post('/api/projects/acme/discover-remotes');
      expect(res.status).toBe(200);
      expect(res.body.repoManifest).toEqual([
        { name: 'backend', gitUrl: 'git@github.com:org/backend.git', primary: true },
        { name: 'frontend', gitUrl: 'git@github.com:org/frontend.git', primary: false },
      ]);
      expect(res.body.gitUrl).toBe('git@github.com:org/backend.git');
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('POST /api/projects/:name/locations/clone clones selected multi-repo manifest entries into <defaultRoot>/<projectName>/<repo>', async () => {
    const cloned = [];
    const cloneRepo = vi.fn(async ({ gitUrl, targetPath }) => {
      cloned.push({ gitUrl, targetPath });
      return { path: targetPath, gitUrl };
    });

    const existing = normalizeProject({
      name: 'acme',
      path: '/local/acme/backend',
      gitUrl: 'git@github.com:org/backend.git',
      locations: [{
        host: 'local',
        path: '/local/acme/backend',
        repositories: [
          { name: 'frontend', path: '/local/acme/frontend' },
          { name: 'local-only', path: '/local/acme/local-only' },
        ],
      }],
      repoManifest: [
        { name: 'backend', gitUrl: 'git@github.com:org/backend.git', primary: true },
        { name: 'frontend', gitUrl: 'git@github.com:org/frontend.git', primary: false },
        { name: 'local-only', gitUrl: null, primary: false },
      ],
    });

    const { app } = buildApp({
      initialProjects: [existing],
      hosts: [{ name: 'media-server', sshTarget: 'media-server', defaultRoot: '/srv/git' }],
      cloneRepo,
    });

    const res = await request(app)
      .post('/api/projects/acme/locations/clone')
      .send({ host: 'media-server' });

    expect(res.status).toBe(201);
    expect(cloned).toEqual([
      { gitUrl: 'git@github.com:org/backend.git', targetPath: '/srv/git/acme/backend' },
      { gitUrl: 'git@github.com:org/frontend.git', targetPath: '/srv/git/acme/frontend' },
    ]);
    const remoteLoc = res.body.locations.find(l => l.host === 'media-server');
    expect(remoteLoc).toMatchObject({
      host: 'media-server',
      path: '/srv/git/acme/backend',
      repositories: [{ name: 'frontend', path: '/srv/git/acme/frontend' }],
    });
    expect(res.body.cloneSummary).toEqual({
      cloned: ['backend', 'frontend'],
      skipped: [{ name: 'local-only', reason: 'no_remote' }],
    });
  });

  it('POST /api/projects/:name/locations/:host/clone-missing clones only missing repos onto an already-bound host', async () => {
    const cloned = [];
    const cloneRepo = vi.fn(async ({ gitUrl, targetPath }) => {
      cloned.push({ gitUrl, targetPath });
      return { path: targetPath, gitUrl };
    });

    let existing = normalizeProject({
      name: 'acme',
      path: '/local/acme/backend',
      gitUrl: 'git@github.com:org/backend.git',
      locations: [{
        host: 'local',
        path: '/local/acme/backend',
        repositories: [
          { name: 'frontend', path: '/local/acme/frontend' },
          { name: 'mcp', path: '/local/acme/mcp' },
        ],
      }],
      repoManifest: [
        { name: 'backend', gitUrl: 'git@github.com:org/backend.git', primary: true },
        { name: 'frontend', gitUrl: 'git@github.com:org/frontend.git', primary: false },
        { name: 'mcp', gitUrl: 'git@github.com:org/mcp.git', primary: false },
      ],
    });
    existing = upsertProjectLocation(existing, {
      host: 'media-server',
      path: '/srv/git/acme/backend',
      repositories: [{ name: 'frontend', path: '/srv/git/acme/frontend' }],
    });

    const { app } = buildApp({
      initialProjects: [existing],
      hosts: [{ name: 'media-server', sshTarget: 'media-server', defaultRoot: '/srv/git' }],
      cloneRepo,
    });

    const res = await request(app)
      .post('/api/projects/acme/locations/media-server/clone-missing')
      .send({});

    expect(res.status).toBe(200);
    expect(cloned).toEqual([
      { gitUrl: 'git@github.com:org/mcp.git', targetPath: '/srv/git/acme/mcp' },
    ]);
    const remoteLoc = res.body.locations.find(l => l.host === 'media-server');
    expect(remoteLoc.repositories.map(r => r.name)).toEqual(['frontend', 'mcp']);
  });
});
