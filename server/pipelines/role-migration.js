/**
 * Seeds built-in structured roles and migrates legacy workflows, teams, templates,
 * and saved steps to reference canonical roles in `pipeline_roles` (with `agentId`
 * stripped from workflow nodes). Also provides transactional role renaming.
 */
import { BUILT_IN_ROLES } from '../../shared/workflow-templates.mjs';
import { ROLE_MAX } from '../../shared/pipeline-definitions.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function fallbackRoleName(nodeName) {
  const trimmed = typeof nodeName === 'string' ? nodeName.trim() : '';
  return (trimmed || 'Step').slice(0, ROLE_MAX).trim() || 'Step';
}

/**
 * Runs once per startup in a single SQLite transaction:
 * 1. Seeds `BUILT_IN_ROLES` once (tracked in `pipeline_role_seed` so deleted roles stay deleted).
 * 2. Strips `agentId` from `pipeline_workflows` nodes, backfills empty `role` from `node.name`,
 *    registers any custom roles already in use across workflows/teams/templates/presets, and
 *    normalizes role casing to the canonical name in `pipeline_roles`.
 */
export function migrateRolesAndWorkflows({ db, roleStore, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('role migration: db must be a database handle');
  }
  if (!roleStore || typeof roleStore.ensureRole !== 'function') {
    throw new TypeError('role migration: roleStore must be a role store');
  }
  if (typeof now !== 'function') throw new TypeError('role migration: now must be a function');

  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_role_seed (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seeded_at TEXT NOT NULL
    );
  `);

  return db.transaction(() => {
    const seededRoles = [];
    const harvestedRoles = [];
    let migratedWorkflows = 0;

    const seedRow = db.prepare('SELECT seeded_at FROM pipeline_role_seed WHERE id = 1').get();
    if (!seedRow) {
      const stamp = now();
      if (typeof stamp !== 'string' || !ISO.test(stamp)) throw new TypeError('role migration: now must return an ISO timestamp');
      for (const role of BUILT_IN_ROLES) {
        const existed = Boolean(roleStore.findByName(role.name));
        roleStore.ensureRole(role.name, role.description);
        if (!existed) seededRoles.push(role.name);
      }
      db.prepare('INSERT INTO pipeline_role_seed (id, seeded_at) VALUES (1, ?)').run(stamp);
    }

    const canonicalize = (rawRole, fallbackName = null) => {
      const candidate = typeof rawRole === 'string' && rawRole.trim() ? rawRole.trim() : (fallbackName ? fallbackRoleName(fallbackName) : '');
      if (!candidate) return '';
      const existing = roleStore.findByName(candidate);
      if (existing) return existing.name;
      const created = roleStore.ensureRole(candidate);
      harvestedRoles.push(created.name);
      return created.name;
    };

    if (tableExists(db, 'pipeline_workflows')) {
      const updateWorkflow = db.prepare('UPDATE pipeline_workflows SET nodes = ? WHERE id = ?');
      for (const row of db.prepare('SELECT id, nodes FROM pipeline_workflows').all()) {
        let nodes;
        try { nodes = JSON.parse(row.nodes); } catch { continue; }
        if (!Array.isArray(nodes)) continue;
        let changed = false;
        const nextNodes = nodes.map(node => {
          if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
          const hadAgent = Object.hasOwn(node, 'agentId');
          const canonical = canonicalize(node.role, node.name);
          if (!hadAgent && node.role === canonical) return node;
          changed = true;
          const { agentId: _dropped, ...rest } = node;
          return { ...rest, role: canonical };
        });
        if (changed) {
          updateWorkflow.run(JSON.stringify(nextNodes), row.id);
          migratedWorkflows += 1;
        }
      }
    }

    if (tableExists(db, 'pipeline_teams')) {
      const updateTeam = db.prepare('UPDATE pipeline_teams SET body = ? WHERE id = ?');
      for (const row of db.prepare('SELECT id, body FROM pipeline_teams').all()) {
        let body;
        try { body = JSON.parse(row.body); } catch { continue; }
        if (!body || !Array.isArray(body.members)) continue;
        let changed = false;
        const members = body.members.map(member => {
          if (!member || typeof member !== 'object' || typeof member.role !== 'string' || !member.role.trim()) return member;
          const canonical = canonicalize(member.role);
          if (member.role === canonical) return member;
          changed = true;
          return { ...member, role: canonical };
        });
        if (changed) updateTeam.run(JSON.stringify({ ...body, members }), row.id);
      }
    }

    if (tableExists(db, 'pipeline_workflow_templates')) {
      const updateTemplate = db.prepare('UPDATE pipeline_workflow_templates SET body = ? WHERE id = ?');
      for (const row of db.prepare('SELECT id, body FROM pipeline_workflow_templates').all()) {
        let body;
        try { body = JSON.parse(row.body); } catch { continue; }
        if (!body || !Array.isArray(body.nodes)) continue;
        let changed = false;
        const nodes = body.nodes.map(node => {
          if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
          const canonical = canonicalize(node.role, node.name);
          if (node.role === canonical) return node;
          changed = true;
          return { ...node, role: canonical };
        });
        if (changed) updateTemplate.run(JSON.stringify({ ...body, nodes }), row.id);
      }
    }

    if (tableExists(db, 'pipeline_step_presets')) {
      const updatePreset = db.prepare('UPDATE pipeline_step_presets SET body = ? WHERE id = ?');
      for (const row of db.prepare('SELECT id, body FROM pipeline_step_presets').all()) {
        let body;
        try { body = JSON.parse(row.body); } catch { continue; }
        if (!body || typeof body !== 'object') continue;
        const canonical = canonicalize(body.role, body.name);
        if (body.role !== canonical) {
          updatePreset.run(JSON.stringify({ ...body, role: canonical }), row.id);
        }
      }
    }

    return { seededRoles, harvestedRoles, migratedWorkflows };
  })();
}

/**
 * Atomically updates every stored workflow, team, template, and saved step that references
 * `oldName` (case-insensitively) to `newName`. Call inside the same transaction as updating
 * the `pipeline_roles` row.
 */
export function renameRoleEverywhere(db, oldName, newName) {
  const fromKey = oldName.trim().toLowerCase();
  const toName = newName.trim();
  if (!fromKey || !toName) return;

  if (tableExists(db, 'pipeline_workflows')) {
    const updateWorkflow = db.prepare('UPDATE pipeline_workflows SET nodes = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, nodes FROM pipeline_workflows').all()) {
      let nodes;
      try { nodes = JSON.parse(row.nodes); } catch { continue; }
      if (!Array.isArray(nodes)) continue;
      let changed = false;
      const next = nodes.map(node => {
        if (typeof node?.role === 'string' && node.role.trim().toLowerCase() === fromKey && node.role !== toName) {
          changed = true;
          return { ...node, role: toName };
        }
        return node;
      });
      if (changed) updateWorkflow.run(JSON.stringify(next), row.id);
    }
  }

  if (tableExists(db, 'pipeline_teams')) {
    const updateTeam = db.prepare('UPDATE pipeline_teams SET body = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, body FROM pipeline_teams').all()) {
      let body;
      try { body = JSON.parse(row.body); } catch { continue; }
      if (!body || !Array.isArray(body.members)) continue;
      let changed = false;
      const members = body.members.map(member => {
        if (typeof member?.role === 'string' && member.role.trim().toLowerCase() === fromKey && member.role !== toName) {
          changed = true;
          return { ...member, role: toName };
        }
        return member;
      });
      if (changed) updateTeam.run(JSON.stringify({ ...body, members }), row.id);
    }
  }

  if (tableExists(db, 'pipeline_workflow_templates')) {
    const updateTemplate = db.prepare('UPDATE pipeline_workflow_templates SET body = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, body FROM pipeline_workflow_templates').all()) {
      let body;
      try { body = JSON.parse(row.body); } catch { continue; }
      if (!body || !Array.isArray(body.nodes)) continue;
      let changed = false;
      const nodes = body.nodes.map(node => {
        if (typeof node?.role === 'string' && node.role.trim().toLowerCase() === fromKey && node.role !== toName) {
          changed = true;
          return { ...node, role: toName };
        }
        return node;
      });
      if (changed) updateTemplate.run(JSON.stringify({ ...body, nodes }), row.id);
    }
  }

  if (tableExists(db, 'pipeline_step_presets')) {
    const updatePreset = db.prepare('UPDATE pipeline_step_presets SET body = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, body FROM pipeline_step_presets').all()) {
      let body;
      try { body = JSON.parse(row.body); } catch { continue; }
      if (typeof body?.role === 'string' && body.role.trim().toLowerCase() === fromKey && body.role !== toName) {
        updatePreset.run(JSON.stringify({ ...body, role: toName }), row.id);
      }
    }
  }
}
