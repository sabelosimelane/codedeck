import { describe, expect, it } from 'vitest';
import { WORKFLOW_TEMPLATES, BUILT_IN_STEPS, buildTemplateDraft } from '../../shared/workflow-templates.mjs';
import { validateStepPresetBody } from '../../shared/pipeline-definitions.mjs';
import { validateWorkflowBody, WORKFLOW_KINDS } from '../../shared/pipeline-definitions.mjs';

const AGENT = '11111111-1111-4111-8111-111111111111';

describe('workflow templates', () => {
  it('ships the exact starting workflows and immutable definitions', () => {
    expect(WORKFLOW_TEMPLATES.map(({ id, name, kind, nodes }) => [id, name, kind, nodes.map(node => node.name)])).toEqual([
      ['bug-fix', 'Bug fix', 'bugfix', ['Clarify', 'Analyse', 'Specify', 'Develop', 'Review', 'Test', 'Commit']],
      ['feature-build', 'Feature build', 'build', ['Plan', 'Develop', 'Review', 'Test', 'Commit']],
      ['feature-from-requirements', 'Feature from requirements', 'build', ['Requirements', 'Specify', 'Plan', 'Develop', 'Review', 'Test', 'Commit']],
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
        expect(node.prompt).not.toMatch(/(?:\/|\$)[\w-]+/);
      }
    }
  });

  it('gates the build and fix workflows on approval and ends them with a commit', () => {
    for (const id of ['bug-fix', 'feature-build']) {
      const template = WORKFLOW_TEMPLATES.find(item => item.id === id);
      // The first step that does the work (after Clarify, where there is one) waits for approval.
      expect(template.nodes.find(node => node.name !== 'Clarify')).toMatchObject({ readOnly: true, approval: true });
      expect(template.nodes.at(-1)).toMatchObject({ name: 'Commit', repeat: { mode: 'once' } });
      expect(template.nodes.find(node => node.name === 'Test').repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: id === 'bug-fix' ? 5 : 12 });
    }
    expect(WORKFLOW_TEMPLATES[0].nodes.find(node => node.name === 'Specify')).toMatchObject({ readOnly: true, approval: true });
    expect(WORKFLOW_TEMPLATES[1].nodes[0].prompt).toContain('plan.md');
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
    expect(byName.Verify.repeat).toEqual({ mode: 'loop_back', to: 'Fix', max: 5 });
    expect(template.nodes.at(-1).name).toBe('Commit');
  });

  it.each([['bug-fix', 'Specify', 'Test'], ['troubleshoot', 'Clarify', 'Verify']])('records acceptance and reserves evidence decisions for the owner in %s', (id, source, check) => {
    const { nodes } = buildTemplateDraft(id);
    expect(nodes.find(node => node.name === source).prompt).toMatch(/agreed acceptance checks/i);
    const verify = nodes.find(node => node.name === check);
    expect(verify.askOwner).toBe(true);
    for (const term of ['CONTINUE', 'base commit', 'equivalent conditions', 'smallest comparison', 'NEEDS_INPUT', 'COMPLETE', 'owner', 'evidence for each']) {
      expect(verify.prompt).toContain(term);
    }
    expect(nodes.at(-1).prompt).toMatch(/owner-approved/);
  });

  it('opens the fix and troubleshoot workflows by checking the report, asking the owner only for what is missing', () => {
    for (const id of ['bug-fix', 'troubleshoot']) {
      const first = WORKFLOW_TEMPLATES.find(item => item.id === id).nodes[0];
      expect(first).toMatchObject({ name: 'Clarify', readOnly: true, approval: false, askOwner: true, repeat: { mode: 'once' } });
      expect(first.prompt).toMatch(/First look for each of these yourself/);
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

  it('builds a feature from requirements: asks what is missing, agrees a specification, then plans and builds it', () => {
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
    // The specification is a file in the repository, so its step is not read-only; nothing is built before it is approved.
    expect(byName.Specify).toMatchObject({ readOnly: false, approval: true, askOwner: false, repeat: { mode: 'once' } });
    expect(byName.Specify.prompt).toMatch(/Read the Requirements note/);
    expect(byName.Specify.prompt).toMatch(/Change no code/);
    expect(byName.Specify.prompt).toMatch(/give the path of the file/);
    // The plan stays in the run notes, where a run without a Progress file reads its progress.
    expect(byName.Plan).toMatchObject({ readOnly: true, approval: true, repeat: { mode: 'once' } });
    expect(byName.Plan.prompt).toMatch(/Write plan\.md in the run notes folder/);
    for (const name of ['Plan', 'Develop', 'Review', 'Test']) expect(byName[name].prompt, name).toMatch(/specification named in the Specify note/);
    expect(byName.Test.repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: 12 });
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
    const inputSteps = { 'bug-fix': ['Clarify', 'Analyse', 'Specify', 'Develop', 'Commit'], 'feature-build': ['Plan', 'Commit'],
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

  it('rejects missing and unknown ids', () => {
    expect(() => buildTemplateDraft()).toThrow(/templateId/);
    expect(() => buildTemplateDraft('missing')).toThrow(/Unknown template/);
  });
});
