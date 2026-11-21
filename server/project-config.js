export const LOCAL_HOST = 'local';

export function normalizeHostName(host) {
  const trimmed = typeof host === 'string' ? host.trim() : '';
  return trimmed === '' ? LOCAL_HOST : trimmed;
}

function normalizeRepositories(repositories) {
  if (!Array.isArray(repositories)) return [];
  return repositories.map(repo => ({ ...repo }));
}

export function normalizeWorkspaceMode(mode) {
  return mode === 'folder' ? 'folder' : 'repo';
}

export function normalizeRepoManifest(manifest) {
  if (!Array.isArray(manifest)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const gitUrl = typeof entry.gitUrl === 'string' && entry.gitUrl.trim() ? entry.gitUrl.trim() : null;
    result.push({ name, gitUrl, primary: Boolean(entry.primary) });
  }
  return result;
}

function normalizeLocation(entry) {
  const host = normalizeHostName(entry?.host);
  return {
    host,
    path: entry?.path ?? '',
    repositories: normalizeRepositories(entry?.repositories),
  };
}

/**
 * Normalize a stored project into the cross-host entity shape while preserving
 * backward-compatible top-level `path`, `host` (when non-local), and `repositories`
 * derived from the project's `defaultHost` location.
 */
export function normalizeProject(project) {
  const rawLocations = Array.isArray(project?.locations) && project.locations.length > 0
    ? project.locations.map(normalizeLocation)
    : [{
      host: normalizeHostName(project?.host),
      path: project?.path ?? '',
      repositories: normalizeRepositories(project?.repositories),
    }];

  // Deduplicate locations by host (case-insensitive), keeping first occurrence.
  const seen = new Set();
  const locations = [];
  for (const loc of rawLocations) {
    const key = loc.host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(loc);
  }

  const requestedDefault = project?.defaultHost
    ? normalizeHostName(project.defaultHost)
    : normalizeHostName(project?.host || locations[0]?.host);
  const primary = locations.find(loc => loc.host.toLowerCase() === requestedDefault.toLowerCase())
    ?? locations[0];
  const defaultHost = primary?.host ?? LOCAL_HOST;

  const workspaceMode = normalizeWorkspaceMode(project?.workspaceMode);
  const repoManifest = normalizeRepoManifest(project?.repoManifest);
  const primaryManifest = repoManifest.find(entry => entry.primary) ?? repoManifest[0] ?? null;
  const rawGitUrl = typeof project?.gitUrl === 'string' && project.gitUrl.trim() ? project.gitUrl.trim() : null;
  const gitUrl = rawGitUrl ?? primaryManifest?.gitUrl ?? null;

  const normalized = {
    shelved: false,
    shelvedAt: null,
    waiting: false,
    waitingAt: null,
    autoSync: project?.autoSync === undefined ? true : Boolean(project.autoSync),
    ...project,
    gitUrl,
    workspaceMode,
    repoManifest,
    defaultHost,
    locations,
    path: primary?.path ?? project?.path ?? '',
    repositories: normalizeRepositories(primary?.repositories ?? project?.repositories),
  };

  if (defaultHost === LOCAL_HOST) {
    delete normalized.host;
  } else {
    normalized.host = defaultHost;
  }

  return normalized;
}

export function normalizeProjects(projects = []) {
  return projects.map(normalizeProject);
}

/** Resolve a project's location for `hostName` (defaults to the project's `defaultHost`). */
export function getProjectLocation(project, hostName) {
  const normalized = normalizeProject(project);
  const target = hostName ? normalizeHostName(hostName) : normalized.defaultHost;
  return normalized.locations.find(loc => loc.host.toLowerCase() === target.toLowerCase()) ?? null;
}

/** All host names currently bound to the project. */
export function listProjectHosts(project) {
  return normalizeProject(project).locations.map(loc => loc.host);
}

/** Add or replace a host location on a project and return the updated project. */
export function upsertProjectLocation(project, location) {
  const normalized = normalizeProject(project);
  const next = normalizeLocation(location);
  const idx = normalized.locations.findIndex(loc => loc.host.toLowerCase() === next.host.toLowerCase());
  const locations = idx === -1
    ? [...normalized.locations, next]
    : normalized.locations.map((loc, i) => (i === idx ? next : loc));
  return normalizeProject({ ...normalized, locations });
}

/** Remove a host location from a project. Returns null if not found. */
export function removeProjectLocation(project, hostName) {
  const normalized = normalizeProject(project);
  const target = normalizeHostName(hostName).toLowerCase();
  const remaining = normalized.locations.filter(loc => loc.host.toLowerCase() !== target);
  if (remaining.length === normalized.locations.length) return null;
  const nextDefault = remaining.some(loc => loc.host.toLowerCase() === normalized.defaultHost.toLowerCase())
    ? normalized.defaultHost
    : (remaining[0]?.host ?? LOCAL_HOST);
  return normalizeProject({ ...normalized, locations: remaining, defaultHost: nextDefault });
}

/** Add or update a repository entry in the project's logical `repoManifest`. */
export function upsertManifestRepo(project, entry) {
  const normalized = normalizeProject(project);
  const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
  if (!name) return normalized;
  const gitUrl = typeof entry?.gitUrl === 'string' && entry.gitUrl.trim() ? entry.gitUrl.trim() : null;
  const key = name.toLowerCase();
  const idx = normalized.repoManifest.findIndex(r => r.name.toLowerCase() === key);
  const existing = idx >= 0 ? normalized.repoManifest[idx] : null;
  const nextEntry = {
    name,
    gitUrl: entry.gitUrl !== undefined ? gitUrl : (existing?.gitUrl ?? null),
    primary: entry.primary !== undefined ? Boolean(entry.primary) : Boolean(existing?.primary),
  };
  let manifest = idx === -1
    ? [...normalized.repoManifest, nextEntry]
    : normalized.repoManifest.map((r, i) => (i === idx ? nextEntry : r));
  if (nextEntry.primary) {
    manifest = manifest.map(r => (r.name.toLowerCase() === key ? r : { ...r, primary: false }));
  }
  const updated = { ...normalized, repoManifest: manifest };
  if (nextEntry.primary && nextEntry.gitUrl) updated.gitUrl = nextEntry.gitUrl;
  return normalizeProject(updated);
}

/** Remove a repository entry from the project's logical `repoManifest`. */
export function removeManifestRepo(project, repoName) {
  const normalized = normalizeProject(project);
  const key = typeof repoName === 'string' ? repoName.trim().toLowerCase() : '';
  if (!key) return normalized;
  const manifest = normalized.repoManifest.filter(r => r.name.toLowerCase() !== key);
  return normalizeProject({ ...normalized, repoManifest: manifest });
}
