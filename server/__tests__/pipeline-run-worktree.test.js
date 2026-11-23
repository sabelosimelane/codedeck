import { describe, expect, it, vi } from 'vitest';
import { buildSetupPrompt, buildSetupPromptForRepositories, create, hasCommittedFile, listDirtyPaths, listWorktrees, planNames, preflight, readCommittedFile, readWorktreeChanges, remove } from '../pipelines/run-worktree.js';

const RUN_ID = '0d9e4b1a-1111-4111-8111-111111111111';
const HOME = '/Users/me/git/codedeck';

describe('hasCommittedFile preconditions', () => {
  const execFile = vi.fn();
  it.each([undefined, '', 'relative', 7])('rejects repoPath %s', async repoPath => {
    await expect(hasCommittedFile({ repoPath, progressFile: 'docs/todo.md', execFile })).rejects.toThrow('repoPath must be an absolute path');
  });
  it.each([undefined, '', 7])('rejects progressFile %s', async progressFile => {
    await expect(hasCommittedFile({ repoPath: HOME, progressFile, execFile })).rejects.toThrow('progressFile must be a non-empty string');
  });
  it('rejects an absent git runner', async () => {
    await expect(hasCommittedFile({ repoPath: HOME, progressFile: 'docs/todo.md' })).rejects.toThrow('execFile is required');
  });
  it('checks HEAD in repoPath', async () => {
    const execFile = vi.fn((_cmd, args, _options, callback) => callback(null, '100644 blob abc\tdocs/todo.md\0', ''));
    await expect(hasCommittedFile({ repoPath: '/linked', progressFile: 'docs/todo.md', execFile })).resolves.toBe(true);
    expect(execFile.mock.calls[0][1]).toEqual(['-C', '/linked', 'ls-tree', '-z', 'HEAD', '--', 'docs/todo.md']);
  });
});

describe('readCommittedFile', () => {
  const execFile = vi.fn();
  it.each([undefined, '', 'relative', 7])('rejects repoPath %s', async repoPath => {
    await expect(readCommittedFile({ repoPath, file: 'docs/todo.md', execFile })).rejects.toThrow('repoPath must be an absolute path');
  });
  it.each([undefined, '', 7, '/abs/todo.md', '../todo.md', 'docs/todo.txt'])('rejects file %s', async file => {
    await expect(readCommittedFile({ repoPath: HOME, file, execFile })).rejects.toThrow('file must be the path of a .md file inside the repository');
  });
  it('rejects an absent git runner', async () => {
    await expect(readCommittedFile({ repoPath: HOME, file: 'docs/todo.md' })).rejects.toThrow('execFile is required');
  });
  it('reads the file as it is at HEAD in repoPath', async () => {
    const execFile = vi.fn((_cmd, args, _options, callback) => callback(null, '# Todo\n', ''));
    await expect(readCommittedFile({ repoPath: '/linked', file: 'docs/todo.md', execFile })).resolves.toBe('# Todo\n');
    expect(execFile.mock.calls[0][1]).toEqual(['-C', '/linked', 'cat-file', 'blob', 'HEAD:docs/todo.md']);
  });
});

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
  it('adds the worktree at the supplied baseCommit without reading HEAD', async () => {
    const baseCommit = 'b'.repeat(40);
    const execFile = vi.fn((_cmd, _args, _options, callback) => callback(null, '', ''));
    await expect(create({ homePath: '/home', projectPath: '/linked', worktreePath: '/new', branch: 'task/new',
      baseCommit, execFile, mkdir: async () => {} })).resolves.toEqual({ baseCommit });
    expect(execFile.mock.calls.map(([, args]) => args)).toEqual([
      ['-C', '/home', 'worktree', 'add', '/new', '-b', 'task/new', baseCommit],
    ]);
  });

  it.each([null, '', '--invalid'])('rejects invalid supplied baseCommit %j before Git', async baseCommit => {
    const execFile = vi.fn((_cmd, _args, _options, callback) => callback(null, '', ''));
    await expect(create({ homePath: '/home', projectPath: '/linked', worktreePath: '/new', branch: 'task/new',
      baseCommit, execFile, mkdir: async () => {} })).rejects.toThrow('baseCommit');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reads project HEAD and adds from home when the paths differ', async () => {
    const calls = [];
    const execFile = vi.fn((_cmd, args, _options, callback) => {
      calls.push(args);
      callback(null, args.includes('rev-parse') ? 'a'.repeat(40) : '', '');
    });
    await create({ homePath: '/home', projectPath: '/linked', worktreePath: '/new', branch: 'workflow/new', execFile, mkdir: async () => {} });
    expect(calls[0]).toEqual(['-C', '/linked', 'rev-parse', 'HEAD']);
    expect(calls[1]).toEqual(['-C', '/home', 'worktree', 'add', '/new', '-b', 'workflow/new', 'a'.repeat(40)]);
  });
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

describe('listWorktrees', () => {
  const HEAD_A = 'a'.repeat(40);
  const HEAD_B = 'b'.repeat(40);
  const HEAD_C = 'c'.repeat(40);
  const listing = stdout => fakeExecFile([{ match: args => args.join(' ') === `-C ${HOME} worktree list --porcelain`, stdout }]);

  it('lists the home checkout and linked worktrees from git, with argv arrays', async () => {
    const execFile = listing([
      `worktree ${HOME}`, `HEAD ${HEAD_A}`, 'branch refs/heads/main', '',
      'worktree /Users/me/git/worktrees/codedeck-feature', `HEAD ${HEAD_B}`, 'branch refs/heads/feature/pipelines', '',
      '',
    ].join('\n'));

    expect(await listWorktrees({ projectPath: HOME, execFile })).toEqual([
      { path: HOME, head: HEAD_A, branch: 'main', missing: false },
      { path: '/Users/me/git/worktrees/codedeck-feature', head: HEAD_B, branch: 'feature/pipelines', missing: false },
    ]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('reports a detached worktree with a null branch and a prunable one as missing', async () => {
    const execFile = listing([
      `worktree ${HOME}`, `HEAD ${HEAD_A}`, 'branch refs/heads/main', '',
      'worktree /w/detached', `HEAD ${HEAD_B}`, 'detached', '',
      'worktree /w/gone', `HEAD ${HEAD_C}`, 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
      'worktree /w/locked', `HEAD ${HEAD_C}`, 'branch refs/heads/locked', 'locked on a removable drive', '',
    ].join('\n'));

    expect(await listWorktrees({ projectPath: HOME, execFile })).toEqual([
      { path: HOME, head: HEAD_A, branch: 'main', missing: false },
      { path: '/w/detached', head: HEAD_B, branch: null, missing: false },
      { path: '/w/gone', head: HEAD_C, branch: 'gone', missing: true },
      { path: '/w/locked', head: HEAD_C, branch: 'locked', missing: false },
    ]);
  });

  it('leaves out a bare repository entry, which has no working tree', async () => {
    const execFile = listing([
      'worktree /repos/codedeck.git', 'bare', '',
      'worktree /repos/worktrees/codedeck-main', `HEAD ${HEAD_A}`, 'branch refs/heads/main', '',
    ].join('\n'));

    expect(await listWorktrees({ projectPath: HOME, execFile })).toEqual([
      { path: '/repos/worktrees/codedeck-main', head: HEAD_A, branch: 'main', missing: false },
    ]);
  });

  it.each([
    ['an entry without a path', [`HEAD ${HEAD_A}`, 'branch refs/heads/main', ''], /worktree list: entry 0 has no path/],
    ['a relative path', ['worktree relative/dir', `HEAD ${HEAD_A}`, 'branch refs/heads/main', ''], /worktree list: entry 0 path is not absolute/],
    ['a missing HEAD', [`worktree ${HOME}`, 'branch refs/heads/main', ''], /worktree list: entry 0 HEAD is not a commit id/],
    ['a malformed HEAD', [`worktree ${HOME}`, 'HEAD abc', 'branch refs/heads/main', ''], /worktree list: entry 0 HEAD is not a commit id/],
    ['neither a branch nor detached', [`worktree ${HOME}`, `HEAD ${HEAD_A}`, ''], /worktree list: entry 0 has neither a branch nor detached/],
    ['a branch outside refs/heads', [`worktree ${HOME}`, `HEAD ${HEAD_A}`, 'branch refs/remotes/origin/main', ''], /worktree list: entry 0 branch is not a local branch/],
  ])('fails loudly on %s', async (_label, lines, message) => {
    await expect(listWorktrees({ projectPath: HOME, execFile: listing(lines.join('\n')) })).rejects.toThrow(message);
  });

  it('surfaces a git failure', async () => {
    const execFile = fakeExecFile([{ match: () => true, error: { message: 'fatal: not a git repository' } }]);
    await expect(listWorktrees({ projectPath: HOME, execFile })).rejects.toThrow(/not a git repository/);
  });
});

describe('readWorktreeChanges', () => {
  const WT = '/Users/me/git/worktrees/codedeck-feature';
  const status = result => fakeExecFile([{ match: args => args.join(' ') === `-C ${WT} status --porcelain`, ...result }]);

  it('reports a readable worktree without changes as clean', async () => {
    expect(await readWorktreeChanges({ worktreePath: WT, execFile: status({ stdout: '' }) })).toEqual({ readable: true, dirty: false });
  });

  it('reports a readable worktree with changes as dirty', async () => {
    expect(await readWorktreeChanges({ worktreePath: WT, execFile: status({ stdout: '?? notes.txt\n' }) })).toEqual({ readable: true, dirty: true });
  });

  it('reports a directory git cannot open as a working tree as unreadable', async () => {
    const execFile = status({ error: { code: 128, message: 'Command failed', stderr: 'fatal: not a git repository: (null)\n' } });
    expect(await readWorktreeChanges({ worktreePath: WT, execFile })).toEqual({ readable: false });
  });

  it('fails loudly on any other git failure', async () => {
    const execFile = status({ error: { code: 128, message: 'Command failed', stderr: 'fatal: unable to read index file\n' } });
    await expect(readWorktreeChanges({ worktreePath: WT, execFile })).rejects.toThrow('Command failed');
  });
});

describe('buildSetupPromptForRepositories', () => {
  const pairs = [
    { repository: 'mobile-app', homePath: '/group/mobile-app', worktreePath: '/group/worktrees/replies/mobile-app' },
    { repository: 'backend', homePath: '/group/backend', worktreePath: '/group/worktrees/replies/backend' },
  ];

  it('is the prompt a run always had when the task has one worktree', () => {
    expect(buildSetupPromptForRepositories([pairs[0]])).toBe(buildSetupPrompt('/group/mobile-app', '/group/worktrees/replies/mobile-app'));
  });

  it('names every worktree of the task with the checkout its local files come from, and asks for each to be left clean', () => {
    const prompt = buildSetupPromptForRepositories(pairs);
    expect(prompt).toContain('You are preparing 2 fresh git worktrees of one task');
    expect(prompt).toContain('- mobile-app: home checkout /group/mobile-app, worktree /group/worktrees/replies/mobile-app (your current directory)');
    expect(prompt).toContain('- backend: home checkout /group/backend, worktree /group/worktrees/replies/backend');
    expect(prompt).toContain('Do the following for each repository, in its own worktree:');
    expect(prompt).toContain('Never print, summarise or log the contents of a copied file.');
    expect(prompt).toContain('change nothing in any home\n   checkout');
    expect(prompt).toContain('Finish by running `git status --short` in every worktree. Each must print nothing.');
    expect(prompt).toContain('report NEEDS_INPUT and say which repository and what is missing');
  });

  it.each([['one worktree', [pairs[0]]], ['several worktrees', pairs]])('has Setup prove that %s can be tested and record how, without asking the owner', (_name, value) => {
    const prompt = buildSetupPromptForRepositories(value).replace(/\s+/g, ' ');
    expect(prompt).toContain('Run one quick test');
    expect(prompt).toContain('not the whole suite');
    expect(prompt).toContain('on ports nothing else is using');
    expect(prompt).toContain("the home checkout's own instance may be running on the usual ports: leave it alone");
    expect(prompt).toContain('how a test user signs in without the owner');
    expect(prompt).toContain('which emulators, simulators and browsers this machine has');
    expect(prompt).toContain("environment.md in this run's notes folder");
    expect(prompt).toContain('never the value of a secret');
    expect(prompt).toContain('Remove anything this leaves behind');
    // Installing and copying may stop the run; what could not be made to run is written down instead.
    expect(prompt).toContain('If you cannot install the dependencies or copy the local files, report NEEDS_INPUT');
    expect(prompt).toContain('Do not ask about step 5');
    expect(prompt).not.toContain('or a step fails');
    expect(prompt.indexOf('5. Prove')).toBeGreaterThan(prompt.indexOf('4. Do not create'));
    expect(prompt.indexOf('6. Finish by running `git status --short`')).toBeGreaterThan(prompt.indexOf('5. Prove'));
  });

  it('asks for one section per repository in the record of a task with several', () => {
    expect(buildSetupPromptForRepositories(pairs)).toContain('one section per repository');
    expect(buildSetupPromptForRepositories([pairs[0]])).not.toContain('one section per repository');
  });

  it.each([[[]], ['x'], [[{ repository: 'a', homePath: 'relative', worktreePath: '/x' }]], [[{ repository: '', homePath: '/a', worktreePath: '/x' }]], [[{ repository: 'a', homePath: '/a' }]]])('refuses %j', (value) => {
    expect(() => buildSetupPromptForRepositories(value)).toThrow(/pairs/);
  });
});
