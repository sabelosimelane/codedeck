export function shouldPersistLayout({ projectName, prevProjectName, tabsLength, isRestoring }) {
  if (!projectName || tabsLength === 0 || isRestoring) return false;
  return prevProjectName === null || prevProjectName === projectName;
}
