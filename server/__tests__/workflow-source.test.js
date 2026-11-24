import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createWorkflowStore } from '../pipelines/workflow-store.js';

const IMPORT_ID = '123e4567-e89b-42d3-a456-426614174000';

const databases = [];
function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  return { db, workflows: createWorkflowStore(db) };
}
afterEach(() => { databases.splice(0).forEach(db => db.close()); });

function body(overrides = {}) {
  return {
    name: 'Bug fix',
    description: '',
    kind: 'bugfix',
    agentsDecide: false,
    progressFile: null,
    nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' } }],
    ...overrides,
  };
}

function baseDefinition() {
  return {
    name: 'Bug fix',
    description: '',
    kind: 'bugfix',
    agentsDecide: false,
    progressFile: null,
    nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
  };
}

describe('workflow source columns', () => {
  it('creates local workflows with an empty source', () => {
    const { workflows } = setup();
    const created = workflows.create(body());
    expect(created.source).toEqual({ kind: 'local', id: null, version: null, base: null, updatedAt: null });
    expect(workflows.get(created.id).source).toEqual(created.source);
  });

  it('creates imported workflows with source and base', () => {
    const { workflows } = setup();
    const created = workflows.create(body(), {
      source: { kind: 'imported', id: IMPORT_ID, version: 7, base: baseDefinition(), updatedAt: null },
    });
    expect(created.source).toMatchObject({ kind: 'imported', id: IMPORT_ID, version: 7 });
    expect(created.source.base).toEqual(baseDefinition());
    expect(workflows.list().at(0).source.id).toBe(IMPORT_ID);
  });

  it('rejects one workflow per linked source', () => {
    const { workflows } = setup();
    workflows.create(body(), { source: { kind: 'imported', id: IMPORT_ID, version: 1, base: baseDefinition() } });
    expect(() => workflows.create(body({ name: 'Other' }), {
      source: { kind: 'imported', id: IMPORT_ID, version: 1, base: baseDefinition() },
    })).toThrow(/already exists|UNIQUE/i);
  });

  it('keeps the source on update and clears the update stamp', () => {
    const { db, workflows } = setup();
    const created = workflows.create(body(), {
      source: { kind: 'imported', id: IMPORT_ID, version: 7, base: baseDefinition() },
    });
    db.prepare('UPDATE pipeline_workflows SET source_updated_at = ? WHERE id = ?').run('2026-11-24T13:05:52.000Z', created.id);
    expect(workflows.get(created.id).source.updatedAt).toBe('2026-11-24T13:05:52.000Z');
    const updated = workflows.update(created.id, { ...body({ description: 'Edited.' }), revision: 1 });
    expect(updated.source).toMatchObject({ kind: 'imported', id: IMPORT_ID, version: 7 });
    expect(updated.source.base).toEqual(baseDefinition());
    expect(updated.source.updatedAt).toBe(null);
  });

  it('refuses bad source values on write, naming the column', () => {
    const { workflows } = setup();
    for (const source of [
      { kind: 'nope', id: null, version: null, base: null },
      { kind: 'imported', id: 'not-a-uuid', version: 1, base: baseDefinition() },
      { kind: 'imported', id: IMPORT_ID, version: 0, base: baseDefinition() },
      { kind: 'builtin', id: 'Bad_ID', version: 1, base: baseDefinition() },
      { kind: 'local', id: IMPORT_ID, version: null, base: null },
      { kind: 'imported', id: IMPORT_ID, version: 1, base: { name: 'x' } },
    ]) {
      expect(() => workflows.create(body({ name: `W${Math.random()}` }), { source })).toThrow(/source_/);
    }
  });

  it('refuses a v1 source UUID on write and on read', () => {
    const { db, workflows } = setup();
    const v1 = '123e4567-e89b-12d3-a456-426614174000';
    expect(() => workflows.create(body(), {
      source: { kind: 'imported', id: v1, version: 1, base: baseDefinition() },
    })).toThrow(/source_id/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pipeline_workflows').get().n).toBe(0);
    const created = workflows.create(body(), {
      source: { kind: 'imported', id: IMPORT_ID, version: 1, base: baseDefinition() },
    });
    db.prepare('UPDATE pipeline_workflows SET source_id = ? WHERE id = ?').run(v1, created.id);
    expect(() => workflows.get(created.id)).toThrow(new RegExp(`${created.id}.*source_id`));
  });

  it('refuses a local workflow with a non-null base before writing, leaving no row', () => {
    const { db, workflows } = setup();
    expect(() => workflows.create(body(), { source: { kind: 'local', id: null, version: null, base: baseDefinition() } }))
      .toThrow(/source_base/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pipeline_workflows').get().n).toBe(0);
  });

  it('refuses an impossible source timestamp on write and on read, leaving no row', () => {
    const { db, workflows } = setup();
    const stamp = '2026-02-30T13:05:52.000Z';
    expect(() => workflows.create(body(), {
      source: { kind: 'imported', id: IMPORT_ID, version: 1, base: baseDefinition(), updatedAt: stamp },
    })).toThrow(/source_updated_at/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pipeline_workflows').get().n).toBe(0);
    const created = workflows.create(body(), {
      source: { kind: 'imported', id: IMPORT_ID, version: 1, base: baseDefinition() },
    });
    db.prepare('UPDATE pipeline_workflows SET source_updated_at = ? WHERE id = ?').run(stamp, created.id);
    expect(() => workflows.get(created.id)).toThrow(new RegExp(`${created.id}.*source_updated_at`));
  });

  it('fails loudly on read for each bad stored value, naming row and column', () => {
    const { db, workflows } = setup();
    const created = workflows.create(body());
    const cases = [
      ['source_kind', 'nope'],
      ['source_id', 'not-a-uuid-when-imported'],
      ['source_version', 0],
      ['source_base', '{"name":'],
      ['source_updated_at', 'not-a-time'],
    ];
    for (const [column, bad] of cases) {
      if (column === 'source_id' || column === 'source_version' || column === 'source_base') {
        db.prepare('UPDATE pipeline_workflows SET source_kind = ?, source_id = ?, source_version = ? WHERE id = ?')
          .run('imported', IMPORT_ID, 1, created.id);
      }
      db.prepare(`UPDATE pipeline_workflows SET ${column} = ? WHERE id = ?`).run(bad, created.id);
      expect(() => workflows.get(created.id)).toThrow(new RegExp(`${created.id}.*${column}`));
      // restore a good row for the next case
      db.prepare('UPDATE pipeline_workflows SET source_kind = ?, source_id = ?, source_version = ?, source_base = ?, source_updated_at = ? WHERE id = ?')
        .run('local', null, null, null, null, created.id);
    }
  });
});
