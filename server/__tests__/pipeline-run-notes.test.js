import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { noteFileName, notePath, feedbackPath, writeFeedback, buildReadme, prepare, readNote, briefPath, buildBrief, writeBrief } from '../pipelines/run-notes.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function repo() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.run-notes-test-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  await fs.writeFile(path.join(root, 'tracked'), 'x');
  execFileSync('git', ['-C', root, 'add', 'tracked']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
  return root;
}
async function outsideDir() {
  const outside = await fs.mkdtemp(path.join(process.cwd(), '.run-notes-outside-'));
  roots.push(outside);
  return outside;
}
const runFolder = root => path.join(root, definition.notesDir);
const readmePath = root => path.join(runFolder(root), 'README.md');
const temporaryFiles = async root => (await fs.readdir(runFolder(root))).filter(name => name.endsWith('.tmp'));

const definition = {
  workflowName: 'General workflow',
  notesDir: '.codedeck/runs/abcdef12',
  steps: [
    { kind: 'setup', role: '', askOwner: false, name: 'Setup', agent: { name: 'Claude' } },
    { kind: 'node', role: '', askOwner: false, name: 'Build things', agent: { name: 'Codex' } },
  ],
};

describe('run notes', () => {
  const feedback = [{ verdict: 'sent_back', comment: 'Please revise', createdAt: '2026-11-17T10:00:00.000Z' }];
  it.each(['symbolic', 'hard'])('replaces a %s-linked feedback file without changing its outside target', async kind => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    const outside = path.join(await outsideDir(), 'target');
    const target = path.join(root, feedbackPath(definition, 1));
    await fs.writeFile(outside, 'outside');
    if (kind === 'symbolic') await fs.symlink(outside, target);
    else await fs.link(outside, target);
    await writeFeedback({ worktreePath: root, definition, stepIndex: 1, reviews: feedback });
    expect(await fs.readFile(outside, 'utf8')).toBe('outside');
    expect((await fs.lstat(target)).isFile()).toBe(true);
    expect((await fs.stat(target)).nlink).toBe(1);
    expect(await fs.readFile(target, 'utf8')).toContain('Please revise');
    expect(await temporaryFiles(root)).toEqual([]);
  });
  it.each(['.codedeck/runs', definition.notesDir])('rejects feedback through linked folder %s', async relative => {
    const root = await repo();
    const outside = await outsideDir();
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.symlink(outside, path.join(root, relative));
    await expect(writeFeedback({ worktreePath: root, definition, stepIndex: 1, reviews: feedback }))
      .rejects.toThrow(`Run notes folder ${definition.notesDir} leaves the worktree`);
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('returns null without writing when there are no send-backs', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    expect(await writeFeedback({ worktreePath: root, definition, stepIndex: 1, reviews: [] })).toBeNull();
    await expect(fs.stat(path.join(root, feedbackPath(definition, 1)))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps the same feedback inode for identical content and removes temporary files after rename failure', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    const target = path.join(root, feedbackPath(definition, 1));
    await writeFeedback({ worktreePath: root, definition, stepIndex: 1, reviews: feedback });
    const first = await fs.stat(target);
    await writeFeedback({ worktreePath: root, definition, stepIndex: 1, reviews: feedback });
    expect((await fs.stat(target)).ino).toBe(first.ino);
    const failingFs = { ...fs, rename: async () => { throw new Error('rename failed'); } };
    await expect(writeFeedback({ worktreePath: root, definition, stepIndex: 1,
      reviews: [{ ...feedback[0], comment: 'Changed' }], fs: failingFs })).rejects.toThrow('rename failed');
    expect(await fs.readFile(target, 'utf8')).toContain('Please revise');
    expect(await temporaryFiles(root)).toEqual([]);
  });
  it('writes ordered send-back feedback inside the ignored notes folder and rewrites it deterministically', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    const reviews = [
      { verdict: 'sent_back', comment: 'First', createdAt: '2026-11-17T10:00:00.000Z' },
      { verdict: 'sent_back', comment: 'Second\nline', createdAt: '2026-11-17T11:00:00.000Z' },
    ];
    expect(await writeFeedback({ worktreePath: root, definition, stepIndex: 1, reviews })).toBe(feedbackPath(definition, 1));
    const target = path.join(root, feedbackPath(definition, 1));
    expect(await fs.readFile(target, 'utf8')).toContain('First');
    expect((await fs.readFile(target, 'utf8')).indexOf('First')).toBeLessThan((await fs.readFile(target, 'utf8')).indexOf('Second'));
    await fs.writeFile(target, 'stale');
    await writeFeedback({ worktreePath: root, definition, stepIndex: 1, reviews });
    expect(await fs.readFile(target, 'utf8')).toContain('Second\nline');
  });
  it('makes bounded, deterministic file names', () => {
    expect(noteFileName(1, 'Build things')).toBe('01-build-things.md');
    expect(noteFileName(2, 'É #')).toBe('02-step.md');
    expect(noteFileName(3, 'A'.repeat(64))).toBe(`03-${'a'.repeat(32)}.md`);
  });
  it('only gives node steps a note path', () => {
    expect(notePath(definition, 0)).toBeNull();
    expect(notePath(definition, 1)).toBe('.codedeck/runs/abcdef12/01-build-things.md');
    expect(notePath({ ...definition, notesDir: null }, 1)).toBeNull();
  });
  it('describes every step and its handoff', () => {
    const readme = buildReadme(definition, 'do a thing');
    expect(readme).toContain(`${definition.notesDir}/plan.md`);
    expect(readme).toContain('do a thing');
    expect(readme).toContain('01-build-things.md');
    expect(readme).toContain('Setup');
    expect(readme).toBe(buildReadme(definition, 'do a thing'));
  });
  it('lists the repositories of the task and of the project when there is more than one to tell apart', () => {
    const places = {
      current: 'mobile-app',
      worktrees: [{ repository: 'mobile-app', path: '/group/worktrees/replies/mobile-app' }, { repository: 'backend', path: '/group/worktrees/replies/backend' }],
      readOnly: [{ repository: 'frontend', path: '/group/worktrees/frontend-main' }],
    };
    const readme = buildReadme(definition, 'do a thing', places);
    expect(readme).toContain([
      '## Repositories',
      '',
      '- mobile-app — part of this task, your current directory — /group/worktrees/replies/mobile-app',
      '- backend — part of this task — /group/worktrees/replies/backend',
      '- frontend — not part of this task: read only, never change — /group/worktrees/frontend-main',
      '',
      'A reference in a document to one of these repositories means the path given here. If a repository that is not part of this task must change, use NEEDS_INPUT.',
    ].join('\n'));
    // One repository and nothing else to name: the notes say what they always said.
    const single = { current: 'demo', worktrees: [{ repository: 'demo', path: '/tmp/run' }], readOnly: [] };
    expect(buildReadme(definition, 'do a thing', single)).toBe(buildReadme(definition, 'do a thing'));
    expect(() => buildReadme(definition, 'do a thing', { current: 'x', worktrees: 'no', readOnly: [] })).toThrow(/places/);
  });
  it('rejects bad arguments', () => {
    expect(() => noteFileName(-1, 'Build')).toThrow(/stepIndex/);
    expect(() => noteFileName(1, null)).toThrow(/stepName/);
    expect(() => notePath({ ...definition, notesDir: '../bad' }, 1)).toThrow(/notesDir/);
    expect(() => buildReadme(definition, null)).toThrow(/input/);
  });
  it('requires the file reader at the read edge', async () => {
    await expect(readNote({ worktreePath: process.cwd(), definition, stepIndex: 1, fs: { stat() {}, realpath() {}, open() {} } })).rejects.toThrow(/fs/);
  });
  it('prepares an ignored README without making the worktree dirty', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: 'do a thing' });
    expect(await fs.readFile(path.join(root, '.codedeck/.gitignore'), 'utf8')).toBe('*\n');
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    await prepare({ worktreePath: root, definition, input: 'second input' });
    expect(await fs.readFile(path.join(root, definition.notesDir, 'README.md'), 'utf8')).toContain('second input');
  });
  it('preserves an existing ignore file and refuses tracked .codedeck content', async () => {
    const root = await repo();
    await fs.mkdir(path.join(root, '.codedeck'));
    await fs.writeFile(path.join(root, '.codedeck/.gitignore'), '*\n# keep\n');
    await prepare({ worktreePath: root, definition, input: '' });
    expect(await fs.readFile(path.join(root, '.codedeck/.gitignore'), 'utf8')).toBe('*\n# keep\n');
    await fs.writeFile(path.join(root, '.codedeck/tracked'), 'keep');
    execFileSync('git', ['-C', root, 'add', '-f', '.codedeck/tracked']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'track notes']);
    await expect(prepare({ worktreePath: root, definition, input: '' })).rejects.toThrow(`Run notes folder ${definition.notesDir} is not ignored by git in this worktree`);
  });
  it('rejects an existing ignore file that does not ignore notes without changing it or tracking notes', async () => {
    const root = await repo();
    const dotPath = path.join(root, '.codedeck');
    const ignorePath = path.join(dotPath, '.gitignore');
    const original = Buffer.from('# keep this comment\n');
    await fs.mkdir(dotPath);
    await fs.writeFile(ignorePath, original);
    await expect(prepare({ worktreePath: root, definition, input: '' }))
      .rejects.toThrow(`Run notes folder ${definition.notesDir} is not ignored by git in this worktree`);
    expect(await fs.readFile(ignorePath)).toEqual(original);
    expect(execFileSync('git', ['-C', root, 'ls-files', '--', '.codedeck'], { encoding: 'utf8' })).toBe('');
  });
  it('surfaces a git check-ignore failure other than exit 1', async () => {
    const root = await repo();
    const failingGit = (command, args, options, callback) => {
      if (args.includes('check-ignore')) {
        const error = new Error('git check-ignore failed: repository unavailable');
        error.code = 128;
        callback(error, '', 'repository unavailable');
      } else import('node:child_process').then(({ execFile }) => execFile(command, args, options, callback));
    };
    await expect(prepare({ worktreePath: root, definition, input: '', execFile: failingGit })).rejects.toThrow(/repository unavailable/);
  });
  it('reads notes only inside the worktree and enforces the size boundary', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    const target = path.join(root, notePath(definition, 1));
    expect(await readNote({ worktreePath: root, definition, stepIndex: 1 })).toEqual({ status: 'missing', content: null });
    await fs.writeFile(target, 'x'.repeat(262_144));
    expect((await readNote({ worktreePath: root, definition, stepIndex: 1 })).status).toBe('present');
    await fs.appendFile(target, 'x');
    expect((await readNote({ worktreePath: root, definition, stepIndex: 1 })).status).toBe('too_large');
    await fs.rm(target);
    await fs.symlink(path.join(process.cwd(), 'package.json'), target);
    expect((await readNote({ worktreePath: root, definition, stepIndex: 1 })).status).toBe('unreadable');
  });
  it('refuses a note symlink even when it points inside the worktree', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    const ordinary = path.join(root, definition.notesDir, 'ordinary.md');
    await fs.writeFile(ordinary, '# Ordinary');
    await fs.symlink(ordinary, path.join(root, notePath(definition, 1)));
    expect((await readNote({ worktreePath: root, definition, stepIndex: 1 })).status).toBe('unreadable');
  });
  it('rejects a .codedeck symlink before creating anything outside', async () => {
    const root = await repo();
    const outside = await outsideDir();
    await fs.symlink(outside, path.join(root, '.codedeck'));
    await expect(prepare({ worktreePath: root, definition, input: '' })).rejects.toThrow(`Run notes folder ${definition.notesDir} leaves the worktree`);
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('rejects a runs symlink before creating a run folder outside', async () => {
    const root = await repo();
    const outside = await outsideDir();
    await fs.mkdir(path.join(root, '.codedeck'));
    await fs.symlink(outside, path.join(root, '.codedeck/runs'));
    await expect(prepare({ worktreePath: root, definition, input: '' })).rejects.toThrow(`Run notes folder ${definition.notesDir} leaves the worktree`);
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('replaces a README symlink without changing its target', async () => {
    const root = await repo();
    const outside = path.join(await outsideDir(), 'target');
    await fs.writeFile(outside, 'outside');
    await fs.mkdir(path.join(root, definition.notesDir), { recursive: true });
    await fs.symlink(outside, readmePath(root));
    await prepare({ worktreePath: root, definition, input: '' });
    expect(await fs.readFile(outside, 'utf8')).toBe('outside');
    expect((await fs.lstat(readmePath(root))).isFile()).toBe(true);
    expect(await fs.readFile(readmePath(root), 'utf8')).toBe(buildReadme(definition, ''));
    expect(await temporaryFiles(root)).toEqual([]);
  });
  it('replaces a hard-linked README without changing its other link', async () => {
    const root = await repo();
    const outside = path.join(await outsideDir(), 'target');
    await fs.writeFile(outside, 'outside');
    await fs.mkdir(runFolder(root), { recursive: true });
    await fs.link(outside, readmePath(root));
    await prepare({ worktreePath: root, definition, input: '' });
    expect(await fs.readFile(outside, 'utf8')).toBe('outside');
    expect((await fs.stat(readmePath(root))).nlink).toBe(1);
    expect(await fs.readFile(readmePath(root), 'utf8')).toBe(buildReadme(definition, ''));
  });
  it('rejects a symlinked .gitignore without changing its target', async () => {
    const root = await repo();
    const outside = path.join(await outsideDir(), 'target');
    await fs.writeFile(outside, '*\n');
    await fs.mkdir(path.join(root, '.codedeck'));
    await fs.symlink(outside, path.join(root, '.codedeck/.gitignore'));
    await expect(prepare({ worktreePath: root, definition, input: '' })).rejects.toThrow(`Run notes folder ${definition.notesDir} leaves the worktree`);
    expect(await fs.readFile(outside, 'utf8')).toBe('*\n');
  });
  it('cleans temporary README files on success, repeat, and rename failure', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: 'first' });
    expect(await temporaryFiles(root)).toEqual([]);
    await prepare({ worktreePath: root, definition, input: 'first' });
    expect(await temporaryFiles(root)).toEqual([]);
    const failingFs = { ...fs, rename: async () => { throw new Error('rename failed'); } };
    await expect(prepare({ worktreePath: root, definition, input: 'second', fs: failingFs })).rejects.toThrow('rename failed');
    expect(await temporaryFiles(root)).toEqual([]);
    expect(await fs.readFile(readmePath(root), 'utf8')).toBe(buildReadme(definition, 'first'));
  });
  it('does not read hard-linked notes', async () => {
    const root = await repo();
    const outside = path.join(await outsideDir(), 'secret');
    await fs.writeFile(outside, '# Secret note');
    await prepare({ worktreePath: root, definition, input: '' });
    const target = path.join(root, notePath(definition, 1));
    await fs.link(outside, target);
    expect(await readNote({ worktreePath: root, definition, stepIndex: 1 })).toEqual({ status: 'unreadable', content: null });
    await fs.rm(target);
    await fs.writeFile(target, '# Normal note');
    expect(await readNote({ worktreePath: root, definition, stepIndex: 1 })).toEqual({ status: 'present', content: '# Normal note' });
  });
  it('never reads more than the measured file size', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    await fs.writeFile(path.join(root, notePath(definition, 1)), 'x');
    const fakeFs = { ...fs, readFile: async () => 'x'.repeat(262_145) };
    expect(await readNote({ worktreePath: root, definition, stepIndex: 1, fs: fakeFs })).toEqual({ status: 'present', content: 'x' });
  });
});

describe('the run brief', () => {
  const entries = [
    { by: 'owner', stepName: 'Clarify', pass: 1, questions: '1. Which page?\nRecommended: login', answer: 'The login page, on mobile', createdAt: '2026-11-18T10:00:00.000Z' },
    { by: 'agent', stepName: 'Fix', pass: 2, questions: '1. Keep the old column?\nRecommended: yes', answer: 'Proceed with your recommendations.', createdAt: '2026-11-18T10:05:00.000Z' },
    { by: 'owner', stepName: 'Fix', pass: 3, questions: null, answer: 'Yes', createdAt: '2026-11-18T10:06:00.000Z' },
  ];

  it('states the request and every question and answer, saying who answered', () => {
    const brief = buildBrief('Login fails on mobile', entries);
    expect(brief).toContain('## Request\n\nLogin fails on mobile');
    expect(brief).toContain('### Clarify, pass 1 — answered by the owner (2026-11-18T10:00:00.000Z)\n\n1. Which page?\nRecommended: login\n\nAnswer: The login page, on mobile');
    expect(brief).toContain('### Fix, pass 2 — decided by the agent, as the owner allowed');
    expect(brief).toContain('The agent asked without listing its questions.\n\nAnswer: Yes');
    expect(brief.indexOf('Clarify, pass 1')).toBeLessThan(brief.indexOf('Fix, pass 2'));
  });

  it('says when no input was given and leaves out the answers heading when there are none', () => {
    const brief = buildBrief('', []);
    expect(brief).toContain('No input was given when this run started.');
    expect(brief).not.toContain('## Questions and answers');
  });

  it.each([
    [['a\nb', []], /input/], [[12, []], /input/], [['x', null], /entries/],
    [['x', [{ ...entries[0], by: 'someone' }]], /entry.by/], [['x', [{ ...entries[0], stepName: '' }]], /stepName/],
    [['x', [{ ...entries[0], pass: 0 }]], /pass/], [['x', [{ ...entries[0], questions: 12 }]], /questions/],
    [['x', [{ ...entries[0], answer: ' ' }]], /answer/], [['x', [{ ...entries[0], createdAt: 'then' }]], /createdAt/],
  ])('refuses %j', (args, message) => {
    expect(() => buildBrief(...args)).toThrow(message);
  });

  it('writes the brief into the run notes folder, replaces it, and is ignored by git', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: 'Login fails' });
    expect(briefPath(definition)).toBe('.codedeck/runs/abcdef12/brief.md');
    expect(await writeBrief({ worktreePath: root, definition, input: 'Login fails', entries: [] })).toBe('.codedeck/runs/abcdef12/brief.md');
    await writeBrief({ worktreePath: root, definition, input: 'Login fails', entries });
    const written = await fs.readFile(path.join(root, briefPath(definition)), 'utf8');
    expect(written).toContain('Answer: The login page, on mobile');
    expect(await temporaryFiles(root)).toEqual([]);
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });

  it('does not follow a link out of the worktree, and writes nothing for a run without notes', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    const outside = path.join(await outsideDir(), 'target');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, path.join(root, briefPath(definition)));
    await writeBrief({ worktreePath: root, definition, input: 'x', entries: [] });
    expect(await fs.readFile(outside, 'utf8')).toBe('outside');
    expect(await writeBrief({ worktreePath: root, definition: { ...definition, notesDir: null }, input: 'x', entries: [] })).toBeNull();
    expect(briefPath({ ...definition, notesDir: null })).toBeNull();
    await expect(writeBrief({ worktreePath: 'relative', definition, input: 'x', entries: [] })).rejects.toThrow(/worktreePath/);
  });

  it('tells every step to read the brief', () => {
    expect(buildReadme(definition, 'x')).toContain("read this file, .codedeck/runs/abcdef12/brief.md (the owner's request and every question answered so far) and every earlier step note");
  });
});

it('lists the recorded base commit for each writable repository in the run README', () => {
  const definition = { workflowName: 'Bug fix', notesDir: '.codedeck/runs/abcdef12', steps: [] };
  const entry = { repository: 'phone', path: '/repo/phone', baseCommit: 'a'.repeat(40) };
  const places = { current: 'phone', worktrees: [entry], readOnly: [] };
  expect(buildReadme(definition, 'Watch', places)).toContain('phone — ' + entry.baseCommit);
  expect(() => buildReadme(definition, 'Watch', { ...places, worktrees: [{ ...entry, baseCommit: 'invalid' }] })).toThrow(/base commit/i);
});
