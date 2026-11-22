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
