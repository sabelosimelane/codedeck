export function validRun(project = 'Alpha') {
  return {
    id: '11111111-1111-4111-8111-111111111111', requestId: 'req-1',
    workflowId: '22222222-2222-4222-8222-222222222222', workflowName: 'Feature', agentsDecide: false, decisionCount: 0,
    project, input: '', status: 'running', approvalRequest: null, stopReason: null, error: null, progress: null, notesDir: null, attachments: [], currentStepIndex: 0,
    steps: [{ index: 0, kind: 'setup', name: 'Setup', readOnly: false, approval: false, agentName: 'Codex', repeat: { mode: 'until_complete', max: 3 },
      status: 'running', sessionId: `${project}-1`, priorSessionIds: [], attempt: 1, iteration: 1, roundsCompleted: 0,
      detail: null, startedAt: '2026-11-13T12:00:00.000Z', finishedAt: null, elapsedMs: 0, notePath: null, note: null }],
    worktree: { path: '/tmp/worktree', branch: 'workflow/feature', baseCommit: 'a'.repeat(40), state: 'present', detail: null },
    inputRequest: null,
    actions: { stop: true, resume: false, continue: false, cleanup: false, answer: false, approve: false, sendBack: false },
    createdAt: '2026-11-13T12:00:00.000Z', updatedAt: '2026-11-13T12:00:00.000Z', finishedAt: null,
  };
}
