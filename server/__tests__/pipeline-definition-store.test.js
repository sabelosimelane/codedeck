import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { createSettingsStore } from '../pipelines/settings-store.js';

const AGENT_UUID = 'c410a1b2-3456-4789-8abc-def012345678';
const databases = [];

function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  return {
    db,
    agents: createAgentStore(db),
    workflows: createWorkflowStore(db),
    settings: createSettingsStore(db),
  };
}

afterEach(() => {
  databases.splice(0).forEach(db => db.close());
});

const validAgent = {
  name: 'codex-sol-high',
  launchCommand: 'codex --model gpt-5',
  resetCommand: '/clear',
};

function node(agentId = AGENT_UUID) {
  return {
    name: 'Develop',
    agentId,
    prompt: 'Implement {input}',
    repeat: { mode: 'once' },
  };
}

describe('pipeline agent store', () => {
  it('creates an agent with a UUID, revision 1 and timestamps', () => {
    const { agents } = setup();
    const created = agents.create(validAgent);
    expect(created).toMatchObject({
      name: 'codex-sol-high',
      launchCommand: 'codex --model gpt-5',
      resetCommand: '/clear',
      revision: 1,
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.updatedAt).toBe(created.createdAt);
    expect(agents.get(created.id)).toEqual(created);
  });

  it('trims the name on write', () => {
    const { agents } = setup();
    expect(agents.create({ ...validAgent, name: '  haiku  ' }).name).toBe('haiku');
  });

  it('lists agents ordered by name case-insensitively', () => {
    const { agents } = setup();
    agents.create({ ...validAgent, name: 'Zebra' });
    agents.create({ ...validAgent, name: 'alpha' });
    expect(agents.list().map(a => a.name)).toEqual(['alpha', 'Zebra']);
  });

  it('updates an agent when the revision matches and increments revision', () => {
    const { agents } = setup();
    const created = agents.create(validAgent);
    const updated = agents.update(created.id, {
      name: 'renamed',
      launchCommand: 'codex --model gpt-6',
      resetCommand: '/reset',
      revision: 1,
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: 'renamed',
      launchCommand: 'codex --model gpt-6',
      resetCommand: '/reset',
      revision: 2,
      createdAt: created.createdAt,
    });
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
  });

  it('throws a revision conflict when the revision is stale', () => {
    const { agents } = setup();
    const created = agents.create(validAgent);
    agents.update(created.id, { ...validAgent, name: 'once', revision: 1 });
    expect(() => agents.update(created.id, { ...validAgent, name: 'twice', revision: 1 }))
      .toThrow(/revision/i);
  });

  it('rejects a second agent with the same name case-insensitively', () => {
    const { agents } = setup();
    agents.create(validAgent);
    expect(() => agents.create({ ...validAgent, name: 'CODEX-SOL-HIGH' }))
      .toThrow(/name/i);
  });

  it('rejects renaming onto another agent case-insensitively', () => {
    const { agents } = setup();
    agents.create(validAgent);
    const other = agents.create({ ...validAgent, name: 'other' });
    expect(() => agents.update(other.id, {
      ...validAgent,
      name: 'Codex-Sol-High',
      revision: 1,
    })).toThrow(/name/i);
  });

  it('allows an update that keeps the same name with different casing', () => {
    const { agents } = setup();
    const created = agents.create(validAgent);
    expect(agents.update(created.id, {
      ...validAgent,
      name: 'CODEX-SOL-HIGH',
      revision: 1,
    }).name).toBe('CODEX-SOL-HIGH');
  });

  it('removes an agent and returns null for a missing id', () => {
    const { agents } = setup();
    const created = agents.create(validAgent);
    agents.remove(created.id);
    expect(agents.get(created.id)).toBeNull();
    expect(() => agents.remove(created.id)).not.toThrow();
  });

  it('rejects invalid create and update bodies', () => {
    const { agents } = setup();
    expect(() => agents.create({ ...validAgent, name: '' })).toThrow();
    const created = agents.create(validAgent);
    expect(() => agents.update(created.id, {
      ...validAgent,
      launchCommand: '',
      revision: 1,
    })).toThrow();
  });

  it('throws naming table, row and field when a persisted field is corrupt', () => {
    const { db, agents } = setup();
    const created = agents.create(validAgent);
    db.prepare('UPDATE pipeline_agents SET name = ? WHERE id = ?').run('', created.id);
    expect(() => agents.get(created.id)).toThrow(
      new RegExp(`pipeline_agents.*${created.id}.*name`, 'i'),
    );
  });

  it.each([
    ['launch_command', ''],
    ['reset_command', ''],
    ['revision', 0],
    ['created_at', 'yesterday'],
    ['updated_at', ''],
  ])('throws naming table/row/field for corrupt %s', (column, value) => {
    const { db, agents } = setup();
    const created = agents.create(validAgent);
    db.prepare(`UPDATE pipeline_agents SET ${column} = ? WHERE id = ?`).run(value, created.id);
    expect(() => agents.get(created.id)).toThrow(
      new RegExp(`pipeline_agents.*${created.id}`, 'i'),
    );
  });
});

describe('pipeline workflow store', () => {
  it('creates a workflow with nodes, revision 1 and timestamps', () => {
    const { agents, workflows } = setup();
    const agent = agents.create(validAgent);
    const created = workflows.create({
      name: 'Feature', agentsDecide: false,
      nodes: [node(agent.id)],
    });
    expect(created).toMatchObject({
      name: 'Feature',
      revision: 1,
      nodes: [node(agent.id)],
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(workflows.get(created.id)).toEqual(created);
  });

  it('lists workflows ordered by name case-insensitively', () => {
    const { agents, workflows } = setup();
    const agent = agents.create(validAgent);
    workflows.create({ name: 'Zebra', agentsDecide: false, nodes: [node(agent.id)] });
    workflows.create({ name: 'alpha', agentsDecide: false, nodes: [{ ...node(agent.id), name: 'A' }] });
    expect(workflows.list().map(w => w.name)).toEqual(['alpha', 'Zebra']);
  });

  it('updates a workflow when the revision matches', () => {
    const { agents, workflows } = setup();
    const agent = agents.create(validAgent);
    const created = workflows.create({ name: 'Feature', agentsDecide: false, nodes: [node(agent.id)] });
    const updated = workflows.update(created.id, {
      name: 'Feature v2', agentsDecide: false,
      nodes: [{ ...node(agent.id), name: 'Ship', prompt: 'Ship it' }],
      revision: 1,
    });
    expect(updated).toMatchObject({
      name: 'Feature v2',
      revision: 2,
      nodes: [{ ...node(agent.id), name: 'Ship', prompt: 'Ship it' }],
    });
  });

  it('throws a revision conflict when the revision is stale', () => {
    const { agents, workflows } = setup();
    const agent = agents.create(validAgent);
    const created = workflows.create({ name: 'Feature', agentsDecide: false, nodes: [node(agent.id)] });
    workflows.update(created.id, { name: 'once', agentsDecide: false, nodes: [node(agent.id)], revision: 1 });
    expect(() => workflows.update(created.id, {
      name: 'twice', agentsDecide: false,
      nodes: [node(agent.id)],
      revision: 1,
    })).toThrow(/revision/i);
  });

  it('rejects duplicate workflow names case-insensitively', () => {
    const { agents, workflows } = setup();
    const agent = agents.create(validAgent);
    workflows.create({ name: 'Feature', agentsDecide: false, nodes: [node(agent.id)] });
    expect(() => workflows.create({
      name: 'feature', agentsDecide: false,
      nodes: [{ ...node(agent.id), name: 'Other' }],
    })).toThrow(/name/i);
  });

  it('removes a workflow', () => {
    const { agents, workflows } = setup();
    const agent = agents.create(validAgent);
    const created = workflows.create({ name: 'Feature', agentsDecide: false, nodes: [node(agent.id)] });
    workflows.remove(created.id);
    expect(workflows.get(created.id)).toBeNull();
  });

  it('rejects invalid nodes on write', () => {
    const { agents, workflows } = setup();
    const agent = agents.create(validAgent);
    expect(() => workflows.create({ name: 'Feature', agentsDecide: false, nodes: [] })).toThrow();
    expect(() => workflows.create({
      name: 'Feature', agentsDecide: false,
      nodes: [{ ...node(agent.id), agentId: 'not-a-uuid' }],
    })).toThrow();
  });

  it('keeps who decides, and changes it on update', () => {
    const { agents, workflows } = setup();
    const agent = agents.create(validAgent);
    const created = workflows.create({ name: 'Feature', agentsDecide: true, nodes: [node(agent.id)] });
    expect(created.agentsDecide).toBe(true);
    expect(workflows.get(created.id).agentsDecide).toBe(true);
    const updated = workflows.update(created.id, { name: 'Feature', agentsDecide: false, nodes: [node(agent.id)], revision: 1 });
    expect(updated.agentsDecide).toBe(false);
    expect(workflows.list().map(workflow => workflow.agentsDecide)).toEqual([false]);
  });

  it('stores a loop back under the name of the node it returns to', () => {
    const { agents, workflows } = setup();
    const agent = agents.create(validAgent);
    const created = workflows.create({
      name: 'Feature',
      agentsDecide: false,
      nodes: [
        node(agent.id),
        { ...node(agent.id), name: 'Test', repeat: { mode: 'loop_back', to: ' develop ', max: 20 } },
      ],
    });
    expect(created.nodes[1].repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: 20 });
    expect(workflows.get(created.id).nodes[1].repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: 20 });
  });

  it('adds the column to a database created before it; those workflows left decisions to the owner', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(`
      CREATE TABLE pipeline_workflows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, nodes TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const id = 'd5207c2e-0000-4000-8000-000000000001';
    db.prepare('INSERT INTO pipeline_workflows VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'Feature', JSON.stringify([node()]), 3, '2026-11-13T10:00:00.000Z', '2026-11-13T10:00:00.000Z');
    const workflows = createWorkflowStore(db);
    expect(workflows.get(id)).toMatchObject({ name: 'Feature', revision: 3, agentsDecide: false, progressFile: null });
    // Constructing the store again finds the column already there.
    expect(createWorkflowStore(db).get(id).agentsDecide).toBe(false);
  });

  it.each([2, -1, null, 'true'])('throws naming table/row/field when the stored agents_decide is %s', (stored) => {
    const { db, agents, workflows } = setup();
    const agent = agents.create(validAgent);
    const created = workflows.create({ name: 'Feature', agentsDecide: false, nodes: [node(agent.id)] });
    try {
      db.prepare('UPDATE pipeline_workflows SET agents_decide = ? WHERE id = ?').run(stored, created.id);
    } catch (err) {
      // NOT NULL refuses the null case at write time; the read guard is then not reachable.
      expect(stored).toBeNull();
      expect(String(err.message)).toMatch(/NOT NULL/);
      return;
    }
    expect(() => workflows.get(created.id)).toThrow(
      new RegExp(`pipeline_workflows row ${created.id} field agents_decide: must be 0 or 1`),
    );
  });

  it('throws naming table/row/field when nodes JSON is corrupt', () => {
    const { db, agents, workflows } = setup();
    const agent = agents.create(validAgent);
    const created = workflows.create({ name: 'Feature', agentsDecide: false, nodes: [node(agent.id)] });
    db.prepare('UPDATE pipeline_workflows SET nodes = ? WHERE id = ?').run('[]', created.id);
    expect(() => workflows.get(created.id)).toThrow(
      new RegExp(`pipeline_workflows.*${created.id}.*nodes`, 'i'),
    );
  });
});

describe('pipeline settings store', () => {
  it('returns the default single-row settings', () => {
    const { settings } = setup();
    expect(settings.get()).toEqual({
      setupAgentId: null,
      revision: 1,
    });
  });

  it('updates the setup agent when the revision matches', () => {
    const { agents, settings } = setup();
    const agent = agents.create(validAgent);
    const updated = settings.update({ setupAgentId: agent.id, revision: 1 });
    expect(updated).toEqual({ setupAgentId: agent.id, revision: 2 });
    expect(settings.get()).toEqual(updated);
  });

  it('clears the setup agent back to null', () => {
    const { agents, settings } = setup();
    const agent = agents.create(validAgent);
    settings.update({ setupAgentId: agent.id, revision: 1 });
    expect(settings.update({ setupAgentId: null, revision: 2 })).toEqual({
      setupAgentId: null,
      revision: 3,
    });
  });

  it('throws a revision conflict when the revision is stale', () => {
    const { settings } = setup();
    expect(() => settings.update({ setupAgentId: null, revision: 99 }))
      .toThrow(/revision/i);
  });

  it('rejects an invalid setupAgentId', () => {
    const { settings } = setup();
    expect(() => settings.update({ setupAgentId: 'nope', revision: 1 })).toThrow();
  });

  it('throws naming table/row/field when the stored setup_agent_id is corrupt', () => {
    const { db, settings } = setup();
    settings.get();
    db.prepare('UPDATE pipeline_settings SET setup_agent_id = ? WHERE id = 1').run('bad');
    expect(() => settings.get()).toThrow(/pipeline_settings.*1.*setup_agent_id/i);
  });
});

describe('workflow progress file persistence', () => {
  it('round-trips a trimmed path and clears it on absent PUT', () => {
    const { agents, workflows } = setup();
    const agent = agents.create(validAgent);
    const created = workflows.create({ name: 'Progress', agentsDecide: false, nodes: [node(agent.id)], progressFile: ' docs/{input}.md ' });
    expect(created.progressFile).toBe('docs/{input}.md');
    expect(workflows.update(created.id, { name: 'Progress', agentsDecide: false, nodes: [node(agent.id)], revision: 1 }).progressFile).toBeNull();
  });
  it('adds the column to an existing database and rejects corrupt rows', () => {
    const { db, agents, workflows } = setup();
    const agent = agents.create(validAgent);
    const created = workflows.create({ name: 'Progress', agentsDecide: false, nodes: [node(agent.id)] });
    expect(db.prepare('PRAGMA table_info(pipeline_workflows)').all().some(column => column.name === 'progress_file')).toBe(true);
    db.prepare('UPDATE pipeline_workflows SET progress_file = ? WHERE id = ?').run('../bad.md', created.id);
    expect(() => workflows.get(created.id)).toThrow('progress_file');
  });
});
