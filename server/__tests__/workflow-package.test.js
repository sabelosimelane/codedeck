import { describe, expect, it } from 'vitest';
import { buildPackage, packageFileName, validatePackage } from '../../shared/workflow-package.mjs';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

function node(overrides = {}) {
  return {
    name: 'Develop',
    role: 'Developer',
    prompt: 'Implement {input}',
    repeat: { mode: 'once' },
    readOnly: false,
    approval: false,
    askOwner: false,
    ...overrides,
  };
}

function validPackage(overrides = {}) {
  return {
    format: 'codedeck.workflow',
    formatVersion: 1,
    source: { id: UUID, version: 7 },
    exportedAt: '2026-11-24T13:05:52.000Z',
    workflow: {
      name: 'Bug fix',
      description: 'Investigate and fix.',
      kind: 'bugfix',
      agentsDecide: false,
      progressFile: null,
      nodes: [node()],
    },
    ...overrides,
  };
}

describe('validatePackage', () => {
  it('accepts a valid package', () => {
    expect(validatePackage(validPackage())).toEqual([]);
  });

  it('reports every field failure at once', () => {
    const errors = validatePackage({
      format: 'wrong',
      formatVersion: 2,
      source: { id: 'nope' },
      exportedAt: 'yesterday',
      extra: true,
      workflow: {
        name: '',
        nodes: [{ name: 'Only', prompt: '', repeat: { mode: 'once' } }],
      },
    });
    const fields = errors.map(error => error.field);
    expect(fields).toContain('format');
    expect(fields).toContain('formatVersion');
    expect(fields).toContain('source.id');
    expect(fields).toContain('source.version');
    expect(fields).toContain('exportedAt');
    expect(fields).toContain('extra');
    expect(fields.some(field => field.startsWith('workflow.'))).toBe(true);
    expect(fields).toContain('workflow.nodes[0].role');
    expect(errors.length).toBeGreaterThan(5);
  });

  it('refuses a newer format with an update message', () => {
    const [error] = validatePackage(validPackage({ formatVersion: 99 })).filter(e => e.field === 'formatVersion');
    expect(error.message).toMatch(/newer CodeDeck/i);
  });

  it('refuses unknown keys at every level', () => {
    const pkg = validPackage({
      source: { id: UUID, version: 1, extra: 1 },
      workflow: { name: 'Bug fix', agentsDecide: false, progressFile: null, kind: 'other', description: '', nodes: [node({ bogus: 1 })] },
    });
    const fields = validatePackage(pkg).map(error => error.field);
    expect(fields).toContain('source.extra');
    expect(fields).toContain('workflow.nodes[0].bogus');
  });

  it('requires a non-empty role on every node', () => {
    const errors = validatePackage(validPackage({
      workflow: { name: 'W', agentsDecide: false, nodes: [node({ role: '' }), node({ name: 'Test', role: '  ' })] },
    }));
    expect(errors.map(e => e.field)).toEqual(expect.arrayContaining(['workflow.nodes[0].role', 'workflow.nodes[1].role']));
  });

  it('refuses a non-object package and a bad source id', () => {
    expect(validatePackage(null).length).toBeGreaterThan(0);
    expect(validatePackage(validPackage({ source: { id: 'not-a-uuid', version: 1 } })).map(e => e.field)).toContain('source.id');
    expect(validatePackage(validPackage({ source: { id: UUID, version: 0 } })).map(e => e.field)).toContain('source.version');
    expect(validatePackage(validPackage({ source: { id: UUID, version: 2 ** 31 } })).map(e => e.field)).toContain('source.version');
  });

  it('reports workflow field errors under the workflow prefix', () => {
    const errors = validatePackage(validPackage({ workflow: { name: 'W', agentsDecide: false, nodes: [] } }));
    expect(errors.map(e => e.field).some(f => f.startsWith('workflow.'))).toBe(true);
  });

  it('rejects a v1 source UUID on its own', () => {
    const errors = validatePackage(validPackage({ source: { id: '123e4567-e89b-12d3-a456-426614174000', version: 1 } }));
    expect(errors.map(e => e.field)).toContain('source.id');
  });

  it('rejects a revision field inside the workflow on its own', () => {
    const errors = validatePackage(validPackage({
      workflow: { name: 'Bug fix', agentsDecide: false, revision: 3, nodes: [node()] },
    }));
    expect(errors.map(e => e.field)).toContain('workflow.revision');
  });

  it('rejects an impossible exportedAt date on its own', () => {
    const errors = validatePackage(validPackage({ exportedAt: '2026-02-30T13:05:52.000Z' }));
    expect(errors.map(e => e.field)).toContain('exportedAt');
  });

  it('rejects the v1 UUID, workflow revision and bad date together with other invalid fields', () => {
    const errors = validatePackage(validPackage({
      format: 'wrong',
      source: { id: '123e4567-e89b-12d3-a456-426614174000', version: 1, extra: 1 },
      exportedAt: '2026-02-30T13:05:52.000Z',
      workflow: { name: 'Bug fix', agentsDecide: false, revision: 3, nodes: [node()] },
    }));
    const fields = errors.map(e => e.field);
    expect(fields).toContain('format');
    expect(fields).toContain('source.id');
    expect(fields).toContain('source.extra');
    expect(fields).toContain('exportedAt');
    expect(fields).toContain('workflow.revision');
  });
});

describe('buildPackage', () => {
  it('builds the package from a stored workflow without agent ids', () => {
    const record = {
      id: UUID,
      name: 'Bug fix',
      description: 'Fix things.',
      kind: 'bugfix',
      agentsDecide: false,
      progressFile: null,
      revision: 7,
      nodes: [{ name: 'Develop', role: 'Developer', agentId: 'aaaaaaaa-1111-4111-8111-111111111111', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: true, approval: false, askOwner: false }],
    };
    const pkg = buildPackage(record, { exportedAt: '2026-11-24T13:05:52.000Z' });
    expect(pkg).toMatchObject({ format: 'codedeck.workflow', formatVersion: 1, source: { id: UUID, version: 7 }, exportedAt: '2026-11-24T13:05:52.000Z' });
    expect(pkg.workflow.nodes[0]).not.toHaveProperty('agentId');
    expect(pkg.workflow.nodes[0]).toMatchObject({ name: 'Develop', role: 'Developer' });
    expect(validatePackage(pkg)).toEqual([]);
  });

  it('requires a stored workflow with id and revision', () => {
    expect(() => buildPackage(null)).toThrow();
    expect(() => buildPackage({ id: UUID })).toThrow();
  });
});

describe('packageFileName', () => {
  it('slugs names per the spec rule', () => {
    expect(packageFileName('Bug fix')).toBe('bug-fix.codedeck-workflow.json');
    expect(packageFileName('  Review & Test!! ')).toBe('review-test.codedeck-workflow.json');
    expect(packageFileName('!!!')).toBe('workflow.codedeck-workflow.json');
    expect(packageFileName('A'.repeat(100))).toHaveLength('a'.repeat(64).length + '.codedeck-workflow.json'.length);
  });

  it('rejects a non-string name', () => {
    expect(() => packageFileName(null)).toThrow();
  });
});
