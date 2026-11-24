import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createRoleStore, createTeamStore, createTemplateStore, createStepPresetStore } from '../pipelines/library-store.js';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { migrateRolesAndWorkflows, renameRoleEverywhere } from '../pipelines/role-migration.js';
import { BUILT_IN_ROLES } from '../../shared/workflow-templates.mjs';
import { isTeamCompatible, missingTeamRoles, requiredWorkflowRoles } from '../../shared/pipeline-definitions.mjs';

const NOW = () => '2026-11-24T20:00:00.000Z';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';

describe('structured roles and migration', () => {
  it('computes required roles and team compatibility', () => {
    const nodes = [
      { name: 'Brainstorm', role: 'Thinking partner' },
      { name: 'Specify', role: 'Planner' },
      { name: 'Review', role: 'Planner' },
      { name: 'Commit', role: 'Committer' },
    ];
    expect(requiredWorkflowRoles(nodes)).toEqual(['Thinking partner', 'Planner', 'Committer']);

    const devTeam = {
      members: [
        { role: 'Planner', agentId: AGENT_ID },
        { role: 'Committer', agentId: AGENT_ID },
      ],
    };
    expect(missingTeamRoles(nodes, devTeam)).toEqual(['Thinking partner']);
    expect(isTeamCompatible(nodes, devTeam)).toBe(false);

    // Disabling Brainstorm leaves only Planner + Committer, which devTeam covers.
    expect(isTeamCompatible(nodes.slice(1), devTeam)).toBe(true);
    expect(missingTeamRoles(nodes.slice(1), devTeam)).toEqual([]);
  });

  it('seeds built-in roles once, strips legacy agentId, backfills blank roles, and harvests custom roles', () => {
    const db = new Database(':memory:');
    // Simulate a legacy database with workflows containing agentId and a blank role, plus a custom team role.
    db.exec(`
      CREATE TABLE pipeline_workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        nodes TEXT NOT NULL,
        agents_decide INTEGER NOT NULL DEFAULT 0,
        progress_file TEXT,
        kind TEXT NOT NULL DEFAULT 'other',
        description TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'local',
        source_id TEXT,
        source_version INTEGER,
        source_base TEXT,
        source_updated_at TEXT
      );
    `);
    const legacyNodes = [
      { name: 'Draft', role: '', agentId: AGENT_ID, prompt: 'Draft {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
      { name: 'Check', role: 'developer', agentId: null, prompt: 'Check {input}', repeat: { mode: 'once' }, readOnly: true, approval: false, askOwner: false },
    ];
    db.prepare(`INSERT INTO pipeline_workflows (id, name, nodes, agents_decide, progress_file, kind, description, revision, created_at, updated_at)
      VALUES (?, ?, ?, 0, NULL, 'other', '', 1, ?, ?)`).run(
      '22222222-2222-4222-8222-222222222222',
      'Legacy flow',
      JSON.stringify(legacyNodes),
      NOW(),
      NOW(),
    );

    const roleStore = createRoleStore(db, { now: NOW });
    const teamStore = createTeamStore(db, { now: NOW });
    teamStore.create({ name: 'Ops', members: [{ role: 'Release captain', agentId: AGENT_ID }] });

    const first = migrateRolesAndWorkflows({ db, roleStore, now: NOW });
    expect(first.seededRoles).toEqual(BUILT_IN_ROLES.map(r => r.name));
    expect(first.harvestedRoles).toContain('Draft');
    expect(first.harvestedRoles).toContain('Release captain');
    expect(first.migratedWorkflows).toBe(1);

    const workflowStore = createWorkflowStore(db, { now: NOW });
    const migrated = workflowStore.get('22222222-2222-4222-8222-222222222222');
    expect(migrated.nodes[0]).not.toHaveProperty('agentId');
    expect(migrated.nodes[0].role).toBe('Draft');
    expect(migrated.nodes[1]).not.toHaveProperty('agentId');
    expect(migrated.nodes[1].role).toBe('Developer');

    // Deleting a built-in role is respected on subsequent startups (not re-seeded).
    const unused = roleStore.findByName('Thinking partner');
    roleStore.remove(unused.id);
    const second = migrateRolesAndWorkflows({ db, roleStore, now: NOW });
    expect(second.seededRoles).toEqual([]);
    expect(roleStore.findByName('Thinking partner')).toBeNull();
  });

  it('renames a role atomically across workflows, teams, templates, and saved steps', () => {
    const db = new Database(':memory:');
    const roleStore = createRoleStore(db, { now: NOW });
    const workflowStore = createWorkflowStore(db, { now: NOW });
    const teamStore = createTeamStore(db, { now: NOW });
    const templateStore = createTemplateStore(db, { now: NOW });
    const presetStore = createStepPresetStore(db, { now: NOW });

    const role = roleStore.create({ name: 'Builder', description: 'Builds code' });
    const wf = workflowStore.create({
      name: 'Build flow',
      agentsDecide: false,
      nodes: [{ name: 'Build', role: 'Builder', prompt: 'Do {input}', repeat: { mode: 'once' } }],
    });
    const team = teamStore.create({ name: 'Core', members: [{ role: 'Builder', agentId: AGENT_ID }] });
    const tpl = templateStore.create({
      name: 'Build tpl',
      agentsDecide: false,
      nodes: [{ name: 'Build', role: 'Builder', prompt: 'Do {input}', repeat: { mode: 'once' } }],
    });
    const preset = presetStore.create({
      name: 'Build step',
      role: 'Builder',
      prompt: 'Do {input}',
      repeat: { mode: 'once' },
    });

    db.transaction(() => {
      roleStore.update(role.id, { name: 'Implementer', description: 'Builds code', revision: role.revision });
      renameRoleEverywhere(db, 'Builder', 'Implementer');
    })();

    expect(workflowStore.get(wf.id).nodes[0].role).toBe('Implementer');
    expect(teamStore.get(team.id).members[0].role).toBe('Implementer');
    expect(templateStore.get(tpl.id).nodes[0].role).toBe('Implementer');
    expect(presetStore.get(preset.id).role).toBe('Implementer');
  });
});
