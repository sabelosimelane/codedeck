// Runs and tasks as the backend sends them, for the phone's tests. Every record
// passes the same parsers the app uses.
export const RUN_ID = '2eaa789f-f15a-41d1-8caa-a7f82164e70c';
export const TASK_ID = '3858fe63-2b5f-4869-bfe6-6d591776294e';
const AT = '2026-11-10T17:50:00.000Z';
const NO_ACTIONS = { stop: false, resume: false, continue: false, cleanup: false, answer: false, approve: false, sendBack: false };

export function step(index, name, extra = {}) {
  return {
    index, kind: 'node', name, role: null, askOwner: false, readOnly: false, approval: false, agentName: 'Fable Medium',
    notePath: `.codedeck/runs/2eaa789f/${String(index).padStart(2, '0')}-${name.toLowerCase()}.md`, note: null,
    repeat: { mode: 'once' }, status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0,
    roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, ...extra,
  };
}

/** A run of project `p` working in its second step of three. */
export function run(extra = {}) {
  return {
    id: RUN_ID, requestId: 'request-1', workflowId: '9d3f050c-5c99-4417-9fa7-715b24b289d5', taskId: TASK_ID,
    workflowName: 'Bug fix', agentsDecide: false, decisionCount: 0, notesDir: '.codedeck/runs/2eaa789f', progress: null,
    project: 'p', input: 'The call says the full name', status: 'running', approvalRequest: null, stopReason: null, error: null,
    attachments: [],
    currentStepIndex: 1,
    steps: [
      step(0, 'Clarify', { status: 'complete', sessionId: 'p-1', attempt: 1, iteration: 1, startedAt: AT, finishedAt: AT }),
      step(1, 'Fix', { status: 'running', sessionId: 'p-2', attempt: 1, iteration: 1, startedAt: AT }),
      step(2, 'Verify'),
    ],
    worktree: { path: '/work/worktrees/p-the-call-3858fe63', branch: 'task/the-call-3858fe63', baseCommit: '42234146cd7c08137a75dc0e170afa5d107fa0b4', state: 'external', detail: null },
    inputRequest: null, actions: { ...NO_ACTIONS, stop: true }, createdAt: AT, updatedAt: AT, finishedAt: null, ...extra,
  };
}

/** The same run, paused on its second step with two listed questions. */
export function askingRun(extra = {}) {
  const base = run();
  return run({
    status: 'needs_input', actions: { ...NO_ACTIONS, stop: true, answer: true },
    inputRequest: { questions: '1. Which name should the call use? Recommended: The first name only\n2. Should the text message change too?', truncated: false },
    steps: [base.steps[0], { ...base.steps[1], status: 'needs_input' }, base.steps[2]], ...extra,
  });
}

/** The same run, with its second step finished and waiting for approval. */
export function approvalRun(extra = {}) {
  const base = run();
  const note = { status: 'written', summary: 'The call now uses the first name', attempt: 1, pass: 1, createdAt: AT };
  return run({
    status: 'awaiting_approval', actions: { ...NO_ACTIONS, stop: true, approve: true, sendBack: true },
    approvalRequest: { stepIndex: 1, stepName: 'Fix', note },
    steps: [base.steps[0], { ...base.steps[1], status: 'awaiting_approval', approval: true, note }, base.steps[2]], ...extra,
  });
}

export function completeRun(extra = {}) {
  const base = run();
  return run({
    status: 'complete', currentStepIndex: 2, actions: { ...NO_ACTIONS, cleanup: true }, finishedAt: AT,
    steps: base.steps.map((item, index) => ({ ...item, status: 'complete', sessionId: `p-${index + 1}`, attempt: 1, iteration: 1, startedAt: AT, finishedAt: AT })), ...extra,
  });
}

export function task(extra = {}) {
  return {
    id: TASK_ID, project: 'p', title: 'First name only on the call', state: 'active', worktreePath: '/work/worktrees/p-the-call-3858fe63',
    branch: 'task/the-call-3858fe63', baseBranch: 'main', baseCommit: '42234146cd7c08137a75dc0e170afa5d107fa0b4', prUrl: null,
    revision: 1, createdAt: AT, updatedAt: AT, finishedAt: null, ...extra,
  };
}

export const pageOf = data => ({ data, page: { currentPage: 0, size: 100, totalElements: data.length, totalPages: data.length ? 1 : 0, hasNextPage: false } });

export const WORKTREE_ID = '7b000000-0000-4000-8000-000000000001';
const NO_BLOCKERS = { commit: [], merge: [], pullRequest: [], close: [] };
/** How the task's one repository stands for landing, as `GET /api/tasks/:id/worktrees` sends it. */
export function landing(extra = {}) {
  return {
    taskId: TASK_ID, worktreeId: WORKTREE_ID, repository: 'p', own: true, first: true, worktreePath: '/work/worktrees/p-the-call-3858fe63',
    state: 'active', branch: 'task/the-call-3858fe63', baseBranch: 'main', prUrl: null, filesPresent: true, runActive: false,
    uncommitted: ['src/call.js', 'src/text.js'], uncommittedCount: 2, commitsAhead: 0, commitsBehind: 0, alreadyInBase: false,
    ignoredAtRisk: [], ignoredAtRiskCount: 0, main: { branch: 'main', dirty: false },
    remotes: [{ name: 'origin', host: 'github.com', tool: 'gh' }],
    blockers: { ...NO_BLOCKERS, merge: [{ code: 'uncommitted', message: 'Commit the changes first' }], pullRequest: [{ code: 'uncommitted', message: 'Commit the changes first' }], close: [{ code: 'uncommitted', message: 'Commit the changes first' }] }, ...extra,
  };
}
/** The same repository with its work committed and ready to merge. */
export function committedLanding(extra = {}) {
  return landing({ uncommitted: [], uncommittedCount: 0, commitsAhead: 3, blockers: { ...NO_BLOCKERS, commit: [{ code: 'nothing_to_commit', message: 'Nothing to commit' }] }, ...extra });
}
