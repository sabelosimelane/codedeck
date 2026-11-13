import { UUID } from './index.js';
const PREFIX = ['claude --resume', 'codex resume', 'agent --resume', 'agy --conversation'];
export async function submitDetachedCommand(sessionId, command, { execFile, sleep }) {
  if (typeof sessionId !== 'string' || !/^.+-\d+$/.test(sessionId) || sessionId.includes('\0')) throw new Error('Invalid sessionId');
  if (typeof command !== 'string' || !PREFIX.some(prefix => command.startsWith(`${prefix} `) && UUID.test(command.slice(prefix.length + 1)))) throw new Error('Invalid resume command');
  if (typeof execFile !== 'function' || typeof sleep !== 'function') throw new Error('Missing terminal submission dependency');
  // Match terminal-runtime's tmux name mapping for detached sessions.
  // The trailing colon makes this a pane target (exact session, active window); without it tmux reports "can't find pane".
  const target = `=${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}:`;
  execFile('tmux', ['send-keys', '-t', target, '-l', command], { stdio: 'pipe' });
  await sleep(100);
  execFile('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'pipe' });
}
