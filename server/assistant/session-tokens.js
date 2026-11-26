import { randomBytes, timingSafeEqual } from 'node:crypto';
import { validConversationId } from './conversation-store.js';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function isValidSessionToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function createSessionTokens() {
  const active = new Map();

  return {
    issue({ project, conversationId } = {}) {
      if (typeof project !== 'string' || !project.trim() || project.length > 200) {
        throw new TypeError('session-tokens: project must be a non-empty string');
      }
      if (!validConversationId(conversationId)) {
        throw new TypeError('session-tokens: conversationId must be a valid UUID');
      }
      const token = randomBytes(32).toString('hex');
      const entry = Object.freeze({
        token,
        project,
        conversationId,
        createdAt: new Date().toISOString(),
      });
      active.set(token, entry);
      return entry;
    },

    verify(token, { project } = {}) {
      if (!isValidSessionToken(token)) return null;
      const entry = active.get(token);
      if (!entry) return null;
      const expected = Buffer.from(entry.token, 'utf8');
      const supplied = Buffer.from(token, 'utf8');
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
      if (project !== undefined && entry.project !== project) return null;
      return entry;
    },

    end(token) {
      if (!isValidSessionToken(token)) return false;
      return active.delete(token);
    },

    endConversation(conversationId) {
      if (!validConversationId(conversationId)) return 0;
      let removed = 0;
      for (const [token, entry] of active.entries()) {
        if (entry.conversationId === conversationId) {
          active.delete(token);
          removed += 1;
        }
      }
      return removed;
    },

    size() {
      return active.size;
    },
  };
}
