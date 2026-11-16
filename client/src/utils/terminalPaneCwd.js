export function getTerminalPaneCwd({ sessionId, projectPath, worktreePath, sessionLookup }) {
  return sessionLookup.get(sessionId)?.cwd || worktreePath || projectPath;
}
