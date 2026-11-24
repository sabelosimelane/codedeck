import { describe, expect, it } from 'vitest';
import { canonicalDefinition, definitionHash } from '../../shared/workflow-changes.mjs';

function definition(overrides = {}) {
  return {
    name: 'Bug fix',
    description: 'Fix things.',
    kind: 'bugfix',
    agentsDecide: false,
    progressFile: null,
    nodes: [
      {
        name: 'Develop',
        role: 'Developer',
        prompt: 'Do it',
        repeat: { mode: 'once' },
        readOnly: true,
        approval: false,
        askOwner: false,
      },
    ],
    ...overrides,
  };
}

describe('canonicalDefinition', () => {
  it('trims names, roles and the progress file and defaults flags', () => {
    const canonical = canonicalDefinition(definition({
      progressFile: '  notes/progress.md  ',
      nodes: [{
        name: '  Develop  ',
        role: '  Developer ',
        prompt: 'Do it',
        repeat: { mode: 'once', max: 99, to: 'Elsewhere' },
        enabled: true,
      }],
    }));
    expect(canonical).toEqual({
      name: 'Bug fix',
      description: 'Fix things.',
      kind: 'bugfix',
      agentsDecide: false,
      progressFile: 'notes/progress.md',
      nodes: [{
        name: 'Develop',
        role: 'Developer',
        prompt: 'Do it',
        repeat: { mode: 'once' },
        readOnly: false,
        approval: false,
        askOwner: false,
      }],
    });
  });

  it('stores loops by target name and keeps enabled only when false', () => {
    const canonical = canonicalDefinition(definition({
      nodes: [
        { name: 'Scope', role: 'Analyst', prompt: 'Scope it', repeat: { mode: 'once' } },
        { name: 'Develop', role: 'Dev', prompt: 'Build', repeat: { mode: 'loop_back', to: 'scope', max: 3 } },
        { name: 'Review', role: 'Rev', prompt: 'Check', repeat: { mode: 'once' }, enabled: false },
      ],
    }));
    expect(canonical.nodes[1].repeat).toEqual({ mode: 'loop_back', to: 'Scope', max: 3 });
    expect(canonical.nodes[2]).not.toHaveProperty('enabled', true);
    expect(canonical.nodes[2].enabled).toBe(false);
    expect(canonical.nodes[0]).not.toHaveProperty('enabled');
  });

  it('treats until_complete and blank progress files canonically', () => {
    const canonical = canonicalDefinition(definition({
      progressFile: '   ',
      nodes: [{ name: 'Test', role: 'Tester', prompt: 'Test', repeat: { mode: 'until_complete', max: 8, to: 'x' } }],
    }));
    expect(canonical.progressFile).toBe(null);
    expect(canonical.nodes[0].repeat).toEqual({ mode: 'until_complete', max: 8 });
  });

  it('ignores agent ids, key order and surrounding whitespace when equal', () => {
    const left = definition();
    const right = {
      progressFile: null,
      agentsDecide: false,
      kind: 'bugfix',
      description: 'Fix things.',
      name: 'Bug fix',
      nodes: [{ role: 'Developer', name: 'Develop', askOwner: false, approval: false, readOnly: true, prompt: 'Do it', repeat: { mode: 'once' }, agentId: 'aaaaaaaa-1111-4111-8111-111111111111' }],
    };
    expect(canonicalDefinition(left)).toEqual(canonicalDefinition(right));
  });

  it('differs on any definition field', () => {
    const base = JSON.stringify(canonicalDefinition(definition()));
    for (const variant of [
      definition({ description: 'Other.' }),
      definition({ kind: 'build' }),
      definition({ agentsDecide: true }),
      definition({ progressFile: 'notes/a.md' }),
      definition({ nodes: [{ name: 'Develop', role: 'Other', prompt: 'Do it', repeat: { mode: 'once' } }] }),
      definition({ nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do something else', repeat: { mode: 'once' } }] }),
      definition({ nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'until_complete', max: 2 } }] }),
    ]) {
      expect(JSON.stringify(canonicalDefinition(variant))).not.toBe(base);
    }
  });

  it('requires a definition object', () => {
    expect(() => canonicalDefinition(null)).toThrow();
    expect(() => canonicalDefinition({})).toThrow();
  });

  it('treats padded workflow names and descriptions as equal', () => {
    const plain = definition();
    const padded = definition({ name: '  Bug fix  ', description: '  Fix things.  ' });
    expect(JSON.stringify(canonicalDefinition(padded))).toBe(JSON.stringify(canonicalDefinition(plain)));
  });

  it('treats omitted kind and description like the stored defaults', () => {
    const { kind: _kind, description: _description, ...omitted } = definition();
    const stored = definition({ kind: 'other', description: '' });
    expect(omitted).not.toHaveProperty('kind');
    expect(omitted).not.toHaveProperty('description');
    expect(canonicalDefinition(omitted)).toEqual(canonicalDefinition(stored));
  });
});

describe('definitionHash', () => {
  it('is the stable SHA-256 of the canonical JSON', async () => {
    const { createHash } = await import('node:crypto');
    const def = definition();
    const expected = createHash('sha256').update(JSON.stringify(canonicalDefinition(def))).digest('hex');
    expect(definitionHash(def)).toBe(expected);
    expect(definitionHash({ ...def, nodes: def.nodes.map(n => ({ ...n, agentId: 'x' })) })).toBe(expected);
  });

  it('hashes padded workflow names and descriptions equally', () => {
    const plain = definition();
    const padded = definition({ name: '  Bug fix  ', description: '  Fix things.  ' });
    expect(definitionHash(padded)).toBe(definitionHash(plain));
  });

  it('hashes omitted kind and description like the stored defaults', () => {
    const { kind: _kind, description: _description, ...omitted } = definition();
    const stored = definition({ kind: 'other', description: '' });
    expect(definitionHash(omitted)).toBe(definitionHash(stored));
  });
});
