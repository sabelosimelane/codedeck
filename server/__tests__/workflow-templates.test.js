import { describe, expect, it } from 'vitest';
import { WORKFLOW_TEMPLATES, BUILT_IN_STEPS, buildTemplateDraft } from '../../shared/workflow-templates.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateStepPresetBody } from '../../shared/pipeline-definitions.mjs';
import { validateWorkflowBody, WORKFLOW_KINDS } from '../../shared/pipeline-definitions.mjs';

const AGENT = '11111111-1111-4111-8111-111111111111';
// The one built-in workflow that starts from a todo file that already exists: it reads its progress from that file and has no planning step.
const TODO_TEMPLATE = 'feature-build-from-spec';


describe('workflow templates', () => {
  it('ships the exact starting workflows and immutable definitions', () => {
    expect(WORKFLOW_TEMPLATES.map(({ id, name, kind, nodes }) => [id, name, kind, nodes.map(node => node.name)])).toEqual([
      ['bug-fix', 'Bug fix', 'bugfix', ['Clarify', 'Analyse', 'Specify', 'Develop', 'Review', 'Test', 'Commit']],
      ['quick-change', 'Quick change', 'build', ['Scope', 'Develop', 'Review & Test', 'Commit']],
      ['feature-build', 'Feature build', 'build', ['Plan', 'Develop', 'Review', 'Test', 'Commit']],
      ['feature-build-from-spec', 'Feature Build from Spec', 'build', ['Develop', 'Review', 'Test']],
      ['feature-from-requirements', 'Feature from requirements', 'build', ['Requirements', 'Specify', 'Develop', 'Review', 'Test', 'Commit']],
      ['troubleshoot', 'Troubleshoot', 'troubleshoot', ['Clarify', 'Investigate', 'Prove', 'Fix', 'Verify', 'Commit']],
      ['review-only', 'Review only', 'review', ['Survey', 'Review', 'Report']],
      ['brainstorm-to-spec', 'Brainstorm to spec', 'build', ['Brainstorm', 'Specify', 'Commit']],
    ]);
    expect(Object.isFrozen(WORKFLOW_TEMPLATES)).toBe(true);
    for (const template of WORKFLOW_TEMPLATES) {
      expect(Object.isFrozen(template)).toBe(true);
      expect(WORKFLOW_KINDS).toContain(template.kind);
      expect(template.description.trim().length).toBeGreaterThan(0);
      expect(template.description.length).toBeLessThanOrEqual(280);
      expect(template.nodes.every(node => Object.isFrozen(node) && Object.isFrozen(node.repeat))).toBe(true);
      expect(template.nodes[0].prompt).toContain('{input}');
      for (const node of template.nodes) {
        expect(node.role.trim()).not.toBe('');
        expect(node.role.length).toBeLessThanOrEqual(32);
        expect(node.prompt.length).toBeLessThanOrEqual(8192);
      }
      for (const node of template.nodes) expect(node.prompt).not.toMatch(/(?:^|\s)\/[\w-]+|\$[\w-]+/);
      if (template.id === TODO_TEMPLATE) continue;
      expect(template.agentsDecide).toBe(false);
      expect(template.progressFile).toBeNull();
      expect(template.nodes[0]).toMatchObject({ readOnly: true, repeat: { mode: 'once' } });
    }
  });

  it('gates the build and fix workflows on approval and ends them with a commit', () => {
    for (const id of ['bug-fix', 'feature-build']) {
      const template = WORKFLOW_TEMPLATES.find(item => item.id === id);
      expect(template.nodes.some(node => node.readOnly && node.approval)).toBe(true);
      expect(template.nodes.at(-1)).toMatchObject({ name: 'Commit', repeat: { mode: 'once' } });
      expect(template.nodes.find(node => node.name === 'Test').repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: 8 });
    }
    const bugFix = WORKFLOW_TEMPLATES.find(item => item.id === 'bug-fix');
    const featureBuild = WORKFLOW_TEMPLATES.find(item => item.id === 'feature-build');
    expect(bugFix.nodes.find(node => node.name === 'Analyse')).toMatchObject({ readOnly: true, approval: false });
    expect(bugFix.nodes.find(node => node.name === 'Specify')).toMatchObject({ readOnly: true, approval: true });
    expect(featureBuild.nodes[0].prompt).toContain('plan.md');
  });

  it('plans a bug fix in phases sized to its rounds and flags a fix that has outgrown a bug fix', () => {
    const byName = Object.fromEntries(WORKFLOW_TEMPLATES.find(item => item.id === 'bug-fix').nodes.map(node => [node.name, node]));
    // Specify agrees the checks and splits them into phases; a fix that will not fit is flagged before the owner approves it.
    expect(byName.Specify.prompt).toMatch(/Write plan\.md in the run notes folder/);
    expect(byName.Specify.prompt).toMatch(/Size the plan to the fix/);
    expect(byName.Specify.prompt).toMatch(/never a phase that only checks or adds tests/);
    expect(byName.Specify.prompt).toMatch(/at most 4 phases/);
    expect(byName.Specify.prompt).toMatch(/The phases together must cover every agreed check/);
    expect(byName.Specify.prompt).toMatch(/Scope warning:/);
    expect(byName.Specify.prompt).toMatch(/feature workflow/);
    // Develop builds one whole phase per round, never a slice of it.
    expect(byName.Develop.prompt).toMatch(/first phase in plan\.md with unticked tasks/);
    expect(byName.Develop.prompt).toMatch(/all of that phase, not a slice of it/);
    expect(byName.Develop.prompt).toMatch(/tick each task when done/);
    expect(byName.Develop.prompt).toMatch(/do not run git commit/);
    expect(byName.Develop.prompt).not.toMatch(/as small as/);
    expect(byName.Review.prompt).toMatch(/against plan\.md and the Specify note/);
    // Test keeps the bug-fix verification rules and works a phase per round, with two rounds per phase.
    expect(byName.Test.prompt).toMatch(/Untick any task in plan\.md that does not hold/);
    expect(byName.Test.prompt).toMatch(/only the tests for that phase/);
    expect(byName.Test.prompt).toMatch(/full test suite once/);
    expect(byName.Test.prompt).toMatch(/focused/);
    expect(byName.Test.prompt).toMatch(/per changed repository/);
    expect(byName.Test.prompt).toMatch(/run the same command on the recorded base commit/);
    expect(byName.Test.repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: 8 });
  });

  it('troubleshoots by evidence, an approved hypothesis and a failing test before any fix', () => {
    const template = WORKFLOW_TEMPLATES.find(item => item.id === 'troubleshoot');
    const byName = Object.fromEntries(template.nodes.map(node => [node.name, node]));
    expect(byName.Investigate.prompt).toMatch(/evidence against/);
    expect(byName.Investigate).toMatchObject({ readOnly: true, approval: true });
    expect(byName.Prove).toMatchObject({ readOnly: false });
    expect(byName.Prove.prompt).toMatch(/Investigate note/);
    expect(byName.Prove.prompt).toMatch(/Change no production code/);
    expect(byName.Fix.prompt).toMatch(/Do not weaken or delete the test/);
    expect(byName.Verify.repeat).toEqual({ mode: 'loop_back', to: 'Fix', max: 3 });
    expect(template.nodes.at(-1).name).toBe('Commit');
  });

  it.each([['bug-fix', 'Specify', 'Test'], ['quick-change', 'Scope', 'Review & Test'], ['troubleshoot', 'Clarify', 'Verify']])('records acceptance and reserves evidence decisions for the owner in %s', (id, source, check) => {
    const { nodes } = buildTemplateDraft(id);
    expect(nodes.find(node => node.name === source).prompt).toMatch(/agreed acceptance checks/i);
    const verify = nodes.find(node => node.name === check);
    expect(verify.askOwner).toBe(true);
    for (const term of ['CONTINUE', 'base commit', 'equivalent conditions', 'smallest comparison', 'NEEDS_INPUT', 'COMPLETE', 'owner', 'evidence for each']) {
      expect(verify.prompt).toContain(term);
    }
    expect(nodes.at(-1).prompt).toMatch(/owner-approved/);
  });

  it.each([['bug-fix', 'Specify', 'Test'], ['quick-change', 'Scope', 'Review & Test'], ['troubleshoot', 'Clarify', 'Verify']])('has %s agree how an agent verifies each check, and leaves only owner-only checks to the owner without waiting for them', (id, source, check) => {
    const { nodes } = buildTemplateDraft(id);
    const agreed = nodes.find(node => node.name === source).prompt;
    expect(agreed).toContain('say how an agent will verify it itself on this machine');
    expect(agreed).toContain('Mark a check owner-only only when it needs what no agent here can have (a physical device, a real account or recipient, production)');
    expect(agreed).toContain('under the heading Owner checks');
    expect(agreed).toContain('no step waits for them');
    expect(agreed).not.toContain('need external evidence');
    const verify = nodes.find(node => node.name === check).prompt;
    expect(verify).toContain('Set up what a check needs yourself');
    expect(verify).toContain('do not ask the owner for an environment or for evidence you can produce');
    expect(verify).toContain('An owner-only check does not wait');
    expect(verify).toContain('use NEEDS_INPUT once, say what you tried, and ask whether it becomes an owner check');
    expect(verify).toContain('was marked owner-only when the checks were agreed or by the owner since');
    expect(verify).not.toContain('proof needs a device, account or other external access');
    expect(nodes.at(-1).prompt).toContain('under the heading Owner checks, every check the owner still has to carry out');
  });

  it.each(['feature-build', 'feature-from-requirements'])('%s keeps owner-only checks out of the plan\'s tasks and never waits for them', (id) => {
    const byName = Object.fromEntries(WORKFLOW_TEMPLATES.find(item => item.id === id).nodes.map(node => [node.name, node]));
    const planner = (byName.Plan ?? byName.Specify).prompt;
    expect(planner).toContain('Say in each such task how an agent will verify it itself on this machine');
    expect(planner).toContain('is owner-only and is not a task: list it under ## Owner checks at the end of plan.md as a plain bullet without a box');
    expect(planner).toContain('no step waits for them');
    expect(byName.Test.prompt).toContain('Set up what a check needs yourself');
    expect(byName.Test.prompt).toContain('The Owner checks in plan.md do not wait');
    expect(byName.Test.prompt).toContain('use NEEDS_INPUT once');
    expect(byName.Test.prompt).not.toContain('waiting for owner evidence');
    expect(byName.Commit.prompt).toContain('under the heading Owner checks, every check the owner still has to carry out');
  });

  it('opens the fix and troubleshoot workflows by checking the report and required repositories, asking the owner only for what is missing', () => {
    for (const id of ['bug-fix', 'troubleshoot']) {
      const first = WORKFLOW_TEMPLATES.find(item => item.id === id).nodes[0];
      expect(first).toMatchObject({ name: 'Clarify', readOnly: true, approval: false, askOwner: true, repeat: { mode: 'once' } });
      expect(first.prompt).toMatch(/First look for each of these yourself/);
      expect(first.prompt).toMatch(/referenced or read-only repository must change/);
      expect(first.prompt).toMatch(/Ask nothing you could find out yourself, and when nothing is missing ask nothing/);
    }
    for (const id of ['feature-build', 'review-only']) {
      const template = WORKFLOW_TEMPLATES.find(item => item.id === id);
      expect(template.nodes.some(node => node.name === 'Clarify')).toBe(false);
      expect(template.nodes.every(node => node.askOwner === false)).toBe(true);
    }
  });

  it('ships Clarify and Requirements as steps that can be inserted into any workflow', () => {
    expect(BUILT_IN_STEPS.map(step => [step.id, step.name, step.askOwner, step.readOnly])).toEqual([
      ['clarify', 'Clarify', true, true],
      ['requirements', 'Requirements', true, true],
    ]);
    expect(Object.isFrozen(BUILT_IN_STEPS)).toBe(true);
    for (const step of BUILT_IN_STEPS) {
      expect(Object.isFrozen(step)).toBe(true);
      const { id, ...body } = step;
      expect(validateStepPresetBody(body)).toEqual([]);
    }
  });

  it.each(['feature-build', 'feature-from-requirements'])('%s sizes its plan to the change and runs the full suite once, at the end', (id) => {
    const byName = Object.fromEntries(WORKFLOW_TEMPLATES.find(item => item.id === id).nodes.map(node => [node.name, node]));
    const planner = byName.Plan ?? byName.Specify;
    // A small change is one phase; a phase is built behaviour, never checking or tests alone.
    expect(planner.prompt).toMatch(/Size the plan to the change/);
    expect(planner.prompt).toMatch(/one phase/);
    expect(planner.prompt).toMatch(/never a phase that only checks or adds tests/);
    expect(planner.prompt).toMatch(/at most 4 phases/);
    expect(planner.prompt).toMatch(/in the phase that builds what it checks/);
    expect(planner.prompt).not.toMatch(/small enough to build and test in one round/);
    // Each round runs the phase's own tests; the whole suite runs once, when nothing is left to build.
    expect(byName.Test.prompt).toMatch(/only the tests for that phase/);
    expect(byName.Test.prompt).toMatch(/NEEDS_INPUT/);
    expect(byName.Test.prompt).toMatch(/full test suite once/);
  });

  it('builds a feature from requirements: asks what is missing, agrees a specification and phased plan, then builds it', () => {
    const template = WORKFLOW_TEMPLATES.find(item => item.id === 'feature-from-requirements');
    const byName = Object.fromEntries(template.nodes.map(node => [node.name, node]));
    // Requirements asks about a feature, not about a fault, and always asks the owner.
    expect(byName.Requirements).toMatchObject({ role: 'Analyst', readOnly: true, approval: false, askOwner: true, repeat: { mode: 'once' } });
    expect(byName.Requirements.prompt).toMatch(/who it is for/);
    expect(byName.Requirements.prompt).toMatch(/out of scope/);
    expect(byName.Requirements.prompt).toMatch(/First look for each of these yourself/);
    expect(byName.Requirements.prompt).toMatch(/Ask nothing you could find out yourself, and when nothing is missing ask nothing/);
    expect(byName.Requirements.prompt).not.toMatch(/reproduce/);
    expect(byName.Requirements).toEqual((({ id, ...step }) => step)(BUILT_IN_STEPS.find(step => step.id === 'requirements')));
    // The specification is a file in the repository and plan.md stays in the run notes; Specify does not wait for approval.
    expect(template.description).toBe('Settle the requirements, agree a specification, plan phases, build each one, review, test and commit.');
    expect(byName.Specify).toMatchObject({ readOnly: false, approval: false, askOwner: false, repeat: { mode: 'once' } });
    expect(byName.Specify.prompt).toMatch(/Read the Requirements note/);
    expect(byName.Specify.prompt).toMatch(/write plan\.md in the run notes folder/i);
    expect(byName.Specify.prompt).toMatch(/Change no code/);
    expect(byName.Specify.prompt).toMatch(/give the path of the file/);
    expect(byName.Develop.prompt).toMatch(/do not run git commit/i);
    expect(byName.Review.prompt).toMatch(/commits since the base commit/i);
    for (const name of ['Develop', 'Review', 'Test']) expect(byName[name].prompt, name).toMatch(/specification named in the Specify note/);
    expect(byName.Test.repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: 8 });
    expect(template.nodes.at(-1)).toMatchObject({ name: 'Commit', repeat: { mode: 'once' } });
    expect(byName.Commit.prompt).toMatch(/Include the specification/);
    expect(template.nodes.filter(node => node.askOwner).map(node => node.name)).toEqual(['Requirements']);
  });

  it('brainstorms an idea with the owner one question at a time, then specifies it as a todo Feature Build from Spec can build', () => {
    const template = WORKFLOW_TEMPLATES.find(item => item.id === 'brainstorm-to-spec');
    expect(template).toMatchObject({ agentsDecide: false, progressFile: null });
    expect(template.nodes.map(({ name, role, repeat, readOnly, approval, askOwner }) => ({ name, role, repeat, readOnly, approval, askOwner }))).toEqual([
      { name: 'Brainstorm', role: 'Thinking partner', repeat: { mode: 'once' }, readOnly: true, approval: false, askOwner: true },
      { name: 'Specify', role: 'Planner', repeat: { mode: 'once' }, readOnly: false, approval: true, askOwner: false },
      { name: 'Commit', role: 'Committer', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
    ]);
    const byName = Object.fromEntries(template.nodes.map(node => [node.name, node.prompt]));
    // A conversation, not a questionnaire: one question per pause, built on the last answer, until the owner agrees it has landed.
    expect(byName.Brainstorm).toMatch(/one question at a time/);
    expect(byName.Brainstorm).toMatch(/use NEEDS_INPUT with exactly one question/);
    expect(byName.Brainstorm).toMatch(/the answer you would recommend/);
    expect(byName.Brainstorm).toMatch(/challenge it/);
    expect(byName.Brainstorm).toMatch(/Do not ask what you can find out yourself/);
    expect(byName.Brainstorm).toMatch(/ask whether it is ready to be specified/);
    expect(byName.Brainstorm).toMatch(/Finish only when the owner agrees/);
    expect(byName.Brainstorm).toMatch(/Change nothing/);
    // The specification and a phased todo are files in the repository, shaped for Feature Build from Spec.
    expect(byName.Specify).toMatch(/Read the Brainstorm note/);
    expect(byName.Specify).toMatch(/## Phase N: <title> sections with - \[ \] tasks/);
    expect(byName.Specify).toMatch(/at most 4 phases/);
    expect(byName.Specify).toMatch(/## Session notes/);
    expect(byName.Specify).toMatch(/\*\*Repositories\*\*:/);
    expect(byName.Specify).toMatch(/Change no code/);
    expect(byName.Specify).toMatch(/Feature Build from Spec/);
    expect(byName.Commit).toMatch(/Commit nothing else/);
    expect(byName.Commit).toMatch(/Do not push/);
    expect(byName.Commit).toMatch(/Start your note with one line/);
  });

  it('reviews without changing or committing anything', () => {
    const template = WORKFLOW_TEMPLATES.find(item => item.id === 'review-only');
    expect(template.nodes.every(node => node.readOnly && !node.approval && node.repeat.mode === 'once')).toBe(true);
    expect(template.nodes.every(node => /Change nothing/.test(node.prompt))).toBe(true);
    expect(template.nodes.some(node => /commit/i.test(node.name))).toBe(false);
  });

  it('builds independent drafts that pass validation with roles only', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const draft = buildTemplateDraft(template.id);
      expect(draft.nodes.every(node => !('agentId' in node))).toBe(true);
      expect(validateWorkflowBody(draft)).toEqual([]);
      // The draft keeps what the template says each step is for, and what the workflow is for.
      expect(draft.nodes.map(node => node.role)).toEqual(template.nodes.map(node => node.role));
      expect(draft).toMatchObject({ kind: template.kind, description: template.description });
      expect(validateWorkflowBody(draft, { template: true })).toEqual([]);
      draft.nodes[0].name = 'Changed';
      expect(template.nodes[0].name).not.toBe('Changed');
    }
  });

  it('keeps files written by read-only steps inside their run notes folder', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      for (const node of template.nodes.filter(item => item.readOnly)) {
        const files = [...node.prompt.matchAll(/\bwrite\s+([^\s]+\.md)\b/gi)].map(match => match[1]);
        for (const file of files) {
          expect(file, `${template.name} / ${node.name}`).toBe('plan.md');
          expect(node.prompt, `${template.name} / ${node.name}`).toMatch(/Write plan\.md in the run notes folder/);
        }
      }
    }
    expect(WORKFLOW_TEMPLATES.find(template => template.id === 'feature-build').nodes[0].prompt).toMatch(/Write plan\.md in the run notes folder/);
  });

  it('uses input in the described steps, no skill invocation, and bounded prompts', () => {
    const inputSteps = { 'bug-fix': ['Clarify', 'Analyse', 'Specify', 'Develop', 'Commit'],
      'quick-change': ['Scope', 'Develop', 'Commit'],
      'feature-build': ['Plan', 'Commit'],
      'feature-build-from-spec': ['Develop', 'Review', 'Test'],
      'feature-from-requirements': ['Requirements', 'Specify', 'Commit'],
      troubleshoot: ['Clarify', 'Investigate', 'Prove', 'Commit'], 'review-only': ['Survey'],
      'brainstorm-to-spec': ['Brainstorm', 'Specify', 'Commit'] };
    for (const template of WORKFLOW_TEMPLATES) {
      for (const node of template.nodes) {
        expect(node.prompt.includes('{input}'), `${template.name} / ${node.name}`).toBe(inputSteps[template.id].includes(node.name));
        expect(node.prompt).not.toMatch(/^\s*\/[\w-]+/);
        expect(node.prompt).not.toMatch(/\$[\w-]+/);
        expect(node.prompt.length).toBeLessThanOrEqual(8192);
      }
    }
  });

  it('instructs Review steps to review incrementally on repeat passes and avoid duplicating broad test suites', () => {
    for (const id of ['bug-fix', 'feature-build', 'feature-from-requirements']) {
      const review = WORKFLOW_TEMPLATES.find(item => item.id === id).nodes.find(node => node.name === 'Review');
      expect(review.prompt).toMatch(/On a repeat pass, read your previous Review and Test notes and review only what changed since that pass/);
      expect(review.prompt).toMatch(/do not run broad test suites that the Test step will run next/);
    }
  });

  it('instructs Committer steps to update CHANGELOG.md and write a dated release file under docs/releases/', () => {
    for (const id of ['bug-fix', 'quick-change', 'feature-build', 'feature-from-requirements', 'troubleshoot']) {
      const commit = WORKFLOW_TEMPLATES.find(item => item.id === id).nodes.at(-1);
      expect(commit.role).toBe('Committer');
      expect(commit.prompt).toContain('CHANGELOG.md');
      expect(commit.prompt).toContain('docs/releases/');
      expect(commit.prompt).toContain('YYYY-MM-DD-HHmmss-<short-slug>.md');
    }
  });

  it('builds a feature from its todo file with written-out prompts, one phase per round', () => {
    const template = WORKFLOW_TEMPLATES.find(item => item.id === TODO_TEMPLATE);
    expect(template).toMatchObject({ name: 'Feature Build from Spec', kind: 'build', agentsDecide: true, progressFile: 'docs/{input}' });
    expect(template.description).not.toMatch(/skill/i);
    expect(template.nodes.map(({ name, role, repeat, readOnly, approval, askOwner }) => ({ name, role, repeat, readOnly, approval, askOwner }))).toEqual([
      { name: 'Develop', role: 'Developer', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
      { name: 'Review', role: 'Reviewer', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
      { name: 'Test', role: 'Tester', repeat: { mode: 'loop_back', to: 'Develop', max: 8 }, readOnly: false, approval: false, askOwner: false },
    ]);
    const byName = Object.fromEntries(template.nodes.map(node => [node.name, node.prompt]));
    // Every step works from the todo file the run was started with, which is also where its progress is read.
    for (const prompt of Object.values(byName)) expect(prompt).toContain('the todo file docs/{input}');
    expect(byName.Develop).toMatch(/first phase in it with unticked tasks/);
    expect(byName.Develop).toMatch(/Write failing tests first/);
    expect(byName.Develop).toMatch(/tick each task when done/);
    expect(byName.Develop).toMatch(/do not run git commit/);
    expect(byName.Review).toMatch(/On a repeat pass, read your previous Review and Test notes and review only what changed since that pass/);
    expect(byName.Review).toMatch(/do not run broad test suites that the Test step will run next/);
    expect(byName.Test).toMatch(/only the tests for that phase/);
    expect(byName.Test).toContain('Set up what a check needs yourself');
    expect(byName.Test).toMatch(/use NEEDS_INPUT once/);
    expect(byName.Test).toMatch(/full test suite once/);
    expect(byName.Test).toMatch(/Report COMPLETE only when every task is ticked and the full test suite passes/);
  });

  // A gap in a test or in recorded evidence must not cost a whole Develop, Review and Test round.
  it.each(['feature-build', 'feature-from-requirements', 'feature-build-from-spec'])('%s: Test closes a test-only gap itself and Develop checks a test against its task', (id) => {
    const byName = Object.fromEntries(WORKFLOW_TEMPLATES.find(item => item.id === id).nodes.map(node => [node.name, node.prompt]));
    expect(byName.Develop).toMatch(/Before ticking a task that names a test, read its wording again and check that the test asserts every condition it names/);
    expect(byName.Develop).toMatch(/When the Test note lists repairs, make each one hold exactly as it is worded before anything else/);
    expect(byName.Develop).toMatch(/tick each task when done/);
    expect(byName.Test).toMatch(/whose only gap is a test that does not assert what the task names, or evidence you can produce that is not recorded/);
    expect(byName.Test).toMatch(/correct or add the test, or produce and record the evidence, yourself/);
    expect(byName.Test).toMatch(/leave the task ticked/);
    expect(byName.Test).toMatch(/change no code other than tests/);
    expect(byName.Test).toMatch(/never edit a test the project marks as locked/);
    // A fault in the behaviour itself still goes back to Develop.
    expect(byName.Test).toMatch(/Untick any task whose behaviour does not hold/);
    expect(byName.Test).not.toMatch(/Untick any task that does not hold/);
  });

  it('ships no workflow that needs a skill: every built-in step carries its whole prompt', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      for (const node of template.nodes) {
        expect(node.prompt, `${template.name} / ${node.name}`).not.toMatch(/(?:^|\s)\/[a-z][\w-]*(?=\s|$)/);
        expect(node.prompt.length, `${template.name} / ${node.name}`).toBeGreaterThan(60);
      }
    }
    expect(existsSync(fileURLToPath(new URL('../../skills', import.meta.url)))).toBe(false);
  });

  it('rejects missing and unknown ids', () => {
    expect(() => buildTemplateDraft()).toThrow(/templateId/);
    expect(() => buildTemplateDraft('missing')).toThrow(/Unknown template/);
  });
});
