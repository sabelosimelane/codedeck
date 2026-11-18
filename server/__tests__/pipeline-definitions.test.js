import { describe, expect, it } from 'vitest';
import {
  composePrompt,
  isProgressFileTemplate,
  validateAgentBody,
  validateRunStartBody,
  validateSettingsBody,
  validateStepPresetBody,
  validateWorkflowBody,
} from '../../shared/pipeline-definitions.mjs';

const UUID = '6f1c0000-0000-4000-8000-000000000001';
const UUID2 = '6f1c0000-0000-4000-8000-000000000002';

function fields(errors) {
  return errors.map(e => e.field);
}

describe('validateAgentBody', () => {
  const valid = { name: 'codex-sol', launchCommand: 'codex --model gpt', resetCommand: '/clear' };

  it('accepts a valid agent', () => {
    expect(validateAgentBody(valid)).toEqual([]);
  });

  it('rejects unknown fields', () => {
    expect(fields(validateAgentBody({ ...valid, extra: 1 }))).toContain('extra');
  });

  it('rejects missing and blank name', () => {
    expect(fields(validateAgentBody({ ...valid, name: '' }))).toContain('name');
    expect(fields(validateAgentBody({ ...valid, name: '   ' }))).toContain('name');
  });

  it('rejects name outside 1–64 after trim', () => {
    expect(validateAgentBody({ ...valid, name: 'x' })).toEqual([]);
    expect(fields(validateAgentBody({ ...valid, name: 'x'.repeat(65) }))).toContain('name');
    expect(validateAgentBody({ ...valid, name: 'x'.repeat(64) })).toEqual([]);
  });

  it('rejects control characters in name (single-line)', () => {
    expect(fields(validateAgentBody({ ...valid, name: 'a\nb' }))).toContain('name');
    expect(fields(validateAgentBody({ ...valid, name: 'a\tb' }))).toContain('name');
  });

  it('rejects launchCommand outside 1–2048 or with controls', () => {
    expect(fields(validateAgentBody({ ...valid, launchCommand: '' }))).toContain('launchCommand');
    expect(fields(validateAgentBody({ ...valid, launchCommand: '   ' }))).toContain('launchCommand');
    expect(fields(validateAgentBody({ ...valid, launchCommand: 'x'.repeat(2049) }))).toContain('launchCommand');
    expect(validateAgentBody({ ...valid, launchCommand: 'x'.repeat(2048) })).toEqual([]);
    expect(fields(validateAgentBody({ ...valid, launchCommand: 'a\nb' }))).toContain('launchCommand');
  });

  it('rejects resetCommand outside 1–256 or with controls', () => {
    expect(fields(validateAgentBody({ ...valid, resetCommand: '' }))).toContain('resetCommand');
    expect(fields(validateAgentBody({ ...valid, resetCommand: 'x'.repeat(257) }))).toContain('resetCommand');
    expect(validateAgentBody({ ...valid, resetCommand: 'x'.repeat(256) })).toEqual([]);
    expect(fields(validateAgentBody({ ...valid, resetCommand: 'a\nb' }))).toContain('resetCommand');
  });

  it('requires integer revision ≥ 1 when present', () => {
    expect(validateAgentBody({ ...valid, revision: 1 })).toEqual([]);
    expect(fields(validateAgentBody({ ...valid, revision: 0 }))).toContain('revision');
    expect(fields(validateAgentBody({ ...valid, revision: 1.5 }))).toContain('revision');
  });
});

describe('workflow progress file', () => {
  const body = progressFile => ({ name: 'Feature', agentsDecide: false, nodes: [{ name: 'Develop', agentId: '11111111-1111-4111-8111-111111111111', prompt: 'Work', repeat: { mode: 'once' } }], progressFile });
  const valid = ['docs/{input}', '{input}', 'docs/{input}.md', 'docs/todos/{input}', 'docs/todo.md', 'docs/{input}.MD', 'a'.repeat(297) + '.md', 'a'.repeat(290) + '{input}.md'];
  const invalid = ['', ' ', 1, {}, [], 'docs/{input}/notes', '/{input}', '~/{input}', '{input}/../x.md', 'docs//{input}', 'docs/{input}.txt', 'docs\\{input}', 'a'.repeat(301), '/tmp/todo.md', '~/todo.md', 'a\\b.md', '../todo.md', 'a/../b.md', 'a//b.md', 'a\nb.md', 'a\u0085b.md', 'a\u2028b.md', 'todo.txt', 'a'.repeat(298) + '.md'];
  it.each(valid)('accepts %s', progressFile => {
    expect(validateWorkflowBody(body(progressFile))).toEqual([]);
  });
  it.each(invalid)('rejects %s', progressFile => {
    expect(validateWorkflowBody(body(progressFile)).map(error => error.field)).toContain('progressFile');
  });
  it.each(valid)('recognizes template %s', value => {
    expect(isProgressFileTemplate(value)).toBe(true);
  });
  it.each(invalid.filter(value => value !== ' '))('rejects template %s', value => {
    expect(isProgressFileTemplate(value)).toBe(false);
  });
  it('accepts absent and null', () => {
    expect(validateWorkflowBody(body(null))).toEqual([]);
    const without = body(null); delete without.progressFile;
    expect(validateWorkflowBody(without)).toEqual([]);
  });
});

describe('validateWorkflowBody', () => {
  const node = (overrides = {}) => ({
    name: 'Develop',
    agentId: UUID,
    prompt: 'do {input}',
    repeat: { mode: 'once' },
    ...overrides,
  });
  const valid = { name: 'Feature', agentsDecide: false, nodes: [node()] };

  it('validates both optional node flags and forbids approval on a loop closer', () => {
    for (const flag of ['readOnly', 'approval']) {
      expect(validateWorkflowBody({ ...valid, nodes: [node({ [flag]: true })] })).toEqual([]);
      expect(validateWorkflowBody({ ...valid, nodes: [node({ [flag]: false })] })).toEqual([]);
      for (const value of [null, 0, 'true']) {
        expect(fields(validateWorkflowBody({ ...valid, nodes: [node({ [flag]: value })] }))).toContain(`nodes[0].${flag}`);
      }
    }
    const nodes = [node({ name: 'Analyse', approval: true }), node({ name: 'Review', repeat: { mode: 'loop_back', to: 'Analyse', max: 2 }, approval: true })];
    expect(fields(validateWorkflowBody({ ...valid, nodes }))).toContain('nodes[1].approval');
    expect(validateWorkflowBody({ ...valid, nodes: [{ ...nodes[0], repeat: { mode: 'until_complete', max: 2 } }, { ...nodes[1], approval: false }] })).toEqual([]);
  });
  it.each([{ mode: 'once' }, { mode: 'until_complete', max: 2 }])('accepts approval on a %j node', repeat => {
    expect(validateWorkflowBody({ ...valid, nodes: [node({ repeat, approval: true })] })).toEqual([]);
  });
  it('accepts approval on a non-closing node inside a loop', () => {
    expect(validateWorkflowBody({ ...valid, nodes: [
      node({ name: 'Analyse', approval: true }),
      node({ name: 'Review', repeat: { mode: 'loop_back', to: 'Analyse', max: 2 } }),
    ] })).toEqual([]);
  });
  it.each(['readOnly', 'approval'])('names %s for every wrong node flag type', flag => {
    for (const bad of [null, 0, 1, 'true', [], {}]) {
      expect(fields(validateWorkflowBody({ ...valid, nodes: [node({ [flag]: bad })] }))).toContain(`nodes[0].${flag}`);
    }
  });

  it('accepts a valid workflow', () => {
    expect(validateWorkflowBody(valid)).toEqual([]);
  });

  it('rejects unknown top-level and node fields', () => {
    expect(fields(validateWorkflowBody({ ...valid, extra: 1 }))).toContain('extra');
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [{ ...node(), extra: true }],
    }))).toContain('nodes[0].extra');
  });

  it('requires 1–32 nodes', () => {
    expect(fields(validateWorkflowBody({ name: 'Feature', agentsDecide: false, nodes: [] }))).toContain('nodes');
    expect(fields(validateWorkflowBody({ name: 'Feature', agentsDecide: false, nodes: null }))).toContain('nodes');
    const thirtyTwo = Array.from({ length: 32 }, (_, i) => node({ name: `N${i}` }));
    expect(validateWorkflowBody({ name: 'Feature', agentsDecide: false, nodes: thirtyTwo })).toEqual([]);
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [...thirtyTwo, node({ name: 'N32' })],
    }))).toContain('nodes');
  });

  it('rejects duplicate node names case-insensitively', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ name: 'Dev' }), node({ name: 'dev', agentId: UUID2 })],
    }))).toContain('nodes[1].name');
  });

  it('rejects invalid agentId', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ agentId: 'not-a-uuid' })],
    }))).toContain('nodes[0].agentId');
  });

  it('rejects prompt outside 1–8192 or with forbidden controls', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ prompt: '' })],
    }))).toContain('nodes[0].prompt');
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ prompt: 'x'.repeat(8193) })],
    }))).toContain('nodes[0].prompt');
    expect(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ prompt: 'line1\nline2\tok' })],
    })).toEqual([]);
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ prompt: 'bad\x00' })],
    }))).toContain('nodes[0].prompt');
  });

  it('rejects max with once and missing max with until_complete', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'once', max: 1 } })],
    }))).toContain('nodes[0].repeat.max');
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete' } })],
    }))).toContain('nodes[0].repeat.max');
  });

  it('accepts until_complete max at 1 and 100; rejects 0 and 101 and non-integers', () => {
    expect(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete', max: 1 } })],
    })).toEqual([]);
    expect(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete', max: 100 } })],
    })).toEqual([]);
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete', max: 0 } })],
    }))).toContain('nodes[0].repeat.max');
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete', max: 101 } })],
    }))).toContain('nodes[0].repeat.max');
    expect(fields(validateWorkflowBody({
      name: 'Feature', agentsDecide: false,
      nodes: [node({ repeat: { mode: 'until_complete', max: 1.5 } })],
    }))).toContain('nodes[0].repeat.max');
  });
});

describe('validateSettingsBody', () => {
  it('accepts null or UUID setupAgentId with revision', () => {
    expect(validateSettingsBody({ setupAgentId: null, revision: 1 })).toEqual([]);
    expect(validateSettingsBody({ setupAgentId: UUID, revision: 2 })).toEqual([]);
  });

  it('rejects invalid setupAgentId and revision', () => {
    expect(fields(validateSettingsBody({ setupAgentId: 'x', revision: 1 }))).toContain('setupAgentId');
    expect(fields(validateSettingsBody({ setupAgentId: null, revision: 0 }))).toContain('revision');
  });

  it('rejects unknown fields', () => {
    expect(fields(validateSettingsBody({ setupAgentId: null, revision: 1, extra: 1 }))).toContain('extra');
  });
});

describe('validateRunStartBody', () => {
  const valid = {
    requestId: 'run-3f2a9c',
    workflowId: UUID,
    project: 'codedeck',
    input: 'docs/todos/x.md',
  };

  it('accepts a valid body including empty input', () => {
    expect(validateRunStartBody(valid)).toEqual([]);
    expect(validateRunStartBody({ ...valid, input: '' })).toEqual([]);
  });

  it('rejects bad requestId, workflowId, project and input bounds', () => {
    expect(fields(validateRunStartBody({ ...valid, requestId: '' }))).toContain('requestId');
    expect(fields(validateRunStartBody({ ...valid, requestId: 'bad id' }))).toContain('requestId');
    expect(fields(validateRunStartBody({ ...valid, workflowId: 'nope' }))).toContain('workflowId');
    expect(fields(validateRunStartBody({ ...valid, project: '' }))).toContain('project');
    expect(fields(validateRunStartBody({ ...valid, input: 'x'.repeat(4097) }))).toContain('input');
    expect(fields(validateRunStartBody({ ...valid, input: 'a\nb' }))).toContain('input');
  });

  it('accepts a run in an existing task or in a task created for it', () => {
    expect(validateRunStartBody({ ...valid, taskId: UUID2 })).toEqual([]);
    expect(validateRunStartBody({ ...valid, newTask: { title: 'x' } })).toEqual([]);
    expect(validateRunStartBody({ ...valid, newTask: { title: 'x'.repeat(80) } })).toEqual([]);
  });

  it('rejects a bad task, a bad new task and more than one place to run', () => {
    expect(fields(validateRunStartBody({ ...valid, taskId: 'nope' }))).toEqual(['taskId']);
    expect(fields(validateRunStartBody({ ...valid, taskId: null }))).toEqual(['taskId']);
    // A new task needs no title: one that is absent is made from the input and named later.
    expect(validateRunStartBody({ ...valid, newTask: {} })).toEqual([]);
    for (const newTask of [null, 'x', [], { title: null }, { title: '' }, { title: '  ' }, { title: 12 }, { title: 'x'.repeat(81) }, { title: 'a\nb' }]) {
      expect(fields(validateRunStartBody({ ...valid, newTask }))[0]).toMatch(/^newTask/);
    }
    expect(fields(validateRunStartBody({ ...valid, newTask: { title: 'x', branch: 'y' } }))).toEqual(['newTask.branch']);
    expect(fields(validateRunStartBody({ ...valid, taskId: UUID2, newTask: { title: 'x' } }))).toEqual(['newTask']);
    expect(fields(validateRunStartBody({ ...valid, worktreePath: '/tmp/w', taskId: UUID2 }))).toEqual(['taskId']);
  });

  it('rejects unknown fields', () => {
    expect(fields(validateRunStartBody({ ...valid, extra: 1 }))).toContain('extra');
  });

  it('accepts an absolute worktreePath of 1–4096 characters, or none', () => {
    expect(validateRunStartBody({ ...valid, worktreePath: '/Users/me/git/worktrees/codedeck-x' })).toEqual([]);
    expect(validateRunStartBody({ ...valid, worktreePath: '/' })).toEqual([]);
    expect(validateRunStartBody({ ...valid, worktreePath: `/${'a'.repeat(4095)}` })).toEqual([]);
  });

  it.each([
    ['null', null],
    ['a number', 5],
    ['an array', ['/a']],
    ['an empty string', ''],
    ['a relative path', 'worktrees/x'],
    ['a newline', '/a\nb'],
    ['a NUL byte', '/a\u0000b'],
    ['4097 characters', `/${'a'.repeat(4096)}`],
  ])('rejects a worktreePath that is %s', (_label, worktreePath) => {
    expect(validateRunStartBody({ ...valid, worktreePath })).toEqual([
      { field: 'worktreePath', message: 'Use the absolute path of an existing worktree, 1–4096 characters on one line, or leave it out for a new worktree' },
    ]);
  });
});

describe('composePrompt', () => {
  it('replaces every {input} in a single pass', () => {
    expect(composePrompt('do {input} and {input}', 'A')).toBe('do A and A');
  });

  it('does not re-expand {input} that came from the input value', () => {
    expect(composePrompt('do {input}', 'contains {input} literally')).toBe('do contains {input} literally');
  });

  it('inserts input literally without interpreting replacement tokens', () => {
    expect(composePrompt('the {input} regex', '$&')).toBe('the $& regex');
    expect(composePrompt('keep {input}', '$$ $` $\'')).toBe('keep $$ $` $\'');
  });

  it('enforces the 16384 composed length limit when checking', () => {
    const prompt = 'x'.repeat(16384);
    expect(composePrompt(prompt, '')).toBe(prompt);
    const errors = [];
    const composed = composePrompt('{input}', 'y'.repeat(16385), errors, 'input');
    expect(composed.length).toBe(16385);
    expect(fields(errors)).toContain('input');
  });
});

describe('validateWorkflowBody: who decides', () => {
  const node = { name: 'Develop', agentId: UUID, prompt: 'do {input}', repeat: { mode: 'once' } };

  it.each([true, false])('accepts agentsDecide %s', (agentsDecide) => {
    expect(validateWorkflowBody({ name: 'Feature', agentsDecide, nodes: [node] })).toEqual([]);
  });

  it.each([undefined, null, 'true', 1, 0])('rejects agentsDecide %s', (agentsDecide) => {
    expect(validateWorkflowBody({ name: 'Feature', agentsDecide, nodes: [node] })).toEqual([
      { field: 'agentsDecide', message: 'Use true or false' },
    ]);
  });
});

describe('validateWorkflowBody: looping back to an earlier node', () => {
  const node = (name, repeat = { mode: 'once' }) => ({ name, agentId: UUID, prompt: 'do {input}', repeat });
  const loop = (to, max = 20) => ({ mode: 'loop_back', to, max });
  const workflow = (...nodes) => ({ name: 'Feature', agentsDecide: false, nodes });

  it('accepts a loop back to an earlier node, matched by name whatever its case or padding', () => {
    expect(validateWorkflowBody(workflow(node('Develop'), node('Test', loop('Develop')), node('Review')))).toEqual([]);
    expect(validateWorkflowBody(workflow(node('Develop'), node('Review'), node('Test', loop(' develop '))))).toEqual([]);
  });

  it('accepts a repeating node inside a loop and two loops that share no node', () => {
    expect(validateWorkflowBody(workflow(
      node('Develop', { mode: 'until_complete', max: 3 }), node('Test', loop('Develop')),
      node('Review'), node('Fix', loop('Review')),
    ))).toEqual([]);
  });

  it.each([1, 100])('accepts a maximum of %i rounds', (max) => {
    expect(validateWorkflowBody(workflow(node('Develop'), node('Test', loop('Develop', max))))).toEqual([]);
  });

  it.each([0, 101, 1.5, '5', undefined, null])('rejects a maximum of %s rounds', (max) => {
    expect(validateWorkflowBody(workflow(node('Develop'), node('Test', { mode: 'loop_back', to: 'Develop', max })))).toEqual([
      { field: 'nodes[1].repeat.max', message: 'Use a whole number from 1 to 100' },
    ]);
  });

  it.each([
    ['itself', 'Test'],
    ['a later node', 'Review'],
    ['a node that does not exist', 'Deploy'],
    ['a blank name', '  '],
    ['a number', 7],
    ['nothing', undefined],
  ])('rejects a loop back to %s', (_label, to) => {
    expect(validateWorkflowBody(workflow(node('Develop'), node('Test', { mode: 'loop_back', to, max: 5 }), node('Review')))).toEqual([
      { field: 'nodes[1].repeat.to', message: 'Choose an earlier node to loop back to' },
    ]);
  });

  it('rejects a loop on the first node, which has no earlier node', () => {
    expect(fields(validateWorkflowBody(workflow(node('Develop', loop('Develop')))))).toEqual(['nodes[0].repeat.to']);
  });

  it('rejects loops that share a node, nested or crossing', () => {
    const message = 'Loops cannot share a node; this one overlaps the loop that ends at Test';
    expect(validateWorkflowBody(workflow(
      node('Plan'), node('Develop'), node('Test', loop('Develop')), node('Review', loop('Plan')),
    ))).toEqual([{ field: 'nodes[3].repeat.to', message }]);
    expect(validateWorkflowBody(workflow(
      node('Plan'), node('Develop'), node('Test', loop('Plan')), node('Review', loop('Develop')),
    ))).toEqual([{ field: 'nodes[3].repeat.to', message }]);
  });

  it('rejects unknown repeat fields and names the three modes', () => {
    expect(fields(validateWorkflowBody(workflow(node('Develop'), node('Test', { ...loop('Develop'), extra: 1 }))))).toEqual(['nodes[1].repeat.extra']);
    expect(fields(validateWorkflowBody(workflow(node('Develop', { mode: 'once', to: 'Develop' }))))).toEqual(['nodes[0].repeat.to']);
    expect(fields(validateWorkflowBody(workflow(node('Develop', { mode: 'until_complete', max: 2, to: 'Develop' }))))).toEqual(['nodes[0].repeat.to']);
    expect(validateWorkflowBody(workflow(node('Develop', { mode: 'forever' })))).toEqual([
      { field: 'nodes[0].repeat.mode', message: 'Choose once, until_complete or loop_back' },
    ]);
  });
});

describe('workflow kind, description and step roles', () => {
  const node = (extra = {}) => ({ name: 'Develop', agentId: UUID, prompt: 'Build', repeat: { mode: 'once' }, ...extra });
  const body = (extra = {}) => ({ name: 'Feature', agentsDecide: false, nodes: [node()], ...extra });

  it('accepts them, and a workflow that names none', () => {
    expect(validateWorkflowBody(body())).toEqual([]);
    expect(validateWorkflowBody(body({ kind: 'troubleshoot', description: 'x'.repeat(280), nodes: [node({ role: 'x'.repeat(32) })] }))).toEqual([]);
    expect(validateWorkflowBody(body({ description: '', nodes: [node({ role: '' })] }))).toEqual([]);
  });

  it.each([
    [{ kind: 'deploy' }, 'kind'], [{ kind: null }, 'kind'], [{ kind: 12 }, 'kind'],
    [{ description: 'x'.repeat(281) }, 'description'], [{ description: 'a\nb' }, 'description'], [{ description: null }, 'description'], [{ description: 12 }, 'description'],
  ])('rejects %j', (extra, field) => {
    expect(fields(validateWorkflowBody(body(extra)))).toEqual([field]);
  });

  it.each([['x'.repeat(33)], ['a\nb'], [null], [12]])('rejects the role %j', role => {
    expect(fields(validateWorkflowBody(body({ nodes: [node({ role })] })))).toEqual(['nodes[0].role']);
  });

  it('validates a saved template: the same definition with no agents', () => {
    const { agentId, ...step } = node({ role: 'Developer' });
    expect(validateWorkflowBody(body({ nodes: [step] }), { template: true })).toEqual([]);
    expect(fields(validateWorkflowBody(body(), { template: true }))).toEqual(['nodes[0].agentId']);
    expect(fields(validateWorkflowBody(body({ nodes: [step] })))).toEqual(['nodes[0].agentId']);
    expect(fields(validateWorkflowBody(body({ nodes: [{ ...step, prompt: '' }] }), { template: true }))).toEqual(['nodes[0].prompt']);
  });
});

describe('validateStepPresetBody', () => {
  const valid = { name: 'Review', role: 'Reviewer', prompt: 'Review the changes', repeat: { mode: 'once' }, readOnly: true, approval: false };

  it('accepts a step with or without its options, and a bounded repeat', () => {
    expect(validateStepPresetBody(valid)).toEqual([]);
    expect(validateStepPresetBody({ name: 'x', prompt: 'p', repeat: { mode: 'until_complete', max: 100 } })).toEqual([]);
    expect(validateStepPresetBody({ ...valid, name: 'x'.repeat(64), prompt: 'x'.repeat(8192), role: '' })).toEqual([]);
  });

  it.each([
    [{ name: '' }, 'name'], [{ name: 'x'.repeat(65) }, 'name'], [{ name: null }, 'name'],
    [{ role: 'x'.repeat(33) }, 'role'], [{ role: 12 }, 'role'],
    [{ prompt: '' }, 'prompt'], [{ prompt: '  ' }, 'prompt'], [{ prompt: 'x'.repeat(8193) }, 'prompt'], [{ prompt: 'a\u0007b' }, 'prompt'], [{ prompt: null }, 'prompt'],
    [{ repeat: { mode: 'loop_back', to: 'Develop', max: 3 } }, 'repeat.mode'], [{ repeat: { mode: 'sometimes' } }, 'repeat.mode'],
    [{ repeat: { mode: 'until_complete', max: 0 } }, 'repeat.max'], [{ repeat: { mode: 'until_complete', max: 101 } }, 'repeat.max'], [{ repeat: null }, 'repeat'],
    [{ readOnly: 'yes' }, 'readOnly'], [{ approval: 1 }, 'approval'], [{ agentId: UUID }, 'agentId'],
  ])('rejects %j', (extra, field) => {
    expect(fields(validateStepPresetBody({ ...valid, ...extra }))).toEqual([field]);
  });

  it('requires a revision only when asked, and an object', () => {
    expect(fields(validateStepPresetBody(valid, { revisionRequired: true }))).toEqual(['revision']);
    expect(validateStepPresetBody({ ...valid, revision: 2 }, { revisionRequired: true })).toEqual([]);
    expect(fields(validateStepPresetBody([]))).toEqual(['body']);
  });
});

describe('a step that always asks the owner', () => {
  const node = (extra = {}) => ({ name: 'Clarify', agentId: UUID, prompt: 'Ask', repeat: { mode: 'once' }, ...extra });
  it('is accepted on a workflow node, a template node and a saved step, and must be a boolean', () => {
    expect(validateWorkflowBody({ name: 'W', agentsDecide: true, nodes: [node({ askOwner: true })] })).toEqual([]);
    const { agentId, ...templateNode } = node({ askOwner: true });
    expect(validateWorkflowBody({ name: 'W', agentsDecide: true, nodes: [templateNode] }, { template: true })).toEqual([]);
    expect(validateStepPresetBody({ name: 'Clarify', prompt: 'Ask', repeat: { mode: 'once' }, askOwner: true })).toEqual([]);
    expect(fields(validateWorkflowBody({ name: 'W', agentsDecide: true, nodes: [node({ askOwner: 'yes' })] }))).toEqual(['nodes[0].askOwner']);
    expect(fields(validateStepPresetBody({ name: 'Clarify', prompt: 'Ask', repeat: { mode: 'once' }, askOwner: 1 }))).toEqual(['askOwner']);
  });
});
