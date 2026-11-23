import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { seedBuiltInWorkflows } from '../pipelines/workflow-seed.js';
import { WORKFLOW_TEMPLATES } from '../../shared/workflow-templates.mjs';
import { validateWorkflowBody } from '../../shared/pipeline-definitions.mjs';

const databases = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  return { db, agents: createAgentStore(db), workflows: createWorkflowStore(db) };
}
const NOW = () => '2026-11-23T21:00:00.000Z';

describe('seedBuiltInWorkflows', () => {
  it('gives a new install every built-in workflow with its prompts, each step left to the team role', () => {
    const { db, workflows } = setup();
    const result = seedBuiltInWorkflows({ db, workflows, now: NOW });
    expect(result).toEqual({ seeded: WORKFLOW_TEMPLATES.map(template => template.name) });
    const saved = workflows.list();
    expect(saved.map(workflow => workflow.name).sort()).toEqual(WORKFLOW_TEMPLATES.map(template => template.name).sort());
    for (const template of WORKFLOW_TEMPLATES) {
      const workflow = saved.find(item => item.name === template.name);
      expect(workflow).toMatchObject({ kind: template.kind, description: template.description, agentsDecide: template.agentsDecide, progressFile: template.progressFile, revision: 1 });
      expect(workflow.nodes.map(({ name, role, prompt, repeat, readOnly, approval, askOwner }) => ({ name, role, prompt, repeat, readOnly, approval, askOwner })))
        .toEqual(template.nodes.map(({ name, role, prompt, repeat, readOnly, approval, askOwner }) => ({ name, role, prompt, repeat, readOnly, approval, askOwner })));
      // No agent is chosen: the owner's team supplies one for each role when a run starts.
      expect(workflow.nodes.every(node => node.agentId === null && node.role.trim() !== '')).toBe(true);
      const { id, revision, createdAt, updatedAt, ...body } = workflow;
      expect(validateWorkflowBody(body)).toEqual([]);
    }
  });

  it('happens once: workflows the owner deleted or renamed do not come back', () => {
    const { db, workflows } = setup();
    seedBuiltInWorkflows({ db, workflows, now: NOW });
    const [first] = workflows.list();
    workflows.remove(first.id);
    const before = workflows.list().map(workflow => workflow.name);
    expect(seedBuiltInWorkflows({ db, workflows, now: NOW })).toEqual({ seeded: [] });
    // A later start of the backend makes its own store on the same database.
    expect(seedBuiltInWorkflows({ db, workflows: createWorkflowStore(db), now: NOW })).toEqual({ seeded: [] });
    expect(workflows.list().map(workflow => workflow.name)).toEqual(before);
  });

  it('adds nothing to an install that already has workflows, now or later', () => {
    const { db, agents, workflows } = setup();
    const agent = agents.create({ name: 'codex', launchCommand: 'codex', resetCommand: '/clear' });
    const own = workflows.create({ name: 'Mine', agentsDecide: false, nodes: [{ name: 'Do', role: '', agentId: agent.id, prompt: 'Do {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }] });
    expect(seedBuiltInWorkflows({ db, workflows, now: NOW })).toEqual({ seeded: [] });
    workflows.remove(own.id);
    expect(seedBuiltInWorkflows({ db, workflows, now: NOW })).toEqual({ seeded: [] });
    expect(workflows.list()).toEqual([]);
  });

  it('records when it ran', () => {
    const { db, workflows } = setup();
    seedBuiltInWorkflows({ db, workflows, now: NOW });
    expect(db.prepare('SELECT id, seeded_at FROM pipeline_workflow_seed').all()).toEqual([{ id: 1, seeded_at: NOW() }]);
  });

  it('seeds all of them or none', () => {
    const { db, workflows } = setup();
    let calls = 0;
    const failing = { list: () => workflows.list(), create: (body) => { calls += 1; if (calls === 3) throw new Error('disk full'); return workflows.create(body); } };
    expect(() => seedBuiltInWorkflows({ db, workflows: failing, now: NOW })).toThrow('disk full');
    expect(workflows.list()).toEqual([]);
    // Nothing was recorded, so the next start tries again.
    expect(seedBuiltInWorkflows({ db, workflows, now: NOW }).seeded).toHaveLength(WORKFLOW_TEMPLATES.length);
  });

  it('refuses a stored record it does not understand', () => {
    const { db, workflows } = setup();
    seedBuiltInWorkflows({ db, workflows, now: NOW });
    db.prepare('UPDATE pipeline_workflow_seed SET seeded_at = ?').run('yesterday');
    expect(() => seedBuiltInWorkflows({ db, workflows, now: NOW })).toThrow('pipeline_workflow_seed row 1: seeded_at must be an ISO timestamp');
  });

  it.each([
    ['db', { db: null }],
    ['workflows', { workflows: {} }],
    ['workflows', { workflows: { list: () => [] } }],
    ['now', { now: 'x' }],
  ])('refuses a bad %s', (name, bad) => {
    const { db, workflows } = setup();
    expect(() => seedBuiltInWorkflows({ db, workflows, now: NOW, ...bad })).toThrow(new RegExp(name));
  });

  it('refuses a clock that does not give an ISO timestamp', () => {
    const { db, workflows } = setup();
    expect(() => seedBuiltInWorkflows({ db, workflows, now: () => 'soon' })).toThrow(/now/);
    expect(workflows.list()).toEqual([]);
  });
});
