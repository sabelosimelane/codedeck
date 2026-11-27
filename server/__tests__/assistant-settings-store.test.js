import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createAssistantSettingsStore } from '../assistant/assistant-settings-store.js';

const dbs = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function setup() { const db = new Database(':memory:'); dbs.push(db); return { db, store: createAssistantSettingsStore(db) }; }

describe('assistant settings store', () => {
  it('returns defaults without writing a row', () => {
    const { db, store } = setup();
    expect(store.settings()).toEqual({ model: 'default', effort: null });
    expect(db.prepare('SELECT count(*) AS count FROM assistant_settings').get().count).toBe(0);
  });
  it('round trips a choice and can restore defaults', () => {
    const { db, store } = setup();
    expect(store.saveSettings({ model: 'opus', effort: 'high' })).toEqual({ model: 'opus', effort: 'high' });
    expect(store.settings()).toEqual({ model: 'opus', effort: 'high' });
    expect(store.saveSettings({ model: 'fable', effort: 'max' })).toEqual({ model: 'fable', effort: 'max' });
    store.saveSettings({ model: 'default', effort: null });
    expect(store.settings()).toEqual({ model: 'default', effort: null });
    expect(db.prepare('SELECT count(*) AS count FROM assistant_settings').get().count).toBe(0);
  });
  it.each([['model', null], ['model', 'other'], ['effort', 'extreme'], ['effort', undefined]])('rejects invalid %s on save', (field, value) => {
    const { store } = setup();
    expect(() => store.saveSettings({ model: 'opus', effort: 'high', [field]: value })).toThrow(field);
  });
  it.each([['model', 'other'], ['effort', 'extreme']])('rejects a corrupt persisted %s', (field, value) => {
    const { db, store } = setup();
    db.prepare('INSERT INTO assistant_settings VALUES (1, ?)').run(JSON.stringify({ model: 'opus', effort: 'high', [field]: value }));
    expect(() => store.settings()).toThrow(field);
  });
});
