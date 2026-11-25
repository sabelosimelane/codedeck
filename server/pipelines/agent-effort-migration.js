import { buildLaunchCommand, parseLaunchCommand } from '../../shared/agent-presets.mjs';
import { isUuid } from '../../shared/pipeline-definitions.mjs';

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function readObject(table, row, field) {
  let value;
  try { value = JSON.parse(row[field]); }
  catch { throw new Error(`${table} row ${row.id ?? row.request_id} field ${field}: must be valid JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${table} row ${row.id ?? row.request_id} field ${field}: must be an object`);
  }
  return value;
}

function withoutEffortWord(name, effort) {
  if (!effort) return name;
  const words = name.split(/\s+/);
  const trimmed = words.filter(word => word.toLowerCase() !== effort.toLowerCase()).join(' ');
  return trimmed || name;
}

/** Move preset effort into the assignments that use it before agent hydration rejects old rows. */
export function migrateAgentEfforts({ db, now = () => new Date().toISOString(), log = console.log } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('agent effort migration: db must be a database handle');
  if (typeof now !== 'function' || typeof log !== 'function') throw new TypeError('agent effort migration: now and log must be functions');
  if (!tableExists(db, 'pipeline_agents')) return;
  const messages = db.transaction(() => {
    const changes = [];
    const stamp = now();
    if (typeof stamp !== 'string' || Number.isNaN(Date.parse(stamp))) throw new TypeError('agent effort migration: now must return an ISO timestamp');
    const agents = db.prepare('SELECT * FROM pipeline_agents ORDER BY created_at, lower(name), id').all();
    const originalEffort = new Map();
    const normalized = new Map();
    for (const row of agents) {
      if (!isUuid(row.id)) throw new Error(`pipeline_agents row ${row.id} field id: must be a UUID`);
      if (typeof row.name !== 'string' || !row.name.trim()) throw new Error(`pipeline_agents row ${row.id} field name: must be nonblank`);
      if (typeof row.launch_command !== 'string' || !row.launch_command.trim()) throw new Error(`pipeline_agents row ${row.id} field launch_command: must be nonblank`);
      if (typeof row.reset_command !== 'string' || !row.reset_command.trim()) throw new Error(`pipeline_agents row ${row.id} field reset_command: must be nonblank`);
      if (!Number.isInteger(row.revision) || row.revision < 1) throw new Error(`pipeline_agents row ${row.id} field revision: must be positive`);
      for (const field of ['created_at', 'updated_at']) if (typeof row[field] !== 'string' || Number.isNaN(Date.parse(row[field]))) throw new Error(`pipeline_agents row ${row.id} field ${field}: must be a timestamp`);
      const preset = parseLaunchCommand(row.launch_command);
      const effort = preset?.effort ?? '';
      originalEffort.set(row.id, effort);
      normalized.set(row.id, effort ? buildLaunchCommand({ ...preset, effort: '' }).command : row.launch_command);
    }
    const survivors = new Map();
    const mergedInto = new Map();
    for (const row of agents) {
      const key = JSON.stringify([normalized.get(row.id), row.reset_command]);
      if (survivors.has(key)) mergedInto.set(row.id, survivors.get(key));
      else survivors.set(key, row.id);
    }
    const survivorId = id => mergedInto.get(id) ?? id;

    if (tableExists(db, 'pipeline_teams')) {
      const update = db.prepare('UPDATE pipeline_teams SET body=?, revision=revision+1, updated_at=? WHERE id=?');
      for (const row of db.prepare('SELECT id,body FROM pipeline_teams').all()) {
        const body = readObject('pipeline_teams', row, 'body');
        if (!Array.isArray(body.members)) throw new Error(`pipeline_teams row ${row.id} field body.members: must be an array`);
        let changed = false;
        const members = body.members.map((member, index) => {
          if (!member || typeof member !== 'object' || Array.isArray(member)) throw new Error(`pipeline_teams row ${row.id} field body.members[${index}]: must be an object`);
          if (typeof member.role !== 'string' || !member.role.trim()) throw new Error(`pipeline_teams row ${row.id} field body.members[${index}].role: must be nonblank`);
          if (!isUuid(member.agentId)) throw new Error(`pipeline_teams row ${row.id} field body.members[${index}].agentId: must be a UUID`);
          for (const key of ['effort', 'fallbackEffort']) {
            if (member[key] != null && (typeof member[key] !== 'string' || !member[key].trim())) throw new Error(`pipeline_teams row ${row.id} field body.members[${index}].${key}: must be an effort or null`);
          }
          const next = { ...member };
          const effort = originalEffort.get(member.agentId);
          if (effort && next.effort == null) { next.effort = effort; changed = true; changes.push(`[agents] moved ${effort} to team ${row.id} role ${member.role}`); }
          const primary = survivorId(member.agentId);
          if (primary !== member.agentId) { next.agentId = primary; changed = true; }
          if (member.fallbackAgentId != null) {
            if (!isUuid(member.fallbackAgentId)) throw new Error(`pipeline_teams row ${row.id} field body.members[${index}].fallbackAgentId: must be a UUID`);
            const fallbackEffort = originalEffort.get(member.fallbackAgentId);
            if (fallbackEffort && next.fallbackEffort == null) { next.fallbackEffort = fallbackEffort; changed = true; changes.push(`[agents] moved fallback ${fallbackEffort} to team ${row.id} role ${member.role}`); }
            next.fallbackAgentId = survivorId(member.fallbackAgentId);
            if (next.fallbackAgentId !== member.fallbackAgentId) changed = true;
            if (next.fallbackAgentId === next.agentId) {
              delete next.fallbackAgentId;
              delete next.fallbackEffort;
              changed = true;
              changes.push(`[agents] dropped merged fallback from team ${row.id} role ${member.role}`);
            }
          }
          return next;
        });
        if (changed) update.run(JSON.stringify({ ...body, members }), stamp, row.id);
      }
    }

    if (tableExists(db, 'pipeline_settings')) {
      const row = db.prepare('SELECT id,setup_agent_id,setup_effort FROM pipeline_settings WHERE id=1').get();
      if (row) {
        if (row.setup_agent_id !== null && !isUuid(row.setup_agent_id)) throw new Error('pipeline_settings row 1 field setup_agent_id: must be a UUID or null');
        if (row.setup_effort !== null && (typeof row.setup_effort !== 'string' || !row.setup_effort.trim())) throw new Error('pipeline_settings row 1 field setup_effort: must be an effort or null');
        const effort = row.setup_agent_id ? originalEffort.get(row.setup_agent_id) : '';
        const nextEffort = row.setup_effort ?? (effort || null);
        const nextId = row.setup_agent_id ? survivorId(row.setup_agent_id) : null;
        if (nextEffort !== row.setup_effort || nextId !== row.setup_agent_id) {
          db.prepare('UPDATE pipeline_settings SET setup_agent_id=?,setup_effort=?,revision=revision+1 WHERE id=1').run(nextId, nextEffort);
          if (nextEffort !== row.setup_effort) changes.push(`[agents] moved ${nextEffort} to setup agent`);
        }
      }
    }

    if (tableExists(db, 'pipeline_run_requests')) {
      const update = db.prepare('UPDATE pipeline_run_requests SET params=? WHERE request_id=?');
      for (const row of db.prepare('SELECT request_id,params FROM pipeline_run_requests').all()) {
        const params = readObject('pipeline_run_requests', row, 'params');
        if (params.stepOverrides === undefined) continue;
        if (!params.stepOverrides || typeof params.stepOverrides !== 'object' || Array.isArray(params.stepOverrides)) throw new Error(`pipeline_run_requests row ${row.request_id} field params.stepOverrides: must be an object`);
        let changed = false;
        const overrides = Object.fromEntries(Object.entries(params.stepOverrides).map(([name, override]) => {
          const id = typeof override === 'string' ? override : override?.agentId;
          if (!isUuid(id)) throw new Error(`pipeline_run_requests row ${row.request_id} field params.stepOverrides.${name}.agentId: must be a UUID`);
          if (typeof override !== 'string') {
            for (const key of Object.keys(override)) if (!['agentId', 'effort'].includes(key)) throw new Error(`pipeline_run_requests row ${row.request_id} field params.stepOverrides.${name}.${key}: unknown field`);
            if (!Object.hasOwn(override, 'effort') || (override.effort !== null && (typeof override.effort !== 'string' || !override.effort.trim()))) {
              throw new Error(`pipeline_run_requests row ${row.request_id} field params.stepOverrides.${name}.effort: must be null or a supported effort`);
            }
            // Shape only: a finished reservation may name an agent since deleted or edited, and run start checks support.
          }
          const nextId = survivorId(id);
          if (nextId !== id) changed = true;
          return [name, typeof override === 'string' ? nextId : { ...override, agentId: nextId }];
        }));
        if (changed) update.run(JSON.stringify({ ...params, stepOverrides: overrides }), row.request_id);
      }
    }

    if (tableExists(db, 'team_trials')) {
      const update = db.prepare('UPDATE team_trials SET draft=?,version=version+1 WHERE id=?');
      for (const row of db.prepare('SELECT id,draft FROM team_trials').all()) {
        const draft = readObject('team_trials', row, 'draft');
        for (const field of ['agentId', 'donorId']) if (draft[field] !== null && !isUuid(draft[field])) throw new Error(`team_trials row ${row.id} field draft.${field}: must be a UUID or null`);
        if (!draft.pins || typeof draft.pins !== 'object' || Array.isArray(draft.pins)) throw new Error(`team_trials row ${row.id} field draft.pins: must be an object`);
        const next = { ...draft, agentId: survivorId(draft.agentId), donorId: draft.donorId ? survivorId(draft.donorId) : null };
        next.pins = Object.fromEntries(Object.entries(draft.pins).map(([id, revision]) => [survivorId(id), revision]));
        if (JSON.stringify(next) !== JSON.stringify(draft)) update.run(JSON.stringify(next), row.id);
      }
    }

    const updateAgent = db.prepare('UPDATE pipeline_agents SET launch_command=?,revision=revision+1,updated_at=? WHERE id=?');
    for (const row of agents) {
      if (mergedInto.has(row.id)) continue;
      if (normalized.get(row.id) !== row.launch_command) {
        updateAgent.run(normalized.get(row.id), stamp, row.id);
        changes.push(`[agents] removed saved ${originalEffort.get(row.id)} effort from agent ${row.id}`);
      }
    }
    const remove = db.prepare('DELETE FROM pipeline_agents WHERE id=?');
    for (const [id, survivor] of mergedInto) {
      remove.run(id);
      changes.push(`[agents] merged agent ${id} into ${survivor}`);
    }
    const retained = agents.filter(row => !mergedInto.has(row.id));
    const names = new Set(retained.map(row => row.name.toLowerCase()));
    const rename = db.prepare('UPDATE pipeline_agents SET name=?,revision=revision+1,updated_at=? WHERE id=?');
    for (const row of retained) {
      const candidate = withoutEffortWord(row.name, originalEffort.get(row.id));
      if (candidate === row.name || names.has(candidate.toLowerCase())) continue;
      rename.run(candidate, stamp, row.id);
      names.delete(row.name.toLowerCase());
      names.add(candidate.toLowerCase());
      changes.push(`[agents] renamed agent ${row.id} to ${candidate}`);
    }
    return changes;
  })();
  for (const message of messages) log(message);
}
