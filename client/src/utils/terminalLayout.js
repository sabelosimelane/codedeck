export function shouldPersistLayout({ projectName, prevProjectName, tabsLength, isRestoring }) {
  if (!projectName || isRestoring) return false;
  return prevProjectName === null || prevProjectName === projectName;
}

export function shouldRenderProjectTerminals({ projectName, prevProjectName }) {
  if (!projectName) return false;
  return prevProjectName === null || prevProjectName === projectName;
}
