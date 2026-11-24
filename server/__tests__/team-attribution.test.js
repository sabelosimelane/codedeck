import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createRunStore } from '../pipelines/run-store.js';
import { attributedAgent } from '../pipelines/team-attribution.js';

const team = { id: randomUUID(), name: 'Planning', revision: 3 };
const first = {
  id: randomUUID(),
  name: 'First',
  revision: 1,
  launchCommand: 'command codex --model m',
  resetCommand: '/clear',
};
const second = { ...first, id: randomUUID(), name: 'Second', revision: 2, launchCommand: 'command agy' };
const workflowId = randomUUID();
const workload = 'c'.repeat(64);
let db, runs;
beforeEach(() => {
  db = new Database(':memory:');
  runs = createRunStore(db);
});
afterEach(() => db.close());
function input() {
  const agent = attributedAgent(first, 'team', team);
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    workflowId,
    project: 'Demo',
    input: 'test',
    status: 'pending',
    stopReason: null,
    currentStepIndex: 0,
    error: null,
    definition: {
      workflowId,
      workflowName: 'Test',
      workflowRevision: 1,
      agentsDecide: false,
      progressFile: null,
      notesDir: null,
      steps: [
        {
          kind: 'node',
          role: 'Review',
          askOwner: false,
          readOnly: false,
          approval: false,
          name: 'Check',
          prompt: 'Test',
          repeat: { mode: 'once' },
          agent,
        },
      ],
    },
    steps: [
      {
        status: 'pending',
        sessionId: null,
        priorSessionIds: [],
        attempt: 0,
        iteration: 0,
        roundsCompleted: 0,
        detail: null,
        startedAt: null,
        finishedAt: null,
        elapsedMs: 0,
      },
    ],
    homePath: '/tmp/example',
    worktreePath: '/tmp/work',
    worktreeBranch: 'work',
    baseCommit: null,
    worktreeState: 'not_created',
    worktreeDetail: null,
    inputRequest: null,
    taskId: null,
    finishedAt: null,
  };
}
const start = () => runs.create(input(), { team, mixed: false, workload });
describe('immutable team attribution', () => {
  it.each([
    ['fallbackAgent', null],
    ['id', 'not a uuid'],
    ['name', ''],
    ['launchCommand', null],
    ['resetCommand', 'break\nline'],
    ['source', 'override'],
    ['agentRevision', 0],
    ['teamId', randomUUID()],
    ['teamRevision', 7],
  ])('rejects an invalid persisted role fallback field %s by run identity', (field, invalid) => {
    const run = start();
    const def = run.definition;
    const fallback = {
      id: second.id, name: second.name, launchCommand: second.launchCommand, resetCommand: second.resetCommand,
      assignment: { source: 'fallback', agentRevision: second.revision, teamId: team.id, teamRevision: team.revision },
    };
    const agent = def.steps[0].agent;
    agent.fallbackAgent = field === 'fallbackAgent' ? invalid : fallback;
    if (['id', 'name', 'launchCommand', 'resetCommand'].includes(field)) fallback[field] = invalid;
    if (['source', 'agentRevision', 'teamId', 'teamRevision'].includes(field)) fallback.assignment[field] = invalid;
    db.prepare('UPDATE pipeline_runs SET definition=? WHERE id=?').run(JSON.stringify(def), run.id);
    expect(() => runs.get(run.id)).toThrow(new RegExp(`${run.id}.*fallbackAgent.*${field === 'fallbackAgent' ? '' : field}`));
  });

  it('does not allow a workflow agent to acquire a fallback from a corrupt run record', () => {
    const record = input();
    record.definition.steps[0].agent = {
      ...attributedAgent(first, 'workflow', null),
      fallbackAgent: { ...attributedAgent(second, 'team', team), assignment: {
        source: 'fallback', agentRevision: second.revision, teamId: team.id, teamRevision: team.revision,
      } },
    };
    expect(() => runs.create(record)).toThrow(new RegExp(`${record.id}.*fallbackAgent.*team`));
  });

  it('keeps initial configuration and each executed assignment across retries and restarts', () => {
    const run = start();
    expect(runs.attributedIds()).toEqual([run.id]);
    const setAttempt = (attempt, agent) =>
      runs.update(run.id, {
        status: 'running',
        definition: { ...run.definition, steps: [{ ...run.definition.steps[0], agent }] },
        steps: [{ ...run.steps[0], attempt, sessionId: 'Demo-1', status: 'running' }],
      });
    runs.recordAttempt(setAttempt(1, run.definition.steps[0].agent));
    runs.recordAttempt(setAttempt(1, run.definition.steps[0].agent));
    const another = attributedAgent(second, 'override', null);
    runs.recordAttempt(setAttempt(2, another));
    runs.update(
      run.id,
      { status: 'stopped', stopReason: 'user', finishedAt: new Date().toISOString() },
      { mixed: true },
    );
    expect(createRunStore(db).attribution(run.id)).toMatchObject({
      teamName: 'Planning',
      teamRevision: 3,
      mixed: true,
      configuration: [{ agentId: first.id, provider: 'codex', model: 'm', effort: '' }],
      attempts: [
        { attempt: 1, agentId: first.id, source: 'team' },
        { attempt: 2, agentId: second.id, source: 'override', teamId: null },
      ],
    });
  });
  it('rolls back an assignment slot when insertion fails and leaves historical runs unattributed', () => {
    db.exec('CREATE TABLE slots(slot INTEGER)');
    const record = input();
    runs.create(record);
    expect(runs.attribution(record.id)).toBeNull();
    expect(() =>
      runs.create(
        { ...record, id: randomUUID() },
        {
          team,
          mixed: false,
          workload,
          reserve() {
            db.exec('INSERT INTO slots VALUES (1)');
            return null;
          },
        },
      ),
    ).toThrow(/requestId/);
    expect(db.prepare('SELECT count(*) AS count FROM slots').get().count).toBe(0);
  });
  it.each([
    'stepName',
    'stepIndex',
    'role',
    'source',
    'teamId',
    'teamRevision',
    'agentId',
    'agentRevision',
    'provider',
    'model',
    'effort',
  ])('rejects corrupt persisted configuration field %s', (field) => {
    const run = start();
    const origin = db.prepare('SELECT configuration FROM team_run_attribution WHERE run_id=?').get(run.id);
    const items = JSON.parse(origin.configuration);
    delete items[0][field];
    db.prepare('UPDATE team_run_attribution SET configuration=? WHERE run_id=?').run(
      JSON.stringify(items),
      run.id,
    );
    expect(() => runs.attribution(run.id)).toThrow(new RegExp(field));
  });
  it.each(['agentRevision', 'source', 'teamId', 'teamRevision'])(
    'rejects corrupt persisted assignment field %s',
    (field) => {
      const run = start();
      const def = run.definition;
      delete def.steps[0].agent.assignment[field];
      db.prepare('UPDATE pipeline_runs SET definition=? WHERE id=?').run(JSON.stringify(def), run.id);
      expect(() => runs.get(run.id)).toThrow(new RegExp(field));
    },
  );
});

it('splits measured running time by actual attempt and excludes owner waiting', () => {
  let time = 0;
  const now = () => new Date(time).toISOString();
  runs = createRunStore(db, { now });
  const run = start();
  const update = (at, status, attempt) => {
    time = at;
    const next = runs.update(run.id, {
      status,
      steps: [{ ...run.steps[0], attempt, status, sessionId: 'Demo-1' }],
      finishedAt: status === 'complete' ? now() : null,
    });
    if (status === 'running') runs.recordAttempt(next);
  };
  update(1000, 'running', 1);
  update(3000, 'awaiting_approval', 1);
  update(8000, 'running', 2);
  update(12000, 'complete', 2);
  expect(runs.attribution(run.id).attempts.map((a) => a.activeMs)).toEqual([2000, 4000]);
});

it.each([
  ['seq', -7],
  ['step', -1],
  ['status', 'unexpected'],
  ['at', 'yesterday'],
  ['first', 5],
  ['attempt', -1],
])('rejects a corrupted clock %s before using it as elapsed time', (field, value) => {
  const run = start();
  db.prepare('UPDATE improvement_clock SET ' + field + '=? WHERE run_id=?').run(value, run.id);
  expect(() => runs.attribution(run.id)).toThrow(new RegExp(field));
});

it('migrates the existing run clock while preserving old durations and unavailable attempt numbers', async () => {
  const { createRunClock } = await import('../pipelines/run-clock.js');
  db.exec(`DROP TRIGGER improvement_run_changed; DROP TRIGGER improvement_run_created; DROP TABLE improvement_clock;
    CREATE TABLE improvement_clock(seq INTEGER PRIMARY KEY,run_id TEXT NOT NULL,step INTEGER NOT NULL,
      status TEXT NOT NULL,at TEXT NOT NULL,first INTEGER NOT NULL);`);
  const id = randomUUID();
  db.prepare('INSERT INTO improvement_clock VALUES(1,?,0,?,?,1)').run(
    id,
    'pending',
    new Date(1).toISOString(),
  );
  expect(createRunClock(db)(id)).toMatchObject([
    { status: 'pending', attempt: null, at: new Date(1).toISOString() },
  ]);
  const run = start();
  expect(createRunClock(db)(run.id)).toMatchObject([{ status: 'pending', attempt: 0 }]);
});
