import { describe, expect, it, vi } from 'vitest';
import { create, listDirtyPaths, planNames, preflight, remove } from '../pipelines/run-worktree.js';

const RUN_ID = '0d9e4b1a-1111-4111-8111-111111111111';
const HOME = '/Users/me/git/codedeck';

describe('planNames', () => {
  it('builds worktree path and branch with slug and shortId', () => {
    const names = planNames({ runId: RUN_ID, workflowName: 'Feature', homeRepoPath: HOME });
    expect(names).toEqual({
      shortId: '0d9e4b1a',
      slug: 'feature',
      homeRepoPath: HOME,
      worktreePath: '/Users/me/git/worktrees/codedeck-feature-0d9e4b1a',
      branch: 'workflow/feature-0d9e4b1a',
    });
  });

  it('slugifies: lowercases, replaces non-alnum runs with -, trims, cuts to 32', () => {
    const names = planNames({
      runId: RUN_ID,
      workflowName: '!!My Cool_Workflow!! Name Extra Padding XX',
      homeRepoPath: HOME,
    });
    expect(names.slug).toBe('my-cool-workflow-name-extra-padd');
    expect(names.slug).toHaveLength(32);
    expect(names.worktreePath).toBe(
      `/Users/me/git/worktrees/codedeck-${names.slug}-0d9e4b1a`,
    );
    expect(names.branch).toBe(`workflow/${names.slug}-0d9e4b1a`);
  });

  it('omits <slug>- when slug is empty', () => {
    const names = planNames({ runId: RUN_ID, workflowName: '!!!', homeRepoPath: HOME });
    expect(names.slug).toBe('');
    expect(names.worktreePath).toBe('/Users/me/git/worktrees/codedeck-0d9e4b1a');
    expect(names.branch).toBe('workflow/0d9e4b1a');
  });

  it('takes first 8 hex characters of the run id', () => {
    const names = planNames({
      runId: 'abcdef01-9999-4000-8000-000000000000',
      workflowName: 'x',
      homeRepoPath: HOME,
    });
    expect(names.shortId).toBe('abcdef01');
  });

  it('uses the home repository folder name in the worktree path', () => {
    const names = planNames({
      runId: RUN_ID,
      workflowName: 'feat',
      homeRepoPath: '/repos/my-app',
    });
    expect(names.worktreePath).toBe('/repos/worktrees/my-app-feat-0d9e4b1a');
  });
});

function fakeExecFile(handlers) {
  return vi.fn((cmd, args, options, callback) => {
    expect(cmd).toBe('git');
    expect(options).toEqual(expect.objectContaining({ timeout: expect.any(Number) }));
    expect(Array.isArray(args)).toBe(true);
    const key = args.join(' ');
    const handler = handlers.find(h => h.match(args));
    if (!handler) {
      const err = new Error(`unexpected git argv: ${key}`);
      if (typeof callback === 'function') return callback(err);
      return Promise.reject(err);
    }
    if (handler.error) {
      const err = Object.assign(new Error(handler.error.message || 'git failed'), {
        code: handler.error.code ?? 1,
        stdout: handler.error.stdout ?? '',
        stderr: handler.error.stderr ?? (handler.error.message || ''),
      });
      if (typeof callback === 'function') return callback(err, err.stdout, err.stderr);
      return Promise.reject(err);
    }
    const stdout = handler.stdout ?? '';
    const stderr = handler.stderr ?? '';
    if (typeof callback === 'function') return callback(null, stdout, stderr);
    return Promise.resolve({ stdout, stderr });
  });
}

describe('preflight', () => {
  it('reports eligible when local, git toplevel, and setup agent present', async () => {
    const projectPath = '/Users/me/git/codedeck';
    const execFile = fakeExecFile([
      {
        match: args => args.includes('--show-toplevel'),
        stdout: `${projectPath}\n`,
      },
      {
        match: args => args.includes('--abbrev-ref'),
        stdout: 'main\n',
      },
      {
        match: args => args.includes('HEAD') && args.includes('rev-parse') && !args.includes('--abbrev-ref') && !args.includes('--show-toplevel'),
        stdout: '15b9b47aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      },
      {
        match: args => args.includes('--porcelain'),
        stdout: '',
      },
    ]);

    const result = await preflight({
      projectPath,
      projectHost: 'local',
      setupAgentId: 'c4100000-0000-4000-8000-000000000001',
      execFile,
      realpath: async p => p,
    });

    expect(result).toEqual({
      eligible: true,
      reasons: [],
      branch: 'main',
      head: '15b9b47aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dirty: false,
    });
    expect(execFile.mock.calls.every(([cmd, args, opts]) => (
      cmd === 'git' && Array.isArray(args) && typeof opts.timeout === 'number'
    ))).toBe(true);
  });

  it('treats missing host as local', async () => {
    const projectPath = '/proj';
    const execFile = fakeExecFile([
      { match: args => args.includes('--show-toplevel'), stdout: `${projectPath}\n` },
      { match: args => args.includes('--abbrev-ref'), stdout: 'main\n' },
      { match: args => args[args.length - 1] === 'HEAD' && !args.includes('--abbrev-ref') && !args.includes('--show-toplevel'), stdout: 'abc\n' },
      { match: args => args.includes('--porcelain'), stdout: ' M file\n' },
    ]);

    const result = await preflight({
      projectPath,
      projectHost: undefined,
      setupAgentId: 'c4100000-0000-4000-8000-000000000001',
      execFile,
      realpath: async p => p,
    });
    expect(result.eligible).toBe(true);
    expect(result.dirty).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('returns project_remote for non-local hosts without running git', async () => {
    const execFile = vi.fn();
    const result = await preflight({
      projectPath: '/proj',
      projectHost: 'studio',
      setupAgentId: 'c4100000-0000-4000-8000-000000000001',
      execFile,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.map(r => r.code)).toEqual(['project_remote']);
    expect(result.branch).toBeNull();
    expect(result.head).toBeNull();
    expect(result.dirty).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns not_git_toplevel when show-toplevel differs from real path', async () => {
    const execFile = fakeExecFile([
      { match: args => args.includes('--show-toplevel'), stdout: '/Users/me/git/codedeck\n' },
    ]);
    const result = await preflight({
      projectPath: '/Users/me/git/codedeck/server',
      projectHost: 'local',
      setupAgentId: 'c4100000-0000-4000-8000-000000000001',
      execFile,
      realpath: async p => p,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.map(r => r.code)).toContain('not_git_toplevel');
    expect(result.branch).toBeNull();
    expect(result.head).toBeNull();
    expect(result.dirty).toBeNull();
  });

  it('returns not_git_toplevel when git fails', async () => {
    const execFile = fakeExecFile([
      {
        match: args => args.includes('--show-toplevel'),
        error: { message: 'not a git repository', stderr: 'fatal: not a git repository' },
      },
    ]);
    const result = await preflight({
      projectPath: '/tmp/not-a-repo',
      projectHost: null,
      setupAgentId: 'c4100000-0000-4000-8000-000000000001',
      execFile,
      realpath: async p => p,
    });
    expect(result.reasons.map(r => r.code)).toContain('not_git_toplevel');
    expect(result.eligible).toBe(false);
  });

  it('returns setup_agent_missing when no setup agent is chosen', async () => {
    const projectPath = '/proj';
    const execFile = fakeExecFile([
      { match: args => args.includes('--show-toplevel'), stdout: `${projectPath}\n` },
      { match: args => args.includes('--abbrev-ref'), stdout: 'main\n' },
      { match: args => args[args.length - 1] === 'HEAD' && !args.includes('--abbrev-ref') && !args.includes('--show-toplevel'), stdout: 'deadbeef\n' },
      { match: args => args.includes('--porcelain'), stdout: '' },
    ]);
    const result = await preflight({
      projectPath,
      projectHost: 'local',
      setupAgentId: null,
      execFile,
      realpath: async p => p,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      { code: 'setup_agent_missing', message: 'Choose a setup agent in Settings → Workflows.' },
    ]);
    expect(result.branch).toBe('main');
    expect(result.head).toBe('deadbeef');
    expect(result.dirty).toBe(false);
  });

  it('reports null branch on detached HEAD', async () => {
    const projectPath = '/proj';
    const execFile = fakeExecFile([
      { match: args => args.includes('--show-toplevel'), stdout: `${projectPath}\n` },
      { match: args => args.includes('--abbrev-ref'), stdout: 'HEAD\n' },
      { match: args => args[args.length - 1] === 'HEAD' && !args.includes('--abbrev-ref') && !args.includes('--show-toplevel'), stdout: 'abc123\n' },
      { match: args => args.includes('--porcelain'), stdout: '' },
    ]);
    const result = await preflight({
      projectPath,
      projectHost: 'local',
      setupAgentId: 'c4100000-0000-4000-8000-000000000001',
      execFile,
      realpath: async p => p,
    });
    expect(result.branch).toBeNull();
    expect(result.head).toBe('abc123');
    expect(result.eligible).toBe(true);
  });
});

describe('create', () => {
  it('rev-parses HEAD then worktree-adds with argv arrays and timeout', async () => {
    const calls = [];
    const execFile = vi.fn((cmd, args, options, callback) => {
      calls.push({ cmd, args, options });
      const stdout = args.includes('rev-parse')
        ? '15b9b47aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
        : '';
      callback(null, stdout, '');
    });

    const mkdir = vi.fn(async () => undefined);
    const result = await create({
      homePath: '/Users/me/git/codedeck',
      worktreePath: '/Users/me/git/worktrees/codedeck-feature-0d9e4b1a',
      branch: 'workflow/feature-0d9e4b1a',
      projectPath: '/Users/me/git/codedeck',
      execFile,
      mkdir,
    });

    expect(result).toEqual({ baseCommit: '15b9b47aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(mkdir).toHaveBeenCalledWith('/Users/me/git/worktrees', { recursive: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      cmd: 'git',
      args: ['-C', '/Users/me/git/codedeck', 'rev-parse', 'HEAD'],
      options: expect.objectContaining({ timeout: expect.any(Number) }),
    });
    expect(calls[1]).toEqual({
      cmd: 'git',
      args: [
        '-C', '/Users/me/git/codedeck',
        'worktree', 'add',
        '/Users/me/git/worktrees/codedeck-feature-0d9e4b1a',
        '-b', 'workflow/feature-0d9e4b1a',
        '15b9b47aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ],
      options: expect.objectContaining({ timeout: expect.any(Number) }),
    });
  });

  it('surfaces git failure from worktree add', async () => {
    const execFile = vi.fn((cmd, args, options, callback) => {
      if (args.includes('rev-parse')) {
        callback(null, 'abc\n', '');
        return;
      }
      const err = Object.assign(new Error('already exists'), {
        code: 128,
        stderr: "fatal: 'workflow/x' is already used by worktree at '/tmp/x'\n",
        stdout: '',
      });
      callback(err, '', err.stderr);
    });

    await expect(create({
      homePath: '/home',
      worktreePath: '/wt',
      branch: 'workflow/x',
      projectPath: '/home',
      execFile,
      mkdir: async () => undefined,
    })).rejects.toThrow(/already used by worktree|already exists/);
  });
});

describe('remove (Spec §8.2)', () => {
  it('runs git worktree remove without --force and returns ok', async () => {
    const calls = [];
    const execFile = vi.fn((cmd, args, options, callback) => {
      calls.push({ cmd, args, options });
      callback(null, '', '');
    });

    await expect(remove({
      homePath: '/Users/me/git/codedeck',
      worktreePath: '/Users/me/git/worktrees/codedeck-feature-0d9e4b1a',
      execFile,
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([{
      cmd: 'git',
      args: [
        '-C', '/Users/me/git/codedeck',
        'worktree', 'remove',
        '/Users/me/git/worktrees/codedeck-feature-0d9e4b1a',
      ],
      options: expect.objectContaining({ timeout: expect.any(Number) }),
    }]);
    expect(calls[0].args).not.toContain('--force');
  });

  it('on refusal returns detail with git message and up to 20 porcelain paths', async () => {
    const paths = Array.from({ length: 25 }, (_, i) => `file-${i}.txt`);
    const execFile = vi.fn((cmd, args, options, callback) => {
      if (args.includes('remove')) {
        const err = Object.assign(new Error('contains modified or untracked files'), {
          code: 128,
          stderr: 'fatal: contains modified or untracked files, use -f to delete it\n',
          stdout: '',
        });
        callback(err, '', err.stderr);
        return;
      }
      if (args.includes('--porcelain')) {
        callback(null, paths.map(p => `?? ${p}`).join('\n') + '\n', '');
        return;
      }
      callback(new Error(`unexpected: ${args.join(' ')}`));
    });

    const result = await remove({
      homePath: '/home',
      worktreePath: '/wt',
      execFile,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/contains modified or untracked files/);
    expect(result.detail).toContain('file-0.txt');
    expect(result.detail).toContain('file-19.txt');
    expect(result.detail).not.toContain('file-20.txt');
    expect(result.detail.length).toBeLessThanOrEqual(2000);
  });
});

describe('listDirtyPaths', () => {
  it('returns porcelain paths only', async () => {
    const execFile = vi.fn((cmd, args, options, callback) => {
      expect(args).toEqual(['-C', '/wt', 'status', '--porcelain']);
      callback(null, ' M tracked.js\n?? new.txt\nA  staged.md\n', '');
    });
    await expect(listDirtyPaths({ worktreePath: '/wt', execFile }))
      .resolves.toEqual(['tracked.js', 'new.txt', 'staged.md']);
  });
});
