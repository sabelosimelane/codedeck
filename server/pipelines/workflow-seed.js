/**
 * A new install starts with the built-in workflows already saved, so that a run can be started
 * without building one first. Each step is left to its role: the owner makes the agents and a
 * team, and the team supplies the agent for each role when a run starts.
 *
 * It happens once per database. The workflows are ordinary saved workflows from then on: the
 * owner may edit, rename or delete them, and none comes back. An install that already had
 * workflows when this was introduced gets nothing added.
 */
import { WORKFLOW_TEMPLATES } from '../../shared/workflow-templates.mjs';
import { builtinTemplateDefinition } from './workflow-store.js';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function seedBuiltInWorkflows({ db, workflows, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('workflow seed: db must be a database handle');
  if (typeof workflows?.list !== 'function' || typeof workflows?.create !== 'function') throw new TypeError('workflow seed: workflows must be a workflow store');
  if (typeof now !== 'function') throw new TypeError('workflow seed: now must be a function');

  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_workflow_seed (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seeded_at TEXT NOT NULL
    );
  `);

  return db.transaction(() => {
    const row = db.prepare('SELECT seeded_at FROM pipeline_workflow_seed WHERE id = 1').get();
    if (row) {
      if (typeof row.seeded_at !== 'string' || !ISO.test(row.seeded_at)) throw new Error('pipeline_workflow_seed row 1: seeded_at must be an ISO timestamp');
      return { seeded: [] };
    }
    const stamp = now();
    if (typeof stamp !== 'string' || !ISO.test(stamp)) throw new TypeError('workflow seed: now must return an ISO timestamp');
    const seeded = [];
    // An install with workflows of its own keeps exactly those.
    if (workflows.list().length === 0) {
      for (const template of WORKFLOW_TEMPLATES) {
        // Seeded workflows are linked built-ins: version and base from the template (§5.1).
        const definition = builtinTemplateDefinition(template);
        workflows.create({
          name: definition.name,
          kind: definition.kind,
          description: definition.description,
          agentsDecide: definition.agentsDecide,
          progressFile: definition.progressFile,
          nodes: definition.nodes,
        }, {
          source: { kind: 'builtin', id: template.id, version: template.version, base: definition, updatedAt: null },
        });
        seeded.push(template.name);
      }
    }
    db.prepare('INSERT INTO pipeline_workflow_seed (id, seeded_at) VALUES (1, ?)').run(stamp);
    return { seeded };
  })();
}
