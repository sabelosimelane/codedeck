const DEFAULT_EDITOR_COMMAND = 'code -r';

function splitCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) return [];

  const parts = [];
  const tokenPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;

  for (const match of trimmed.matchAll(tokenPattern)) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }

  return parts;
}

export function resolveEditorCommand(configuredCommand) {
  const parts = splitCommand(configuredCommand || DEFAULT_EDITOR_COMMAND);
  if (parts.length === 0) {
    return splitCommand(DEFAULT_EDITOR_COMMAND);
  }
  return parts;
}

export { DEFAULT_EDITOR_COMMAND };
