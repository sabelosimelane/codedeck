export function shouldPersistLayout({ projectName, prevProjectName, tabsLength, isRestoring, isPersistenceSuspended = false }) {
  if (!projectName || isRestoring || isPersistenceSuspended) return false;
  return prevProjectName === null || prevProjectName === projectName;
}

export function shouldRenderProjectTerminals({ projectName, prevProjectName }) {
  if (!projectName) return false;
  return prevProjectName === null || prevProjectName === projectName;
}
