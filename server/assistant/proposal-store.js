import { randomUUID } from 'node:crypto';
import { validConversationId } from './conversation-store.js';
import {
  isValidProposalReason,
  isValidProposalSummary,
  PROPOSAL_KINDS,
  PROPOSAL_STATES,
  validateProposalPayloadShape,
} from './proposal-payloads.js';

export const validProposalId = validConversationId;
export const MAX_PENDING_PROPOSALS = 10;

const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const nonEmpty = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max;
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pagingError = (field, value) => Object.assign(new Error(`Invalid ${field}: ${String(value)}`), { status: 400, errors: [{ field, message: `Invalid ${field}` }] });

function guard(id, column, valid) {
  if (!valid) throw new Error(`assistant_proposals row ${id}: invalid ${column}`);
}

function parseJsonObject(id, column, raw) {
  guard(id, column, typeof raw === 'string' && raw.length > 0);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`assistant_proposals row ${id}: invalid ${column}`);
  }
  guard(id, column, isPlain(parsed));
  return parsed;
}

export function hydrateProposal(row) {
  const key = row?.id;
  guard(key, 'id', validProposalId(row?.id));
  guard(key, 'conversation_id', validConversationId(row.conversation_id));
  guard(key, 'project', nonEmpty(row.project, 200));
  guard(key, 'kind', PROPOSAL_KINDS.includes(row.kind));
  const payload = parseJsonObject(key, 'payload', row.payload);
  guard(key, 'payload', validateProposalPayloadShape(row.kind, payload).length === 0);
  guard(key, 'summary', isValidProposalSummary(row.summary));
  guard(key, 'reason', isValidProposalReason(row.reason));
  guard(key, 'state', PROPOSAL_STATES.includes(row.state));
  const needsResult = row.state === 'done' || row.state === 'failed';
  const result = needsResult ? parseJsonObject(key, 'result', row.result) : (guard(key, 'result', row.result === null), null);
  guard(key, 'created_at', date(row.created_at));
  guard(key, 'decided_at', row.state === 'pending' ? row.decided_at === null : date(row.decided_at));
  guard(key, 'finished_at', needsResult ? date(row.finished_at) : row.finished_at === null);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    project: row.project,
    kind: row.kind,
    payload,
    summary: row.summary,
    reason: row.reason,
    state: row.state,
    result,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    finishedAt: row.finished_at,
  };
}

export function createProposalStore(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('proposal store requires db');
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_proposals (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id),
    project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('commit','merge','pull_request','close','new_task','start_run')),
    payload TEXT NOT NULL,
    summary TEXT NOT NULL,
    reason TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','approved','declined','done','failed','expired')),
    result TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS assistant_proposals_conversation_idx ON assistant_proposals(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS assistant_proposals_project_idx ON assistant_proposals(project, created_at);`);

  const byId = db.prepare('SELECT * FROM assistant_proposals WHERE id = ?');
  const countPendingStmt = db.prepare("SELECT count(*) AS n FROM assistant_proposals WHERE conversation_id = ? AND state = 'pending'");
  const insertStmt = db.prepare(`INSERT INTO assistant_proposals
    (id, conversation_id, project, kind, payload, summary, reason, state, result, created_at, decided_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)`);
  const claimApproveStmt = db.prepare("UPDATE assistant_proposals SET state = 'approved', decided_at = ? WHERE id = ? AND state = 'pending'");
  const finishStmt = db.prepare("UPDATE assistant_proposals SET state = ?, result = ?, finished_at = ? WHERE id = ? AND state = 'approved'");
  const declineStmt = db.prepare("UPDATE assistant_proposals SET state = 'declined', decided_at = ? WHERE id = ? AND state = 'pending'");
  const expireStmt = db.prepare("UPDATE assistant_proposals SET state = 'expired', decided_at = ? WHERE conversation_id = ? AND state = 'pending'");
  // The store is created once at startup, when no proposal can still be running: one left approved
  // was being carried out when the backend stopped, so it is failed with the outcome said to be unknown.
  db.prepare("UPDATE assistant_proposals SET state = 'failed', result = ?, finished_at = ? WHERE state = 'approved'").run(
    JSON.stringify({ status: 500, message: 'CodeDeck restarted while this was being carried out, so whether it finished is not known. Check the task before proposing it again.' }),
    new Date().toISOString(),
  );
  const decidedStmt = db.prepare("SELECT * FROM assistant_proposals WHERE conversation_id = ? AND state IN ('done','failed','declined','expired') ORDER BY decided_at ASC, id ASC");

  const createTx = db.transaction(({ conversationId, project, kind, payload, summary, reason, maxPending = MAX_PENDING_PROPOSALS }) => {
    guard(conversationId, 'conversation_id', validConversationId(conversationId));
    guard(project, 'project', nonEmpty(project, 200));
    guard(kind, 'kind', PROPOSAL_KINDS.includes(kind));
    guard(kind, 'payload', validateProposalPayloadShape(kind, payload).length === 0);
    guard(summary, 'summary', isValidProposalSummary(summary));
    guard(reason, 'reason', isValidProposalReason(reason));
    const pendingCount = countPendingStmt.get(conversationId).n;
    if (pendingCount >= maxPending) {
      throw Object.assign(new Error(`This conversation already has ${maxPending} pending proposals.`), { status: 409 });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    insertStmt.run(id, conversationId, project, kind, JSON.stringify(payload), summary.trim(), reason.trim(), now);
    return hydrateProposal(byId.get(id));
  });

  return {
    create: createTx,

    get(id) {
      guard(id, 'id', validProposalId(id));
      const row = byId.get(id);
      return row ? hydrateProposal(row) : null;
    },

    list({ project, conversationId, state, page = 0, size = 20, direction = 'desc' } = {}) {
      guard(project, 'project', nonEmpty(project, 200));
      if (conversationId !== undefined) guard(conversationId, 'conversation_id', validConversationId(conversationId));
      if (state !== undefined) guard(state, 'state', PROPOSAL_STATES.includes(state));
      if (!Number.isSafeInteger(page) || page < 0) throw pagingError('page', page);
      if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw pagingError('size', size);
      if (!['asc', 'desc'].includes(direction)) throw pagingError('direction', direction);

      const where = ['project = ?'];
      const params = [project];
      if (conversationId !== undefined) { where.push('conversation_id = ?'); params.push(conversationId); }
      if (state !== undefined) { where.push('state = ?'); params.push(state); }
      const clause = where.join(' AND ');
      const order = direction === 'asc' ? 'created_at ASC, id ASC' : 'created_at DESC, id DESC';

      const total = db.prepare(`SELECT count(*) AS n FROM assistant_proposals WHERE ${clause}`).get(...params).n;
      const rows = db.prepare(`SELECT * FROM assistant_proposals WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, size, page * size);
      return {
        data: rows.map(hydrateProposal),
        page: {
          currentPage: page,
          size,
          totalElements: total,
          totalPages: Math.ceil(total / size),
          hasNextPage: (page + 1) * size < total,
        },
      };
    },

    claimApprove(id) {
      guard(id, 'id', validProposalId(id));
      const info = claimApproveStmt.run(new Date().toISOString(), id);
      if (info.changes === 0) return null;
      return hydrateProposal(byId.get(id));
    },

    finish(id, { state, result }) {
      guard(id, 'id', validProposalId(id));
      guard(id, 'state', state === 'done' || state === 'failed');
      guard(id, 'result', isPlain(result));
      const info = finishStmt.run(state, JSON.stringify(result), new Date().toISOString(), id);
      if (info.changes === 0) throw new Error(`assistant_proposals row ${id}: cannot finish proposal not in approved state`);
      return hydrateProposal(byId.get(id));
    },

    decline(id) {
      guard(id, 'id', validProposalId(id));
      const info = declineStmt.run(new Date().toISOString(), id);
      if (info.changes === 0) return null;
      return hydrateProposal(byId.get(id));
    },

    expireForConversation(conversationId) {
      guard(conversationId, 'conversation_id', validConversationId(conversationId));
      return expireStmt.run(new Date().toISOString(), conversationId).changes;
    },

    countPending(conversationId) {
      guard(conversationId, 'conversation_id', validConversationId(conversationId));
      return countPendingStmt.get(conversationId).n;
    },

    listDecided(conversationId) {
      guard(conversationId, 'conversation_id', validConversationId(conversationId));
      return decidedStmt.all(conversationId).map(hydrateProposal);
    },
  };
}
