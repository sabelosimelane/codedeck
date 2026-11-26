import fs from 'node:fs/promises';
import path from 'node:path';
import { isUuid } from '../../shared/pipeline-definitions.mjs';

const MAX_BYTES = 512 * 1024;
const ALLOWED_DOC_PATH = /^docs\/(todos|specifications)\/[^/\\\x00-\x1f]+\.md$/;
const MAIN_LOCATION = /^main:([^/\\\x00-\x1f]+)$/;
const TASK_LOCATION = /^task:([^/\\\x00-\x1f]+)\/([^/\\\x00-\x1f]+)$/;

function validationError(field, message) {
  return Object.assign(new Error('One or more fields failed validation.'), {
    status: 400,
    errors: [{ field, message }],
  });
}

export function parseDocLocation(location) {
  if (typeof location !== 'string' || !location) {
    throw validationError('location', 'Use main:<repository> or task:<taskId>/<worktreeId>');
  }
  const mainMatch = MAIN_LOCATION.exec(location);
  if (mainMatch) {
    const repository = mainMatch[1];
    if (repository === '.' || repository === '..') {
      throw validationError('location', 'Use a valid repository name');
    }
    return { kind: 'main', repository };
  }
  const taskMatch = TASK_LOCATION.exec(location);
  if (taskMatch) {
    const [, taskId, worktreeId] = taskMatch;
    if (!isUuid(taskId) || !worktreeId || worktreeId === '.' || worktreeId === '..') {
      throw validationError('location', 'Use a valid task:<taskId>/<worktreeId> location');
    }
    return { kind: 'task', taskId, worktreeId };
  }
  throw validationError('location', 'Use main:<repository> or task:<taskId>/<worktreeId>');
}

export function validateDocPath(relPath) {
  if (typeof relPath !== 'string' || !ALLOWED_DOC_PATH.test(relPath) || relPath.includes('..')) {
    throw validationError('path', 'Use a markdown file directly inside docs/todos/ or docs/specifications/');
  }
  return relPath;
}

export async function resolveLocationRoot({ project, location, repositoryService, taskStore }) {
  const parsed = parseDocLocation(location);
  if (parsed.kind === 'main') {
    const repositories = await repositoryService.list(project);
    const repo = repositories.find(item => item.name === parsed.repository);
    if (!repo || repo.usable === false || typeof repo.path !== 'string' || !path.isAbsolute(repo.path)) {
      throw Object.assign(new Error('Location not found'), { status: 404 });
    }
    return repo.path;
  }
  const task = taskStore.get(parsed.taskId);
  if (!task || task.project !== project || !['active', 'pr_open'].includes(task.state)) {
    throw Object.assign(new Error('Location not found'), { status: 404 });
  }
  const worktree = Array.isArray(task.worktrees)
    ? task.worktrees.find(item => item.id === parsed.worktreeId)
    : null;
  if (!worktree || typeof worktree.worktreePath !== 'string' || !path.isAbsolute(worktree.worktreePath)) {
    throw Object.assign(new Error('Location not found'), { status: 404 });
  }
  return worktree.worktreePath;
}

export async function readScopedDoc({ project, location, relPath, repositoryService, taskStore }) {
  const validatedPath = validateDocPath(relPath);
  const root = await resolveLocationRoot({ project, location, repositoryService, taskStore });
  const candidate = path.resolve(root, validatedPath);
  const resolvedRoot = path.resolve(root);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw validationError('path', 'Path must stay inside the selected location');
  }

  let realRoot;
  let realTarget;
  try {
    realRoot = await fs.realpath(resolvedRoot);
    realTarget = await fs.realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw Object.assign(new Error('Document not found'), { status: 404 });
    }
    throw error;
  }

  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) {
    throw validationError('path', 'Path must stay inside the selected location');
  }

  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) {
    throw validationError('path', 'Path must point to a regular file');
  }
  if (stat.size > MAX_BYTES) {
    throw Object.assign(new Error('Document exceeds the 512 KiB size limit.'), { status: 413 });
  }

  const content = await fs.readFile(realTarget, 'utf8');
  return { location, path: validatedPath, size: stat.size, content };
}
