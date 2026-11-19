export function normalizeProject(project) {
  return {
    shelved: false,
    shelvedAt: null,
    waiting: false,
    waitingAt: null,
    // The project's other repositories, beside its own at `path`; a lone repository has none.
    repositories: [],
    ...project,
  };
}

export function normalizeProjects(projects = []) {
  return projects.map(normalizeProject);
}
