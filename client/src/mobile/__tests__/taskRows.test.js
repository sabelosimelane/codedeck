import { describe, it, expect } from 'vitest';
import { buildNowView } from '../nowView';
import { parseRun } from '../../utils/pipelineRunRecords';
import { parseTaskSummary } from '../../utils/tasksApi';
import { run, askingRun, approvalRun, completeRun, step, task, RUN_ID } from './runFixtures';

const NOW = Date.parse('2026-11-10T18:00:00.000Z');
const MIN = 60_000, HOUR = 60 * MIN;
const projects = [{ id: 'p', name: 'p', state: 'active' }, { id: 'w', name: 'w', state: 'waiting' }];
const session = (id, extra = {}) => ({ id, incarnationId: `inc-${id}`, projectId: 'p', title: id, status: 'idle', live: true, finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: NOW - 10 * MIN, ...extra });
const view = (options = {}) => buildNowView({ sessions: [], projects, now: NOW, scope: 'active', query: '', runs: [run()], tasks: [task()], ...options });
const only = options => view(options).tasks[0];

it('uses fixtures the app would accept from the backend', () => {
  for (const record of [run(), askingRun(), approvalRun(), completeRun()]) expect(() => parseRun(record)).not.toThrow();
  // The phone reads a task by the fields every backend release sends.
  expect(() => parseTaskSummary(task())).not.toThrow();
});

describe('a run shown as its task', () => {
  it('is named after its task, with its workflow, project, state and step in words', () => {
    expect(only()).toMatchObject({
      key: RUN_ID, title: 'First name only on the call', workflowName: 'Bug fix', projectName: 'p',
      label: 'Running', tone: 'running', step: 'Step 2 of 3 · Fix', when: 'now',
    });
  });
  it('is named after its folder when it has no task', () => {
    expect(only({ runs: [run({ taskId: null, worktree: { ...run().worktree, path: '/work/codedeck' } })], tasks: [] }).title).toBe('codedeck');
  });
  it('is named after its folder when its task is not among the open tasks', () => {
    expect(only({ tasks: [] }).title).toBe('p-the-call-3858fe63');
  });
  it.each([
    [askingRun(), 'Needs your input', 'needs'],
    [approvalRun(), 'Waiting for your approval', 'needs'],
    [run({ status: 'interrupted', actions: { ...run().actions, stop: false, resume: true } }), 'Interrupted', 'needs'],
    [run({ status: 'error', error: 'The agent exited', finishedAt: run().createdAt }), 'Failed', 'needs'],
    [run({ status: 'stopped', stopReason: 'no_progress', finishedAt: run().createdAt }), 'Stopped: no progress', 'needs'],
    [run({ status: 'stopped', stopReason: 'user', finishedAt: run().createdAt }), 'Stopped', 'idle'],
    [run({ status: 'pending' }), 'Starting', 'idle'],
  ])('says how the run stands (%#)', (record, label, tone) => {
    expect(only({ runs: [record] })).toMatchObject({ label, tone });
  });
  it('says where a looping step is in its rounds', () => {
    const steps = [run().steps[0], step(1, 'Test', { status: 'running', sessionId: 'p-2', attempt: 1, iteration: 1, startedAt: run().createdAt, repeat: { mode: 'loop_back', toStepIndex: 0, max: 12 }, roundsCompleted: 3 }), run().steps[2]];
    expect(only({ runs: [run({ steps })] }).step).toBe('Step 2 of 3 · Test · round 4 of 12');
  });
  it('names no step once the run is complete', () => {
    expect(only({ runs: [completeRun()], scope: 'all' })).toMatchObject({ label: 'Complete', tone: 'idle', step: null });
  });
  it('says when the run last changed', () => {
    expect(only({ runs: [askingRun({ updatedAt: new Date(NOW - 12 * MIN).toISOString() })] }).when).toBe('12m');
  });
});

describe('which tasks are listed', () => {
  const finishedAt = new Date(NOW - 9 * HOUR).toISOString();
  it('lists working runs and runs that need the owner, newest change first', () => {
    const older = askingRun({ id: '11111111-1111-4111-8111-111111111111', taskId: null, updatedAt: new Date(NOW - 30 * MIN).toISOString() });
    expect(view({ runs: [older, run()] }).tasks.map(row => row.key)).toEqual([RUN_ID, older.id]);
  });
  it('leaves out a run that ended long ago until everything is shown', () => {
    const old = completeRun({ updatedAt: finishedAt, finishedAt });
    expect(view({ runs: [old] })).toMatchObject({ tasks: [], quietTaskCount: 1 });
    expect(view({ runs: [old], scope: 'all' })).toMatchObject({ tasks: [{ key: RUN_ID }], quietTaskCount: 0 });
  });
  it('keeps a run that ended recently', () => {
    expect(view({ runs: [completeRun()] }).tasks).toHaveLength(1);
  });
  it('parks the run of a project that is waiting: listed only under all, quiet, and not counted', () => {
    const parked = askingRun({ project: 'w', steps: askingRun().steps.map(item => ({ ...item, sessionId: item.sessionId && item.sessionId.replace('p-', 'w-') })) });
    expect(view({ runs: [parked], tasks: [] })).toMatchObject({ tasks: [], headline: 'All quiet' });
    expect(view({ runs: [parked], tasks: [], scope: 'all' }).tasks[0]).toMatchObject({ tone: 'idle', parked: true });
  });
  it('does not list a run whose project is no longer among the projects', () => {
    expect(view({ runs: [run({ project: 'gone', steps: [step(0, 'Clarify', { status: 'running', attempt: 1, iteration: 1, startedAt: run().createdAt })], currentStepIndex: 0 })] }).tasks).toEqual([]);
  });
  it('finds a task by its title, workflow or project', () => {
    expect(view({ query: 'first NAME' }).tasks).toHaveLength(1);
    expect(view({ query: 'bug fix' }).tasks).toHaveLength(1);
    expect(view({ query: 'nothing like it' }).tasks).toEqual([]);
  });
});

describe('a run and its terminals', () => {
  const sessions = [session('p-1'), session('p-2', { status: 'running' }), session('p-9')];
  it('shows the terminals of a listed run on the task, not in the session list', () => {
    const result = view({ sessions });
    expect(result.groups.flatMap(group => group.rows.map(row => row.id))).toEqual(['p-9']);
    expect(result.tasks[0].sessions.map(item => item.id)).toEqual(['p-1', 'p-2']);
  });
  it('counts the run once, not its terminals', () => {
    expect(view({ sessions })).toMatchObject({ headline: '1 running', subline: 'Nothing needs you' });
    expect(view({ sessions: [session('p-1'), session('p-2', { needsInput: true })], runs: [askingRun()] })).toMatchObject({ headline: '1 needs you', headlineTone: 'needs' });
  });
  it('counts runs and other sessions together', () => {
    expect(view({ sessions: [...sessions, session('p-8', { status: 'running' })], runs: [run(), askingRun({ id: '11111111-1111-4111-8111-111111111111', steps: [step(0, 'Clarify', { status: 'needs_input', sessionId: 'p-7', attempt: 1, iteration: 1, startedAt: run().createdAt })], currentStepIndex: 0 })] }))
      .toMatchObject({ headline: '2 running', subline: '1 needs you' });
  });
  it('says there is nothing open only when there are no sessions and no runs', () => {
    expect(view({ runs: [], tasks: [] }).subline).toBe('No open sessions');
    expect(view().subline).not.toBe('No open sessions');
  });
});

describe('what the task list requires', () => {
  it.each([['runs', undefined], ['runs', {}], ['tasks', undefined], ['tasks', 'none']])('requires %s to be a list', (field, value) => {
    expect(() => view({ [field]: value })).toThrow(`Now view: ${field} must be a list`);
  });
});
