import { validProposalId } from './proposal-store.js';

const REFUSAL_STATUSES = new Set([400, 404, 409, 503]);

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeResult(value) {
  if (isPlain(value)) return value;
  return { value };
}

function extractFailure(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const isRefusal = REFUSAL_STATUSES.has(status);
  const base = typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim()
    : 'Proposal execution failed.';
  // A validation refusal says which fields; without them the owner would read only "failed validation".
  const fieldDetail = Array.isArray(error?.errors)
    ? error.errors.filter(item => typeof item?.field === 'string' && typeof item?.message === 'string').map(item => `${item.field}: ${item.message}`)
    : [];
  const message = fieldDetail.length ? `${base} ${fieldDetail.join('; ')}` : base;
  const reasons = Array.isArray(error?.extra?.reasons)
    ? error.extra.reasons
    : Array.isArray(error?.reasons) ? error.reasons : undefined;
  const conflicts = Array.isArray(error?.extra?.conflicts)
    ? error.extra.conflicts
    : Array.isArray(error?.conflicts) ? error.conflicts : undefined;
  return {
    isRefusal,
    result: {
      status,
      message,
      ...(reasons ? { reasons } : {}),
      ...(conflicts ? { conflicts } : {}),
    },
  };
}

export function createProposalExecutor({ proposalStore, landing, taskService, startRun, runActions, logger = console } = {}) {
  if (!proposalStore) throw new TypeError('proposal executor requires proposalStore');

  function runAction(action, ...args) {
    if (typeof runActions?.[action] !== 'function') throw new Error(`Run action ${action} is unavailable`);
    return runActions[action](...args);
  }

  async function runService(proposal) {
    const { kind, payload, project, id } = proposal;
    switch (kind) {
      case 'commit':
        if (typeof landing?.commit !== 'function') throw new Error('Task landing commit is unavailable');
        return landing.commit(payload.taskId, {
          message: payload.message,
          ...(payload.worktreeId !== undefined ? { worktreeId: payload.worktreeId } : {}),
        });
      case 'merge':
        if (typeof landing?.merge !== 'function') throw new Error('Task landing merge is unavailable');
        return landing.merge(payload.taskId, payload.worktreeId !== undefined ? { worktreeId: payload.worktreeId } : {});
      case 'pull_request':
        if (typeof landing?.pullRequest !== 'function') throw new Error('Task landing pullRequest is unavailable');
        return landing.pullRequest(payload.taskId, {
          remote: payload.remote,
          ...(payload.worktreeId !== undefined ? { worktreeId: payload.worktreeId } : {}),
        });
      case 'close':
        // Spec §8.4.5: close never deletes ignored files.
        if (payload.worktreeId !== undefined) {
          if (typeof landing?.closeWorktree !== 'function') throw new Error('Task landing closeWorktree is unavailable');
          return landing.closeWorktree(payload.taskId, payload.worktreeId, { deleteIgnored: false });
        }
        if (typeof landing?.close !== 'function') throw new Error('Task landing close is unavailable');
        return landing.close(payload.taskId, { deleteIgnored: false });
      case 'new_task':
        if (typeof taskService?.create !== 'function') throw new Error('Task service create is unavailable');
        return taskService.create({
          project,
          title: payload.title,
          ...(payload.repositories !== undefined ? { repositories: payload.repositories } : {}),
        });
      case 'start_run':
        if (typeof startRun !== 'function') throw new Error('Workflow run start is unavailable');
        // Spec §8.4.6: proposal id is used as requestId so a retried approval starts at most one run.
        return startRun({
          ...payload,
          project,
          requestId: id,
        });
      case 'stop_run':
        return runAction('stop', payload.runId);
      case 'resume_run':
        return runAction('resume', payload.runId);
      case 'answer_run':
        return runAction('answer', payload.runId, payload.answer, payload.expectedUpdatedAt);
      case 'continue_run':
        // The grant names the pause the owner approved; the engine refuses it once the run has moved past it.
        return runAction('continue', payload.runId, {
          stepIndex: payload.stepIndex,
          roundsCompleted: payload.roundsCompleted,
          ...(payload.extraRounds !== undefined ? { extraRounds: payload.extraRounds } : {}),
        });
      case 'change_team':
        return runAction('changeTeam', payload.runId, payload.teamId, payload.expectedUpdatedAt);
      default:
        throw new Error(`Unsupported proposal kind ${String(kind)}`);
    }
  }

  return {
    async approve(id) {
      if (!validProposalId(id)) throw Object.assign(new Error('Proposal not found'), { status: 404 });
      const claimed = proposalStore.claimApprove(id);
      if (!claimed) {
        const existing = proposalStore.get(id);
        if (!existing) throw Object.assign(new Error('Proposal not found'), { status: 404 });
        throw Object.assign(new Error('Proposal is no longer pending.'), { status: 409 });
      }

      try {
        const serviceResult = await runService(claimed);
        const done = proposalStore.finish(id, { state: 'done', result: normalizeResult(serviceResult) });
        logger.info?.(`[assistant] proposal decision id=${done.id} kind=${done.kind} outcome=done`);
        return { status: 200, proposal: done };
      } catch (error) {
        const { isRefusal, result } = extractFailure(error);
        const failed = proposalStore.finish(id, { state: 'failed', result });
        if (isRefusal) {
          logger.warn?.(`[assistant] proposal decision id=${failed.id} kind=${failed.kind} outcome=failed status=${result.status}`);
          return { status: 409, proposal: failed, problem: result };
        }
        logger.error?.(`[assistant] proposal decision id=${failed.id} kind=${failed.kind} outcome=failed status=500`, error);
        return { status: 500, proposal: failed, problem: result };
      }
    },

    decline(id) {
      if (!validProposalId(id)) throw Object.assign(new Error('Proposal not found'), { status: 404 });
      const declined = proposalStore.decline(id);
      if (!declined) {
        const existing = proposalStore.get(id);
        if (!existing) throw Object.assign(new Error('Proposal not found'), { status: 404 });
        throw Object.assign(new Error('Proposal is no longer pending.'), { status: 409 });
      }
      logger.info?.(`[assistant] proposal decision id=${declined.id} kind=${declined.kind} outcome=declined`);
      return { status: 200, proposal: declined };
    },
  };
}
