import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROVISIONING_STATES, reservedAttachmentIdentities } from './request-store.js';
import { removeUnpublishedAttachments } from './attachment-publisher.js';

/**
 * The private staging root of the CodeDeck instance that uses `databasePath`. Startup clears every
 * staging attempt under its root, so two instances on one machine (an isolated QA boot beside the
 * owner's own) must never share one: each database gets its own.
 */
export function attachmentStagingRootFor(databasePath) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) {
    throw new TypeError(`databasePath must be an absolute path (got ${JSON.stringify(databasePath ?? null)})`);
  }
  const key = createHash('sha256').update(path.resolve(databasePath)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `codedeck-pipeline-attachments-${key}`);
}

/**
 * Settles attached starts a server stop interrupted, before any start is served. No request is in
 * flight at startup, so every staging attempt is abandoned. A start whose run was recorded had
 * persisted its manifest, so its batch is published and kept. Any other start that recorded a
 * checkout is failed after what it may have written there is removed; its task and checkout are
 * kept for a retry by the owner with the same ID, or for Close run.
 * @returns {Promise<{ published: string[], failed: string[] }>} request ids
 */
export async function reconcileAttachmentStarts({
  requestStore,
  runStore,
  stagingRoot,
  removeManagedAttachments = removeUnpublishedAttachments,
} = {}) {
  if (typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot)) throw new TypeError('stagingRoot must be an absolute path');
  await rm(path.join(stagingRoot, 'attempts'), { recursive: true, force: true });

  const summary = { published: [], failed: [] };
  for (const record of requestStore.listUnpublished()) {
    if (record.runId !== null && runStore.get(record.runId)) {
      requestStore.transition(record.requestId, { from: record.provisioningState, to: PROVISIONING_STATES.PUBLISHED });
      summary.published.push(record.requestId);
      continue;
    }
    if (record.placement === null) continue;
    try {
      await removeManagedAttachments({
        checkoutPath: record.placement.worktreePath,
        notesDir: `.codedeck/runs/${record.runId.slice(0, 8)}`,
        files: reservedAttachmentIdentities(record.params),
      });
    } catch (error) {
      console.error(`[pipelines] could not clear unpublished attachments requestId=${record.requestId}`, error);
    }
    if (record.provisioningState === PROVISIONING_STATES.RESERVED) {
      requestStore.transition(record.requestId, { from: PROVISIONING_STATES.RESERVED, to: PROVISIONING_STATES.FAILED });
    }
    summary.failed.push(record.requestId);
  }
  return summary;
}
