import { describe, expect, it } from 'vitest';
import {
  PROPOSAL_KINDS,
  validateProposalCreateBody,
  validateProposalPayload,
  validateProposalPayloadShape,
} from '../assistant/proposal-payloads.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TASK_ID = '22222222-2222-4222-8222-222222222222';
const CLOSED_TASK_ID = '33333333-3333-4333-8333-333333333333';
const WORKTREE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_WORKTREE_ID = '55555555-5555-4555-8555-555555555555';
const WORKFLOW_ID = '66666666-6666-4666-8666-666666666666';
const TEAM_ID = '77777777-7777-4777-8777-777777777777';

const tasks = new Map([
  [TASK_ID, { id: TASK_ID, project: 'Demo', state: 'active', worktrees: [{ id: WORKTREE_ID, repository: 'backend', state: 'active' }] }],
  [OTHER_TASK_ID, { id: OTHER_TASK_ID, project: 'Other', state: 'active', worktrees: [{ id: OTHER_WORKTREE_ID, repository: 'api', state: 'active' }] }],
  [CLOSED_TASK_ID, { id: CLOSED_TASK_ID, project: 'Demo', state: 'closed', worktrees: [{ id: WORKTREE_ID, repository: 'backend', state: 'closed' }] }],
]);
const taskStore = { get: id => tasks.get(id) ?? null };

describe('proposal payload validation', () => {
  it('accepts valid payloads for every kind', () => {
    expect(PROPOSAL_KINDS).toEqual(['commit', 'merge', 'pull_request', 'close', 'new_task', 'start_run', 'stop_run', 'resume_run', 'continue_run', 'answer_run', 'change_team']);
    expect(validateProposalPayload('commit', { taskId: TASK_ID, worktreeId: WORKTREE_ID, message: 'wip: checkpoint' }, { project: 'Demo', taskStore })).toEqual([]);
    expect(validateProposalPayload('commit', { taskId: TASK_ID, message: 'a'.repeat(200) }, { project: 'Demo', taskStore })).toEqual([]);
    expect(validateProposalPayload('merge', { taskId: TASK_ID }, { project: 'Demo', taskStore })).toEqual([]);
    expect(validateProposalPayload('merge', { taskId: TASK_ID, worktreeId: WORKTREE_ID }, { project: 'Demo', taskStore })).toEqual([]);
    expect(validateProposalPayload('pull_request', { taskId: TASK_ID, remote: 'origin' }, { project: 'Demo', taskStore })).toEqual([]);
    expect(validateProposalPayload('close', { taskId: TASK_ID, worktreeId: WORKTREE_ID }, { project: 'Demo', taskStore })).toEqual([]);
    expect(validateProposalPayload('new_task', { title: 'Add Phase 4' }, { project: 'Demo', taskStore })).toEqual([]);
    expect(validateProposalPayload('new_task', { title: 'Add Phase 4', repositories: ['backend', 'frontend'] }, { project: 'Demo', taskStore })).toEqual([]);
    expect(validateProposalPayload('start_run', { workflowId: WORKFLOW_ID, input: 'todos/plan.md', teamId: TEAM_ID, taskId: TASK_ID, startIn: 'backend' }, { project: 'Demo', taskStore })).toEqual([]);
    expect(validateProposalPayload('start_run', { workflowId: WORKFLOW_ID, input: 'todos/plan.md', teamId: TEAM_ID, newTask: { title: 'Run task', repositories: ['backend'] }, startIn: 'backend' }, { project: 'Demo', taskStore })).toEqual([]);
  });

  it('rejects another project task, missing task, closed task, and unknown worktree', () => {
    const otherProj = validateProposalPayload('commit', { taskId: OTHER_TASK_ID, message: 'wip' }, { project: 'Demo', taskStore });
    expect(otherProj).toEqual([expect.objectContaining({ field: 'taskId', message: expect.stringMatching(/another project/i) })]);

    const missing = validateProposalPayload('merge', { taskId: '99999999-9999-4999-8999-999999999999' }, { project: 'Demo', taskStore });
    expect(missing).toEqual([expect.objectContaining({ field: 'taskId', message: expect.stringMatching(/not found/i) })]);

    const closed = validateProposalPayload('close', { taskId: CLOSED_TASK_ID }, { project: 'Demo', taskStore });
    expect(closed).toEqual([expect.objectContaining({ field: 'taskId', message: expect.stringMatching(/open/i) })]);

    const badWorktree = validateProposalPayload('merge', { taskId: TASK_ID, worktreeId: OTHER_WORKTREE_ID }, { project: 'Demo', taskStore });
    expect(badWorktree).toEqual([expect.objectContaining({ field: 'worktreeId', message: expect.stringMatching(/worktree/i) })]);

    const startRunOtherTask = validateProposalPayload('start_run', { workflowId: WORKFLOW_ID, input: 'hello', teamId: TEAM_ID, taskId: OTHER_TASK_ID }, { project: 'Demo', taskStore });
    expect(startRunOtherTask).toEqual([expect.objectContaining({ field: 'taskId', message: expect.stringMatching(/another project/i) })]);
  });

  it('rejects deleteIgnored on close and unknown fields on every kind', () => {
    const closeIgnored = validateProposalPayload('close', { taskId: TASK_ID, deleteIgnored: true }, { project: 'Demo', taskStore });
    expect(closeIgnored).toEqual([expect.objectContaining({ field: 'deleteIgnored' })]);

    const closeFalseIgnored = validateProposalPayload('close', { taskId: TASK_ID, deleteIgnored: false }, { project: 'Demo', taskStore });
    expect(closeFalseIgnored).toEqual([expect.objectContaining({ field: 'deleteIgnored' })]);

    const startRunExtra = validateProposalPayload('start_run', { workflowId: WORKFLOW_ID, input: 'hi', teamId: TEAM_ID, project: 'Other', requestId: 'custom' }, { project: 'Demo', taskStore });
    expect(startRunExtra.map(e => e.field)).toEqual(expect.arrayContaining(['project', 'requestId']));
  });

  it('rejects over-long, multiline, or blank fields and reports every field at once', () => {
    const commitErrors = validateProposalPayload('commit', { taskId: 'not-uuid', worktreeId: 'also-bad', message: 'line1\nline2', extra: 1 }, { project: 'Demo', taskStore });
    expect(commitErrors.map(e => e.field)).toEqual(expect.arrayContaining(['taskId', 'worktreeId', 'message', 'extra']));

    const overLongCommit = validateProposalPayloadShape('commit', { taskId: TASK_ID, message: 'x'.repeat(201) });
    expect(overLongCommit).toEqual([expect.objectContaining({ field: 'message' })]);

    const prErrors = validateProposalPayloadShape('pull_request', { taskId: TASK_ID, remote: 'r'.repeat(101) });
    expect(prErrors).toEqual([expect.objectContaining({ field: 'remote' })]);

    const newTaskErrors = validateProposalPayloadShape('new_task', { title: 't'.repeat(81), repositories: ['a', 'a'] });
    expect(newTaskErrors.map(e => e.field)).toEqual(expect.arrayContaining(['title', 'repositories']));
  });

  it('validates the full create body and reports every invalid field together', () => {
    const errors = validateProposalCreateBody({
      kind: 'commit',
      payload: { taskId: OTHER_TASK_ID, worktreeId: 'bad', message: '' },
      summary: 'line1\nline2',
      reason: 'r'.repeat(2001),
      extra: true,
    }, { project: 'Demo', taskStore });
    expect(errors.map(e => e.field)).toEqual(expect.arrayContaining([
      'extra',
      'summary',
      'reason',
      'payload.taskId',
      'payload.worktreeId',
      'payload.message',
    ]));
  });
});

describe('run proposal validation', () => {
  const RUN_ID = '88888888-8888-4888-8888-888888888888';
  const OTHER_RUN_ID = '99999999-9999-4999-8999-999999999999';
  const MISSING_RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const runs = new Map([[RUN_ID, { id: RUN_ID, project: 'Demo' }], [OTHER_RUN_ID, { id: OTHER_RUN_ID, project: 'Other' }]]);
  const context = { project: 'Demo', taskStore, runStore: { get: id => runs.get(id) ?? null }, teamStore: { get: id => (id === TEAM_ID ? { id } : null) } };

  it('accepts each run action naming a run of this project', () => {
    expect(validateProposalPayload('stop_run', { runId: RUN_ID }, context)).toEqual([]);
    expect(validateProposalPayload('resume_run', { runId: RUN_ID }, context)).toEqual([]);
    expect(validateProposalPayload('answer_run', { runId: RUN_ID, answer: '1. Yes\n2. (b) Set it aside', expectedUpdatedAt: '2026-11-27T16:00:00.000Z' }, context)).toEqual([]);
    expect(validateProposalPayload('continue_run', { runId: RUN_ID, stepIndex: 3, roundsCompleted: 8 }, context)).toEqual([]);
    expect(validateProposalPayload('continue_run', { runId: RUN_ID, stepIndex: 3, roundsCompleted: 8, extraRounds: 1 }, context)).toEqual([]);
    expect(validateProposalPayload('change_team', { runId: RUN_ID, teamId: TEAM_ID, expectedUpdatedAt: '2026-11-27T16:00:00.000Z' }, context)).toEqual([]);
  });
  it('refuses a malformed run id, unknown fields, and missing fields on every run action', () => {
    for (const kind of ['stop_run', 'resume_run', 'answer_run', 'continue_run', 'change_team']) {
      expect(validateProposalPayloadShape(kind, { runId: 'run-1' })).toContainEqual({ field: 'runId', message: 'Use a valid run UUID' });
      expect(validateProposalPayloadShape(kind, { runId: RUN_ID, force: true })).toContainEqual({ field: 'force', message: 'Unknown field' });
      expect(validateProposalPayloadShape(kind, {})).toContainEqual({ field: 'runId', message: 'Use a valid run UUID' });
    }
  });
  it('checks each action\'s own fields and reports them together', () => {
    expect(validateProposalPayloadShape('answer_run', { runId: RUN_ID, answer: '', expectedUpdatedAt: '2026-11-27T16:00:00.000Z' }).map(e => e.field)).toEqual(['answer']);
    expect(validateProposalPayloadShape('answer_run', { runId: RUN_ID, answer: 'x'.repeat(4001), expectedUpdatedAt: '2026-11-27T16:00:00.000Z' }).map(e => e.field)).toEqual(['answer']);
    expect(validateProposalPayloadShape('answer_run', { runId: RUN_ID, answer: 'stop\u001b[0m', expectedUpdatedAt: '2026-11-27T16:00:00.000Z' }).map(e => e.field)).toEqual(['answer']);
    expect(validateProposalPayloadShape('answer_run', { runId: RUN_ID, answer: 'x'.repeat(4000), expectedUpdatedAt: '2026-11-27T16:00:00.000Z' })).toEqual([]);
    // A continue names the exact pause it grants, so an approval made later cannot spend a different one.
    expect(validateProposalPayloadShape('continue_run', { runId: RUN_ID }).map(e => e.field)).toEqual(['stepIndex', 'roundsCompleted']);
    expect(validateProposalPayloadShape('continue_run', { runId: RUN_ID, stepIndex: 33, roundsCompleted: -1 }).map(e => e.field)).toEqual(['stepIndex', 'roundsCompleted']);
    expect(validateProposalPayloadShape('change_team', { runId: RUN_ID, teamId: null, expectedUpdatedAt: '2026-11-27T16:00:00.000Z' }).map(e => e.field)).toEqual(['teamId']);
    expect(validateProposalPayloadShape('change_team', { runId: 'x', teamId: 'y', expectedUpdatedAt: '2026-11-27T16:00:00.000Z' }).map(e => e.field)).toEqual(['runId', 'teamId']);
  });
  it('refuses a run of another project, a run that does not exist, and a team that does not exist', () => {
    expect(validateProposalPayload('stop_run', { runId: OTHER_RUN_ID }, context)).toEqual([{ field: 'runId', message: 'This run belongs to another project' }]);
    expect(validateProposalPayload('stop_run', { runId: MISSING_RUN_ID }, context)).toEqual([{ field: 'runId', message: 'Run not found' }]);
    expect(validateProposalPayload('change_team', { runId: RUN_ID, teamId: WORKFLOW_ID, expectedUpdatedAt: '2026-11-27T16:00:00.000Z' }, context)).toEqual([{ field: 'teamId', message: 'Team not found' }]);
  });
  it('requires the run version CodeDeck records on answers and team changes', () => {
    for (const [kind, payload] of [['answer_run', { runId: RUN_ID, answer: 'Yes' }], ['change_team', { runId: RUN_ID, teamId: TEAM_ID }]]) {
      expect(validateProposalPayloadShape(kind, payload)).toEqual([{ field: 'expectedUpdatedAt', message: 'Use the run version CodeDeck recorded (an ISO timestamp)' }]);
      expect(validateProposalPayloadShape(kind, { ...payload, expectedUpdatedAt: 'yesterday' }).map(e => e.field)).toEqual(['expectedUpdatedAt']);
    }
    expect(validateProposalPayloadShape('stop_run', { runId: RUN_ID, expectedUpdatedAt: '2026-11-27T16:00:00.000Z' })).toEqual([{ field: 'expectedUpdatedAt', message: 'Unknown field' }]);
  });
  it('fails loudly when a run proposal is checked without the run store', () => {
    expect(() => validateProposalPayload('stop_run', { runId: RUN_ID }, { project: 'Demo', taskStore })).toThrow('runStore');
  });
});
