import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createConversationStore } from '../assistant/conversation-store.js';
import { createProposalStore } from '../assistant/proposal-store.js';
import { createProposalExecutor } from '../assistant/proposal-executor.js';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskService } from '../tasks/task-service.js';
import { createTaskLanding } from '../tasks/task-landing.js';

const dbs = [];
const dirs = [];

afterEach(async () => {
  dbs.splice(0).forEach(db => db.close());
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function gitSync(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

async function createGitHarness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-prop-exec-'));
  dirs.push(root);
  const repoDir = path.join(root, 'demo-repo');
  await fs.mkdir(repoDir, { recursive: true });
  gitSync(repoDir, ['init', '-b', 'main']);
  gitSync(repoDir, ['config', 'user.email', 'test@example.com']);
  gitSync(repoDir, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(repoDir, '.gitignore'), 'local-secret.env\n');
  await fs.writeFile(path.join(repoDir, 'README.md'), '# Demo\n');
  gitSync(repoDir, ['add', '.']);
  gitSync(repoDir, ['commit', '-m', 'init']);

  const db = new Database(':memory:');
  dbs.push(db);
  const project = { name: 'Demo', path: repoDir, host: 'local', repositories: [] };
  const findProject = name => (name === 'Demo' ? project : null);
  const pathExists = async target => fs.access(target).then(() => true, () => false);

  const taskStore = createTaskStore(db);
  const taskService = createTaskService({
    taskStore,
    findProject,
    execFile,
    startSession: async () => ({ id: 's-1' }),
    pathExists,
    isRunWorking: () => false,
  });
  const landing = createTaskLanding({
    taskStore,
    findProject,
    execFile,
    pathExists,
    hasActiveRun: () => false,
    onTaskFinished: () => {},
    onWorktreeFinished: () => {},
    closeTerminals: async () => ({ closed: [], notClosed: [] }),
  });

  const conversations = createConversationStore(db);
  const proposals = createProposalStore(db);
  const conversation = conversations.current('Demo');
  const logs = [];
  const logger = {
    info: msg => logs.push(msg),
    warn: msg => logs.push(msg),
    error: msg => logs.push(msg),
  };

  return { root, repoDir, db, taskStore, taskService, landing, conversations, proposals, conversation, logs, logger };
}

describe('proposal executor (integration with real git repositories)', () => {
  it('commits on the task branch only and leaves main unchanged, logging without payload', async () => {
    const h = await createGitHarness();
    const task = await h.taskService.create({ project: 'Demo', title: 'Commit task' });
    const mainHeadBefore = gitSync(h.repoDir, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(task.worktreePath, 'feature.txt'), 'hello\n');

    const proposal = h.proposals.create({
      conversationId: h.conversation.id,
      project: 'Demo',
      kind: 'commit',
      payload: { taskId: task.id, message: 'feat: secret-payload-marker' },
      summary: 'Commit feature.txt',
      reason: 'Save work on task branch.',
    });

    const executor = createProposalExecutor({
      proposalStore: h.proposals,
      landing: h.landing,
      taskService: h.taskService,
      startRun: async () => ({ id: 'r-1' }),
      logger: h.logger,
    });

    const outcome = await executor.approve(proposal.id);
    expect(outcome.status).toBe(200);
    expect(outcome.proposal.state).toBe('done');
    expect(gitSync(h.repoDir, ['rev-parse', 'HEAD'])).toBe(mainHeadBefore);
    expect(gitSync(task.worktreePath, ['log', 'main..HEAD', '--pretty=%s'])).toBe('feat: secret-payload-marker');
    expect(h.logs.join('\n')).toContain(proposal.id);
    expect(h.logs.join('\n')).not.toContain('secret-payload-marker');
  });

  it('fails merge with main_dirty when Main has uncommitted changes', async () => {
    const h = await createGitHarness();
    const task = await h.taskService.create({ project: 'Demo', title: 'Merge task' });
    await fs.writeFile(path.join(task.worktreePath, 'work.txt'), 'done\n');
    await h.landing.commit(task.id, { message: 'work' });
    // Dirty Main
    await fs.writeFile(path.join(h.repoDir, 'README.md'), '# Dirty Main\n');

    const proposal = h.proposals.create({
      conversationId: h.conversation.id,
      project: 'Demo',
      kind: 'merge',
      payload: { taskId: task.id },
      summary: 'Merge task into main',
      reason: 'Ready to merge.',
    });

    const executor = createProposalExecutor({
      proposalStore: h.proposals,
      landing: h.landing,
      taskService: h.taskService,
      startRun: async () => ({ id: 'r-1' }),
      logger: h.logger,
    });

    const outcome = await executor.approve(proposal.id);
    expect(outcome.status).toBe(409);
    expect(outcome.proposal.state).toBe('failed');
    expect(outcome.problem.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'main_dirty' })]));
    expect(h.proposals.get(proposal.id).result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'main_dirty' })]));
  });

  it('never deletes ignored files when closing a task', async () => {
    const h = await createGitHarness();
    const task = await h.taskService.create({ project: 'Demo', title: 'Close task' });
    const secretFile = path.join(task.worktreePath, 'local-secret.env');
    await fs.writeFile(secretFile, 'SECRET=1\n');

    const proposal = h.proposals.create({
      conversationId: h.conversation.id,
      project: 'Demo',
      kind: 'close',
      payload: { taskId: task.id },
      summary: 'Close task',
      reason: 'No longer needed.',
    });

    const executor = createProposalExecutor({
      proposalStore: h.proposals,
      landing: h.landing,
      taskService: h.taskService,
      startRun: async () => ({ id: 'r-1' }),
      logger: h.logger,
    });

    const outcome = await executor.approve(proposal.id);
    expect(outcome.status).toBe(409);
    expect(outcome.proposal.state).toBe('failed');
    expect(outcome.problem.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ignored_files' })]));
    expect(await fs.readFile(secretFile, 'utf8')).toBe('SECRET=1\n');
  });

  it('passes proposal id as requestId for start_run so a replayed start creates at most one run', async () => {
    const h = await createGitHarness();
    const seenRequests = new Map();
    const startRun = vi.fn(async body => {
      if (seenRequests.has(body.requestId)) return seenRequests.get(body.requestId);
      const run = { id: `run-${seenRequests.size + 1}`, requestId: body.requestId, project: body.project };
      seenRequests.set(body.requestId, run);
      return run;
    });

    const proposal = h.proposals.create({
      conversationId: h.conversation.id,
      project: 'Demo',
      kind: 'start_run',
      payload: {
        workflowId: '66666666-6666-4666-8666-666666666666',
        input: 'todos/plan.md',
        teamId: '77777777-7777-4777-8777-777777777777',
      },
      summary: 'Start workflow run',
      reason: 'Continue next phase.',
    });

    const executor = createProposalExecutor({
      proposalStore: h.proposals,
      landing: h.landing,
      taskService: h.taskService,
      startRun,
      logger: h.logger,
    });

    const first = await executor.approve(proposal.id);
    expect(first.status).toBe(200);
    expect(first.proposal.state).toBe('done');
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      project: 'Demo',
      requestId: proposal.id,
      workflowId: '66666666-6666-4666-8666-666666666666',
    }));

    // Simulate replay of the same requestId directly (as if response failed after start)
    const replayed = await startRun({ ...proposal.payload, project: 'Demo', requestId: proposal.id });
    expect(replayed.id).toBe(first.proposal.result.id);
    expect(seenRequests.size).toBe(1);
  });

  it('runs the service once on concurrent approvals and never calls services on decline', async () => {
    const h = await createGitHarness();
    const createSpy = vi.fn(async input => h.taskService.create(input));
    const proposal = h.proposals.create({
      conversationId: h.conversation.id,
      project: 'Demo',
      kind: 'new_task',
      payload: { title: 'Concurrent task' },
      summary: 'Create a new task',
      reason: 'Start new work.',
    });

    const executor = createProposalExecutor({
      proposalStore: h.proposals,
      landing: h.landing,
      taskService: { create: createSpy },
      startRun: async () => ({ id: 'r-1' }),
      logger: h.logger,
    });

    const [a, b] = await Promise.allSettled([executor.approve(proposal.id), executor.approve(proposal.id)]);
    const fulfilled = [a, b].filter(r => r.status === 'fulfilled');
    const rejected = [a, b].filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].value.status).toBe(200);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.status).toBe(409);
    expect(createSpy).toHaveBeenCalledTimes(1);

    const second = h.proposals.create({
      conversationId: h.conversation.id,
      project: 'Demo',
      kind: 'new_task',
      payload: { title: 'Declined task' },
      summary: 'Create another task',
      reason: 'Optional.',
    });
    const declined = executor.decline(second.id);
    expect(declined.status).toBe(200);
    expect(declined.proposal.state).toBe('declined');
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the field detail of a service validation refusal in the failed result', async () => {
    const h = await createGitHarness();
    const proposal = h.proposals.create({
      conversationId: h.conversation.id,
      project: 'Demo',
      kind: 'start_run',
      payload: { workflowId: '00000000-0000-4000-8000-000000000001', input: 'todo.md', teamId: '00000000-0000-4000-8000-000000000002' },
      summary: 'Start a run',
      reason: 'Build the feature.',
    });
    const refusal = Object.assign(new Error('One or more fields failed validation.'), {
      status: 400,
      errors: [{ field: 'teamId', message: 'Team not found' }],
    });
    const executor = createProposalExecutor({ proposalStore: h.proposals, startRun: async () => { throw refusal; }, logger: h.logger });

    const outcome = await executor.approve(proposal.id);
    expect(outcome.status).toBe(409);
    expect(outcome.proposal.state).toBe('failed');
    expect(outcome.proposal.result.message).toBe('One or more fields failed validation. teamId: Team not found');
    expect(outcome.problem.message).toBe('One or more fields failed validation. teamId: Team not found');
  });
});

describe('run proposals', () => {
  const RUN_ID = '88888888-8888-4888-8888-888888888888';
  const TEAM_ID = '77777777-7777-4777-8777-777777777777';
  const cases = [
    ['stop_run', { runId: RUN_ID }, 'stop', [RUN_ID]],
    ['resume_run', { runId: RUN_ID }, 'resume', [RUN_ID]],
    ['answer_run', { runId: RUN_ID, answer: '1. (a) Close Batch 1 first' }, 'answer', [RUN_ID, '1. (a) Close Batch 1 first']],
    ['continue_run', { runId: RUN_ID, stepIndex: 3, roundsCompleted: 8 }, 'continue', [RUN_ID, { stepIndex: 3, roundsCompleted: 8 }]],
    ['continue_run', { runId: RUN_ID, stepIndex: 3, roundsCompleted: 8, extraRounds: 1 }, 'continue', [RUN_ID, { stepIndex: 3, roundsCompleted: 8, extraRounds: 1 }]],
    ['change_team', { runId: RUN_ID, teamId: TEAM_ID }, 'changeTeam', [RUN_ID, TEAM_ID]],
  ];
  it.each(cases)('carries out %s through the run action %s', async (kind, payload, action, args) => {
    const h = await createGitHarness();
    const runActions = { stop: vi.fn(), resume: vi.fn(), answer: vi.fn(), continue: vi.fn(), changeTeam: vi.fn() };
    runActions[action].mockResolvedValue({ id: RUN_ID, status: 'stopped' });
    const proposal = h.proposals.create({ conversationId: h.conversation.id, project: 'Demo', kind, payload, summary: 'Act on the run', reason: 'The owner asked.' });
    const executor = createProposalExecutor({ proposalStore: h.proposals, runActions, logger: h.logger });
    const outcome = await executor.approve(proposal.id);
    expect(outcome.status).toBe(200);
    expect(outcome.proposal).toMatchObject({ state: 'done', result: { id: RUN_ID, status: 'stopped' } });
    expect(runActions[action]).toHaveBeenCalledExactlyOnceWith(...args);
    for (const other of Object.keys(runActions).filter(name => name !== action)) expect(runActions[other]).not.toHaveBeenCalled();
  });
  it('fails the proposal with the run engine\'s refusal when the run has moved on', async () => {
    const h = await createGitHarness();
    const proposal = h.proposals.create({ conversationId: h.conversation.id, project: 'Demo', kind: 'stop_run', payload: { runId: RUN_ID }, summary: 'Stop it', reason: 'Blocked.' });
    const refusal = Object.assign(new Error('Run is already complete'), { status: 409 });
    const executor = createProposalExecutor({ proposalStore: h.proposals, runActions: { stop: async () => { throw refusal; } }, logger: h.logger });
    const outcome = await executor.approve(proposal.id);
    expect(outcome.status).toBe(409);
    expect(outcome.proposal).toMatchObject({ state: 'failed', result: { status: 409, message: 'Run is already complete' } });
  });
  it('fails the proposal loudly when run actions are not wired', async () => {
    const h = await createGitHarness();
    const proposal = h.proposals.create({ conversationId: h.conversation.id, project: 'Demo', kind: 'resume_run', payload: { runId: RUN_ID }, summary: 'Resume it', reason: 'Unblocked.' });
    const outcome = await createProposalExecutor({ proposalStore: h.proposals, logger: h.logger }).approve(proposal.id);
    expect(outcome.status).toBe(500);
    expect(outcome.proposal.result.message).toBe('Run action resume is unavailable');
  });
});
