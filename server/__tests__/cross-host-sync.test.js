import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import {
  normalizeProject,
  getProjectLocation,
  listProjectHosts,
  upsertProjectLocation,
  removeProjectLocation,
} from '../project-config.js';
import { addHost, updateHost, deleteHost, rewriteProjectHost } from '../host-service.js';
import { createTerminalSessionHostStore } from '../terminal-session-host-store.js';
import { createHostRuntimeResolver } from '../host-runtime-resolver.js';
import { createHostExecFile } from '../host-exec.js';
import { createHostFs } from '../host-fs.js';
import {
  syncCheckout,
  syncProjectLocation,
  cloneToHost,
  isValidGitUrl,
  repoFolderNameFromGitUrl,
} from '../git-sync-service.js';
import { createProjectsRouter } from '../routes/projects.js';
import { createProjectDeletionService } from '../project-deletion-service.js';
import { attachBackgroundSessionAsync, backgroundSessionAvailableAsync } from '../ws-handler.js';
import { createTaskLanding } from '../tasks/task-landing.js';
import { createTaskStore } from '../tasks/task-store.js';
import { loopbackTestServer } from './helpers/loopback-test-server.js';

describe('cross-host project-config', () => {
  it('normalizes legacy single-host projects into locations[]', () => {
    const localProj = normalizeProject({ name: 'app', path: '/local/app' });
    expect(localProj.defaultHost).toBe('local');
    expect(localProj.autoSync).toBe(true);
    expect(localProj.gitUrl).toBeNull();
    expect(localProj.locations).toEqual([{ host: 'local', path: '/local/app', repositories: [] }]);
    expect(localProj).not.toHaveProperty('host');

    const remoteProj = normalizeProject({ name: 'srv', path: '/srv/app', host: 'devbox' });
    expect(remoteProj.defaultHost).toBe('devbox');
    expect(remoteProj.host).toBe('devbox');
    expect(remoteProj.locations).toEqual([{ host: 'devbox', path: '/srv/app', repositories: [] }]);
  });

  it('supports adding, querying, and removing multiple host locations', () => {
    let proj = normalizeProject({ name: 'app', path: '/local/app' });
    proj = upsertProjectLocation(proj, { host: 'devbox', path: '/home/dev/app', repositories: [] });
    expect(listProjectHosts(proj)).toEqual(['local', 'devbox']);
    expect(getProjectLocation(proj, 'devbox')?.path).toBe('/home/dev/app');
    expect(getProjectLocation(proj)?.host).toBe('local');

    proj = removeProjectLocation(proj, 'local');
    expect(listProjectHosts(proj)).toEqual(['devbox']);
    expect(proj.defaultHost).toBe('devbox');
    expect(proj.path).toBe('/home/dev/app');
  });
});

describe('host-service defaultRoot and multi-location references', () => {
  it('validates and persists optional defaultRoot', () => {
    const added = addHost({ name: 'devbox', sshTarget: 'devbox', defaultRoot: '/home/dev/git/' }, []);
    expect(added.data.host).toEqual({ name: 'devbox', sshTarget: 'devbox', defaultRoot: '/home/dev/git' });

    const invalid = addHost({ name: 'bad', sshTarget: 'bad', defaultRoot: 'relative/path' }, []);
    expect(invalid.status).toBe(400);

    const updated = updateHost('devbox', { defaultRoot: '/srv/code' }, added.data.hosts);
    expect(updated.data.host.defaultRoot).toBe('/srv/code');
  });

  it('blocks deleting a host referenced in project.locations[] and rewrites on rename', () => {
    const hosts = [{ name: 'devbox', sshTarget: 'devbox' }];
    const projects = [
      upsertProjectLocation(normalizeProject({ name: 'app', path: '/local/app' }), { host: 'devbox', path: '/home/dev/app' }),
    ];
    expect(deleteHost('devbox', hosts, projects).status).toBe(409);

    const rewritten = rewriteProjectHost(projects, 'devbox', 'gpu-box');
    expect(rewritten[0].locations.map(l => l.host)).toEqual(['local', 'gpu-box']);
  });
});

describe('terminal-session-host-store and cross-host runtime routing', () => {
  it('routes simultaneous sessions for the same project to different hosts', () => {
    const db = new Database(':memory:');
    const store = createTerminalSessionHostStore(db);
    store.set({ sessionId: 'app-1', project: 'app', host: 'local' });
    store.set({ sessionId: 'app-2', project: 'app', host: 'devbox' });

    const resolver = createHostRuntimeResolver({
      loadProjects: () => [
        upsertProjectLocation(normalizeProject({ name: 'app', path: '/local/app' }), { host: 'devbox', path: '/home/dev/app' }),
      ],
      loadHosts: () => [{ name: 'devbox', sshTarget: 'devbox' }],
      sessionHostStore: store,
      createRuntime: host => ({ host: host.name }),
    });

    expect(resolver.resolveHostRuntime('app-1')).toBeNull(); // local
    expect(resolver.resolveHostRuntime('app-2')?.host).toBe('devbox');

    store.rewriteHost('devbox', 'gpu-box');
    expect(store.get('app-2')?.host).toBe('gpu-box');
    store.remove('app-2');
    expect(store.get('app-2')).toBeNull();
  });
});

describe('host-exec and host-fs remote adapters', () => {
  it('prefixes GIT_TERMINAL_PROMPT=0 and shell-quotes cwd for remote git commands', async () => {
    const runner = {
      kind: 'ssh',
      host: 'devbox',
      run: vi.fn(async () => ({ stdout: 'ok\n', stderr: '' })),
    };
    const remoteExec = createHostExecFile(runner);
    await new Promise((resolve, reject) => {
      remoteExec('git', ['status', '--porcelain'], { cwd: "/srv/my 'app'" }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    expect(runner.run).toHaveBeenCalledWith(
      'sh',
      ['-c', expect.stringContaining("GIT_TERMINAL_PROMPT=0 'git' 'status' '--porcelain'")],
      expect.any(Object),
    );
  });

  it('implements remote stat, readFile, writeFile, and sha256 via runner', async () => {
    const payload = Buffer.from('hello remote').toString('base64');
    const runner = {
      kind: 'ssh',
      host: 'devbox',
      run: vi.fn(async (cmd, args) => {
        const script = args[1] || '';
        if (script.includes('base64 <')) return { stdout: payload, stderr: '' };
        if (script.includes('sha256sum')) return { stdout: 'deadbeef\n', stderr: '' };
        if (script.includes('stat -c')) return { stdout: 'f\t12\t1700000000\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }),
    };
    const remoteFs = createHostFs(runner);
    expect(await remoteFs.readFile('/srv/a.txt', 'utf8')).toBe('hello remote');
    expect(await remoteFs.sha256('/srv/a.txt')).toBe('deadbeef');
    const st = await remoteFs.stat('/srv/a.txt');
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(12);
  });
});

describe('git-sync-service', () => {
  function fakeGitExec(handlers) {
    return vi.fn((cmd, args, _opts, cb) => {
      const key = args.slice(2).join(' ');
      const handler = handlers[key];
      if (!handler) return cb(null, '', '');
      if (handler instanceof Error) return cb(handler, '', handler.stderr || handler.message);
      return cb(null, handler, '');
    });
  }

  it('validates Git URLs and derives folder names', () => {
    expect(isValidGitUrl('git@github.com:org/codedeck.git')).toBe(true);
    expect(isValidGitUrl('https://github.com/org/codedeck.git')).toBe(true);
    expect(isValidGitUrl('-u evil')).toBe(false);
    expect(isValidGitUrl('https://evil.com/a;rm -rf /')).toBe(false);
    expect(repoFolderNameFromGitUrl('git@github.com:org/codedeck.git')).toBe('codedeck');
  });

  it('fast-forward pulls cleanly and reports pulled commit count', async () => {
    let headCalls = 0;
    const execFile = vi.fn((_cmd, args, _opts, cb) => {
      const sub = args.slice(2).join(' ');
      if (sub === 'rev-parse --is-inside-work-tree') return cb(null, 'true\n', '');
      if (sub === 'status --porcelain') return cb(null, '', '');
      if (sub === 'rev-parse --abbrev-ref HEAD') return cb(null, 'main\n', '');
      if (sub === 'rev-parse HEAD') {
        headCalls += 1;
        return cb(null, headCalls === 1 ? '1111\n' : '2222\n', '');
      }
      if (sub === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return cb(null, 'origin/main\n', '');
      if (sub === 'pull --ff-only') return cb(null, 'Fast-forward\n', '');
      if (sub === 'rev-list --count 1111..2222') return cb(null, '3\n', '');
      return cb(null, '', '');
    });

    const result = await syncCheckout({ host: 'devbox', repoPath: '/srv/app', execFile });
    expect(result).toMatchObject({
      status: 'synced',
      host: 'devbox',
      branch: 'main',
      updated: true,
      commitsPulled: 3,
    });
  });

  it('blocks with 409 dirty when working tree has uncommitted changes', async () => {
    const execFile = fakeGitExec({
      'rev-parse --is-inside-work-tree': 'true\n',
      'status --porcelain': ' M server/index.js\n',
    });
    const result = await syncCheckout({ host: 'devbox', repoPath: '/srv/app', execFile });
    expect(result).toMatchObject({ status: 'blocked', code: 'dirty', httpStatus: 409 });
  });

  it('blocks with 409 diverged when git pull --ff-only fails due to divergence', async () => {
    const divergeErr = Object.assign(new Error('diverged'), {
      code: 1,
      stderr: 'fatal: Not possible to fast-forward, aborting.',
    });
    const execFile = fakeGitExec({
      'rev-parse --is-inside-work-tree': 'true\n',
      'status --porcelain': '',
      'rev-parse --abbrev-ref HEAD': 'main\n',
      'rev-parse HEAD': '1111\n',
      'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main\n',
      'pull --ff-only': divergeErr,
    });
    const result = await syncCheckout({ host: 'devbox', repoPath: '/srv/app', execFile });
    expect(result).toMatchObject({ status: 'blocked', code: 'diverged', httpStatus: 409 });
  });

  it('blocks with 503 host_unreachable on SSH transport failure', async () => {
    const transportErr = Object.assign(new Error('connect timeout'), { code: 255 });
    const execFile = fakeGitExec({
      'rev-parse --is-inside-work-tree': transportErr,
    });
    const result = await syncCheckout({ host: 'devbox', repoPath: '/srv/app', execFile });
    expect(result).toMatchObject({ status: 'blocked', code: 'host_unreachable', httpStatus: 503 });
  });

  it('skips non-git directories without failing', async () => {
    const notGitErr = Object.assign(new Error('not a git repo'), { code: 128 });
    const execFile = fakeGitExec({
      'rev-parse --is-inside-work-tree': notGitErr,
    });
    const result = await syncCheckout({ host: 'local', repoPath: '/tmp/notes', execFile });
    expect(result).toMatchObject({ status: 'skipped', reason: 'not_git_repo' });
  });

  it('clones a repository onto a remote host via runner', async () => {
    const runner = {
      kind: 'ssh',
      host: 'devbox',
      run: vi.fn(async () => ({ stdout: '', stderr: '' })),
    };
    const res = await cloneToHost({
      gitUrl: 'git@github.com:org/app.git',
      targetPath: '/home/dev/git/app',
      runner,
    });
    expect(res).toEqual({ path: '/home/dev/git/app', gitUrl: 'git@github.com:org/app.git' });
    expect(runner.run).toHaveBeenCalledWith('mkdir', ['-p', '--', '/home/dev/git'], expect.any(Object));
    expect(runner.run).toHaveBeenCalledWith(
      'env',
      ['GIT_TERMINAL_PROMPT=0', 'git', 'clone', '--', 'git@github.com:org/app.git', '/home/dev/git/app'],
      expect.any(Object),
    );
  });

  it('syncProjectLocation returns 409 sync_blocked when checkout is dirty', async () => {
    const execFile = fakeGitExec({
      'rev-parse --is-inside-work-tree': 'true\n',
      'status --porcelain': '?? untracked.txt\n',
    });
    const project = normalizeProject({ name: 'app', path: '/local/app' });
    const outcome = await syncProjectLocation({ project, host: 'local', execFile });
    expect(outcome).toMatchObject({ ok: false, status: 409, code: 'sync_blocked', host: 'local' });
  });
});

describe('cross-host project location & sync endpoints', () => {
  it('binds a second host location, clones to a third host, and syncs on demand', async () => {
    const state = {
      projects: [normalizeProject({ name: 'app', path: '/local/app', gitUrl: 'git@github.com:org/app.git' })],
    };
    const hosts = [
      { name: 'devbox', sshTarget: 'devbox', defaultRoot: '/home/dev/git' },
      { name: 'gpu', sshTarget: 'gpu', defaultRoot: '/srv/git' },
    ];
    const cloneRepo = vi.fn(async ({ targetPath, gitUrl }) => ({ path: targetPath, gitUrl }));
    const syncLocation = vi.fn(async ({ host }) => ({ ok: true, status: 200, host, updated: true, commitsPulled: 2, results: [] }));
    const app = express();
    app.use(express.json());
    app.use(createProjectsRouter({
      loadProjects: () => state.projects,
      saveProjects: p => { state.projects = p; },
      loadHosts: () => hosts,
      localPathExists: () => true,
      createRunner: () => ({ run: vi.fn(async () => ({ stdout: '', stderr: '' })) }),
      deleteProject: createProjectDeletionService({
        loadProjects: () => state.projects,
        saveProjects: p => { state.projects = p; },
        sessions: new Map(),
        listSessionIds: async () => [],
        deleteTerminalSession: async () => {},
      }),
      cloneRepo,
      syncLocation,
    }));
    const server = await loopbackTestServer(app);

    // Bind existing remote path
    const bindRes = await request(server)
      .post('/api/projects/app/locations')
      .send({ host: 'devbox', path: '/home/dev/git/app' });
    expect(bindRes.status).toBe(201);
    expect(bindRes.body.locations.map(l => l.host)).toEqual(['local', 'devbox']);

    // Clone onto gpu using host defaultRoot
    const cloneRes = await request(server)
      .post('/api/projects/app/locations/clone')
      .send({ host: 'gpu' });
    expect(cloneRes.status).toBe(201);
    expect(cloneRepo).toHaveBeenCalledWith(expect.objectContaining({
      gitUrl: 'git@github.com:org/app.git',
      targetPath: '/srv/git/app',
    }));
    expect(cloneRes.body.locations.map(l => l.host)).toEqual(['local', 'devbox', 'gpu']);

    // Manual sync on devbox
    const syncRes = await request(server)
      .post('/api/projects/app/sync')
      .send({ host: 'devbox' });
    expect(syncRes.status).toBe(200);
    expect(syncRes.body).toMatchObject({ ok: true, host: 'devbox', commitsPulled: 2 });

    // Remove gpu location
    const delRes = await request(server).delete('/api/projects/app/locations/gpu');
    expect(delRes.status).toBe(200);
    expect(delRes.body.locations.map(l => l.host)).toEqual(['local', 'devbox']);
  });
});

describe('remote host-fs compatibility with pipeline run notes', () => {
  it('supports stat().nlink, open().readFile(), and mkdir EEXIST on remote hosts', async () => {
    const runner = {
      kind: 'ssh',
      host: 'devbox',
      run: vi.fn(async (cmd, args) => {
        if (cmd === 'sh' && args[1]?.includes('base64 <')) {
          return { stdout: Buffer.from('# Note\nhello', 'utf8').toString('base64') + '\n', stderr: '' };
        }
        if (cmd === 'sh' && args[1]?.includes('stat -c')) {
          return { stdout: 'f\t12\t1700000000\t1\n', stderr: '' };
        }
        if (cmd === 'mkdir') {
          const err = new Error('mkdir: cannot create directory: File exists');
          err.stderr = 'mkdir: cannot create directory ‘/home/dev/app/.codedeck’: File exists';
          throw err;
        }
        return { stdout: '', stderr: '' };
      }),
    };
    const hostFs = createHostFs(runner);
    const handle = await hostFs.open('/home/dev/app/.codedeck/runs/12345678/README.md');
    const stat = await handle.stat();
    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    expect(await handle.readFile('utf8')).toBe('# Note\nhello');
    await handle.close();

    await expect(hostFs.mkdir('/home/dev/app/.codedeck')).rejects.toMatchObject({ code: 'EEXIST' });
  });
});

describe('remote background attach and task landing', () => {
  it('attaches to a remote hostRuntime via attachBackgroundSessionAsync and backgroundSessionAvailableAsync', async () => {
    const pty = {
      write: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    const hostRuntime = {
      type: 'tmux',
      host: 'devbox',
      isSessionRecoverableAsync: vi.fn(async () => true),
      getSessionIncarnationAsync: vi.fn(async () => 'inc-1'),
      spawnAsync: vi.fn(async () => pty),
    };
    const sessions = new Map();
    expect(await backgroundSessionAvailableAsync('Demo-34', sessions, hostRuntime)).toBe(true);

    const handle = await attachBackgroundSessionAsync('Demo-34', sessions, hostRuntime, new Set(), {
      cwd: '/home/dev/git/demo/worktrees/task-1/backend',
    });
    expect(hostRuntime.spawnAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'Demo-34',
      cwd: '/home/dev/git/demo/worktrees/task-1/backend',
    }));
    expect(sessions.get('Demo-34')).toMatchObject({
      host: 'devbox',
      hostRuntime,
      alive: true,
    });
    handle.write('hello\r');
    expect(pty.write).toHaveBeenCalledWith('hello\r');
    handle.release();
  });

  it('inspects a remote task via resolveHostTools instead of local execFile', async () => {
    const db = new Database(':memory:');
    const taskStore = createTaskStore(db);
    const task = taskStore.create({
      id: '08dd8562-7959-4b2d-8060-61a6bb5cceb9',
      project: 'Demo',
      host: 'devbox',
      title: 'Remote task',
      titleSource: 'owner',
      folder: null,
      repository: 'backend',
      repositoryPath: null,
      worktreePath: '/home/dev/git/demo/worktrees/remote-task/backend',
      branch: 'task/remote-task',
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
    });
    const remoteCalls = [];
    const remoteExecFile = (cmd, args, optsOrCb, maybeCb) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      remoteCalls.push({ cmd, args });
      if (args.includes('--abbrev-ref')) return cb(null, 'main\n', '');
      if (args.includes('--left-right')) return cb(null, '0\t0\n', '');
      if (args.includes('--count')) return cb(null, '0\n', '');
      if (args.includes('remote')) return cb(null, '', '');
      return cb(null, '', '');
    };
    const landing = createTaskLanding({
      taskStore,
      findProject: () => ({
        name: 'Demo',
        path: '/Users/local/git/demo/backend',
        defaultHost: 'local',
        locations: [
          { host: 'local', path: '/Users/local/git/demo/backend', repositories: [] },
          { host: 'devbox', path: '/home/dev/git/demo/backend', repositories: [] },
        ],
      }),
      execFile: () => { throw new Error('local execFile must not be called for remote task'); },
      pathExists: async () => { throw new Error('local pathExists must not be called for remote task'); },
      hasActiveRun: () => false,
      onTaskFinished: () => {},
      onWorktreeFinished: () => {},
      closeTerminals: async () => ({ closed: [], notClosed: [] }),
      resolveHostTools: () => ({
        host: 'devbox',
        execFile: remoteExecFile,
        pathExists: async () => true,
        fs: {
          lstat: async () => ({ isFile: () => false, size: 0, nlink: 1 }),
          readdir: async () => [],
          rmdir: async () => {},
        },
        sha256: async () => '0'.repeat(64),
      }),
    });

    const view = await landing.status(task.id);
    expect(remoteCalls.length).toBeGreaterThan(0);
    expect(view.filesPresent).toBe(true);
    expect(view.main.branch).toBe('main');
    db.close();
  });
});
