export const TERMINAL_EXECUTION_RUNNING = 'running';
export const TERMINAL_EXECUTION_IDLE = 'idle';
export const TERMINAL_EXECUTION_DEAD = 'dead';
export const TERMINAL_EXECUTION_UNKNOWN = 'unknown';

const INTERACTIVE_SHELL_COMMANDS = new Set([
  'bash',
  'csh',
  'dash',
  'fish',
  'ksh',
  'sh',
  'tcsh',
  'zsh',
]);

function normalizeCommandName(command) {
  if (!command || typeof command !== 'string') return '';
  return command.trim().split('/').pop() || '';
}

function normalizeSnapshotLines(snapshotText) {
  if (!snapshotText || typeof snapshotText !== 'string') return [];

  return snapshotText
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function buildResult({
  executionStatus,
  foregroundCommand,
  executionReason,
  executionConfidence,
}) {
  return {
    executionStatus,
    foregroundCommand,
    executionReason,
    executionConfidence,
  };
}

function hasShellPrompt(line) {
  return /^[\w.-]+@[\w.-]+\s+.+\s[%$#]$/.test(line)
    || /^[^ ]+\s+.+\s[%$#]$/.test(line);
}

function hasAgentWorkingMarker(line) {
  return /^[•✳✱*]\s*Working\b/i.test(line);
}

function hasAgentBackgroundTerminalMarker(line) {
  return /Waiting for background terminal\b/i.test(line);
}

function hasAgentIdlePrompt(line) {
  return line === '❯'
    || /^❯\s/.test(line)
    || /^›\s/.test(line);
}

function hasAgentInterruptIndicator(line) {
  if (/\besc to interrupt\b/i.test(line)) return true;
  if (!/^[^\w\s⏺❯›]\s/u.test(line)) return false;
  return line.includes('…');
}

function classifySnapshotTail(snapshotText) {
  const tail = normalizeSnapshotLines(snapshotText).slice(-40);
  const lastLine = tail[tail.length - 1] || '';

  if (tail.some(hasAgentWorkingMarker)) {
    return {
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      executionReason: 'agent_working',
      executionConfidence: 'high',
    };
  }

  if (tail.some(hasAgentBackgroundTerminalMarker)) {
    return {
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      executionReason: 'agent_background_terminal',
      executionConfidence: 'high',
    };
  }

  if (tail.some(hasAgentInterruptIndicator)) {
    return {
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      executionReason: 'agent_streaming',
      executionConfidence: 'high',
    };
  }

  if (tail.some(hasAgentIdlePrompt)) {
    return {
      executionStatus: TERMINAL_EXECUTION_IDLE,
      executionReason: 'agent_prompt_idle',
      executionConfidence: 'high',
    };
  }

  if (hasShellPrompt(lastLine)) {
    return {
      executionStatus: TERMINAL_EXECUTION_IDLE,
      executionReason: 'shell_prompt',
      executionConfidence: 'high',
    };
  }

  return null;
}

export function classifyTerminalExecution({
  paneCurrentCommand,
  paneDead,
  snapshotText,
} = {}) {
  if (String(paneDead) === '1') {
    return buildResult({
      executionStatus: TERMINAL_EXECUTION_DEAD,
      foregroundCommand: null,
      executionReason: 'pane_dead',
      executionConfidence: 'high',
    });
  }

  const foregroundCommand = normalizeCommandName(paneCurrentCommand);
  if (!foregroundCommand) {
    return buildResult({
      executionStatus: TERMINAL_EXECUTION_UNKNOWN,
      foregroundCommand: null,
      executionReason: 'missing_foreground_command',
      executionConfidence: 'low',
    });
  }

  const snapshotState = classifySnapshotTail(snapshotText);
  if (snapshotState) {
    return buildResult({
      foregroundCommand,
      ...snapshotState,
    });
  }

  if (INTERACTIVE_SHELL_COMMANDS.has(foregroundCommand)) {
    return buildResult({
      executionStatus: TERMINAL_EXECUTION_RUNNING,
      foregroundCommand,
      executionReason: 'shell_without_prompt',
      executionConfidence: 'medium',
    });
  }

  return buildResult({
    executionStatus: TERMINAL_EXECUTION_RUNNING,
    foregroundCommand,
    executionReason: 'foreground_command',
    executionConfidence: 'medium',
  });
}
