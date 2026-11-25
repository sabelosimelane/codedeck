import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createNamingStore } from '../session-naming-store.js';
import { createCliNamingClient, validateCliSettings } from '../cli-naming-client.js';
import { buildLaunchCommand } from '../../shared/agent-presets.mjs';

const resources = [];
afterEach(() => { for (const item of resources.splice(0)) item.close(); });
function setup() {
  const db = new Database(':memory:'); resources.push(db);
  const agents = createAgentStore(db);
  const add = (provider, model = 'model') => agents.create({ name: `${provider}-${agents.list().length}`, launchCommand: buildLaunchCommand({ provider, model, effort: '', skipPermissions: false }).command, resetCommand: '/clear' });
  return { db, agents, add, store: createNamingStore(db, { agentStore: agents }) };
}

it('validates each setting against an existing preset agent and provider effort', () => {
  const { agents, add } = setup(); const claude = add('claude');
  expect(validateCliSettings({ agentId: claude.id, effort: null }, agents)).toEqual({ agentId: claude.id, effort: null });
  expect(validateCliSettings({ agentId: claude.id, effort: 'high' }, agents)).toEqual({ agentId: claude.id, effort: 'high' });
  for (const value of [null, {}, { agentId: 'bad', effort: null }, { agentId: claude.id, effort: 'ultra' }, { agentId: claude.id }, { agentId: claude.id, effort: '' }]) {
    expect(() => validateCliSettings(value, agents)).toThrow();
  }
  expect(() => validateCliSettings({ agentId: claude.id, effort: null, provider: 'claude' }, agents)).toThrowError(expect.objectContaining({ errors: [expect.objectContaining({ field: 'provider' })] }));
  agents.remove(claude.id);
  expect(() => validateCliSettings({ agentId: claude.id, effort: null }, agents)).toThrow('The session naming agent no longer exists; choose one in Settings');
});

it('migrates a unique legacy provider and model on hydration and clears ambiguous or unmatched rows', () => {
  const { db, agents, add, store } = setup(); const first = add('claude', 'fable');
  db.prepare('INSERT INTO session_naming_settings VALUES (1, ?)').run(JSON.stringify({ provider: 'claude', model: 'fable', effort: 'low' }));
  expect(store.settings()).toEqual({ agentId: first.id, effort: 'low' });
  expect(JSON.parse(db.prepare('SELECT value FROM session_naming_settings').get().value)).toEqual({ agentId: first.id, effort: 'low' });
  db.prepare('UPDATE session_naming_settings SET value=?').run(JSON.stringify({ provider: 'claude', model: 'missing', effort: null }));
  expect(store.settings()).toBeNull();
  expect(db.prepare('SELECT value FROM session_naming_settings').get()).toBeUndefined();
  add('claude', 'fable');
  db.prepare('INSERT INTO session_naming_settings VALUES (1, ?)').run(JSON.stringify({ provider: 'claude', model: 'fable', effort: null }));
  expect(store.settings()).toBeNull();
  expect(agents.list()).toHaveLength(2);
});

it('rejects corrupt current rows per field and keeps legacy Conduit rows unset', () => {
  const { db, store, add } = setup(); const agent = add('codex');
  const write = value => db.prepare('INSERT OR REPLACE INTO session_naming_settings VALUES (1, ?)').run(JSON.stringify(value));
  for (const value of [{ agentId: 'bad', effort: null }, { agentId: agent.id, effort: 'invalid' }, { agentId: agent.id }, { agentId: agent.id, effort: false }]) {
    write(value); expect(() => store.settings()).toThrow();
  }
  write({ baseUrl: 'https://old', provider: 'x', model: 'y', effort: null });
  expect(store.settings()).toBeNull();
});

it.each([
  ['claude', 'claude', '{"title":"Fix login redirects"}'],
  ['codex', 'codex', '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"title\\":\\"Fix login redirects\\"}"}}'],
  ['cursor', 'agent', '{"type":"result","is_error":false,"result":"{\\"title\\":\\"Fix login redirects\\"}"}'],
  ['agy', 'agy', '{"event":"result","result":{"status":"SUCCESS","structured_output":{"title":"Fix login redirects"}}}'],
  ['muse', 'muse', '{"title":"Fix login redirects"}'],
])('resolves %s from the saved agent and runs its headless profile', async (provider, executable, output) => {
  const { agents, add } = setup(); const agent = add(provider, 'chosen-model');
  const execute = vi.fn((_file, _args, _options, callback) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.kill = vi.fn();
    queueMicrotask(() => callback(null, output, '')); return child;
  });
  const client = createCliNamingClient({ execute, agentStore: agents }); resources.push(client);
  expect(await client.generate({ agentId: agent.id, effort: null }, '$ npm test\nfixing login redirect bug')).toBe('Fix login redirects');
  const [file, args, options] = execute.mock.calls[0];
  expect(file).toBe(executable);
  expect(args).toContain('chosen-model');
  expect(args).not.toContain('--effort');
  if (provider === 'agy') {
    expect(args).toContain('--input-format');
    expect(args).toContain('--sandbox');
    expect(args).toContain('plan');
    expect(args).not.toContain('--disable-slash-commands');
  }
  expect(options).toMatchObject({ shell: false, timeout: 65000 });
});

it('omits model args when the selected agent uses its CLI default and rejects custom commands', async () => {
  const { agents, add } = setup(); const agent = add('claude', '');
  const execute = vi.fn((_file, _args, _options, callback) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.kill = vi.fn();
    queueMicrotask(() => callback(null, '{"title":"Fix login redirects"}', '')); return child;
  });
  const client = createCliNamingClient({ execute, agentStore: agents }); resources.push(client);
  await client.generate({ agentId: agent.id, effort: null }, 'fix login');
  expect(execute.mock.calls[0][1]).not.toContain('--model');
  const custom = agents.create({ name: 'custom', launchCommand: 'my-alias --whatever', resetCommand: '/clear' });
  expect(() => validateCliSettings({ agentId: custom.id, effort: null }, agents)).toThrowError(expect.objectContaining({ errors: [expect.objectContaining({ field: 'agentId', message: expect.stringContaining('custom command') })] }));
});
