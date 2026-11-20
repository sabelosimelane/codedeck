// Persistence and decisions belong to CodeDeck; verdicts are computed by the standalone scoring policy.
import { createHash, randomUUID } from 'node:crypto';
import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { AGENT_PRESETS, buildLaunchCommand, parseLaunchCommand } from '../../shared/agent-presets.mjs';
import { compareTeamTrial, scoreTeam, TEAM_POLICY_VERSION } from '../../shared/scoring/index.mjs';

const LIMIT = 5;
const terminal = new Set(['complete', 'stopped', 'interrupted', 'error']);
const closed = new Set(['stopped', 'dismissed', 'adopted']);
const revision = (n) => Number.isSafeInteger(n) && n > 0;
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const workloadKey = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const iso = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });
const bad = (field) =>
  Object.assign(new Error('Invalid trial ' + field), {
    status: 400,
    errors: [{ field, message: 'Invalid trial ' + field }],
  });
const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function requireField(ok, field, id) {
  if (!ok) throw new Error('Team trial ' + id + ' has an invalid ' + field);
}

function validateProfile(profile, field, id) {
  requireField(
    profile && AGENT_PRESETS.some((preset) => preset.id === profile.provider),
    field + '.provider',
    id,
  );
  const result = buildLaunchCommand({ ...profile, skipPermissions: false });
  requireField(!result.errors.length && profile.model === profile.model.trim(), field + '.model/effort', id);
}

function configurationKey(configuration) {
  if (!Array.isArray(configuration)) throw new Error('Team trial requires a configuration array');
  return digest(
    configuration.map((step, index) => {
      requireField(
        step && Number.isInteger(step.stepIndex) && step.stepIndex === index,
        'configuration.stepIndex',
        index,
      );
      requireField(
        text(step.stepName) && typeof step.role === 'string',
        'configuration.stepName/role',
        index,
      );
      requireField(
        ['team', 'setup', 'workflow', 'override', 'trial'].includes(step.source),
        'configuration.source',
        index,
      );
      requireField(isUuid(step.agentId) && revision(step.agentRevision), 'configuration.agent', index);
      return [step.stepIndex, step.stepName, step.role, step.source, step.agentId, step.agentRevision];
    }),
  );
}

function readDraft(row) {
  const { id, at, state, version } = row;
  requireField(isUuid(id) && iso(at), 'identity/date', id);
  requireField(
    revision(version) && ['pending', 'running', 'dismissed', 'stopped', 'adopted'].includes(state),
    'state/version',
    id,
  );
  const d = JSON.parse(row.draft);
  for (const k of ['teamId', 'workflowId', 'agentId']) requireField(isUuid(d[k]), k, id);
  for (const k of ['teamRevision', 'workflowRevision', 'policyVersion']) requireField(revision(d[k]), k, id);
  for (const k of ['teamName', 'role', 'project', 'reason', 'counterevidence', 'success'])
    requireField(text(d[k]), k, id);
  requireField(workloadKey(d.workload) && workloadKey(d.configurationKey), 'workload/configuration', id);
  requireField(d.goal === 'speed' || d.goal === 'accuracy', 'goal', id);
  requireField(
    Array.isArray(d.baselineIds) &&
      d.baselineIds.length === LIMIT &&
      d.baselineIds.every(isUuid) &&
      new Set(d.baselineIds).size === LIMIT,
    'baselineIds',
    id,
  );
  requireField(
    d.pins &&
      typeof d.pins === 'object' &&
      !Array.isArray(d.pins) &&
      Object.entries(d.pins).every(([key, value]) => isUuid(key) && revision(value)) &&
      revision(d.pins[d.agentId]),
    'pins',
    id,
  );
  requireField(d.donorId === null || (isUuid(d.donorId) && revision(d.pins[d.donorId])), 'donorId', id);
  validateProfile(d.from, 'from', id);
  validateProfile(d.to, 'to', id);
  requireField(
    (d.from.effort !== d.to.effort) !== (d.from.provider !== d.to.provider || d.from.model !== d.to.model),
    'candidate',
    id,
  );
  requireField(row.adoption === null ? state !== 'adopted' : state === 'adopted', 'adoption', id);
  if (['running', 'stopped', 'adopted'].includes(state)) {
    requireField(
      Array.isArray(d.baseline) &&
        d.baseline.length === LIMIT &&
        d.baseline.every((r, i) => r.id === d.baselineIds[i] && workloadKey(r.deliverySignature)),
      'frozen baseline',
      id,
    );
    scoreTeam(d.baseline);
  }
  return d;
}

function* candidateProfiles(source, resetCommand, goal, agents) {
  const preset = AGENT_PRESETS.find((p) => p.id === source.provider);
  const tier = preset.efforts.indexOf(source.effort);
  if (tier !== -1) {
    const effort = preset.efforts[tier + (goal === 'speed' ? -1 : 1)];
    if (effort) yield { profile: { ...source, effort }, donor: null };
  }
  for (const agent of agents) {
    const donor = parseLaunchCommand(agent.launchCommand);
    if (
      donor &&
      donor.model &&
      (donor.provider !== source.provider || donor.model !== source.model) &&
      agent.resetCommand === resetCommand &&
      donor.skipPermissions === source.skipPermissions &&
      donor.effort === source.effort
    ) {
      yield { profile: donor, donor: agent };
    }
  }
}

const publicProfile = ({ provider, model, effort }) => ({ provider, model, effort });

function scoringInput(row) {
  requireField(workloadKey(row.deliverySignature), 'delivery signature', row.id);
  return {
    id: row.id,
    deliverySignature: row.deliverySignature,
    status: row.status,
    mixed: row.mixed,
    activeMs: row.activeMs,
    elapsedMs: row.elapsedMs,
    steps: row.steps.map(({ role, activeMs }) => ({ role, activeMs })),
    criteria: row.criteria.map(({ id, text, verdict, evidenceRefs }) => ({
      id,
      text,
      verdict,
      evidenceRefs,
    })),
    evidenceRefs: row.evidenceRefs,
  };
}

function nominate(rows, team, agents, previous) {
  const baseline = rows.slice(-LIMIT);
  const latest = baseline.at(-1);
  const available = byId(agents);
  const pins = {};
  for (const m of team.members) {
    const agent = available.get(m.agentId);
    if (!agent) return null;
    pins[agent.id] = agent.revision;
  }
  for (const step of latest.configuration) {
    if (available.get(step.agentId)?.revision !== step.agentRevision) return null;
    pins[step.agentId] = step.agentRevision;
  }
  const score = scoreTeam(baseline);
  const accuracy = score.metrics.accuracy.value;
  if (accuracy === null || score.metrics.activeMs.value === null) return null;
  const goal = accuracy < 1 ? 'accuracy' : 'speed';
  const durations = new Map();
  for (const run of baseline) {
    for (const [index, step] of run.steps.entries()) {
      const slot = run.configuration[index];
      if (slot?.source !== 'team' || step.activeMs === null) continue;
      const role = slot.role.toLowerCase();
      durations.set(role, (durations.get(role) ?? 0) + step.activeMs);
    }
  }
  for (const [role, ms] of [...durations.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const member = team.members.find((m) => m.role.toLowerCase() === role);
    if (!member || ms <= 0) continue;
    const agent = available.get(member.agentId);
    const current = parseLaunchCommand(agent.launchCommand);
    if (!current) continue;
    const changes = candidateProfiles(current, agent.resetCommand, goal, agents);
    const change = [...changes].find(
      ({ profile }) =>
        !previous.some(
          (p) =>
            p.role === member.role &&
            p.goal === goal &&
            p.to.provider === profile.provider &&
            p.to.effort === profile.effort &&
            p.to.model === profile.model,
        ),
    );
    if (!change) continue;
    if (change.donor) pins[change.donor.id] = change.donor.revision;
    const usage =
      member.role +
      ' used ' +
      (ms / 1000).toFixed(1) +
      ' seconds of active time across the five baseline runs.';
    const last = previous.find((p) => p.role === member.role && p.comparison);
    const counterevidence = last
      ? 'The earlier ' + last.to.model + ' ' + last.to.effort + ' trial was ' + last.comparison.verdict + '. '
      : '';
    return {
      teamId: team.id,
      teamName: team.name,
      teamRevision: team.revision,
      agentId: agent.id,
      donorId: change.donor?.id ?? null,
      pins,
      workflowId: latest.workflowId,
      workflowRevision: latest.workflowRevision,
      workload: latest.workload,
      project: latest.project,
      role: member.role,
      goal,
      configurationKey: configurationKey(latest.configuration),
      from: publicProfile(current),
      to: publicProfile(change.profile),
      policyVersion: TEAM_POLICY_VERSION,
      baselineIds: baseline.map((r) => r.id),
      reason:
        goal === 'speed'
          ? usage + ' Test whether this setting shortens delivery time.'
          : usage +
            ' Verified deliveries missed at least one criterion. Test this setting for higher team accuracy.',
      counterevidence:
        counterevidence +
        'Task difficulty can differ within this workload. Team outcomes alone cannot establish which role caused a miss.',
      success:
        goal === 'speed'
          ? 'Reduce median active delivery time while maintaining accuracy, delivery rate, and verification coverage.'
          : 'Increase solution accuracy while maintaining delivery rate and verification coverage. Review the change in delivery time.',
    };
  }
  return null;
}

export function createTeamTrials({
  db,
  teams,
  agents,
  workflows,
  observations,
  now = () => new Date().toISOString(),
}) {
  for (const [name, service, methods] of [
    ['db', db, ['exec', 'prepare', 'transaction']],
    ['teams', teams, ['get', 'update']],
    ['agents', agents, ['get', 'list', 'create']],
    ['workflows', workflows, ['get']],
  ]) {
    if (!methods.every((key) => typeof service?.[key] === 'function'))
      throw new Error('Team trials requires ' + name);
  }
  if (typeof observations !== 'function' || typeof now !== 'function')
    throw new Error('Team trials requires observations and a clock');
  db.exec(`CREATE TABLE IF NOT EXISTS team_trials(
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, at TEXT NOT NULL, version INTEGER NOT NULL,
    state TEXT NOT NULL, draft TEXT NOT NULL CHECK(json_valid(draft)), adoption TEXT CHECK(json_valid(adoption)));
    CREATE TABLE IF NOT EXISTS team_trial_assignments(
    run_id TEXT PRIMARY KEY, trial_id TEXT NOT NULL REFERENCES team_trials(id), slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 5),
    UNIQUE(trial_id,slot));`);
  const listRows = db.prepare('SELECT * FROM team_trials ORDER BY at DESC,id');
  const getRow = db.prepare('SELECT * FROM team_trials WHERE id=?');
  const getAssignments = db.prepare(
    'SELECT run_id FROM team_trial_assignments WHERE trial_id=? ORDER BY slot',
  );
  const allRunning = db.prepare("SELECT * FROM team_trials WHERE state='running' ORDER BY at,id");

  function staleReason(d) {
    if (teams.get(d.teamId)?.revision !== d.teamRevision)
      return 'Team revision changed. Review fresh evidence.';
    if (workflows.get(d.workflowId)?.revision !== d.workflowRevision)
      return 'Workflow revision changed. Review fresh evidence.';
    for (const [id, expected] of Object.entries(d.pins)) {
      if (agents.get(id)?.revision !== expected) return 'An agent revision changed. Review fresh evidence.';
    }
    return null;
  }

  function cohorts(d, assignmentIds, records) {
    // Freeze the delivery we approved. An owner correction can amend its verdict;
    // a later execution of the same run ID is a different delivery.
    const before = d.baseline
      ? d.baseline.map((frozen) => {
          const current = records.get(frozen.id);
          if (current?.deliverySignature !== frozen.deliverySignature) return frozen;
          return { ...frozen, criteria: scoringInput(current).criteria, evidenceRefs: current.evidenceRefs };
        })
      : d.baselineIds
          .map((id) => records.get(id))
          .filter(Boolean)
          .map(scoringInput);
    const after = assignmentIds
      .map((id) => records.get(id))
      .filter(Boolean)
      .map((row) => {
        requireField(Array.isArray(row.attempts), 'executed attempts', row.id);
        const exposed = row.attempts.some(
          (a) =>
            a.source === 'trial' &&
            a.role.toLowerCase() === d.role.toLowerCase() &&
            a.provider === d.to.provider &&
            a.model === d.to.model &&
            a.effort === d.to.effort,
        );
        return { ...scoringInput(row), exposed };
      });
    return { before, after };
  }
  function measuredResult(d, { before, after }) {
    const result = compareTeamTrial(before, after, d.goal, d.policyVersion);
    const exposedRuns = after.filter((r) => {
      requireField(typeof r.exposed === 'boolean', 'candidate exposure', r.id);
      return r.exposed;
    }).length;
    // Launch assignment alone cannot establish that the candidate ever performed work.
    const verdict = result.verdict === 'helped' && exposedRuns === 0 ? 'inconclusive' : result.verdict;
    return { ...result, verdict, exposedRuns };
  }
  function present(row, records) {
    const d = readDraft(row);
    const assignmentIds = getAssignments.all(row.id).map(({ run_id }) => {
      requireField(isUuid(run_id), 'assigned run', row.id);
      return run_id;
    });
    const { before, after } = cohorts(d, assignmentIds, records);
    const finished =
      assignmentIds.length === LIMIT && after.length === LIMIT && after.every((r) => terminal.has(r.status));
    const status = row.state === 'running' && finished ? 'measured' : row.state;
    const stale = closed.has(status) ? null : staleReason(d);
    const { pins, agentId, donorId, configurationKey: key, baseline, ...visible } = d;
    // The owner's revision must also fence measured evidence. Two helped verdicts can
    // still represent different time tradeoffs or corrected accuracy.
    const decisionRevision =
      status === 'measured'
        ? parseInt(digest([row.version, before, after]).slice(0, 13), 16) + 1
        : row.version;
    return {
      id: row.id,
      at: row.at,
      revision: decisionRevision,
      ...visible,
      assignmentIds,
      status,
      stale: Boolean(stale),
      staleReason: stale,
      comparison: assignmentIds.length ? measuredResult(d, { before, after }) : null,
      adoptedComparison: row.adoption ? measuredResult(d, JSON.parse(row.adoption)) : null,
    };
  }

  const refresh = db.transaction(() => {
    const groups = new Map();
    const all = observations();
    const records = byId(all);
    const history = listRows.all().map((row) => ({ row, draft: readDraft(row) }));
    for (const r of all) {
      if (!r.teamId || r.mixed || r.trialId || !r.workload || !terminal.has(r.status)) continue;
      const key = JSON.stringify([
        r.teamId,
        r.teamRevision,
        r.project,
        r.workflowId,
        r.workflowRevision,
        r.workload,
        configurationKey(r.configuration),
      ]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const allAgents = agents.list();
    for (const group of groups.values()) {
      if (group.length < LIMIT) continue;
      group.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      const r = group.at(-1),
        team = teams.get(r.teamId);
      if (team?.revision !== r.teamRevision || workflows.get(r.workflowId)?.revision !== r.workflowRevision)
        continue;
      const key = configurationKey(r.configuration);
      const previous = history
        .filter(
          ({ draft }) =>
            draft.teamId === r.teamId &&
            draft.teamRevision === r.teamRevision &&
            draft.workflowId === r.workflowId &&
            draft.workflowRevision === r.workflowRevision &&
            draft.workload === r.workload &&
            draft.project === r.project &&
            draft.configurationKey === key,
        )
        .map(({ row }) => present(row, records));
      if (
        previous.some(
          (p) =>
            !p.stale &&
            (p.status === 'pending' ||
              p.status === 'running' ||
              (p.status === 'measured' && p.comparison.verdict === 'helped')),
        )
      )
        continue;
      const d = nominate(
        group,
        team,
        allAgents,
        previous.filter((p) => !p.stale),
      );
      if (!d) continue;
      const fingerprint = digest([
        d.teamId,
        d.teamRevision,
        d.workflowId,
        d.workflowRevision,
        d.project,
        d.workload,
        d.configurationKey,
        d.pins,
        d.role,
        d.goal,
        d.to,
        d.policyVersion,
      ]);
      const row = {
        id: randomUUID(),
        at: now(),
        draft: JSON.stringify(d),
        state: 'pending',
        version: 1,
        adoption: null,
      };
      readDraft(row);
      db.prepare(
        `INSERT INTO team_trials(id,fingerprint,at,version,state,draft) VALUES(?,?,?,1,'pending',?)
        ON CONFLICT(fingerprint) DO NOTHING`,
      ).run(row.id, fingerprint, row.at, row.draft);
    }
  });

  function candidate(d) {
    if (d.donorId) return agents.get(d.donorId);
    const base = agents.get(d.agentId);
    const current = parseLaunchCommand(base.launchCommand);
    const { command, errors } = buildLaunchCommand({ ...d.to, skipPermissions: current.skipPermissions });
    if (errors.length) throw new Error('Invalid candidate launch configuration');
    return { ...base, launchCommand: command };
  }

  const reserve = db.transaction((ctx) => {
    for (const key of ['runId', 'teamId', 'workflowId']) requireField(isUuid(ctx?.[key]), key, 'reservation');
    for (const key of ['teamRevision', 'workflowRevision'])
      requireField(revision(ctx[key]), key, 'reservation');
    requireField(text(ctx.project) && workloadKey(ctx.workload), 'project/workload', ctx.runId);
    requireField(
      Array.isArray(ctx.roles) && ctx.roles.every(text) && typeof ctx.mixed === 'boolean',
      'roles/mixed',
      ctx.runId,
    );
    const key = configurationKey(ctx.configuration);
    if (ctx.mixed) return null;
    for (const row of allRunning.all()) {
      const d = readDraft(row);
      if (
        d.teamId !== ctx.teamId ||
        d.teamRevision !== ctx.teamRevision ||
        d.workflowId !== ctx.workflowId ||
        d.workflowRevision !== ctx.workflowRevision ||
        d.project !== ctx.project ||
        d.workload !== ctx.workload ||
        d.configurationKey !== key ||
        !ctx.roles.some((r) => r.toLowerCase() === d.role.toLowerCase()) ||
        staleReason(d)
      )
        continue;
      const assigned = getAssignments.all(row.id);
      if (!assigned.some((a) => a.run_id === ctx.runId)) {
        if (assigned.length === LIMIT) continue;
        db.prepare('INSERT INTO team_trial_assignments(run_id,trial_id,slot) VALUES(?,?,?)').run(
          ctx.runId,
          row.id,
          assigned.length + 1,
        );
      }
      return { trialId: row.id, role: d.role, agent: candidate(d) };
    }
    return null;
  });

  const decide = db.transaction((id, body) => {
    if (!isUuid(id)) throw bad('id');
    if (!body || Object.keys(body).some((k) => !['action', 'revision'].includes(k))) throw bad('body');
    if (!['start', 'dismiss', 'stop', 'adopt'].includes(body.action)) throw bad('action');
    if (!revision(body.revision)) throw bad('revision');
    const row = getRow.get(id);
    if (!row) throw Object.assign(new Error('Team recommendation not found'), { status: 404 });
    const records = byId(observations());
    const p = present(row, records),
      d = readDraft(row);
    if (p.revision !== body.revision)
      throw conflict('This recommendation changed. Refresh it before deciding.');
    const { action } = body;
    if ((action === 'start' || action === 'adopt') && p.stale) throw conflict(p.staleReason);
    let state,
      adoption = null;
    if (action === 'start' && p.status === 'pending') {
      const baseline = d.baselineIds.map((key) => records.get(key));
      if (baseline.some((r) => !r || r.mixed || r.trialId || !terminal.has(r.status)))
        throw conflict('The baseline changed. Review fresh evidence.');
      if (
        allRunning.all().some((other) => {
          const existing = readDraft(other);
          return (
            existing.teamId === d.teamId &&
            !staleReason(existing) &&
            getAssignments.all(other.id).length < LIMIT
          );
        })
      )
        throw conflict('Another trial is assigning runs for this team.');
      d.baseline = baseline.map(scoringInput);
      state = 'running';
    } else if (action === 'dismiss' && p.status === 'pending') state = 'dismissed';
    else if (action === 'stop' && row.state === 'running') state = 'stopped';
    else if (action === 'adopt' && p.status === 'measured' && p.comparison.verdict === 'helped') {
      const team = teams.get(d.teamId),
        agent = candidate(d);
      const name = (team.name + ' ' + d.role).slice(0, 25) + ' · ' + row.id;
      const replacement = agents.create({
        name,
        launchCommand: agent.launchCommand,
        resetCommand: agent.resetCommand,
      });
      teams.update(team.id, {
        name: team.name,
        revision: d.teamRevision,
        members: team.members.map((member) =>
          member.role === d.role ? { ...member, agentId: replacement.id } : member,
        ),
      });
      adoption = JSON.stringify(cohorts(d, p.assignmentIds, records));
      state = 'adopted';
    } else
      throw conflict('This trial cannot ' + action + ' in its current state or with its current evidence.');
    db.prepare(
      'UPDATE team_trials SET state=?,adoption=?,draft=?,version=version+1 WHERE id=? AND version=?',
    ).run(state, adoption, JSON.stringify(d), id, row.version);
    return present(getRow.get(id), records);
  });
  return {
    refresh: refresh.immediate,
    reserve: reserve.immediate,
    decide: decide.immediate,
    list() {
      const records = byId(observations());
      return listRows.all().map((row) => present(row, records));
    },
  };
}
