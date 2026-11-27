import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createAssistantSettingsStore } from '../assistant/assistant-settings-store.js';
import { buildLaunchCommand } from '../../shared/agent-presets.mjs';

const dbs = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
const commands = Object.fromEntries(['claude', 'codex', 'agy', 'muse', 'opencode', 'cursor'].map(provider => [provider, buildLaunchCommand({ provider, model: '', effort: '', skipPermissions: false }).command]));
const agents = { get: id => commands[id] ? { id, name: id, launchCommand: commands[id] } : id === 'custom' ? { id, name: id, launchCommand: 'my-agent' } : null };
function setup() { const db = new Database(':memory:'); dbs.push(db); return { db, store: createAssistantSettingsStore(db, { agentStore: agents }) }; }

describe('assistant settings store', () => {
  it('returns defaults without writing a row', () => {
    const { db, store } = setup();
    expect(store.settings()).toEqual({ agentId: '', effort: null });
    expect(db.prepare('SELECT count(*) AS count FROM assistant_settings').get().count).toBe(0);
  });
  it('round trips a choice and can restore defaults', () => {
    const { db, store } = setup();
    expect(store.saveSettings({ agentId: 'codex', effort: 'ultra' })).toEqual({ agentId: 'codex', effort: 'ultra' });
    expect(store.settings()).toEqual({ agentId: 'codex', effort: 'ultra' });
    store.saveSettings({ agentId: '', effort: null });
    expect(store.settings()).toEqual({ agentId: '', effort: null });
    expect(db.prepare('SELECT count(*) AS count FROM assistant_settings').get().count).toBe(0);
  });
  it.each([['agentId', null], ['agentId', 'missing'], ['agentId', 'cursor'], ['agentId', 'custom'], ['effort', 'extreme'], ['effort', undefined]])('rejects invalid %s on save', (field, value) => {
    const { store } = setup();
    expect(() => store.saveSettings({ agentId: 'claude', effort: 'high', [field]: value })).toThrow(field);
  });
  it.each([['agentId', 'other'], ['effort', 'extreme']])('rejects a corrupt persisted %s', (field, value) => {
    const { db, store } = setup();
    db.prepare('INSERT INTO assistant_settings VALUES (1, ?)').run(JSON.stringify({ agentId: 'claude', effort: 'high', [field]: value }));
    expect(() => store.settings()).toThrow(field);
  });
  it('rejects old rows and Muse effort', () => {
    const { db, store } = setup();
    expect(() => store.saveSettings({ agentId: 'muse', effort: 'high' })).toThrow('effort');
    db.prepare('INSERT INTO assistant_settings VALUES (1, ?)').run(JSON.stringify({ model: 'default', effort: null }));
    expect(() => store.settings()).toThrow('agentId');
  });
});
