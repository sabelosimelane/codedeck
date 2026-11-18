import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createStepPresetStore, createTemplateStore } from '../pipelines/library-store.js';

const databases = [];
function open() {
  const db = new Database(':memory:');
  databases.push(db);
  let tick = 0;
  return { db, now: () => new Date(Date.UTC(2026, 10, 18, 10, 0, tick++)).toISOString() };
}
afterEach(() => databases.splice(0).forEach(db => db.close()));
const OTHER = '7c000000-0000-4000-8000-000000000009';

describe('saved workflow templates', () => {
  const body = (extra = {}) => ({
    name: ' My build ', description: ' Plan then build ', kind: 'build', agentsDecide: true, progressFile: null,
    nodes: [
      { name: ' Plan ', role: ' Planner ', prompt: 'Plan {input}', repeat: { mode: 'once' }, readOnly: true, approval: true },
      { name: 'Develop', prompt: 'Build', repeat: { mode: 'once' } },
      { name: 'Test', prompt: 'Test', repeat: { mode: 'loop_back', to: ' develop ', max: 3 } },
    ],
    ...extra,
  });
  const setup = () => { const { db, now } = open(); return { db, store: createTemplateStore(db, { now }) }; };

  it('stores a template trimmed, with defaults spelled out, and no agents', () => {
    const { store } = setup();
    const saved = store.create(body());
    expect(saved).toEqual({
      id: saved.id, name: 'My build', description: 'Plan then build', kind: 'build', agentsDecide: true, progressFile: null,
      nodes: [
        { name: 'Plan', role: 'Planner', prompt: 'Plan {input}', repeat: { mode: 'once' }, readOnly: true, approval: true, askOwner: false },
        { name: 'Develop', role: '', prompt: 'Build', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
        { name: 'Test', role: '', prompt: 'Test', repeat: { mode: 'loop_back', to: 'develop', max: 3 }, readOnly: false, approval: false, askOwner: false },
      ],
      revision: 1, createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z',
    });
    expect(store.get(saved.id)).toEqual(saved);
    expect(store.get(OTHER)).toBeNull();
    expect(store.create({ name: 'Bare', agentsDecide: false, nodes: [{ name: 'A', prompt: 'p', repeat: { mode: 'once' } }] })).toMatchObject({ kind: 'other', description: '' });
  });

  it('refuses agents, invalid definitions and a taken name', () => {
    const { store } = setup();
    store.create(body());
    expect(() => store.create(body({ name: 'my BUILD' }))).toThrow('pipeline_workflow_templates: name already exists');
    expect(() => store.create(body({ name: 'With agent', nodes: [{ name: 'A', agentId: OTHER, prompt: 'p', repeat: { mode: 'once' } }] }))).toThrow('nodes[0].agentId');
    expect(() => store.create(body({ name: '' }))).toThrow('pipeline_workflow_templates: name');
    expect(() => store.create(body({ name: 'Bad kind', kind: 'deploy' }))).toThrow('kind');
    expect(() => store.create(null)).toThrow('body');
    expect(store.list()).toHaveLength(1);
  });

  it('lists by name, updates with a revision and removes', () => {
    const { store } = setup();
    const b = store.create(body({ name: 'beta' }));
    const a = store.create(body({ name: 'Alpha' }));
    expect(store.list().map(item => item.name)).toEqual(['Alpha', 'beta']);
    const updated = store.update(a.id, { ...body({ name: 'Alpha 2', kind: 'review' }), revision: 1 });
    expect(updated).toMatchObject({ name: 'Alpha 2', kind: 'review', revision: 2, createdAt: a.createdAt });
    expect(updated.updatedAt).not.toBe(a.updatedAt);
    expect(() => store.update(a.id, { ...body({ name: 'Late' }), revision: 1 })).toThrow('revision conflict');
    expect(() => store.update(a.id, body({ name: 'No revision' }))).toThrow('revision');
    expect(() => store.update(a.id, { ...body({ name: 'beta' }), revision: 2 })).toThrow('name already exists');
    expect(() => store.update(OTHER, { ...body(), revision: 1 })).toThrow('not found');
    store.remove(b.id);
    expect(store.list().map(item => item.id)).toEqual([a.id]);
    expect(() => store.remove('nope')).toThrow('id must be a UUID');
  });

  it.each([
    ['body', '{broken', /field body: must be valid JSON/],
    ['body', JSON.stringify({ name: 'My build', agentsDecide: false, nodes: [] }), /field body\.nodes/],
    ['name', 'Someone else', /field name: does not match/],
    ['revision', 0, /field revision/],
    ['created_at', 'yesterday', /field created_at/],
    ['updated_at', 'yesterday', /field updated_at/],
  ])('fails loudly when stored column %s is invalid', (column, value, message) => {
    const { db, store } = setup();
    const saved = store.create(body());
    db.prepare(`UPDATE pipeline_workflow_templates SET ${column} = ? WHERE id = ?`).run(value, saved.id);
    expect(() => store.get(saved.id)).toThrow(message);
  });

  it('requires a database handle', () => {
    expect(() => createTemplateStore(null)).toThrow('pipeline_workflow_templates: a database handle is required');
  });
});

describe('saved steps', () => {
  const body = (extra = {}) => ({ name: ' Review ', role: ' Reviewer ', prompt: 'Review the changes', repeat: { mode: 'until_complete', max: 3 }, readOnly: true, ...extra });
  const setup = () => { const { db, now } = open(); return { db, store: createStepPresetStore(db, { now }) }; };

  it('stores a step trimmed, with defaults spelled out', () => {
    const { store } = setup();
    const saved = store.create(body());
    expect(saved).toEqual({ id: saved.id, name: 'Review', role: 'Reviewer', prompt: 'Review the changes', repeat: { mode: 'until_complete', max: 3 }, readOnly: true, approval: false, askOwner: false,
      revision: 1, createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z' });
    expect(store.create({ name: 'Plain', prompt: 'p', repeat: { mode: 'once' } })).toMatchObject({ role: '', readOnly: false, approval: false, askOwner: false, repeat: { mode: 'once' } });
    expect(store.create({ name: 'Clarify', prompt: 'p', repeat: { mode: 'once' }, askOwner: true }).askOwner).toBe(true);
  });

  it('refuses a loop, an agent, a bad prompt and a taken name; updates and removes', () => {
    const { store } = setup();
    const saved = store.create(body());
    expect(() => store.create(body({ name: 'Loop', repeat: { mode: 'loop_back', to: 'Develop', max: 3 } }))).toThrow('repeat.mode');
    expect(() => store.create(body({ name: 'Agent', agentId: OTHER }))).toThrow('agentId');
    expect(() => store.create(body({ name: 'Empty', prompt: ' ' }))).toThrow('prompt');
    expect(() => store.create(body({ name: 'REVIEW' }))).toThrow('pipeline_step_presets: name already exists');
    expect(store.update(saved.id, { ...body({ prompt: 'Review harder' }), revision: 1 })).toMatchObject({ prompt: 'Review harder', revision: 2 });
    expect(() => store.update(saved.id, { ...body(), revision: 1 })).toThrow('revision conflict');
    store.remove(saved.id);
    expect(store.list()).toEqual([]);
  });

  it('fails loudly on a stored step that is no longer valid', () => {
    const { db, store } = setup();
    const saved = store.create(body());
    db.prepare('UPDATE pipeline_step_presets SET body = ? WHERE id = ?').run(JSON.stringify({ name: 'Review', prompt: '', repeat: { mode: 'once' } }), saved.id);
    expect(() => store.list()).toThrow(/pipeline_step_presets row .* field body\.prompt/);
  });
});
