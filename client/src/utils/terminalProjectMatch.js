function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isProjectSessionId(sessionId, projectName) {
  if (!sessionId || !projectName) return false;
  return new RegExp(`^${escapeRegExp(projectName)}-\\d+$`).test(sessionId);
}

export function doesSessionBelongToProject(session, project) {
  if (!session || !project) return false;

  return isProjectSessionId(session.sessionId, project.name)
    || session.cwd === project.path;
}
