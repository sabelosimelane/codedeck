import { describe, expect, it } from 'vitest';
import {
  composePrompt,
  validateAgentBody,
  validateRunStartBody,
  validateSettingsBody,
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

describe('validateWorkflowBody', () => {
  const node = (overrides = {}) => ({
    name: 'Develop',
    agentId: UUID,
    prompt: 'do {input}',
    repeat: { mode: 'once' },
    ...overrides,
  });
  const valid = { name: 'Feature', nodes: [node()] };

  it('accepts a valid workflow', () => {
    expect(validateWorkflowBody(valid)).toEqual([]);
  });

  it('rejects unknown top-level and node fields', () => {
    expect(fields(validateWorkflowBody({ ...valid, extra: 1 }))).toContain('extra');
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [{ ...node(), extra: true }],
    }))).toContain('nodes[0].extra');
  });

  it('requires 1–32 nodes', () => {
    expect(fields(validateWorkflowBody({ name: 'Feature', nodes: [] }))).toContain('nodes');
    expect(fields(validateWorkflowBody({ name: 'Feature', nodes: null }))).toContain('nodes');
    const thirtyTwo = Array.from({ length: 32 }, (_, i) => node({ name: `N${i}` }));
    expect(validateWorkflowBody({ name: 'Feature', nodes: thirtyTwo })).toEqual([]);
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [...thirtyTwo, node({ name: 'N32' })],
    }))).toContain('nodes');
  });

  it('rejects duplicate node names case-insensitively', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ name: 'Dev' }), node({ name: 'dev', agentId: UUID2 })],
    }))).toContain('nodes[1].name');
  });

  it('rejects invalid agentId', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ agentId: 'not-a-uuid' })],
    }))).toContain('nodes[0].agentId');
  });

  it('rejects prompt outside 1–8192 or with forbidden controls', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ prompt: '' })],
    }))).toContain('nodes[0].prompt');
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ prompt: 'x'.repeat(8193) })],
    }))).toContain('nodes[0].prompt');
    expect(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ prompt: 'line1\nline2\tok' })],
    })).toEqual([]);
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ prompt: 'bad\x00' })],
    }))).toContain('nodes[0].prompt');
  });

  it('rejects max with once and missing max with until_complete', () => {
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ repeat: { mode: 'once', max: 1 } })],
    }))).toContain('nodes[0].repeat.max');
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ repeat: { mode: 'until_complete' } })],
    }))).toContain('nodes[0].repeat.max');
  });

  it('accepts until_complete max at 1 and 100; rejects 0 and 101 and non-integers', () => {
    expect(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ repeat: { mode: 'until_complete', max: 1 } })],
    })).toEqual([]);
    expect(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ repeat: { mode: 'until_complete', max: 100 } })],
    })).toEqual([]);
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ repeat: { mode: 'until_complete', max: 0 } })],
    }))).toContain('nodes[0].repeat.max');
    expect(fields(validateWorkflowBody({
      name: 'Feature',
      nodes: [node({ repeat: { mode: 'until_complete', max: 101 } })],
    }))).toContain('nodes[0].repeat.max');
    expect(fields(validateWorkflowBody({
      name: 'Feature',
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

  it('rejects unknown fields', () => {
    expect(fields(validateRunStartBody({ ...valid, extra: 1 }))).toContain('extra');
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
