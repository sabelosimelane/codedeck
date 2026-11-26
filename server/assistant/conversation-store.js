import { randomUUID } from 'node:crypto';

export const validConversationId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const uuid = validConversationId;
const ROLES = ['owner', 'agent', 'tool', 'notice'];
const pagingError = (field, value) => Object.assign(new Error(`Invalid ${field}: ${String(value)}`), { status: 400, errors: [{ field, message: `Invalid ${field}` }] });
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const string = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max;
function guard(table, id, column, valid) { if (!valid) throw new Error(`${table} row ${id}: invalid ${column}`); }
function conversation(row) {
  const key = row.id;
  guard('assistant_conversations', key, 'id', uuid(row.id));
  guard('assistant_conversations', key, 'project', string(row.project, 200));
  guard('assistant_conversations', key, 'state', ['current', 'ended'].includes(row.state));
  guard('assistant_conversations', key, 'created_at', date(row.created_at));
  guard('assistant_conversations', key, 'ended_at', row.state === 'current' ? row.ended_at === null : date(row.ended_at));
  return { id: row.id, project: row.project, state: row.state, createdAt: row.created_at, endedAt: row.ended_at };
}
export function hydrateMessage(row) {
  const key = row.id;
  guard('assistant_messages', key, 'id', Number.isSafeInteger(row.id) && row.id > 0);
  guard('assistant_messages', key, 'conversation_id', uuid(row.conversation_id));
  guard('assistant_messages', key, 'role', ROLES.includes(row.role));
  guard('assistant_messages', key, 'content', string(row.content, 200000));
  guard('assistant_messages', key, 'tool_name', row.role === 'tool' ? string(row.tool_name, 100) : row.tool_name === null);
  // Phase 4 creates assistant_proposals; until then this nullable ID has no FK.
  guard('assistant_messages', key, 'proposal_id', row.proposal_id === null || uuid(row.proposal_id));
  guard('assistant_messages', key, 'created_at', date(row.created_at));
  return { id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, toolName: row.tool_name, proposalId: row.proposal_id, createdAt: row.created_at };
}

export function createConversationStore(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('conversation store requires db');
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_conversations (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('current','ended')),
    created_at TEXT NOT NULL, ended_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS assistant_one_current ON assistant_conversations(project) WHERE state='current';
  CREATE TABLE IF NOT EXISTS assistant_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id),
    role TEXT NOT NULL CHECK(role IN ('owner','agent','tool','notice')), content TEXT NOT NULL,
    tool_name TEXT, proposal_id TEXT, created_at TEXT NOT NULL
  );`);
  const byId = db.prepare('SELECT * FROM assistant_conversations WHERE id=?');
  const byProject = db.prepare("SELECT * FROM assistant_conversations WHERE project=? AND state='current'");
  const insert = db.prepare('INSERT INTO assistant_conversations (id,project,state,created_at,ended_at) VALUES (?, ?, ?, ?, NULL)');
  const end = db.prepare("UPDATE assistant_conversations SET state='ended', ended_at=? WHERE project=? AND state='current'");
  const insertMessage = db.prepare('INSERT INTO assistant_messages (conversation_id,role,content,tool_name,proposal_id,created_at) VALUES (?,?,?,?,?,?)');
  const byMessageId = db.prepare('SELECT * FROM assistant_messages WHERE id=?');
  const countMessages = db.prepare('SELECT count(*) AS n FROM assistant_messages WHERE conversation_id=?');
  const hasMessage = db.prepare('SELECT 1 FROM assistant_messages WHERE conversation_id=? LIMIT 1');
  const pageAsc = db.prepare('SELECT * FROM assistant_messages WHERE conversation_id=? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?');
  const pageDesc = db.prepare('SELECT * FROM assistant_messages WHERE conversation_id=? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?');
  const requireProject = project => guard('assistant_conversations', project, 'project', string(project, 200));
  const requireId = id => guard('assistant_conversations', id, 'id', uuid(id));
  const create = project => { const id = randomUUID(); insert.run(id, project, 'current', new Date().toISOString()); return conversation(byId.get(id)); };
  const start = db.transaction(project => { requireProject(project); end.run(new Date().toISOString(), project); return create(project); });
  const current = db.transaction(project => { requireProject(project); const row = byProject.get(project); return row ? conversation(row) : create(project); });
  return {
    current,
    findCurrent(project) { requireProject(project); const row = byProject.get(project); return row ? conversation(row) : null; },
    startNew: start,
    get(id) { requireId(id); const row = byId.get(id); return row ? conversation(row) : null; },
    append(conversationId, { role, content, toolName = null, proposalId = null }) {
      requireId(conversationId);
      guard('assistant_messages', conversationId, 'role', ROLES.includes(role));
      guard('assistant_messages', conversationId, 'content', string(content, 200000));
      guard('assistant_messages', conversationId, 'toolName', role === 'tool' ? string(toolName, 100) : toolName === null);
      guard('assistant_messages', conversationId, 'proposalId', proposalId === null || uuid(proposalId));
      const existing = this.get(conversationId);
      if (!existing) throw Object.assign(new Error('Conversation not found'), { status: 404 });
      if (existing.state === 'ended') throw new Error(`Conversation ${conversationId} is ended`);
      const result = insertMessage.run(conversationId, role, content, toolName, proposalId, new Date().toISOString());
      return hydrateMessage(byMessageId.get(result.lastInsertRowid));
    },
    messages(conversationId, { page = 0, size = 20, direction = 'asc' } = {}) {
      requireId(conversationId);
      if (!this.get(conversationId)) throw Object.assign(new Error('Conversation not found'), { status: 404 });
      if (!Number.isSafeInteger(page) || page < 0) throw pagingError('page', page);
      if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw pagingError('size', size);
      if (!['asc', 'desc'].includes(direction)) throw pagingError('direction', direction);
      const count = countMessages.get(conversationId).n;
      const rows = (direction === 'asc' ? pageAsc : pageDesc).all(conversationId, size, page * size);
      return { data: rows.map(hydrateMessage), page: { currentPage: page, size, totalElements: count, totalPages: Math.ceil(count / size), hasNextPage: (page + 1) * size < count } };
    },
    hasMessages(id) { requireId(id); return hasMessage.get(id) !== undefined; },
  };
}
