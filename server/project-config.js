export function normalizeProject(project) {
  return {
    shelved: false,
    shelvedAt: null,
    waiting: false,
    waitingAt: null,
    ...project,
  };
}

export function normalizeProjects(projects = []) {
  return projects.map(normalizeProject);
}
