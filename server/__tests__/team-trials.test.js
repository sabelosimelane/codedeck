import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createTeamStore } from '../pipelines/library-store.js';
import { buildLaunchCommand } from '../../shared/agent-presets.mjs';
import { createTeamTrials } from '../pipelines/team-trials.js';

function fixture({ effort = 'high', model = 'm1', alternate = false, teamEffort } = {}) {
  const db = new Database(':memory:');
  const teams = createTeamStore(db);
  const agents = createAgentStore(db);
  const command = (model, effort) =>
    buildLaunchCommand({ provider: 'codex', model, effort, skipPermissions: true }).command;
  const agent = agents.create({
    name: 'Engineer',
    launchCommand: command(model, ''),
    resetCommand: '/clear',
  });
  const other = agents.create({
    name: 'Checker',
    launchCommand: alternate ? command('m2', '') : 'custom-check',
    resetCommand: '/clear',
  });
  const team = teams.create({
    name: 'A',
    members: [
      { role: 'Build', agentId: agent.id, ...((teamEffort ?? effort) && { effort: teamEffort ?? effort }) },
      { role: 'Verify', agentId: other.id, ...(alternate && effort && { effort }) },
    ],
  });
  const shared = teams.create({ name: 'B', members: [{ role: 'Build', agentId: agent.id, ...(effort && { effort }) }] });
  const workflow = { id: randomUUID(), revision: 1 };
  const configuration = team.members.map(({ role, agentId }, stepIndex) => ({
    stepIndex,
    stepName: role,
    role,
    source: 'team',
    agentId,
    agentRevision: 1,
    teamId: team.id,
    teamRevision: 1,
    provider: stepIndex === 0 || alternate ? 'codex' : null,
    model: stepIndex === 0 ? model : alternate ? 'm2' : null,
    effort: stepIndex === 0 ? (teamEffort ?? effort) : alternate ? effort : null,
  }));
  const cohort = {
    teamId: team.id,
    teamRevision: 1,
    workflowId: workflow.id,
    workflowRevision: 1,
    project: 'CodeDeck',
    workload: 'a'.repeat(64),
  };
  const sample = (patch = {}) => {
    const id = patch.id ?? randomUUID();
    return {
      ...cohort,
      id,
      deliverySignature: createHash('sha256')
        .update(id + ' delivery')
        .digest('hex'),
      signature: createHash('sha256').update(id).digest('hex'),
      teamName: team.name,
      at: new Date().toISOString(),
      status: 'complete',
      activeMs: 100,
      elapsedMs: 180,
      mixed: false,
      steps: [
        { role: 'Build', activeMs: 90 },
        { role: 'Verify', activeMs: 10 },
      ],
      evidenceRefs: ['note:1'],
      criteria: [{ id: 'c1', text: 'Delivered', verdict: 'met', evidenceRefs: ['note:1'] }],
      configuration,
      attempts: configuration.map((a) => ({ ...a, attempt: 1 })),
      trialId: null,
      ...patch,
    };
  };
  const rows = Array.from({ length: 3 }, () => sample());
  const service = () =>
    createTeamTrials({
      db,
      teams,
      agents,
      workflows: { get: (id) => (id === workflow.id ? workflow : null) },
      observations: () => rows,
    });
  const trials = service();
  const context = () => ({
    ...cohort,
    configuration,
    runId: randomUUID(),
    roles: ['Build', 'Verify'],
    mixed: false,
  });
  const propose = () => {
    trials.refresh();
    return trials.list()[0];
  };
  const start = () => {
    const p = propose();
    return trials.decide(p.id, { action: 'start', revision: p.revision });
  };
  const fill = (p, patch = {}) => {
    for (let i = 0; i < 3; i++) {
      const ctx = context();
      const assignment = trials.reserve(ctx);
      expect(assignment.trialId).toBe(p.id);
      const attempts = configuration.map((a) =>
        a.role === p.role ? { ...a, ...p.to, source: 'trial', attempt: 1 } : { ...a, attempt: 1 },
      );
      rows.push(sample({ id: ctx.runId, trialId: p.id, attempts, activeMs: 70, ...patch }));
    }
  };
  return {
    db,
    teams,
    agents,
    rows,
    team,
    shared,
    agent,
    other,
    workflow,
    trials,
    service,
    cohort,
    context,
    sample,
    propose,
    start,
    fill,
    command,
  };
}

describe('bounded team role trials', () => {
  it('pins three matching runs across projects, explains a single role change, and deduplicates across restart', () => {
    const f = fixture();
    f.rows[2] = f.sample({ project: 'Somewhere else', workload: 'b'.repeat(64) });
    f.rows.push(
      f.sample({ mixed: true }),
      f.sample({ configuration: [] }),
    );
    const p = f.propose();
    expect(p).toMatchObject({
      status: 'pending',
      role: 'Build',
      goal: 'speed',
      teamRevision: 1,
      project: 'Multiple projects',
      from: { model: 'm1', effort: 'high' },
      to: { model: 'm1', effort: 'medium' },
      policyVersion: 1,
    });
    expect(new Set(p.baselineIds)).toEqual(new Set(f.rows.slice(0, 3).map((r) => r.id)));
    expect(p.counterevidence).toMatch(/2 projects/);
    for (const field of ['reason', 'counterevidence', 'success']) expect(p[field].length).toBeGreaterThan(15);
    f.service().refresh();
    expect(f.trials.list()).toHaveLength(1);
    expect(f.trials.reserve(f.context())).toBeNull();
  });
  it('never mixes revisions or configurations across insufficient baselines', () => {
    const f = fixture();
    f.rows[2] = {
      ...f.rows[2],
      configuration: f.rows[2].configuration.map((a) => ({ ...a, agentRevision: 9 })),
    };
    f.trials.refresh();
    expect(f.trials.list()).toEqual([]);
  });
  it('uses a locally configured alternative model when no lower effort exists', () => {
    const f = fixture({ effort: 'low', alternate: true });
    const p = f.propose();
    expect(p.to).toEqual({ provider: 'codex', model: 'm2', effort: 'low' });
    expect(p.from).toEqual({ provider: 'codex', model: 'm1', effort: 'low' });
  });
  it('considers a compatible donor when the role uses the CLI default effort', () => {
    const f = fixture({ effort: '' });
    f.agents.create({ name: 'Claude default', launchCommand: 'command claude --model m2 --dangerously-skip-permissions', resetCommand: '/clear' });
    expect(f.propose()).toMatchObject({ from: { effort: '' }, to: { provider: 'claude', model: 'm2', effort: '' } });
  });
  it('adopts a donor for a role at the CLI default effort without storing a blank effort', () => {
    const f = fixture({ effort: '' });
    const donor = f.agents.create({ name: 'Claude default', launchCommand: 'command claude --model m2 --dangerously-skip-permissions', resetCommand: '/clear' });
    const p = f.start();
    expect(p.to).toMatchObject({ provider: 'claude', effort: '' });
    f.fill(p);
    const measured = f.trials.list()[0];
    expect(f.trials.decide(p.id, { action: 'adopt', revision: measured.revision }).status).toBe('adopted');
    const member = f.teams.get(f.team.id).members[0];
    expect(member.agentId).toBe(donor.id);
    expect(member.effort ?? null).toBeNull();
  });
  it('nominates the effective team effort independently of the saved agent default', () => {
    const f = fixture({ effort: 'medium', teamEffort: 'high' });
    expect(f.propose()).toMatchObject({ from: { effort: 'high' }, to: { effort: 'medium' } });
  });
  it('trials the exact saved cross-provider profile and adopts for the reviewed team alone', () => {
    const f = fixture({ effort: 'low', teamEffort: 'low' });
    const donor = f.agents.create({
      name: 'Claude low',
      launchCommand: 'command claude --model m2 --dangerously-skip-permissions',
      resetCommand: '/clear',
    });
    const p = f.start();
    expect(p.from).toEqual({ provider: 'codex', model: 'm1', effort: 'low' });
    expect(p.to).toEqual({ provider: 'claude', model: 'm2', effort: 'low' });
    const ctx = f.context();
    expect(() =>
      f.db.transaction(() => {
        expect(f.trials.reserve(ctx).agent).toMatchObject({
          id: donor.id,
          revision: donor.revision,
          launchCommand: 'command claude --model m2 --effort low --dangerously-skip-permissions',
          resetCommand: donor.resetCommand,
        });
        throw Error('Test rollback');
      })(),
    ).toThrow('Test rollback');
    f.fill(p);
    const measured = f.trials.list()[0];
    const adopted = f.trials.decide(p.id, { action: 'adopt', revision: measured.revision });
    expect(adopted.status).toBe('adopted');
    const member = f.teams.get(f.team.id).members[0];
    expect(member.effort).toBe('low');
    expect(member.agentId).toBe(donor.id);
    const newAgent = f.agents.get(member.agentId);
    expect(newAgent.launchCommand).toBe(donor.launchCommand);
    expect(newAgent.resetCommand).toBe(f.agent.resetCommand);
    expect(f.agents.get(donor.id)).toEqual(donor);
    expect(f.teams.get(f.shared.id)).toEqual(f.shared);
  });
  it.each([
    ['command claude --model m2', '/clear'],
    ['command claude --model m2 --dangerously-skip-permissions', '/reset'],
    ['custom --model m2 --effort low', '/clear'],
  ])('skips candidates with incompatible controls', (launchCommand, resetCommand) => {
    const f = fixture({ effort: 'low' });
    f.agents.create({ name: 'Alternative', launchCommand, resetCommand });
    f.trials.refresh();
    expect(f.trials.list()).toEqual([]);
  });
  it('targets accuracy when the delivered criteria miss, without blaming one role', () => {
    const f = fixture();
    f.rows[0].criteria = [{ id: 'c1', text: 'Delivered', verdict: 'missed', evidenceRefs: ['note:1'] }];
    const p = f.propose();
    expect(p).toMatchObject({ goal: 'accuracy', from: { effort: 'high' }, to: { effort: 'xhigh' } });
  });
  it('reserves at most three matching launches and rolls back slots with the launch transaction', () => {
    const f = fixture(),
      p = f.start(),
      ctx = f.context();
    expect(f.trials.reserve({ ...ctx, mixed: true })).toBeNull();
    expect(f.trials.reserve({ ...ctx, roles: ['Verify'] })).toBeNull();
    expect(f.trials.reserve({ ...ctx, configuration: ctx.configuration.slice(0, 1) })).toBeNull();
    expect(() =>
      f.db.transaction(() => {
        f.trials.reserve(ctx);
        throw Error('failed insert');
      })(),
    ).toThrow('failed insert');
    expect(f.trials.list()[0].assignmentIds).toEqual([]);
    const result = f.trials.reserve(ctx);
    expect(result).toMatchObject({
      trialId: p.id,
      role: 'Build',
      agent: { launchCommand: f.command('m1', 'medium'), resetCommand: '/clear' },
    });
    expect(f.trials.reserve(ctx)).toEqual(result);
    const restarted = f.service();
    for (let i = 0; i < 2; i++) expect(restarted.reserve({ ...f.context(), project: 'Other', workload: 'b'.repeat(64) })).not.toBeNull();
    expect(restarted.reserve(f.context())).toBeNull();
    expect(restarted.list()[0].assignmentIds).toHaveLength(3);
    expect(f.teams.get(f.team.id).revision).toBe(1);
  });
  it('rechecks independent team, workflow and member revisions and exposes conflicts', () => {
    for (const what of ['team', 'workflow', 'other member', 'candidate']) {
      const f = fixture({ alternate: true, effort: 'low' }),
        p = f.propose();
      if (what === 'team')
        f.teams.update(f.team.id, { name: 'renamed', revision: 1, members: f.team.members });
      else if (what === 'workflow') f.workflow.revision++;
      else {
        const a = f.other;
        f.agents.update(a.id, {
          name: 'changed',
          launchCommand: a.launchCommand,
          resetCommand: a.resetCommand,
          revision: 1,
        });
      }
      expect(f.trials.list()[0].stale).toBe(true);
      expect(() => f.trials.decide(p.id, { action: 'start', revision: 1 })).toThrow(/changed/i);
    }
  });
  it('adopts only a measured improvement and leaves shared agent records alone', () => {
    const f = fixture(),
      p = f.start();
    expect(() => f.trials.decide(p.id, { action: 'start', revision: 1 })).toThrow();
    expect(() => f.trials.decide(p.id, { action: 'adopt', revision: p.revision })).toThrow();
    f.fill(p);
    const measured = f.trials.list()[0];
    expect(measured).toMatchObject({ status: 'measured', comparison: { verdict: 'helped' } });
    const adopted = f.service().decide(p.id, { action: 'adopt', revision: measured.revision });
    expect(adopted).toMatchObject({ status: 'adopted', adoptedComparison: { verdict: 'helped' } });
    expect(f.teams.get(f.team.id).members[1]).toEqual(f.team.members[1]);
    expect(f.teams.get(f.shared.id)).toEqual(f.shared);
    expect(f.agents.get(f.agent.id)).toEqual(f.agent);
    expect(f.teams.get(f.team.id).members[0]).toEqual({ role: 'Build', agentId: f.agent.id, effort: 'medium' });
    expect(f.agents.list()).toHaveLength(2);
    expect(() => f.trials.decide(p.id, { action: 'adopt', revision: measured.revision })).toThrow();
  });
  it('recomputes evidence corrections before adoption, retains a faster-but-inaccurate result', () => {
    const f = fixture(),
      p = f.start();
    f.fill(p);
    const measured = f.trials.list()[0];
    expect(measured.comparison.verdict).toBe('helped');
    f.rows[3].criteria[0] = { ...f.rows[3].criteria[0], verdict: 'missed' };
    expect(f.trials.list()[0].comparison.verdict).toBe('regressed');
    expect(() => f.trials.decide(p.id, { action: 'adopt', revision: measured.revision })).toThrow();
  });
  it('freezes the scored baseline across restarts and subsequent executions of the same run', () => {
    const f = fixture(),
      p = f.start();
    f.fill(p);
    for (const record of f.rows.slice(0, 3)) {
      record.signature = record.deliverySignature = '0'.repeat(64);
      record.activeMs = 30;
      record.status = 'stopped';
    }
    const result = f.service().list()[0].comparison;
    expect(result.before.metrics.activeMs.value).toBe(100);
    expect(result.verdict).toBe('helped');
  });
  it('applies a correction to the same baseline delivery and rejects an outdated measured decision', () => {
    const f = fixture(),
      p = f.start();
    f.fill(p);
    const earlier = f.trials.list()[0];
    f.rows[0].signature = 'b'.repeat(64); // New evidence for the delivery originally measured.
    f.rows[0].criteria[0].verdict = 'missed';
    const current = f.trials.list()[0];
    expect(current.comparison.before.missed).toBe(1);
    expect(current.comparison.verdict).toBe('helped');
    expect(() => f.trials.decide(p.id, { action: 'adopt', revision: earlier.revision })).toThrow(/changed/i);
    const adopted = f.trials.decide(p.id, { action: 'adopt', revision: current.revision });
    f.rows[3].criteria[0].verdict = 'missed';
    f.rows[4].criteria[0].verdict = 'missed';
    const history = f.service().list()[0];
    expect(history.adoptedComparison).toEqual(adopted.adoptedComparison);
    expect(history.comparison.verdict).toBe('regressed');
  });
  it('exposes failed deliveries, mixed assignments and unknowns in the trial verdict', () => {
    for (const patch of [{ status: 'error' }, { criteria: [] }, { mixed: true }]) {
      const f = fixture(),
        p = f.start();
      f.fill(p);
      Object.assign(f.rows.at(-1), patch);
      const measured = f.trials.list()[0];
      expect(measured.comparison.verdict).toBe(patch.mixed ? 'inconclusive' : 'regressed');
      expect(() => f.trials.decide(p.id, { action: 'adopt', revision: measured.revision })).toThrow();
    }
  });
  it('does not attribute a speedup to a candidate skipped by every delivery', () => {
    const f = fixture(),
      p = f.start();
    f.fill(p, { attempts: [] });
    const measured = f.trials.list()[0];
    expect(measured.comparison.verdict).toBe('inconclusive');
    expect(measured.comparison.after.metrics.activeMs.value).toBe(70);
    expect(measured.comparison.exposedRuns).toBe(0);
    expect(() => f.trials.decide(p.id, { action: 'adopt', revision: measured.revision })).toThrow();
  });
  it('uses the next locally configured model after a measured effort trial regresses', () => {
    const f = fixture({ alternate: true }),
      p = f.start();
    f.fill(p, { activeMs: 150 });
    f.trials.refresh();
    const suggestions = f.trials.list().filter((item) => item.status === 'pending');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].to).toEqual({ provider: 'codex', model: 'm2', effort: 'high' });
    expect(suggestions[0].counterevidence).toMatch(/regressed/i);
    expect(f.trials.list().find((item) => item.id === p.id).comparison.verdict).toBe('regressed');
  });
  it('stopping or dismissing never applies the candidate', () => {
    for (const action of ['stop', 'dismiss']) {
      const f = fixture(),
        p = action === 'stop' ? f.start() : f.propose();
      const result = f.trials.decide(p.id, { action, revision: p.revision });
      expect(result.status).toBe(action === 'stop' ? 'stopped' : 'dismissed');
      expect(f.trials.reserve(f.context())).toBeNull();
      f.trials.refresh();
      expect(f.trials.list()).toHaveLength(1);
      expect(f.teams.get(f.team.id)).toEqual(f.team);
    }
  });
  it('auto-supersedes stale pending recommendations on refresh', () => {
    const f = fixture(),
      p = f.propose();
    expect(p.status).toBe('pending');
    f.workflow.revision++;
    f.trials.refresh();
    const [updated] = f.trials.list();
    expect(updated).toMatchObject({ id: p.id, status: 'superseded', stale: false });
  });
});
