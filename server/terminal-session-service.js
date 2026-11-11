function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Must match sanitizeTmuxName in terminal-runtime.js: hidden durable sessions
// are listed by their tmux names, so "Equinox Local-15" appears as "Equinox_Local-15".
const tmuxSafeName = name => name.replace(/[^a-zA-Z0-9_-]/g, '_');

function getProjectSessionNumber(projectName, sessionId) {
  if (!projectName || !sessionId) return null;
  for (const name of new Set([projectName, tmuxSafeName(projectName)])) {
    const match = sessionId.match(new RegExp(`^${escapeRegExp(name)}-(\\d+)$`));
    if (match) return Number(match[1]);
  }
  return null;
}

export function allocateTerminalSessionId({
  projectName,
  activeSessionIds = [],
  deletedSessionIds = [],
  recoverableSessionIds = [],
  reservedSessionIds = [],
} = {}) {
  if (!projectName || typeof projectName !== 'string') {
    return { error: 'projectName required', status: 400 };
  }

  const allSessionIds = [
    ...activeSessionIds,
    ...deletedSessionIds,
    ...recoverableSessionIds,
    ...reservedSessionIds,
  ];

  const maxSessionNumber = allSessionIds.reduce((max, sessionId) => {
    const sessionNumber = getProjectSessionNumber(projectName, sessionId);
    return sessionNumber === null ? max : Math.max(max, sessionNumber);
  }, 0);

  return {
    data: {
      sessionId: `${projectName}-${maxSessionNumber + 1}`,
    },
  };
}
