import { findAgentProfile } from './agent-profiles/index.js';

export const TERMINAL_EXECUTION_RUNNING = 'running';
export const TERMINAL_EXECUTION_IDLE = 'idle';
export const TERMINAL_EXECUTION_DEAD = 'dead';
export const TERMINAL_EXECUTION_UNKNOWN = 'unknown';
export const WORKING_SILENCE_SECONDS = 20;

const SHELLS = new Set(['bash', 'csh', 'dash', 'fish', 'ksh', 'sh', 'tcsh', 'zsh']);
const commandName = command => typeof command === 'string' ? command.trim().split('/').pop() : '';
const result = (executionStatus, foregroundCommand, executionReason, executionConfidence, agentCli = null, backgroundAgents = 0, backgroundShells = 0, needsInput = false) => ({
  executionStatus, foregroundCommand, executionReason, executionConfidence,
  agentCli, backgroundAgents, backgroundShells, needsInput,
});
const shellPrompt = line => /^[\w.-]+@[\w.-]+\s+.+\s[%$#]$/.test(line) || /^[^ ]+\s+.+\s[%$#]$/.test(line);

export function classifyTerminalExecution({ paneCurrentCommand, paneDead, snapshotText, subagentPanes, quietSeconds }) {
  if (!Array.isArray(subagentPanes)) throw new Error('subagentPanes must be an array');
  if (!Number.isFinite(quietSeconds) || quietSeconds < 0) throw new Error('quietSeconds must be a finite nonnegative number');
  if (String(paneDead) === '1') return result('dead', null, 'pane_dead', 'high');
  const foregroundCommand = commandName(paneCurrentCommand);
  if (!foregroundCommand) return result('unknown', null, 'missing_foreground_command', 'low');
  const lines = typeof snapshotText === 'string' ? snapshotText.replace(/\r/g, '').split('\n') : [];
  const profile = findAgentProfile({ foregroundCommand, lines });
  if (profile) {
    const main = profile.read(lines);
    const agentCli = profile.id;
    if (main.turn === 'needs_input') return result('running', foregroundCommand, 'agent_needs_input', 'high', agentCli, 0, main.backgroundShells, true);
    const stale = main.turn === 'working' && quietSeconds >= WORKING_SILENCE_SECONDS;
    if (main.turn === 'working' && !stale) return result('running', foregroundCommand, 'agent_working', 'high', agentCli, 0, main.backgroundShells);
    const reads = subagentPanes.filter(pane => String(pane.paneDead) !== '1').map(pane => {
      const sublines = typeof pane.snapshotText === 'string' ? pane.snapshotText.replace(/\r/g, '').split('\n') : [];
      return findAgentProfile({ foregroundCommand: commandName(pane.paneCurrentCommand), lines: sublines })?.read(sublines);
    }).filter(Boolean);
    if (reads.some(read => read.turn === 'needs_input')) return result('running', foregroundCommand, 'agent_needs_input', 'high', agentCli, 0, main.backgroundShells, true);
    const backgroundAgents = quietSeconds < WORKING_SILENCE_SECONDS ? reads.filter(read => read.turn === 'working').length : 0;
    if (backgroundAgents) return result('running', foregroundCommand, 'agent_delegated', 'high', agentCli, backgroundAgents, main.backgroundShells);
    if (main.backgroundShells) return result('running', foregroundCommand, 'agent_background_shells', 'high', agentCli, 0, main.backgroundShells);
    return result('idle', foregroundCommand, stale ? 'agent_marker_stale' : 'agent_prompt_idle', 'high', agentCli);
  }
  const lastLine = lines.map(line => line.trim()).filter(Boolean).at(-1) || '';
  if (shellPrompt(lastLine)) return result('idle', foregroundCommand, 'shell_prompt', 'high');
  if (SHELLS.has(foregroundCommand)) return result('running', foregroundCommand, 'shell_without_prompt', 'medium');
  return result('running', foregroundCommand, 'foreground_command', 'medium');
}
