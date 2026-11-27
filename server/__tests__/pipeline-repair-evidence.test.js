import { it, expect } from 'vitest';
import { execFile,execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repairFindings, sourceFingerprint } from '../pipelines/repair-evidence.js';

it('requires attributable, current-attempt repair findings and ignores earlier appended notes', () => {
  const note='REPAIR 1 AC1 | old.kt | missing focus\nREPAIR 2 AC2 | detector.kt | chord fails';
  expect(repairFindings(note,2)).toEqual(['AC2 | detector.kt | chord fails']);
  expect(()=>repairFindings(note,3)).toThrow(/REPAIR 3/);
  expect(()=>repairFindings('REPAIR 2 AC1 | | failed',2)).toThrow(/path/);
});
it('fingerprints tracked and new sources on the selected host without run-note churn', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'workflow-source-'));
  try {
    const git = (...args)=>execFileSync('git',['-C',dir,...args],{stdio:'pipe'});
    git('init'); git('-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-m','base');
    const source=()=>sourceFingerprint([{path:dir,repository:'demo'}],execFile);
    await writeFile(path.join(dir,'.gitignore'),'.codedeck/\n');
    const clean=await source();
    await mkdir(path.join(dir,'.codedeck'));
    await writeFile(path.join(dir,'.codedeck','pass.md'),'new handoff');
    expect(await source()).toBe(clean);
    await writeFile(path.join(dir,'file.txt'),'one');
    const one=await source();
    expect(one).not.toBe(clean);
    await writeFile(path.join(dir,'file.txt'),'two');
    expect(await source()).not.toBe(one);
    git('add','file.txt');
    const staged=await source();
    await writeFile(path.join(dir,'file.txt'),'three');
    expect(await source()).not.toBe(staged);
  } finally { await rm(dir,{recursive:true}); }
});
it('accepts a detailed finding whose absolute path and reason together exceed 500 characters', () => {
  const file=`/Users/dev/git/app/worktrees/sos-shortcut-ceb9a7fb/mobile-app/app/src/main/java/com/example/app/${'a'.repeat(30)}/MainActivity.kt`;
  const reason=`Regression: MainActivity.kt:107 casts application as App ${'x'.repeat(480)}`;
  expect(file.length).toBeGreaterThan(140);
  expect(reason.length).toBeGreaterThan(530);
  expect(repairFindings(`REPAIR 4 P2-1 | ${file} | ${reason}`,4)).toEqual([`P2-1 | ${file} | ${reason}`]);
});
it('names the field and its length when a repair path or reason is too long', () => {
  expect(()=>repairFindings(`REPAIR 4 P2-1 | /${'p'.repeat(1024)} | failed`,4)).toThrow(/P2-1.*path.*1025.*1024/);
  expect(()=>repairFindings(`REPAIR 4 P2-1 | a.kt | ${'r'.repeat(1001)}`,4)).toThrow(/P2-1.*reason.*1001.*1000/);
});
it('rejects control characters in a repair path or reason', () => {
  expect(()=>repairFindings('REPAIR 4 P2-1 | a\t.kt | failed',4)).toThrow(/P2-1.*path.*control/);
  expect(()=>repairFindings('REPAIR 4 P2-1 | a.kt | fail\x07ed',4)).toThrow(/P2-1.*reason.*control/);
});
it('rejects control characters at the edge of a repair path or reason', () => {
  expect(()=>repairFindings('REPAIR 4 P2-1 | \ta.kt | failed',4)).toThrow(/P2-1.*path.*control/);
  expect(()=>repairFindings('REPAIR 4 P2-1 | a.kt | failed\t',4)).toThrow(/P2-1.*reason.*control/);
});
it('keeps a pipe inside the reason verbatim and measures the reason as written', () => {
  expect(repairFindings('REPAIR 4 P2-1 | a.kt | expected A | got B',4)).toEqual(['P2-1 | a.kt | expected A | got B']);
  expect(()=>repairFindings(`REPAIR 4 P2-1 | a.kt | ${'a'.repeat(499)} | ${'b'.repeat(499)}`,4)).toThrow(/P2-1.*reason.*1001.*1000/);
});
it('rejects a reason made only of pipes', () => {
  expect(()=>repairFindings('REPAIR 4 P2-1 | a.kt | |',4)).toThrow(/P2-1 requires a failure/);
});
it('accepts many findings whose total exceeds 6000 characters, as a Test note listing 34 outstanding tasks did', () => {
  const lines=Array.from({length:34},(_,i)=>`REPAIR 3 T${i} | docs/todos/2026-11-26-trade-hub-b2-delivery.md | ${'outstanding task '.repeat(11)}${i}`);
  expect(lines.join('\n').length).toBeGreaterThan(6000);
  expect(repairFindings(lines.join('\n'),3)).toHaveLength(34);
});
