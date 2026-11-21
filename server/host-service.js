/**
 * Host service (Spec §3, §6.1) — pure business logic for the remote-host CRUD
 * lifecycle. No Express, no DB: functions take the current hosts/projects
 * arrays and return either `{ error, status }` (expected failure) or
 * `{ data }`. The route layer orchestrates persistence around these.
 *
 * Hosts are stored as a JSON array under the `hosts` config key (same pattern
 * as `projects`). The `local` host is reserved: never stored, never mutable,
 * always listed first.
 */

import { SSH_TARGET_REGEX } from './command-runner.js';

export const RESERVED_LOCAL_HOST = 'local';
export const HOST_NAME_MAX_LENGTH = 64;

/** True when `name` refers to the reserved built-in local host (case-insensitive). */
export function isReservedHostName(name) {
  return typeof name === 'string' && name.trim().toLowerCase() === RESERVED_LOCAL_HOST;
}

/**
 * Validate a host create/update payload. Returns trimmed `{ data }` on success
 * or `{ error, status: 400 }` on the first violation.
 */
export function validateHostInput({ name, sshTarget, defaultRoot } = {}) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName) return { error: 'name required', status: 400 };
  if (trimmedName.length > HOST_NAME_MAX_LENGTH) {
    return { error: `name must be at most ${HOST_NAME_MAX_LENGTH} characters`, status: 400 };
  }
  if (isReservedHostName(trimmedName)) {
    return { error: '"local" is a reserved host name', status: 400 };
  }

  const trimmedTarget = typeof sshTarget === 'string' ? sshTarget.trim() : '';
  if (!trimmedTarget) return { error: 'sshTarget required', status: 400 };
  // The §3 regex allows `-` anywhere (for names like `dev-box`), so a leading
  // dash passes the regex — reject it explicitly so a target can never be read
  // as an ssh flag even before the runner's `--` guard.
  if (trimmedTarget.startsWith('-')) {
    return { error: 'sshTarget must not start with "-"', status: 400 };
  }
  if (!SSH_TARGET_REGEX.test(trimmedTarget)) {
    return {
      error: 'sshTarget must match ^[A-Za-z0-9._@-]+$ (no whitespace or shell metacharacters)',
      status: 400,
    };
  }

  let normalizedRoot;
  if (defaultRoot !== undefined && defaultRoot !== null && String(defaultRoot).trim() !== '') {
    if (typeof defaultRoot !== 'string') {
      return { error: 'defaultRoot must be an absolute path', status: 400 };
    }
    const trimmedRoot = defaultRoot.trim();
    if (!trimmedRoot.startsWith('/') || /[\x00-\x1f\x7f]/.test(trimmedRoot)) {
      return { error: 'defaultRoot must be an absolute path without control characters', status: 400 };
    }
    normalizedRoot = trimmedRoot.replace(/\/+$/, '') || '/';
  }

  const data = { name: trimmedName, sshTarget: trimmedTarget };
  if (normalizedRoot !== undefined) data.defaultRoot = normalizedRoot;
  return { data };
}

/** Find a stored host by name, case-insensitively. */
export function findHostByName(hosts = [], name) {
  const lower = String(name).toLowerCase();
  return hosts.find(h => h.name.toLowerCase() === lower);
}

/**
 * Create a host. Returns `{ data: { host, hosts } }` (the new host and the next
 * hosts array) or `{ error, status }`. Name uniqueness is case-insensitive;
 * sshTarget uniqueness is intentionally NOT enforced (Spec §3).
 */
export function addHost(input, existingHosts = []) {
  const validation = validateHostInput(input);
  if (validation.error) return validation;
  const { name, sshTarget, defaultRoot } = validation.data;
  if (findHostByName(existingHosts, name)) {
    return { error: 'host name already exists', status: 409 };
  }
  const host = defaultRoot !== undefined ? { name, sshTarget, defaultRoot } : { name, sshTarget };
  return { data: { host, hosts: [...existingHosts, host] } };
}

/**
 * Update a host's name, sshTarget, and/or defaultRoot. Returns
 * `{ data: { host, previousName, hosts } }` so the caller can rewrite
 * referencing projects when the name changed, or `{ error, status }`.
 */
export function updateHost(currentName, input = {}, existingHosts = []) {
  if (isReservedHostName(currentName)) {
    return { error: 'the local host is built-in and cannot be modified', status: 400 };
  }
  const idx = existingHosts.findIndex(
    h => h.name.toLowerCase() === String(currentName).toLowerCase()
  );
  if (idx === -1) return { error: 'host not found', status: 404 };

  const existing = existingHosts[idx];
  const nextName = input.name ?? existing.name;
  const nextTarget = input.sshTarget ?? existing.sshTarget;
  const nextRoot = input.defaultRoot !== undefined ? input.defaultRoot : existing.defaultRoot;

  const validation = validateHostInput({ name: nextName, sshTarget: nextTarget, defaultRoot: nextRoot });
  if (validation.error) return validation;
  const { name, sshTarget, defaultRoot } = validation.data;

  const collides = existingHosts.some(
    (h, i) => i !== idx && h.name.toLowerCase() === name.toLowerCase()
  );
  if (collides) return { error: 'host name already exists', status: 409 };

  const host = defaultRoot !== undefined ? { name, sshTarget, defaultRoot } : { name, sshTarget };
  const hosts = existingHosts.map((h, i) => (i === idx ? host : h));
  return { data: { host, previousName: existing.name, hosts } };
}

function projectReferencesHost(project, lowerHostName) {
  if (typeof project?.host === 'string' && project.host.toLowerCase() === lowerHostName) return true;
  if (typeof project?.defaultHost === 'string' && project.defaultHost.toLowerCase() === lowerHostName) return true;
  if (Array.isArray(project?.locations)) {
    return project.locations.some(
      loc => typeof loc?.host === 'string' && loc.host.toLowerCase() === lowerHostName
    );
  }
  return false;
}

/**
 * Delete a host. Blocked (409) while any project references it. Returns
 * `{ data: { hosts } }` or `{ error, status }`.
 */
export function deleteHost(name, existingHosts = [], projects = []) {
  if (isReservedHostName(name)) {
    return { error: 'the local host is built-in and cannot be deleted', status: 400 };
  }
  const idx = existingHosts.findIndex(
    h => h.name.toLowerCase() === String(name).toLowerCase()
  );
  if (idx === -1) return { error: 'host not found', status: 404 };

  const host = existingHosts[idx];
  const lowerHost = host.name.toLowerCase();
  const referenced = projects.some(p => projectReferencesHost(p, lowerHost));
  if (referenced) {
    return { error: 'host is referenced by one or more projects', status: 409 };
  }

  return { data: { hosts: existingHosts.filter((_, i) => i !== idx) } };
}

/**
 * Rewrite host references (`host`, `defaultHost`, and `locations[].host`) on
 * every project referencing `previousName` to `nextName` (case-insensitive).
 * Returns the original array unchanged when the name did not change.
 */
export function rewriteProjectHost(projects = [], previousName, nextName) {
  if (previousName === nextName) return projects;
  const lowerPrev = String(previousName).toLowerCase();
  return projects.map(p => {
    if (!projectReferencesHost(p, lowerPrev)) return p;
    const updated = { ...p };
    if (typeof updated.host === 'string' && updated.host.toLowerCase() === lowerPrev) {
      updated.host = nextName;
    }
    if (typeof updated.defaultHost === 'string' && updated.defaultHost.toLowerCase() === lowerPrev) {
      updated.defaultHost = nextName;
    }
    if (Array.isArray(updated.locations)) {
      updated.locations = updated.locations.map(loc =>
        typeof loc?.host === 'string' && loc.host.toLowerCase() === lowerPrev
          ? { ...loc, host: nextName }
          : loc
      );
    }
    return updated;
  });
}

/**
 * Build the API host list: the built-in local host first, then stored hosts.
 * `getReachability(name)` (optional; wired in Phase 3) supplies live
 * `{ reachability, lastError?, unreachableSince? }`; without it stored hosts
 * default to `unknown`.
 */
export function listHostsWithLocal(storedHosts = [], getReachability) {
  const local = {
    name: RESERVED_LOCAL_HOST,
    sshTarget: null,
    builtIn: true,
    reachability: 'reachable',
  };

  const stored = storedHosts.map(h => {
    const live = getReachability ? getReachability(h.name) : null;
    return {
      name: h.name,
      sshTarget: h.sshTarget,
      ...(h.defaultRoot ? { defaultRoot: h.defaultRoot } : {}),
      builtIn: false,
      reachability: live?.reachability ?? 'unknown',
      ...(live?.lastError != null ? { lastError: live.lastError } : {}),
      ...(live?.unreachableSince != null ? { unreachableSince: live.unreachableSince } : {}),
    };
  });

  return [local, ...stored];
}
