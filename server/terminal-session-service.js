function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getProjectSessionNumber(projectName, sessionId) {
  if (!projectName || !sessionId) return null;
  const match = sessionId.match(new RegExp(`^${escapeRegExp(projectName)}-(\\d+)$`));
  return match ? Number(match[1]) : null;
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
