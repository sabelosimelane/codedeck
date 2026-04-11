export function getTerminalPaneCwd({ sessionId, projectPath, sessionLookup }) {
  return sessionLookup.get(sessionId)?.cwd || projectPath;
}
