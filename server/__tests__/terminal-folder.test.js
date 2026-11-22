import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTerminalInFolder } from '../pipelines/terminal-folder.js';

function folders() {
  // os.tmpdir() on macOS is under /var, which is a link to /private/var: tmux reports the real path.
  const base = mkdtempSync(path.join(os.tmpdir(), 'cd-folder-'));
  const worktree = path.join(base, 'worktree');
  mkdirSync(path.join(worktree, 'server'), { recursive: true });
  mkdirSync(path.join(base, 'worktree-other'));
  mkdirSync(path.join(base, 'main'));
  symlinkSync(worktree, path.join(base, 'link'));
  return { base, worktree };
}

describe('createTerminalInFolder', () => {
  it('requires a way to read a terminal\'s pane', () => {
    expect(() => createTerminalInFolder(null)).toThrow('createTerminalInFolder: inspectPane must be a function');
  });

  it('answers whether the pane is in the folder or below it, by real path', async () => {
    const { base, worktree } = folders();
    try {
      const at = dir => createTerminalInFolder(vi.fn(async () => ({ currentPath: dir })));
      expect(await at(realpathSync(worktree))('s-1', worktree)).toBe(true);
      expect(await at(path.join(realpathSync(worktree), 'server'))('s-1', worktree)).toBe(true);
      expect(await at(path.join(base, 'link'))('s-1', worktree)).toBe(true);
      expect(await at(path.join(base, 'main'))('s-1', worktree)).toBe(false);
      // A sibling whose name starts like the folder is not inside it.
      expect(await at(path.join(base, 'worktree-other'))('s-1', worktree)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('fails loudly on a folder or pane path it cannot read', async () => {
    const { base, worktree } = folders();
    try {
      await expect(createTerminalInFolder(async () => ({ currentPath: worktree }))('s-1', 'relative'))
        .rejects.toThrow('terminalInFolder: folder must be an absolute path, got relative');
      await expect(createTerminalInFolder(async () => ({ currentPath: '' }))('s-1', worktree))
        .rejects.toThrow('terminalInFolder: the pane of s-1 has no absolute current path');
      await expect(createTerminalInFolder(async () => ({ currentPath: worktree }))('s-1', path.join(base, 'gone')))
        .rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

it('rejects a terminal on a different host before inspecting an identically named folder', async () => {
  const inspect = vi.fn(async () => ({currentPath: '/tmp'}));
  const matches = createTerminalInFolder(inspect, {sessionHost: () => 'worker'});
  expect(await matches('session','/tmp','local')).toBe(false);
  expect(inspect).not.toHaveBeenCalled();
});

it('uses the local host for the local-filesystem terminal inspector', async () => {
  const match = createTerminalInFolder(async () => ({currentPath:'/tmp'}));
  expect(await match('s','/tmp','local')).toBe(true);
  expect(await match('s','/tmp','worker')).toBe(false);
});
