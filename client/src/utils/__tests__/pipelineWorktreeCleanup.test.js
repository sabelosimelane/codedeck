import { describe, expect, it } from 'vitest';
import { describeBlockedCleanup } from '../pipelineWorktreeCleanup';

const DIRTY_SUMMARY = 'Worktree kept: it has uncommitted work. Commit or discard the files, then choose Clean up worktree.';

describe('describeBlockedCleanup', () => {
  it('replaces a dirty git refusal with a plain summary and lists its paths', () => {
    expect(describeBlockedCleanup("fatal: '/tmp/worktree' contains modified or untracked files, use --force to delete it\nnotes.txt\ntmp.out"))
      .toEqual({ summary: DIRTY_SUMMARY, paths: ['notes.txt', 'tmp.out'] });
  });

  it('keeps a single-line git refusal as its summary', () => {
    expect(describeBlockedCleanup('fatal: worktree is locked'))
      .toEqual({ summary: 'fatal: worktree is locked', paths: [] });
  });

  it('ignores blank lines and surrounding whitespace', () => {
    expect(describeBlockedCleanup('  fatal: dirty  \n\n  notes.txt  \n  \n tmp.out  \n'))
      .toEqual({ summary: DIRTY_SUMMARY, paths: ['notes.txt', 'tmp.out'] });
  });

  it.each([null, 42, '', ' \n  '])('rejects invalid detail %s', (detail) => {
    expect(() => describeBlockedCleanup(detail))
      .toThrow(new TypeError('worktree.detail must be a non-empty string'));
  });
});
