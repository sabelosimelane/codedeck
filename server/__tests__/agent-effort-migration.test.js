import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createTeamStore } from '../pipelines/library-store.js';
import { createSettingsStore } from '../pipelines/settings-store.js';
import { migrateAgentEfforts } from '../pipelines/agent-effort-migration.js';

const ids = Array.from({ length: 7 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const stamp = '2026-11-01T00:00:00.000Z';
const dbs = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));

function fixture() {
  const db = new Database(':memory:');
  dbs.push(db);
  const agents = createAgentStore(db);
  const teams = createTeamStore(db);
  const settings = createSettingsStore(db);
  const insert = db.prepare('INSERT INTO pipeline_agents(id,name,launch_command,reset_command,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)');
  const put = (index, name, command, createdAt = stamp) => insert.run(ids[index], name, command, '/clear', createdAt, createdAt);
  const command = effort => `command codex --model gpt-6-sol -c model_reasoning_effort="${effort}"`;
  return { db, agents, teams, settings, put, command };
}

describe('startup agent effort migration', () => {
  it('moves effort to members, fallback and setup; merges duplicate agents and is idempotent', () => {
    const f = fixture();
    f.put(0, 'Codex Astra High', f.command('high'));
    f.put(1, 'Codex Astra Medium', f.command('medium'), '2026-11-02T00:00:00.000Z');
    const team = f.teams.create({ name: 'A', members: [
      { role: 'Builder', agentId: ids[0], fallbackAgentId: ids[1] },
      { role: 'Reviewer', agentId: ids[1], effort: 'low', fallbackAgentId: ids[0] },
    ] });
    f.settings.update({ setupAgentId: ids[1], setupEffort: null, defaultBaseBranch: null, timeouts: f.settings.get().timeouts, revision: 1 });
    const log = vi.fn();
    migrateAgentEfforts({ db: f.db, log });
    expect(f.agents.list()).toMatchObject([{ id: ids[0], name: 'Codex Astra', launchCommand: 'command codex --model gpt-6-sol' }]);
    expect(f.teams.get(team.id).members).toEqual([
      { role: 'Builder', agentId: ids[0], effort: 'high' },
      { role: 'Reviewer', agentId: ids[0], effort: 'low' },
    ]);
    expect(f.teams.get(team.id).revision).toBe(2);
    expect(f.settings.get()).toMatchObject({ setupAgentId: ids[0], setupEffort: 'medium' });
    expect(log.mock.calls.length).toBeGreaterThan(0);
    const count = log.mock.calls.length;
    migrateAgentEfforts({ db: f.db, log });
    expect(log).toHaveBeenCalledTimes(count);
    expect(f.teams.get(team.id).revision).toBe(2);
  });

  it('leaves custom commands untouched and renames only a standalone available effort word', () => {
    const f = fixture();
    f.put(0, 'Codex Astra High', f.command('high'));
    f.put(1, 'Codex Astra', 'custom-command');
    f.put(2, 'gemini-4-neon-high', 'command agy --model gemini-4-neon-high --effort high');
    f.put(3, 'Custom high', 'my-cli --effort high');
    migrateAgentEfforts({ db: f.db, log: vi.fn() });
    expect(f.agents.get(ids[0]).name).toBe('Codex Astra High');
    expect(f.agents.get(ids[1]).name).toBe('Codex Astra');
    expect(f.agents.get(ids[2]).name).toBe('gemini-4-neon-high');
    expect(f.agents.get(ids[3]).launchCommand).toBe('my-cli --effort high');
  });

  it('moves an independent fallback effort and repoints stored reservation and trial references', () => {
    const f = fixture();
    f.put(0, 'Codex High', f.command('high'));
    f.put(1, 'Codex Medium', f.command('medium'), '2026-11-02T00:00:00.000Z');
    f.put(2, 'Claude Low', 'command claude --model opus --effort low');
    const team = f.teams.create({ name: 'B', members: [{ role: 'Builder', agentId: ids[1], fallbackAgentId: ids[2] }] });
    f.db.exec('CREATE TABLE pipeline_run_requests(request_id TEXT PRIMARY KEY, params TEXT NOT NULL)');
    f.db.prepare('INSERT INTO pipeline_run_requests(request_id,params) VALUES(?,?)').run('run-1', JSON.stringify({ stepOverrides: { Build: ids[1], Review: { agentId: ids[1], effort: 'high' } } }));
    f.db.exec('CREATE TABLE team_trials(id TEXT PRIMARY KEY, draft TEXT NOT NULL, version INTEGER NOT NULL)');
    f.db.prepare('INSERT INTO team_trials(id,draft,version) VALUES(?,?,1)').run(ids[4], JSON.stringify({ agentId: ids[1], donorId: ids[1], pins: { [ids[1]]: 1 } }));
    migrateAgentEfforts({ db: f.db, log: vi.fn() });
    expect(f.teams.get(team.id).members).toEqual([{ role: 'Builder', agentId: ids[0], effort: 'medium', fallbackAgentId: ids[2], fallbackEffort: 'low' }]);
    expect(JSON.parse(f.db.prepare('SELECT params FROM pipeline_run_requests WHERE request_id=?').get('run-1').params).stepOverrides).toEqual({ Build: ids[0], Review: { agentId: ids[0], effort: 'high' } });
    expect(JSON.parse(f.db.prepare('SELECT draft FROM team_trials WHERE id=?').get(ids[4]).draft)).toEqual({ agentId: ids[0], donorId: ids[0], pins: { [ids[0]]: 1 } });
    expect(f.db.prepare('SELECT version FROM team_trials WHERE id=?').get(ids[4]).version).toBe(2);
    migrateAgentEfforts({ db: f.db, log: vi.fn() });
    expect(f.db.prepare('SELECT version FROM team_trials WHERE id=?').get(ids[4]).version).toBe(2);
    expect(f.teams.get(team.id).revision).toBe(2);
  });

  it('rejects a malformed saved step override effort and rolls back normalization', () => {
    const f = fixture();
    f.put(0, 'Codex High', f.command('high'));
    f.db.exec('CREATE TABLE pipeline_run_requests(request_id TEXT PRIMARY KEY, params TEXT NOT NULL)');
    f.db.prepare('INSERT INTO pipeline_run_requests(request_id,params) VALUES(?,?)').run('run-1', JSON.stringify({ stepOverrides: { Build: { agentId: ids[0], effort: 5 } } }));
    expect(() => migrateAgentEfforts({ db: f.db, log: vi.fn() })).toThrow(/pipeline_run_requests row run-1 field params.stepOverrides.Build.effort/);
    expect(f.db.prepare('SELECT launch_command FROM pipeline_agents WHERE id=?').get(ids[0]).launch_command).toBe(f.command('high'));
  });
  it.each([
    ['role', { role: '  ', agentId: ids[0] }],
    ['effort', { role: 'Builder', agentId: ids[0], effort: 7 }],
    ['fallbackEffort', { role: 'Builder', agentId: ids[0], fallbackEffort: '' }],
  ])('rejects a stored team member with an invalid %s', (field, member) => {
    const f = fixture();
    f.put(0, 'Codex High', f.command('high'));
    f.teams.create({ name: 'A', members: [{ role: 'Builder', agentId: ids[0] }] });
    f.db.prepare('UPDATE pipeline_teams SET body=?').run(JSON.stringify({ name: 'A', members: [member] }));
    expect(() => migrateAgentEfforts({ db: f.db, log: vi.fn() })).toThrow(new RegExp(`body\\.members\\[0\\]\\.${field}`));
  });
  it('starts with a well-formed old reservation whose agent was deleted or no longer offers its effort', () => {
    const f = fixture();
    f.put(0, 'Codex High', f.command('high'));
    f.db.exec('CREATE TABLE pipeline_run_requests(request_id TEXT PRIMARY KEY, params TEXT NOT NULL)');
    const params = { stepOverrides: { Build: { agentId: ids[5], effort: 'xhigh' }, Review: { agentId: ids[0], effort: 'max' } } };
    f.db.prepare('INSERT INTO pipeline_run_requests(request_id,params) VALUES(?,?)').run('run-1', JSON.stringify(params));
    expect(() => migrateAgentEfforts({ db: f.db, log: vi.fn() })).not.toThrow();
    expect(JSON.parse(f.db.prepare('SELECT params FROM pipeline_run_requests WHERE request_id=?').get('run-1').params)).toEqual(params);
  });
});
