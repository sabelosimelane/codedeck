// A project's repositories: its own and the others it lists. Every record read from the
// backend is checked field by field before the app shows it.

const FALLBACK = 'Something went wrong. Please try again.';
const PAGE_SIZE = 100;
const CANDIDATE_PAGE_SIZE = 20;

const text = value => typeof value === 'string' && value.trim().length > 0;
const folderName = value => text(value) && value.length <= 100 && !value.includes('/') && value !== '.' && value !== '..';
const absolute = value => typeof value === 'string' && value.startsWith('/') && !value.includes('\0');

export function parseRepository(entry, index = 0) {
  const identity = folderName(entry?.name) ? entry.name : `index ${index}`;
  const guard = (condition, field) => { if (!condition) throw new Error(`Invalid repository ${identity} field ${field}`); };
  guard(entry !== null && typeof entry === 'object' && !Array.isArray(entry), 'repository');
  guard(folderName(entry.name), 'name');
  guard(absolute(entry.path), 'path');
  guard(typeof entry.own === 'boolean', 'own');
  guard(typeof entry.usable === 'boolean', 'usable');
  guard(entry.branch === null || text(entry.branch), 'branch');
  guard(entry.usable ? typeof entry.head === 'string' && /^[0-9a-f]{40}$/.test(entry.head) : entry.head === null, 'head');
  guard(entry.usable ? typeof entry.dirty === 'boolean' : entry.dirty === null, 'dirty');
  // A repository Git cannot use says why; one it can use has nothing to say.
  guard(entry.usable ? entry.reason === null
    : entry.reason !== null && typeof entry.reason === 'object' && text(entry.reason.code) && text(entry.reason.message), 'reason');
  return {
    name: entry.name, path: entry.path, own: entry.own, branch: entry.branch, head: entry.head, dirty: entry.dirty, usable: entry.usable,
    reason: entry.reason === null ? null : { code: entry.reason.code, message: entry.reason.message },
  };
}

export function parseCandidate(entry, index = 0) {
  const identity = folderName(entry?.name) ? entry.name : `index ${index}`;
  const guard = (condition, field) => { if (!condition) throw new Error(`Invalid repository candidate ${identity} field ${field}`); };
  guard(entry !== null && typeof entry === 'object' && !Array.isArray(entry), 'candidate');
  guard(folderName(entry.name), 'name');
  guard(absolute(entry.path), 'path');
  return { name: entry.name, path: entry.path };
}

function base(project) {
  if (!text(project)) throw new TypeError('project must be a nonempty string');
  return `/api/projects/${encodeURIComponent(project)}`;
}

async function request(url, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method, signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (failure) {
    if (failure?.name === 'AbortError') throw failure;
    throw new Error('Server unreachable');
  }
  if (response.status === 204) return undefined;
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(FALLBACK); }
  if (!response.ok) {
    const field = Array.isArray(payload?.errors) && text(payload.errors[0]?.message) ? payload.errors[0].message : null;
    throw Object.assign(new Error(field ?? (text(payload?.message) ? payload.message : FALLBACK)), { status: response.status });
  }
  return payload;
}

function readPage(body, kind) {
  if (!Array.isArray(body?.data) || typeof body?.page?.hasNextPage !== 'boolean' || !Number.isSafeInteger(body.page.totalElements) || body.page.totalElements < 0) {
    throw new Error(`Invalid ${kind} response`);
  }
  return body;
}

/** The project's own repository and every other one it lists, with how each stands in Git. */
export async function listProjectRepositories(project, { signal } = {}) {
  const root = base(project);
  const repositories = [];
  for (let page = 0; ; page += 1) {
    const body = readPage(await request(`${root}/repositories?size=${PAGE_SIZE}&page=${page}`, { signal }), 'repositories');
    body.data.forEach((entry, index) => repositories.push(parseRepository(entry, index)));
    if (!body.page.hasNextPage) return repositories;
  }
}

/** One page of the repositories found beside the project that it does not list yet. */
export async function getRepositoryCandidates(project, page, { signal } = {}) {
  const root = base(project);
  if (!Number.isSafeInteger(page) || page < 0) throw new TypeError('page must be a whole number from 0');
  const body = readPage(await request(`${root}/repository-candidates?size=${CANDIDATE_PAGE_SIZE}&page=${page}`, { signal }), 'repository candidates');
  return { candidates: body.data.map(parseCandidate), hasNextPage: body.page.hasNextPage, total: body.page.totalElements };
}

export async function addProjectRepository(project, path, { signal } = {}) {
  const root = base(project);
  if (!absolute(path)) throw new TypeError('path must be an absolute path');
  return parseRepository(await request(`${root}/repositories`, { method: 'POST', body: { path }, signal }));
}

export async function removeProjectRepository(project, repository, { signal } = {}) {
  const root = base(project);
  if (!text(repository)) throw new TypeError('repository must be a nonempty string');
  await request(`${root}/repositories/${encodeURIComponent(repository)}`, { method: 'DELETE', signal });
}
