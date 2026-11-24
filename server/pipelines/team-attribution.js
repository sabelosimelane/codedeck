import { createRunClock, attemptDurations } from './run-clock.js';
import { createHash } from 'node:crypto';
import { AGENT_ASSIGNMENT_SOURCES, isUuid } from '../../shared/pipeline-definitions.mjs';
import { AGENT_PRESETS, parseLaunchCommand } from '../../shared/agent-presets.mjs';

const positive = (n) => Number.isSafeInteger(n) && n > 0;
const singleLine = (s, max) => typeof s === 'string' && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
function check(id, field, valid) {
  if (!valid) throw new Error(`team attribution for ${id}: invalid ${field}`);
}
export function checkedAssignment(id, value, prefix) {
  const field = name => prefix ? `${prefix}.${name}` : name;
  check(id, prefix ?? 'assignment', value && typeof value === 'object' && !Array.isArray(value));
  check(id, field('agentRevision'), positive(value.agentRevision));
  check(id, field('source'), AGENT_ASSIGNMENT_SOURCES.includes(value.source));
  const byTeam = ['team', 'trial', 'fallback'].includes(value.source);
  check(id, field('teamId'), byTeam ? isUuid(value.teamId) : value.teamId === null);
  check(id, field('teamRevision'), byTeam ? positive(value.teamRevision) : value.teamRevision === null);
  return {
    agentRevision: value.agentRevision,
    source: value.source,
    teamId: value.teamId,
    teamRevision: value.teamRevision,
  };
}
export function attributedAgent(agent, source, team) {
  const { id, name, launchCommand, resetCommand } = agent;
  const result = { id, name, launchCommand, resetCommand };
  if (source)
    result.assignment = checkedAssignment(id, {
      agentRevision: agent.revision,
      source,
      teamId: team?.id ?? null,
      teamRevision: team?.revision ?? null,
    });
  return result;
}

// Commands are pinned in the runnable definition only.
export function publicRoleFallback({ id, name, assignment }) {
  return { id, name, agentRevision: assignment.agentRevision };
}

export function workloadKey(repositories, progressTemplate, input) {
  return createHash('sha256')
    .update(JSON.stringify([[...repositories].sort(), progressTemplate, /\.md$/i.test(input)]))
    .digest('hex');
}
function checkObservation(id, observation) {
  check(id, 'observation', observation && typeof observation === 'object');
  check(
    id,
    'stepIndex',
    Number.isInteger(observation.stepIndex) && observation.stepIndex >= 0 && observation.stepIndex <= 32,
  );
  check(id, 'stepName', singleLine(observation.stepName, 64) && observation.stepName.trim());
  check(id, 'role', singleLine(observation.role, 32));
  check(id, 'agentId', isUuid(observation.agentId));
  checkedAssignment(id, observation);
  if (Object.hasOwn(observation, 'fallbackAgent')) {
    const fallback = observation.fallbackAgent;
    check(id, 'fallbackAgent',
      observation.source === 'team' && fallback && typeof fallback === 'object' && !Array.isArray(fallback)
      && Object.keys(fallback).every(key => ['id', 'name', 'agentRevision'].includes(key)));
    check(id, 'fallbackAgent.id', isUuid(fallback.id));
    check(id, 'fallbackAgent.name', singleLine(fallback.name, 64) && fallback.name.trim());
    check(id, 'fallbackAgent.agentRevision', positive(fallback.agentRevision));
  }
  const preset = AGENT_PRESETS.find((p) => p.id === observation.provider);
  check(id, 'provider', observation.provider === null || preset);
  check(
    id,
    'model',
    preset
      ? typeof observation.model === 'string' &&
          (observation.model === '' || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(observation.model))
      : observation.model === null,
  );
  check(
    id,
    'effort',
    preset
      ? observation.effort === '' || preset.efforts.includes(observation.effort)
      : observation.effort === null,
  );
  return observation;
}
function observationFor(step, stepIndex) {
  const { agent } = step;
  const preset = parseLaunchCommand(agent.launchCommand);
  return checkObservation(agent.id, {
    stepIndex,
    stepName: step.name,
    role: step.role,
    ...agent.assignment,
    ...(agent.fallbackAgent && { fallbackAgent: publicRoleFallback(agent.fallbackAgent) }),
    agentId: agent.id,
    provider: preset?.provider ?? null,
    model: preset?.model ?? null,
    effort: preset?.effort ?? null,
  });
}

function validateOrigin(id, origin) {
  const hasTeam = origin.teamId !== null;
  check(id, 'teamId', !hasTeam || isUuid(origin.teamId));
  check(
    id,
    'teamName',
    hasTeam ? singleLine(origin.teamName, 64) && origin.teamName.trim() : origin.teamName === null,
  );
  check(id, 'teamRevision', hasTeam ? positive(origin.teamRevision) : origin.teamRevision === null);
  check(id, 'mixed', typeof origin.mixed === 'boolean');
  check(id, 'trialId', origin.trialId === null || isUuid(origin.trialId));
  check(id, 'workload', typeof origin.workload === 'string' && /^[\da-f]{64}$/.test(origin.workload));
  check(
    id,
    'configuration',
    Array.isArray(origin.configuration) &&
      origin.configuration.length >= 1 &&
      origin.configuration.length <= 33,
  );
  origin.configuration.forEach((item, i) => {
    checkObservation(id, item);
    check(id, 'configuration.stepIndex', item.stepIndex === i);
  });
  return origin;
}

// Store the initial assignment separately from the mutable run definition. A paused run
// can acquire another agent now or queue one for its next loop through a completed step.
export function createTeamAttribution(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS team_run_attribution (
    run_id TEXT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE CASCADE, team_id TEXT, team_name TEXT,
    team_revision INTEGER, mixed INTEGER NOT NULL CHECK(mixed IN (0,1)), trial_id TEXT,
    workload TEXT NOT NULL, configuration TEXT NOT NULL CHECK(json_valid(configuration)));
    CREATE TABLE IF NOT EXISTS team_run_attempts (
    run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE, step_index INTEGER NOT NULL, attempt INTEGER NOT NULL,
    assignment TEXT NOT NULL CHECK(json_valid(assignment)), PRIMARY KEY(run_id,step_index,attempt));`);
  const clock = createRunClock(db);
  const runIds = db
    .prepare('SELECT run_id FROM team_run_attribution WHERE team_id IS NOT NULL ORDER BY run_id')
    .pluck();
  const insertOrigin = db.prepare('INSERT INTO team_run_attribution VALUES(?,?,?,?,?,?,?,?)');
  const origins = db.prepare('SELECT * FROM team_run_attribution WHERE run_id=?');
  const attempts = db.prepare('SELECT * FROM team_run_attempts WHERE run_id=? ORDER BY step_index,attempt');
  const insertAttempt = db.prepare(`INSERT INTO team_run_attempts VALUES(?,?,?,?)
    ON CONFLICT(run_id,step_index,attempt) DO NOTHING`);
  const markMixed = db.prepare(`UPDATE team_run_attribution SET mixed=1,
    team_name=CASE WHEN team_id IS NULL THEN ? ELSE team_name END,
    team_revision=CASE WHEN team_id IS NULL THEN ? ELSE team_revision END,
    team_id=COALESCE(team_id,?) WHERE run_id=?`);
  return {
    ids() {
      const ids = runIds.all();
      for (const id of ids) check('stored run', 'run_id', isUuid(id));
      return ids;
    },
    markMixed(id, team) {
      markMixed.run(team?.name ?? null, team?.revision ?? null, team?.id ?? null, id);
    },
    prepare(record, { team, mixed, workload, reserve }) {
      const id = record.id;
      const configuration = record.definition.steps.map(observationFor);
      const origin = validateOrigin(id, {
        teamId: team?.id ?? null,
        teamName: team?.name ?? null,
        teamRevision: team?.revision ?? null,
        trialId: null,
        mixed,
        workload,
        configuration,
      });
      const roles = [
        ...new Set(configuration.filter((item) => item.source === 'team').map((item) => item.role)),
      ];
      const trial =
        reserve && !mixed && roles.length
          ? reserve({
              runId: id,
              teamId: team.id,
              teamRevision: team.revision,
              project: record.project,
              workflowId: record.workflowId,
              workflowRevision: record.definition.workflowRevision,
              workload,
              roles,
              mixed,
              configuration,
            })
          : null;
      if (trial === null) return team && !roles.length ? { ...origin, mixed: true } : origin;
      check(id, 'trialId', isUuid(trial?.trialId));
      check(
        id,
        'trial role',
        typeof trial.role === 'string' &&
          roles.some((role) => role.toLowerCase() === trial.role.toLowerCase()),
      );
      const agent = attributedAgent(trial.agent, 'trial', team);
      record.definition.steps = record.definition.steps.map((step) =>
        step.agent.assignment.source === 'team' && step.role.toLowerCase() === trial.role.toLowerCase()
          ? { ...step, agent }
          : step,
      );
      return validateOrigin(id, {
        ...origin,
        trialId: trial.trialId,
        configuration: record.definition.steps.map(observationFor),
      });
    },
    save(id, origin) {
      insertOrigin.run(
        id,
        origin.teamId,
        origin.teamName,
        origin.teamRevision,
        Number(origin.mixed),
        origin.trialId,
        origin.workload,
        JSON.stringify(origin.configuration),
      );
    },
    recordAttempt(run) {
      const index = run.currentStepIndex;
      const assignment = observationFor(run.definition.steps[index], index);
      const attempt = run.steps[index].attempt;
      check(run.id, 'attempt', positive(attempt));
      insertAttempt.run(run.id, index, attempt, JSON.stringify(assignment));
    },
    get(id) {
      check('run', 'id', isUuid(id));
      const row = origins.get(id);
      if (!row) return null;
      check(id, 'run_id', row.run_id === id);
      check(id, 'mixed', row.mixed === 0 || row.mixed === 1);
      const origin = validateOrigin(id, {
        teamId: row.team_id,
        teamName: row.team_name,
        teamRevision: row.team_revision,
        mixed: row.mixed === 1,
        trialId: row.trial_id,
        workload: row.workload,
        configuration: JSON.parse(row.configuration),
      });
      if (origin.teamId === null) return null;
      const durations = attemptDurations(id, clock(id));
      return {
        ...origin,
        attempts: attempts.all(id).map((a) => {
          const item = checkObservation(id, JSON.parse(a.assignment));
          check(id, 'attempt.run_id', a.run_id === id);
          check(id, 'attempt.stepIndex', a.step_index === item.stepIndex);
          check(id, 'attempt', positive(a.attempt));
          return {
            ...item,
            attempt: a.attempt,
            activeMs: durations.get(a.step_index + ':' + a.attempt) ?? null,
          };
        }),
      };
    },
  };
}
