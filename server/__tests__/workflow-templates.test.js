import { describe, expect, it } from 'vitest';
import { WORKFLOW_TEMPLATES, BUILT_IN_STEPS, buildTemplateDraft } from '../../shared/workflow-templates.mjs';
import { validateStepPresetBody } from '../../shared/pipeline-definitions.mjs';
import { validateWorkflowBody, WORKFLOW_KINDS } from '../../shared/pipeline-definitions.mjs';

const AGENT = '11111111-1111-4111-8111-111111111111';

describe('workflow templates', () => {
  it('ships the exact starting workflows and immutable definitions', () => {
    expect(WORKFLOW_TEMPLATES.map(({ id, name, kind, nodes }) => [id, name, kind, nodes.map(node => node.name)])).toEqual([
      ['bug-fix', 'Bug fix', 'bugfix', ['Clarify', 'Analyse', 'Specify', 'Develop', 'Review', 'Test', 'Commit']],
      ['quick-change', 'Quick change', 'build', ['Scope', 'Develop', 'Review & Test', 'Commit']],
      ['feature-build', 'Feature build', 'build', ['Plan', 'Develop', 'Review', 'Test', 'Commit']],
      ['feature-from-requirements', 'Feature from requirements', 'build', ['Requirements', 'Specify', 'Develop', 'Review', 'Test', 'Commit']],
      ['troubleshoot', 'Troubleshoot', 'troubleshoot', ['Clarify', 'Investigate', 'Prove', 'Fix', 'Verify', 'Commit']],
      ['review-only', 'Review only', 'review', ['Survey', 'Review', 'Report']],
    ]);
    expect(Object.isFrozen(WORKFLOW_TEMPLATES)).toBe(true);
    for (const template of WORKFLOW_TEMPLATES) {
      expect(Object.isFrozen(template)).toBe(true);
      expect(WORKFLOW_KINDS).toContain(template.kind);
      expect(template.description.trim().length).toBeGreaterThan(0);
      expect(template.description.length).toBeLessThanOrEqual(280);
      expect(template.agentsDecide).toBe(false);
      expect(template.progressFile).toBeNull();
      expect(template.nodes.every(node => Object.isFrozen(node) && Object.isFrozen(node.repeat))).toBe(true);
      expect(template.nodes[0]).toMatchObject({ readOnly: true, repeat: { mode: 'once' } });
      expect(template.nodes[0].prompt).toContain('{input}');
      for (const node of template.nodes) {
        expect(node.role.trim()).not.toBe('');
        expect(node.role.length).toBeLessThanOrEqual(32);
        expect(node.prompt.length).toBeLessThanOrEqual(8192);
        expect(node.prompt).not.toMatch(/(?:^|\s)\/[\w-]+|\$[\w-]+/);
      }
    }
  });

  it('gates the build and fix workflows on approval and ends them with a commit', () => {
    for (const id of ['bug-fix', 'feature-build']) {
      const template = WORKFLOW_TEMPLATES.find(item => item.id === id);
      expect(template.nodes.some(node => node.readOnly && node.approval)).toBe(true);
      expect(template.nodes.at(-1)).toMatchObject({ name: 'Commit', repeat: { mode: 'once' } });
      expect(template.nodes.find(node => node.name === 'Test').repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: id === 'bug-fix' ? 3 : 8 });
    }
    const bugFix = WORKFLOW_TEMPLATES.find(item => item.id === 'bug-fix');
    const featureBuild = WORKFLOW_TEMPLATES.find(item => item.id === 'feature-build');
    expect(bugFix.nodes.find(node => node.name === 'Analyse')).toMatchObject({ readOnly: true, approval: false });
    expect(bugFix.nodes.find(node => node.name === 'Specify')).toMatchObject({ readOnly: true, approval: true });
    expect(featureBuild.nodes[0].prompt).toContain('plan.md');
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
    // The specification is a file in the repository and plan.md stays in the run notes; nothing is built before Specify is approved.
    expect(byName.Specify).toMatchObject({ readOnly: false, approval: true, askOwner: false, repeat: { mode: 'once' } });
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

  it('reviews without changing or committing anything', () => {
    const template = WORKFLOW_TEMPLATES.find(item => item.id === 'review-only');
    expect(template.nodes.every(node => node.readOnly && !node.approval && node.repeat.mode === 'once')).toBe(true);
    expect(template.nodes.every(node => /Change nothing/.test(node.prompt))).toBe(true);
    expect(template.nodes.some(node => /commit/i.test(node.name))).toBe(false);
  });

  it('builds independent drafts that pass validation after choosing agents', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const draft = buildTemplateDraft(template.id);
      expect(draft.nodes.every(node => node.agentId === '')).toBe(true);
      expect(validateWorkflowBody({ ...draft, nodes: draft.nodes.map(node => ({ ...node, agentId: AGENT })) })).toEqual([]);
      // The draft keeps what the template says each step is for, and what the workflow is for.
      expect(draft.nodes.map(node => node.role)).toEqual(template.nodes.map(node => node.role));
      expect(draft).toMatchObject({ kind: template.kind, description: template.description });
      // Without agents it is a valid saved template.
      expect(validateWorkflowBody({ ...draft, nodes: draft.nodes.map(({ agentId, ...node }) => node) }, { template: true })).toEqual([]);
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
      'feature-from-requirements': ['Requirements', 'Specify', 'Commit'],
      troubleshoot: ['Clarify', 'Investigate', 'Prove', 'Commit'], 'review-only': ['Survey'] };
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

  it('rejects missing and unknown ids', () => {
    expect(() => buildTemplateDraft()).toThrow(/templateId/);
    expect(() => buildTemplateDraft('missing')).toThrow(/Unknown template/);
  });
});
