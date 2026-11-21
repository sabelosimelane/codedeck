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
  it('tells the last step of a run with notes that its note is the summary of the change', () => {
    const SUMMARY = "This is the run's last step, and the owner reads your note in their list of changes. Start the note with one line that says what this run changed, in plain words, then summarize what changed and why before anything else you record.";
    const def = { ...definition(false, step('Setup', { mode: 'once' }, 'setup'), step('Build'), step('Commit')), notesDir: '.codedeck/runs/abcdef12' };
    expect(buildStepGuidance(def, 2, OPTIONS)).toBe(`${BOUNDARY} Run notes: read .codedeck/runs/abcdef12/README.md before you start, and before your final signal write your note to .codedeck/runs/abcdef12/02-commit.md. ${SUMMARY}`);
    expect(buildStepGuidance(def, 1, OPTIONS)).not.toContain('list of changes');
    // Without run notes there is no note to read the summary from.
    expect(buildStepGuidance({ ...def, notesDir: null }, 2, OPTIONS)).toBe(BOUNDARY);
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
    expect(fixedLength).toBe(1251);
    expect(2000 - fixedLength).toBe(749); // room left for the worktree path
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


describe('buildStepGuidance attachment instructions', () => {
  const NOTES = '.codedeck/runs/abcdef12';
  const attachments = [
    { name: 'a.txt', path: `${NOTES}/attachments/01-a.txt`, sizeBytes: 1, digest: 'a'.repeat(64) },
  ];
  const POINT = `Attachments for this run are listed under Attachments in ${NOTES}/README.md and ${NOTES}/brief.md; open each checkout-relative path under ${NOTES}/attachments/.`;

  it('points Setup and every node at the attachment manifest when the run has files', () => {
    const def = { ...definition(true, step('Setup', { mode: 'once' }, 'setup'), step('Build')), notesDir: NOTES };
    expect(buildStepGuidance(def, 0, { ...OPTIONS, attachments })).toBe(POINT);
    expect(buildStepGuidance(def, 1, { ...OPTIONS, attachments })).toContain(POINT);
    expect(buildStepGuidance(def, 1, { ...OPTIONS, attachments })).toContain(BOUNDARY);
  });

  it('leaves Setup silent and omits the instruction for attachment-free runs', () => {
    const def = { ...definition(true, step('Setup', { mode: 'once' }, 'setup'), step('Build')), notesDir: NOTES };
    expect(buildStepGuidance(def, 0, OPTIONS)).toBeUndefined();
    expect(buildStepGuidance(def, 0, { ...OPTIONS, attachments: [] })).toBeUndefined();
    expect(buildStepGuidance(def, 1, OPTIONS)).not.toContain('Attachments for this run');
    expect(buildStepGuidance(def, 1, { ...OPTIONS, attachments: [] })).not.toContain('Attachments for this run');
  });

  it('counts the attachment instruction inside the existing guidance bound', () => {
    const def = { ...definition(true, { ...step('Analyse'), readOnly: true, approval: true }), notesDir: NOTES };
    const withAttachments = buildStepGuidance(def, 0, {
      ...OPTIONS,
      feedbackPath: `${NOTES}/00-analyse.feedback.md`,
      attachments,
    });
    expect(withAttachments).toContain(POINT);
    expect(withAttachments.length).toBeLessThanOrEqual(4000);
    expect(withAttachments).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(withAttachments.split('\n')).toHaveLength(1);
  });
});

describe('buildStepGuidance for a task or a project with several repositories', () => {
  const FOLDER = '/group/worktrees/replies-7a000000';
  const places = {
    current: 'mobile-app',
    worktrees: [{ repository: 'mobile-app', path: `${FOLDER}/mobile-app` }, { repository: 'backend', path: `${FOLDER}/backend` }],
    readOnly: [{ repository: 'frontend', path: '/group/worktrees/frontend-main' }],
  };
  const options = { worktreePath: `${FOLDER}/mobile-app`, places };
  const def = definition(false, step('Develop'));

  it('names every worktree of the task as a place to work, and the other repositories as places to read', () => {
    expect(buildStepGuidance(def, 0, options)).toBe(
      `Work only inside this task's worktrees: mobile-app at ${FOLDER}/mobile-app, backend at ${FOLDER}/backend. Your current directory is the mobile-app one. `
      + 'Each is a separate Git repository on its own branch: run Git inside the worktree it concerns, commit each separately and switch no branch. '
      + 'Do not create, change or delete files anywhere else. '
      + 'These repositories of the project are not part of this task: frontend at /group/worktrees/frontend-main. Read them there when a document refers to them and never change them. '
      + 'If a repository that is not part of this task must change, or the files of the task are in none of these places, use NEEDS_INPUT and say what is missing.',
    );
  });

  it('says only what applies: one worktree with other repositories to read, or several worktrees and nothing else', () => {
    const one = buildStepGuidance(def, 0, { worktreePath: '/group/backend', places: { current: 'backend', worktrees: [{ repository: 'backend', path: '/group/backend' }], readOnly: [{ repository: 'mobile-app', path: '/group/mobile-app' }] } });
    expect(one).toBe(
      "Work only inside this run's worktree, /group/backend, which is your current directory and the backend repository. Do not create, change or delete files outside it. "
      + 'These repositories of the project are not part of this run: mobile-app at /group/mobile-app. Read them there when a document refers to them and never change them. '
      + 'If a repository that is not part of this run must change, or the files of the task are in none of these places, use NEEDS_INPUT and say what is missing.',
    );
    const several = buildStepGuidance(def, 0, { ...options, places: { ...places, readOnly: [] } });
    expect(several).not.toContain('are not part of this task:');
    expect(several).toContain('If a repository that is not part of this task must change, or the files of the task are in none of these places, use NEEDS_INPUT');
  });

  it('keeps the sentence a run always had where there is one repository and nothing else to name', () => {
    const single = { current: 'demo', worktrees: [{ repository: 'demo', path: '/tmp/worktrees/run' }], readOnly: [] };
    expect(buildStepGuidance(def, 0, { worktreePath: '/tmp/worktrees/run', places: single })).toBe(BOUNDARY);
    expect(buildStepGuidance(def, 0, { worktreePath: '/tmp/worktrees/run' })).toBe(BOUNDARY);
  });

  it('tells a read-only step to change nothing in any of the task\'s worktrees', () => {
    const readOnly = { ...definition(false, { ...step('Review'), readOnly: true }), notesDir: '.codedeck/runs/abcdef12' };
    expect(buildStepGuidance(readOnly, 0, options)).toContain("This step is read-only: change nothing in any of the task's worktrees except files in the run notes folder, .codedeck/runs/abcdef12.");
    expect(buildStepGuidance({ ...readOnly, notesDir: null }, 0, options)).toContain("This step is read-only: change nothing in any of the task's worktrees.");
  });

  it.each([
    ['places that are not an object', 'x'],
    ['no current repository', { worktrees: places.worktrees, readOnly: [] }],
    ['no worktrees', { current: 'mobile-app', worktrees: [], readOnly: [] }],
    ['a worktree without a path', { current: 'mobile-app', worktrees: [{ repository: 'mobile-app' }], readOnly: [] }],
    ['a relative path', { current: 'mobile-app', worktrees: [{ repository: 'mobile-app', path: 'x' }], readOnly: [] }],
    ['a current repository that is not one of the worktrees', { current: 'frontend', worktrees: places.worktrees, readOnly: [] }],
    ['a current worktree that is not the working directory', { current: 'backend', worktrees: places.worktrees, readOnly: [] }],
    ['read-only places that are not a list', { current: 'mobile-app', worktrees: places.worktrees, readOnly: 'x' }],
    ['a read-only place without a name', { current: 'mobile-app', worktrees: places.worktrees, readOnly: [{ path: '/x' }] }],
  ])('refuses %s', (_name, value) => {
    expect(() => buildStepGuidance(def, 0, { worktreePath: `${FOLDER}/mobile-app`, places: value })).toThrow(/step guidance: places/);
  });
});
