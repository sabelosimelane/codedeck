import { describe, expect, it } from 'vitest';
import { WORKFLOW_TEMPLATES, buildTemplateDraft } from '../../shared/workflow-templates.mjs';
import { validateWorkflowBody } from '../../shared/pipeline-definitions.mjs';

const AGENT = '11111111-1111-4111-8111-111111111111';

describe('workflow templates', () => {
  it('ships the exact starting workflows and immutable definitions', () => {
    expect(WORKFLOW_TEMPLATES.map(({ id, name, nodes }) => [id, name, nodes.map(node => node.name)])).toEqual([
      ['bug-fix', 'Bug fix', ['Analyse', 'Specify', 'Develop', 'Review', 'Test', 'Commit']],
      ['feature-build', 'Feature build', ['Plan', 'Develop', 'Review', 'Test', 'Commit']],
    ]);
    expect(Object.isFrozen(WORKFLOW_TEMPLATES)).toBe(true);
    for (const template of WORKFLOW_TEMPLATES) {
      expect(Object.isFrozen(template)).toBe(true);
      expect(template.agentsDecide).toBe(false);
      expect(template.progressFile).toBeNull();
      expect(template.nodes.every(node => Object.isFrozen(node) && Object.isFrozen(node.repeat))).toBe(true);
      expect(template.nodes[0]).toMatchObject({ readOnly: true, approval: true, repeat: { mode: 'once' } });
      expect(template.nodes.at(-1)).toMatchObject({ name: 'Commit', repeat: { mode: 'once' } });
      const test = template.nodes.find(node => node.name === 'Test');
      expect(test.repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: template.id === 'bug-fix' ? 5 : 12 });
      for (const node of template.nodes) {
        expect(node.role.trim()).not.toBe('');
        expect(node.prompt.length).toBeLessThanOrEqual(8192);
        expect(node.prompt).not.toMatch(/(?:\/|\$)[\w-]+/);
      }
    }
    expect(WORKFLOW_TEMPLATES[0].nodes[1]).toMatchObject({ readOnly: true, approval: true });
    expect(WORKFLOW_TEMPLATES[1].nodes[0].prompt).toContain('plan.md');
    expect(WORKFLOW_TEMPLATES[0].nodes[0].prompt).toContain('{input}');
  });

  it('builds independent drafts that pass validation after choosing agents', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const draft = buildTemplateDraft(template.id);
      expect(draft.nodes.every(node => node.agentId === '')).toBe(true);
      expect(validateWorkflowBody({ ...draft, nodes: draft.nodes.map(({ role, ...node }) => ({ ...node, agentId: AGENT })) })).toEqual([]);
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
    const inputSteps = { 'bug-fix': ['Analyse', 'Specify', 'Develop', 'Commit'], 'feature-build': ['Plan', 'Commit'] };
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
