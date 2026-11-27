import {parseLaunchCommand} from '../../shared/agent-presets.mjs';
import { isAbsolute } from 'node:path';
import { isUuid } from '../../shared/pipeline-definitions.mjs';

const kinds = new Set(('created start step_running needs_input input_received step_complete approval_requested approve send_back loop_back limit_reached error stop continue resume agent_restarted agent_switched quota_takeover interrupted prompt_submitted prompt_unclaimed work_observed disposition_requested signal_accepted observation_unavailable observation_restored verification_report build_receipt').split(' '));
function check(field, valid) {
  if (!valid) throw new TypeError(`Invalid run audit ${field}`);
}

function checked(row) {
  check('runId', isUuid(row.runId));
  check('stepIndex', Number.isInteger(row.stepIndex) && row.stepIndex >= 0 && row.stepIndex <= 32);
  for (const key of ['attempt','pass']) check(key, Number.isSafeInteger(row[key]) && row[key] >= 0);
  for (const key of ['host','agentName']) check(key, typeof row[key] === 'string' && row[key].trim() !== '');
  check('worktreePath', typeof row.worktreePath === 'string' && isAbsolute(row.worktreePath));
  for (const key of ['sessionId','model','effort']) check(key, row[key] === null || (typeof row[key] === 'string' && row[key].trim() !== ''));
  check('kind', kinds.has(row.kind));
  check('detail', row.detail === null || (typeof row.detail === 'string' && row.detail.length <= 2000));
  check('createdAt', typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt)));
  return row;
}

export function createRunAudit(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_run_audit(
    id INTEGER PRIMARY KEY, runId TEXT NOT NULL, stepIndex INTEGER NOT NULL, attempt INTEGER NOT NULL, pass INTEGER NOT NULL,
    host TEXT NOT NULL, worktreePath TEXT NOT NULL, sessionId TEXT, agentName TEXT NOT NULL,
    model TEXT, effort TEXT, kind TEXT NOT NULL, detail TEXT, createdAt TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS pipeline_audit_run ON pipeline_run_audit(runId,stepIndex,id);`);
  const append = db.prepare(`INSERT INTO pipeline_run_audit(runId,stepIndex,attempt,pass,host,worktreePath,sessionId,agentName,model,effort,kind,detail,createdAt)
    VALUES(@runId,@stepIndex,@attempt,@pass,@host,@worktreePath,@sessionId,@agentName,@model,@effort,@kind,@detail,@createdAt)`);
  return {
    append(run, event, createdAt) {
      const stepIndex = run.currentStepIndex;
      const step = run.steps[stepIndex];
      const agent = run.definition.steps[stepIndex].agent;
      // Store only an explicit model or effort option. Launch commands may contain credentials.
      const preset = parseLaunchCommand(agent.launchCommand);
      const model = preset?.model || null;
      const effort = preset?.effort || null;
      append.run(checked({runId:run.id,stepIndex,attempt:step.attempt,pass:step.iteration,host:run.host,worktreePath:run.worktreePath,
        sessionId:step.sessionId,agentName:agent.name,model,effort,kind:event.kind,detail:event.detail,createdAt}));
    },
    lastDetail(runId,stepIndex,kind) {
      check('runId',isUuid(runId));
      check('stepIndex',Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex <= 32);
      check('kind',kinds.has(kind));
      return db.prepare('SELECT detail FROM pipeline_run_audit WHERE runId=? AND stepIndex=? AND kind=? ORDER BY id DESC LIMIT 1').get(runId,stepIndex,kind)?.detail ?? null;
    },
    lastDetailOf(runId,stepIndex,ofKinds) {
      check('runId',isUuid(runId));
      check('stepIndex',Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex <= 32);
      if (!Array.isArray(ofKinds) || ofKinds.length === 0 || !ofKinds.every(kind => kinds.has(kind))) throw new TypeError('Invalid run audit kinds');
      const placeholders = ofKinds.map(() => '?').join(',');
      return db.prepare(`SELECT detail FROM pipeline_run_audit WHERE runId=? AND stepIndex=? AND kind IN (${placeholders}) ORDER BY id DESC LIMIT 1`).get(runId,stepIndex,...ofKinds)?.detail ?? null;
    },
    page(runId, {page,size,direction,stepIndex}) {
      check('runId',isUuid(runId));
      check('page',Number.isSafeInteger(page) && page >= 0 && page <= 100000);
      check('size',Number.isInteger(size) && size >= 1 && size <= 100);
      check('direction',['asc','desc'].includes(direction));
      check('stepIndex',stepIndex === null || (Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex <= 32));
      const where = 'WHERE runId = ?' + (stepIndex === null ? '' : ' AND stepIndex = ?');
      const params = stepIndex === null ? [runId] : [runId,stepIndex];
      const total = db.prepare(`SELECT count(*) AS n FROM pipeline_run_audit ${where}`).get(...params).n;
      const data = db.prepare(`SELECT * FROM pipeline_run_audit ${where} ORDER BY id ${direction} LIMIT ? OFFSET ?`).all(...params,size,page*size);
      for (const row of data) {
        check('id',Number.isSafeInteger(row.id) && row.id > 0);
        checked(row);
      }
      return {data,page:{currentPage:page,size,totalElements:total,totalPages:Math.ceil(total/size),hasNextPage:(page+1)*size<total}};
    },
  };
}
