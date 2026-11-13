import { CLIS, UUID } from './index.js';
const PREFIX = { claude: 'claude --resume', codex: 'codex resume', cursor: 'agent --resume', agy: 'agy --conversation' };
export function buildResumeCommand(cli, conversationId) {
  if (!CLIS.includes(cli)) throw new Error('Invalid cli');
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) throw new Error('Invalid conversationId');
  return `${PREFIX[cli]} ${conversationId}`;
}
