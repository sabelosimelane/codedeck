import { describe, expect, it } from 'vitest';
import { buildStepGuidance } from '../pipelines/step-guidance.js';

const agent = { id: 'c410a1b2-3456-4789-8abc-def012345678', name: 'codex', launchCommand: 'codex', resetCommand: '/clear' };
const step = (name, repeat = { mode: 'once' }, kind = 'node') => ({ kind, name, prompt: `do ${name}`, repeat, agent });
const definition = (agentsDecide, ...steps) => ({
  workflowId: 'a2d0b1c2-3456-4789-8abc-def012345678', workflowName: 'Feature', workflowRevision: 1, agentsDecide, notesDir: null, steps,
});
const loop = toStepIndex => ({ mode: 'loop_back', toStepIndex, max: 20 });

const LOOP = 'This step closes a loop: CodeDeck repeats the steps from "Develop" to "Test" in order, round after round. Use COMPLETE only when the whole task is finished and no step of the loop has work left; use CONTINUE when another round is needed.';
const DECIDE = 'The owner is not available during this run. Do not stop for a decision you can make yourself: choose the option you would recommend, write down the decision and your reason where this project keeps such notes, and continue. Use NEEDS_INPUT only when you cannot continue at all.';
const OPTIONS = { worktreePath: '/tmp/worktrees/run' };
const BOUNDARY = "Work only inside this run's worktree, /tmp/worktrees/run, which is your current directory. Do not create, change or delete files outside it. You may read files outside it that your instructions, your skills or the project's documents refer to. If the files of the task itself are not in the worktree, do not look for them in other repositories: use NEEDS_INPUT and say what is missing.";

describe('buildStepGuidance', () => {
  it('places feedback and read-only rules after notes', () => {
    const def = { ...definition(false, { ...step('Analyse'), readOnly: true, approval: true }), notesDir: '.codedeck/runs/abcdef12' };
    const guidance = buildStepGuidance(def, 0, { ...OPTIONS, feedbackPath: '.codedeck/runs/abcdef12/00-analyse.feedback.md' });
    expect(guidance).toContain('The owner sent this step back: read .codedeck/runs/abcdef12/00-analyse.feedback.md before you start. This step is read-only: change nothing in the worktree except files in the run notes folder, .codedeck/runs/abcdef12.');
    expect(buildStepGuidance({ ...def, notesDir: null }, 0, OPTIONS)).toBe(`${BOUNDARY} This step is read-only: change nothing in the worktree.`);
  });
  it('places run notes directly after the worktree boundary', () => {
    const def = { ...definition(true, step('Setup', { mode: 'once' }, 'setup'), step('Build')), notesDir: '.codedeck/runs/abcdef12' };
    expect(buildStepGuidance(def, 0, OPTIONS)).toBeUndefined();
    expect(buildStepGuidance(def, 1, OPTIONS)).toContain(`${BOUNDARY} Run notes: read .codedeck/runs/abcdef12/README.md before you start, and before your final signal write your note to .codedeck/runs/abcdef12/01-build.md.`);
    expect(() => buildStepGuidance({ ...def, notesDir: undefined }, 1, OPTIONS)).toThrow(/notesDir/);
  });
  it('does not tell a step that always asks the owner to decide for them', () => {
    const def = definition(true, { ...step('Clarify'), askOwner: true }, step('Fix'));
    expect(buildStepGuidance(def, 0, OPTIONS)).toBe(BOUNDARY);
    expect(buildStepGuidance(def, 1, OPTIONS)).toBe(`${BOUNDARY} ${DECIDE}`);
  });
  it('gives boundary guidance to a plain node', () => {
    const def = definition(false, step('Develop'), step('Test', { mode: 'until_complete', max: 5 }));
    expect(buildStepGuidance(def, 0, OPTIONS)).toBe(BOUNDARY);
    expect(buildStepGuidance(def, 1, OPTIONS)).toBe(BOUNDARY);
    expect(BOUNDARY).not.toContain('do not look for it elsewhere');
    expect(BOUNDARY.startsWith("Work only inside this run's worktree")).toBe(true);
  });

  it('tells the step that closes a loop what COMPLETE and CONTINUE mean for the loop', () => {
    const def = definition(false, step('Setup', { mode: 'until_complete', max: 3 }, 'setup'), step('Develop'), step('Test', loop(1)), step('Review'));
    expect(buildStepGuidance(def, 2, OPTIONS)).toBe(`${BOUNDARY} ${LOOP}`);
    // The steps inside and after the loop get nothing.
    expect(buildStepGuidance(def, 1, OPTIONS)).toBe(BOUNDARY);
    expect(buildStepGuidance(def, 3, OPTIONS)).toBe(BOUNDARY);
  });

  it('tells every node, but not Setup, to decide for itself when agents decide', () => {
    const def = definition(true, step('Setup', { mode: 'until_complete', max: 3 }, 'setup'), step('Develop'), step('Review'));
    expect(buildStepGuidance(def, 0, OPTIONS)).toBeUndefined();
    expect(buildStepGuidance(def, 1, OPTIONS)).toBe(`${BOUNDARY} ${DECIDE}`);
    expect(buildStepGuidance(def, 2, OPTIONS)).toBe(`${BOUNDARY} ${DECIDE}`);
  });

  it('gives both to a step that closes a loop in a workflow whose agents decide', () => {
    const def = definition(true, step('Develop'), step('Test', loop(0)));
    expect(buildStepGuidance(def, 1, OPTIONS)).toBe(`${BOUNDARY} ${LOOP} ${DECIDE}`);
  });

  it('stays on one line and within what the loop engine accepts, whatever the step names', () => {
    const long = 'N'.repeat(64);
    const def = definition(true, step(long), step(`${long}2`.slice(0, 64), loop(0)));
    const guidance = buildStepGuidance(def, 1, OPTIONS);
    expect(guidance.length).toBeLessThanOrEqual(2000);
    const fixedLength = guidance.length - OPTIONS.worktreePath.length;
    expect(fixedLength).toBe(1000);
    expect(2000 - fixedLength).toBe(1000); // characters left for the worktree path
    expect(guidance).not.toMatch(/[\x00-\x1f\x7f]/);
  });
  it('includes read-only and feedback text in the worst-case guidance budget', () => {
    const def = { ...definition(true, { ...step('Analyse'), readOnly: true, approval: true }), notesDir: '.codedeck/runs/abcdef12' };
    const plain = buildStepGuidance(def, 0, OPTIONS);
    const worst = buildStepGuidance(def, 0, { ...OPTIONS, feedbackPath: '.codedeck/runs/abcdef12/00-analyse.feedback.md' });
    expect(worst.length).toBeGreaterThan(plain.length);
    expect(worst.length).toBeLessThanOrEqual(2000);
    const fixedLength = worst.length - OPTIONS.worktreePath.length;
    expect(fixedLength).toBe(1019);
    expect(2000 - fixedLength).toBe(981); // room left for the worktree path
    expect(worst).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it.each([
    ['a definition that is not an object', null, 0, 'step guidance: definition must be an object'],
    ['a definition without steps', { agentsDecide: false }, 0, 'step guidance: definition.steps must be an array'],
    ['a definition without agentsDecide', { steps: [step('Develop')] }, 0, 'step guidance: definition.agentsDecide must be true or false'],
    ['a step index out of range', definition(false, step('Develop')), 1, 'step guidance: stepIndex 1 is not a step of the definition'],
    ['a fractional step index', definition(false, step('Develop')), 0.5, 'step guidance: stepIndex 0.5 is not a step of the definition'],
    ['a loop whose first step is missing', definition(false, step('Develop'), step('Test', loop(5))), 1, 'step guidance: step 1 loops back to step 5, which is not an earlier step'],
  ])('throws on %s', (_label, def, index, message) => {
    expect(() => buildStepGuidance(def, index, OPTIONS)).toThrow(message);
  });

  it.each([undefined, {}, Object.assign([], OPTIONS), { worktreePath: '' }, { worktreePath: 'relative' }, { worktreePath: 12 }])('rejects invalid worktree options %s', options => {
    expect(() => buildStepGuidance(definition(false, step('Develop')), 0, options)).toThrow('worktreePath must be a non-empty absolute path');
  });
});
