import { describe, expect, it } from 'vitest';
import { WORKFLOW_TEMPLATES, buildTemplateDraft } from '../../shared/workflow-templates.mjs';
import { validateWorkflowBody, WORKFLOW_KINDS } from '../../shared/pipeline-definitions.mjs';

const AGENT = '11111111-1111-4111-8111-111111111111';

describe('workflow templates', () => {
  it('ships the exact starting workflows and immutable definitions', () => {
    expect(WORKFLOW_TEMPLATES.map(({ id, name, kind, nodes }) => [id, name, kind, nodes.map(node => node.name)])).toEqual([
      ['bug-fix', 'Bug fix', 'bugfix', ['Analyse', 'Specify', 'Develop', 'Review', 'Test', 'Commit']],
      ['feature-build', 'Feature build', 'build', ['Plan', 'Develop', 'Review', 'Test', 'Commit']],
      ['troubleshoot', 'Troubleshoot', 'troubleshoot', ['Gather evidence', 'Hypothesise', 'Prove', 'Fix', 'Verify', 'Commit']],
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
      expect(template.nodes[0]).toMatchObject({ readOnly: true, approval: true });
      expect(template.nodes.at(-1)).toMatchObject({ name: 'Commit', repeat: { mode: 'once' } });
      expect(template.nodes.find(node => node.name === 'Test').repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: id === 'bug-fix' ? 5 : 12 });
    }
    expect(WORKFLOW_TEMPLATES[0].nodes[1]).toMatchObject({ readOnly: true, approval: true });
    expect(WORKFLOW_TEMPLATES[1].nodes[0].prompt).toContain('plan.md');
  });

  it('troubleshoots by evidence, an approved hypothesis and a failing test before any fix', () => {
    const template = WORKFLOW_TEMPLATES.find(item => item.id === 'troubleshoot');
    const byName = Object.fromEntries(template.nodes.map(node => [node.name, node]));
    expect(byName['Gather evidence']).toMatchObject({ readOnly: true, approval: false });
    expect(byName.Hypothesise).toMatchObject({ readOnly: true, approval: true });
    expect(byName.Prove).toMatchObject({ readOnly: false });
    expect(byName.Prove.prompt).toMatch(/Change no production code/);
    expect(byName.Fix.prompt).toMatch(/Do not weaken or delete the test/);
    expect(byName.Verify.repeat).toEqual({ mode: 'loop_back', to: 'Fix', max: 5 });
    expect(template.nodes.at(-1).name).toBe('Commit');
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
    const inputSteps = { 'bug-fix': ['Analyse', 'Specify', 'Develop', 'Commit'], 'feature-build': ['Plan', 'Commit'],
      troubleshoot: ['Gather evidence', 'Hypothesise', 'Prove', 'Commit'], 'review-only': ['Survey'] };
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
