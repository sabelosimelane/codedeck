import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { seedBuiltInWorkflows } from '../pipelines/workflow-seed.js';
import { WORKFLOW_TEMPLATES } from '../../shared/workflow-templates.mjs';
import { canonicalDefinition } from '../../shared/workflow-changes.mjs';

const databases = [];
function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  return { db, workflows: createWorkflowStore(db, { now: NOW }) };
}
afterEach(() => { databases.splice(0).forEach(db => db.close()); });

const NOW = () => '2026-11-24T13:05:52.000Z';

function localBody(overrides = {}) {
  return {
    name: 'Bug fix',
    description: 'Investigate, agree on a fix, build, review, test and commit.',
    kind: 'bugfix',
    agentsDecide: false,
    progressFile: null,
    nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
    ...overrides,
  };
}

function definitionOf(body) {
  return { ...body, nodes: body.nodes.map(node => ({ ...node })) };
}

/** A definition with the shape of a shipped template, at a chosen version. */
function templateLike(id, version, mutate = {}) {
  const template = WORKFLOW_TEMPLATES.find(item => item.id === id);
  return {
    id,
    ...JSON.parse(JSON.stringify({
      name: template.name,
      description: template.description,
      kind: template.kind,
      agentsDecide: template.agentsDecide,
      progressFile: template.progressFile,
      nodes: template.nodes,
    })),
    ...mutate,
    version,
  };
}

describe('built-in lifecycle', () => {
  it('seeds built-in workflows linked to their template with version and base', () => {
    const { db, workflows } = setup();
    seedBuiltInWorkflows({ db, workflows, now: NOW });
    const saved = workflows.list();
    expect(saved).toHaveLength(WORKFLOW_TEMPLATES.length);
    for (const template of WORKFLOW_TEMPLATES) {
      const workflow = saved.find(item => item.name === template.name);
      expect(workflow.source.kind).toBe('builtin');
      expect(workflow.source.id).toBe(template.id);
      expect(workflow.source.version).toBe(template.version);
      expect(workflow.source.updatedAt).toBe(null);
      expect(JSON.stringify(canonicalDefinition(workflow.source.base)))
        .toBe(JSON.stringify(canonicalDefinition(template)));
    }
  });

  it('deleting a built-in workflow writes a dismissal in the same transaction', () => {
    const { db, workflows } = setup();
    const created = workflows.create(localBody(), {
      source: { kind: 'builtin', id: 'bug-fix', version: 1, base: definitionOf(localBody()), updatedAt: null },
    });
    workflows.remove(created.id);
    expect(workflows.list()).toEqual([]);
    expect(db.prepare('SELECT template_id, dismissed_at FROM pipeline_builtin_dismissals').all())
      .toEqual([{ template_id: 'bug-fix', dismissed_at: NOW() }]);
  });

  it('deleting a local workflow writes no dismissal', () => {
    const { db, workflows } = setup();
    const created = workflows.create(localBody());
    workflows.remove(created.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pipeline_builtin_dismissals').get().n).toBe(0);
  });
});

describe('one-time source linking', () => {
  it('links an identical saved workflow with its base and an edited one without', () => {
    const { db, workflows } = setup();
    const bugFix = WORKFLOW_TEMPLATES.find(item => item.id === 'bug-fix');
    const feature = WORKFLOW_TEMPLATES.find(item => item.id === 'feature-build');
    const identical = workflows.create({
      name: bugFix.name, description: bugFix.description, kind: bugFix.kind,
      agentsDecide: bugFix.agentsDecide, progressFile: bugFix.progressFile,
      nodes: bugFix.nodes.map(node => ({ ...node })),
    });
    const edited = workflows.create({
      name: feature.name, description: feature.description, kind: feature.kind,
      agentsDecide: feature.agentsDecide, progressFile: feature.progressFile,
      nodes: feature.nodes.map((node, index) => index === 0
        ? { ...node, prompt: `${node.prompt} Extra owner words.` }
        : { ...node }),
    });
    const result = workflows.linkBuiltinSources();
    expect(result.linked.sort()).toEqual([bugFix.name, feature.name].sort());
    const linkedIdentical = workflows.get(identical.id);
    expect(linkedIdentical.source.kind).toBe('builtin');
    expect(linkedIdentical.source.id).toBe('bug-fix');
    expect(linkedIdentical.source.version).toBe(bugFix.version);
    expect(JSON.stringify(canonicalDefinition(linkedIdentical.source.base)))
      .toBe(JSON.stringify(canonicalDefinition(bugFix)));
    const linkedEdited = workflows.get(edited.id);
    expect(linkedEdited.source).toMatchObject({ kind: 'builtin', id: 'feature-build', version: feature.version, base: null });
    expect(db.prepare('SELECT id FROM pipeline_workflow_source_link').all()).toEqual([{ id: 1 }]);
  });

  it('links once and never takes a template another workflow already links', () => {
    const { workflows } = setup();
    const bugFix = WORKFLOW_TEMPLATES.find(item => item.id === 'bug-fix');
    workflows.create({
      name: `${bugFix.name} (old)`, description: bugFix.description, kind: bugFix.kind,
      agentsDecide: bugFix.agentsDecide, progressFile: bugFix.progressFile,
      nodes: bugFix.nodes.map(node => ({ ...node })),
    }, { source: { kind: 'builtin', id: 'bug-fix', version: 1, base: null, updatedAt: null } });
    const other = workflows.create(localBody({ name: 'Bug fix' }));
    expect(workflows.linkBuiltinSources()).toEqual({ linked: [] });
    expect(workflows.get(other.id).source.kind).toBe('local');
    expect(workflows.linkBuiltinSources()).toEqual({ linked: [] });
  });

  it('rejects an invalid linked_at on read and write, naming row 1 and linked_at', () => {
    const { db, workflows } = setup();
    db.prepare('INSERT INTO pipeline_workflow_source_link (id, linked_at) VALUES (1, ?)').run('invalid');
    expect(() => workflows.linkBuiltinSources()).toThrow(/row 1.*linked_at/i);

    db.prepare('DELETE FROM pipeline_workflow_source_link').run();
    db.prepare('INSERT INTO pipeline_workflow_source_link (id, linked_at) VALUES (1, ?)').run('2026-02-30T00:00:00.000Z');
    expect(() => workflows.linkBuiltinSources()).toThrow(/row 1.*linked_at/i);

    const db2 = new Database(':memory:');
    databases.push(db2);
    const badClockStore = createWorkflowStore(db2, { now: () => 'invalid' });
    expect(() => badClockStore.linkBuiltinSources()).toThrow(/row 1.*linked_at/i);
    expect(db2.prepare('SELECT COUNT(*) AS n FROM pipeline_workflow_source_link').get().n).toBe(0);
  });
});

describe('startup update to a newer built-in', () => {
  it('takes the newer definition for an unchanged workflow', () => {
    const { workflows } = setup();
    const oldTemplate = templateLike('bug-fix', 1);
    const base = {
      name: oldTemplate.name, description: oldTemplate.description, kind: oldTemplate.kind,
      agentsDecide: oldTemplate.agentsDecide, progressFile: oldTemplate.progressFile, nodes: oldTemplate.nodes,
    };
    const keptName = base.nodes[1].name;
    const created = workflows.create({
      ...base,
      nodes: base.nodes.map(node => ({ ...node })),
    }, { source: { kind: 'builtin', id: 'bug-fix', version: 1, base, updatedAt: null } });
    const renamedNode = `${base.nodes[0].name} v2`;
    const log = vi.fn();
    const result = workflows.applyBuiltinUpdates({
      templates: [{ ...templateLike('bug-fix', 2, {
        description: 'Updated description.',
        kind: 'build',
        agentsDecide: true,
        progressFile: 'docs/{input}',
        nodes: [{ ...base.nodes[0], name: renamedNode }, ...base.nodes.slice(1), { name: 'Verify new', role: 'Tester', prompt: 'Check it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
      }) }],
      now: NOW,
      log,
    });
    expect(result).toEqual({ updated: [base.name] });
    const updated = workflows.get(created.id);
    expect(updated.revision).toBe(2);
    expect(updated.description).toBe('Updated description.');
    expect(updated.kind).toBe('build');
    expect(updated.agentsDecide).toBe(true);
    expect(updated.progressFile).toBe('docs/{input}');
    expect(updated.source.version).toBe(2);
    expect(updated.source.updatedAt).toBe(NOW());
    expect(JSON.stringify(canonicalDefinition(updated.source.base)))
      .toBe(JSON.stringify(canonicalDefinition({ ...updated, name: updated.source.base.name })));
    expect(updated.nodes.find(node => node.name === keptName)).not.toHaveProperty('agentId');
    expect(updated.nodes.find(node => node.name === renamedNode)).not.toHaveProperty('agentId');
    expect(updated.nodes.find(node => node.name === 'Verify new').role).toBe('Tester');
    expect(log).toHaveBeenCalledWith(`[workflows] ${base.name} updated to built-in version 2`);
  });

  it('leaves an edited workflow alone with no log, and logs an invalid new definition for an unchanged one', () => {
    const { workflows } = setup();
    const oldTemplate = templateLike('bug-fix', 1);
    const base = {
      name: oldTemplate.name, description: oldTemplate.description, kind: oldTemplate.kind,
      agentsDecide: oldTemplate.agentsDecide, progressFile: oldTemplate.progressFile, nodes: oldTemplate.nodes,
    };
    const edited = workflows.create({
      ...base,
      nodes: base.nodes.map((node, index) => index === 0 ? { ...node, prompt: 'Owner words.' } : { ...node }),
    }, { source: { kind: 'builtin', id: 'bug-fix', version: 1, base, updatedAt: null } });
    const unchanged = workflows.create({
      ...base,
      name: 'Bug fix kept',
      nodes: base.nodes.map(node => ({ ...node })),
    }, { source: { kind: 'builtin', id: 'quick-change', version: 1, base: { ...base, name: 'Bug fix kept' }, updatedAt: null } });
    const log = vi.fn();
    expect(workflows.applyBuiltinUpdates({ templates: [templateLike('bug-fix', 2)], now: NOW, log })).toEqual({ updated: [] });
    expect(workflows.get(edited.id).source.version).toBe(1);
    expect(log).not.toHaveBeenCalled();
    // An invalid higher version against an edited workflow must not log: it is not a candidate (§5.2).
    const badBugFix = templateLike('bug-fix', 3, { nodes: [] });
    expect(workflows.applyBuiltinUpdates({ templates: [badBugFix], now: NOW, log })).toEqual({ updated: [] });
    expect(log).not.toHaveBeenCalled();
    // The same invalid definition against an unchanged linked copy is refused and logged.
    const badKept = templateLike('quick-change', 2, { name: 'Bug fix kept', nodes: [] });
    const log2 = vi.fn();
    expect(workflows.applyBuiltinUpdates({ templates: [badKept], now: NOW, log: log2 })).toEqual({ updated: [] });
    expect(workflows.get(unchanged.id).source.version).toBe(1);
    expect(log2).toHaveBeenCalledTimes(1);
    expect(String(log2.mock.calls[0][0])).toMatch(/built-in update refused/);
  });

  it('preserves enabled:false on saved steps and source_base, and refuses an invalid enabled value', () => {
    const { workflows } = setup();
    const oldTemplate = templateLike('bug-fix', 1);
    const base = {
      name: oldTemplate.name, description: oldTemplate.description, kind: oldTemplate.kind,
      agentsDecide: oldTemplate.agentsDecide, progressFile: oldTemplate.progressFile, nodes: oldTemplate.nodes,
    };
    const created = workflows.create({
      ...base,
      nodes: base.nodes.map(node => ({ ...node })),
    }, { source: { kind: 'builtin', id: 'bug-fix', version: 1, base, updatedAt: null } });

    const disabledStepName = base.nodes[1].name;
    const v2 = templateLike('bug-fix', 2, {
      nodes: base.nodes.map((node, index) => (index === 1 ? { ...node, enabled: false } : node)),
    });
    const log = vi.fn();
    expect(workflows.applyBuiltinUpdates({ templates: [v2], now: NOW, log })).toEqual({ updated: [base.name] });
    const updated = workflows.get(created.id);
    expect(updated.revision).toBe(2);
    expect(updated.source.version).toBe(2);
    expect(updated.nodes[1].name).toBe(disabledStepName);
    expect(updated.nodes[1].enabled).toBe(false);
    expect(updated.source.base.nodes[1].enabled).toBe(false);

    const invalidV3 = templateLike('bug-fix', 3, {
      nodes: base.nodes.map((node, index) => (index === 1 ? { ...node, enabled: 'no' } : node)),
    });
    const logInvalid = vi.fn();
    expect(workflows.applyBuiltinUpdates({ templates: [invalidV3], now: NOW, log: logInvalid })).toEqual({ updated: [] });
    expect(workflows.get(created.id).source.version).toBe(2);
    expect(logInvalid).toHaveBeenCalledTimes(1);
    expect(String(logInvalid.mock.calls[0][0])).toMatch(/built-in update refused/);
  });

  it('refuses an impossible update timestamp before writing, leaving the original row readable and logging row and field', () => {
    const { workflows } = setup();
    const oldTemplate = templateLike('bug-fix', 1);
    const base = {
      name: oldTemplate.name, description: oldTemplate.description, kind: oldTemplate.kind,
      agentsDecide: oldTemplate.agentsDecide, progressFile: oldTemplate.progressFile, nodes: oldTemplate.nodes,
    };
    const created = workflows.create({
      ...base,
      nodes: base.nodes.map(node => ({ ...node })),
    }, { source: { kind: 'builtin', id: 'bug-fix', version: 1, base, updatedAt: null } });

    const log = vi.fn();
    const v2 = templateLike('bug-fix', 2);
    expect(workflows.applyBuiltinUpdates({
      templates: [v2],
      now: () => '2026-02-30T00:00:00.000Z',
      log,
    })).toEqual({ updated: [] });

    const preserved = workflows.get(created.id);
    expect(preserved.revision).toBe(1);
    expect(preserved.updatedAt).toBe(NOW());
    expect(preserved.source.version).toBe(1);
    expect(preserved.source.updatedAt).toBe(null);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(new RegExp(`${created.id}.*built-in update refused.*updated_at`));
  });
});

describe('dismissal row guards', () => {
  it('rejects invalid template_id and dismissed_at on hydration and writes, naming row and column', () => {
    const { db, workflows } = setup();
    db.prepare('INSERT INTO pipeline_builtin_dismissals (template_id, dismissed_at) VALUES (?, ?)').run('bug-fix', '2026-02-30T00:00:00.000Z');
    expect(() => workflows.builtinDismissals()).toThrow(/bug-fix.*dismissed_at/);

    db.prepare('DELETE FROM pipeline_builtin_dismissals').run();
    db.prepare('INSERT INTO pipeline_builtin_dismissals (template_id, dismissed_at) VALUES (?, ?)').run('Bad_ID', NOW());
    expect(() => workflows.builtinDismissals()).toThrow(/Bad_ID.*template_id/);

    const db2 = new Database(':memory:');
    databases.push(db2);
    const badClockStore = createWorkflowStore(db2, { now: () => '2026-02-30T00:00:00.000Z' });
    expect(() => badClockStore.dismissBuiltinTemplate('bug-fix')).toThrow(/bug-fix.*dismissed_at/);
    expect(db2.prepare('SELECT COUNT(*) AS n FROM pipeline_builtin_dismissals').get().n).toBe(0);

    expect(() => workflows.dismissBuiltinTemplate('Bad_ID')).toThrow(/Bad_ID.*template_id/);
  });
});
