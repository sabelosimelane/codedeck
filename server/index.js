import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { spawn as spawnProcess, execFile, execFileSync } from 'child_process';
import * as fsSync from 'node:fs';
import os from 'node:os';
import multer from 'multer';
import db from './db.js';
import {
  handleWsConnection,
  reseedRemoteDetachedSessions,
  computeSessionHealth,
  computeStallReason,
  sanitizePreviewLine,
  attachBackgroundSession,
  backgroundSessionAvailable,
} from './ws-handler.js';
import { createTerminalWorkflow } from './terminal-workflow.js';
import { findAgentProfile } from './agent-profiles/index.js';
import { createAgentStore } from './pipelines/agent-store.js';
import { createWorkflowStore } from './pipelines/workflow-store.js';
import { createSettingsStore } from './pipelines/settings-store.js';
import { createRunStore } from './pipelines/run-store.js';
import { createDecisionStore } from './pipelines/decision-store.js';
import { createNoteStore } from './pipelines/note-store.js';
import { createReviewStore } from './pipelines/review-store.js';
import { createAnswerStore } from './pipelines/answer-store.js';
import { createTemplateStore, createStepPresetStore } from './pipelines/library-store.js';
import {
  create as createPipelineWorktree,
  remove as removePipelineWorktree,
  listDirtyPaths as listPipelineDirtyPaths,
  listWorktrees as listPipelineWorktrees,
} from './pipelines/run-worktree.js';
import { createRunEngine } from './pipelines/run-engine.js';
import { setObservedTerminalMuted } from './pipelines/terminal-muting-adapter.js';
import { createRunProgressReader, readRunProgress } from './pipelines/run-progress.js';
import { classify as classifyAgentReadiness } from './pipelines/agent-readiness.js';
import { createPipelinesRouter } from './routes/pipelines.js';
import {
  createHostTerminalRuntime,
  createTerminalRuntime,
  getTerminalRuntimeStatus,
  TERMINAL_EXECUTION_DEAD,
  TERMINAL_EXECUTION_UNKNOWN,
  TERMINAL_SNAPSHOT_WINDOW_LINES,
} from './terminal-runtime.js';
import { createCommandRunner, isTransportFailure, STATUS_POLL_TIMEOUT_MS } from './command-runner.js';
import { createHostReachabilityManager } from './host-reachability.js';
import { findHostByName } from './host-service.js';
import { createHostRuntimeResolver } from './host-runtime-resolver.js';
import { allocateTerminalSessionId } from './terminal-session-service.js';
import { listTerminalSessions } from './terminal-session-status-service.js';
import { createTerminalStatusCache } from './terminal-session-status-cache.js';
import { pruneTerminalSessions, pruneRemoteTerminalSessions } from './session-gc.js';
import { readTree } from './file-tree.js';
import { readFilePreview } from './file-preview.js';
import { resolveEditorCommand } from './editor-command.js';
import { normalizeProjects } from './project-config.js';
import { createHostsRouter } from './routes/hosts.js';
import { createProjectsRouter } from './routes/projects.js';
import { createProjectRepositoriesRouter, REPOSITORIES_PATH } from './routes/project-repositories.js';
import { createProjectRepositories } from './project-repositories.js';
import { createProjectDeletionService } from './project-deletion-service.js';
import { collectSystemResources } from './system-resources.js';
import { stripNodeWatchEnvironment } from './shell-env.js';
import { createNamingStore } from './session-naming-store.js';
import { createCliNamingClient } from './cli-naming-client.js';
import { createNamingService } from './session-naming-service.js';
import { createNamingRouter } from './routes/session-naming.js';
import { createTerminalWaitingStore } from './terminal-waiting-store.js';
import { createTerminalSessionWorktreeStore } from './terminal-session-worktree-store.js';
import { createWorktreeSessionStarter } from './terminal-session-worktree-start.js';
import { createTerminalWaitingRouter } from './routes/terminal-waiting.js';
import { createTerminalWorktreeService } from './terminal-worktree-service.js';
import { createTerminalWorktreesRouter } from './routes/terminal-worktrees.js';
import { createTaskStore } from './tasks/task-store.js';
import { createTaskService } from './tasks/task-service.js';
import { createTaskNaming } from './tasks/task-naming.js';
import { createTasksRouter } from './routes/tasks.js';
import { adoptWorktrees } from './tasks/task-adoption.js';
import { createTaskLanding } from './tasks/task-landing.js';
import { createTaskTerminalCloser } from './tasks/task-terminals.js';
import { createTerminalDeleteHandler, createTerminalSessionDeleter } from './routes/terminal-delete.js';
import { createSessionAttention } from './session-attention.js';
import { createSessionStateService } from './session-state-service.js';
import { createSessionAttentionRouter } from './routes/session-attention.js';
import { fileURLToPath } from 'node:url';
import { createPrivateAccess } from './mobile-access.js';
import { describeCompanionAccess, readLaunchSettings, resolveLaunchSettings } from './launch-settings.js';
import { createMobileStore, MobileError } from './mobile-store.js';
import { createMobileSessionStarter } from './mobile-session-start.js';
import { createAgentHistory } from './agent-history/index.js';
import { createAgentSessionsRouter } from './routes/agent-sessions.js';
import { submitDetachedCommand } from './agent-history/submit.js';
import { createMobileRouter } from './routes/mobile.js';
import { createMobileDiscovery, runNeedsOwner } from './mobile-integration.js';
import { createMobileNotifications, DESKTOP_PRESENCE_MS, initializeFcmProvider } from './mobile-notifications.js';
import { prepareMobileDatabase } from './mobile-migration.js';

// Node's watch supervisor injects this internal flag into the backend child.
// Keep it out of every terminal and tool process spawned by CodeDeck.
stripNodeWatchEnvironment(process.env);

const app = express();
// The owner keeps the companion's settings in a private file, so a restart
// that passes no environment still lets the phone in.
const launchSettingsFile = path.join(os.homedir(), '.codedeck', 'launch.env');
const launchSettings = resolveLaunchSettings(process.env, readLaunchSettings(launchSettingsFile), launchSettingsFile);
console.log(`[companion] ${describeCompanionAccess(launchSettings)}`);
const privateAccess = createPrivateAccess({
  owner: launchSettings.CODEDECK_TAILSCALE_OWNER,
  serveOrigin: launchSettings.CODEDECK_SERVE_ORIGIN,
  localOrigins: ['http://localhost:43000', 'http://127.0.0.1:43000', `http://localhost:${process.env.PORT || 43001}`, `http://127.0.0.1:${process.env.PORT || 43001}`],
});
app.use(privateAccess.middleware);
// Naming and terminal waiting own their parsers so malformed bodies also use their Problem Details handlers.
app.use((req, res, next) => req.path.startsWith('/api/session-naming/') || req.path.startsWith('/api/terminal-waiting') || req.path.startsWith('/api/terminal-worktrees') || req.path.startsWith('/api/pipelines') || req.path.startsWith('/api/agent-sessions') || req.path.startsWith('/api/mobile/v1') || REPOSITORIES_PATH.test(req.path) ? next() : express.json()(req, res, next));

// -------------------------------------------------------------------
// Config helpers (SQLite-backed)
// -------------------------------------------------------------------
function getConfig(key) {
  const row = db.prepare('SELECT value FROM configs WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function setConfig(key, value) {
  db.prepare('INSERT INTO configs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function loadProjects() {
  const projects = getConfig('projects') || [];
  return normalizeProjects(projects);
}

function saveProjects(projects) {
  setConfig('projects', projects);
}

function loadHosts() {
  return getConfig('hosts') || [];
}

function saveHosts(hosts) {
  setConfig('hosts', hosts);
}

// Commit the hosts and projects configs in a single SQLite transaction so a
// host rename can never leave projects referencing the old name (Spec §6.1).
const saveHostsAndProjects = db.transaction((hosts, projects) => {
  setConfig('hosts', hosts);
  setConfig('projects', projects);
});

// -------------------------------------------------------------------
// Host runtime resolution (remote host connectors)
// -------------------------------------------------------------------
const hostReachability = createHostReachabilityManager({
  probeHost: (host) => createCommandRunner(host).run('true', [], { timeout: STATUS_POLL_TIMEOUT_MS }),
  onRecovered: async (hostName, host) => {
    const liveHost = findHostByName(loadHosts(), hostName) ?? host;
    const hostRuntime = getHostRuntime(liveHost);
    await reseedRemoteDetachedSessions({ sessions, host: hostName, hostRuntime });
    terminalStatusCache.refreshSessionList();
  },
});

function createReachabilityAwareRunner(host) {
  return hostReachability.wrapRunner(host, createCommandRunner(host));
}

const {
  getHostRuntime,
  resolveHostRuntime,
  listAllSessionIds: listAllHostSessionIds,
} = createHostRuntimeResolver({
  loadProjects,
  loadHosts,
  getReachability: hostReachability.getReachability,
  createRuntime: (host) => createHostTerminalRuntime(createReachabilityAwareRunner(host), host.name),
});

function openFileWithCommand(filePath, commandParts) {
  const [command, ...args] = commandParts;
  const child = spawnProcess(command, [...args, filePath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// -------------------------------------------------------------------
// REST API: Hosts (remote host connectors)
// -------------------------------------------------------------------
app.use(createHostsRouter({
  loadHosts,
  saveHosts,
  loadProjects,
  saveProjects,
  saveHostsAndProjects,
  createRunner: createReachabilityAwareRunner,
  getReachability: hostReachability.getReachability,
}));

// -------------------------------------------------------------------
// REST API: Projects (host-aware, extracted to routes/projects.js)
// -------------------------------------------------------------------
let deleteProject;
app.use(createProjectsRouter({
  loadProjects,
  saveProjects,
  loadHosts,
  createRunner: createReachabilityAwareRunner,
  getReachability: hostReachability.getReachability,
  deleteProject: name => deleteProject(name),
}));
// A project's other repositories: a list in CodeDeck's configuration, nothing changed on disk.
app.use(createProjectRepositoriesRouter({ service: createProjectRepositories({ loadProjects, saveProjects, execFile }) }));

// -------------------------------------------------------------------
// REST API: Config (generic key-value)
// -------------------------------------------------------------------
app.get('/api/config/:key', (req, res) => {
  const value = getConfig(req.params.key);
  if (value === null) return res.status(404).json({ error: 'key not found' });
  res.json({ key: req.params.key, value });
});

app.put('/api/config/:key', (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  setConfig(req.params.key, value);
  res.json({ key: req.params.key, value });
});

app.delete('/api/config/:key', (req, res) => {
  db.prepare('DELETE FROM configs WHERE key = ?').run(req.params.key);
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM configs').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = JSON.parse(row.value);
  }
  res.json(result);
});

// -------------------------------------------------------------------
// REST API: Local system resources
// -------------------------------------------------------------------
app.get('/api/system/resources', async (req, res) => {
  try {
    res.json(await collectSystemResources());
  } catch (error) {
    console.error('Failed to get system resources:', error);
    res.status(500).json({ error: 'Failed to retrieve system resources' });
  }
});

// -------------------------------------------------------------------
// REST API: File tree
// -------------------------------------------------------------------
app.get('/api/files', async (req, res) => {
  const { root } = req.query;
  if (!root) return res.status(400).json({ error: 'invalid root' });
  
  const hostName = typeof req.query.host === 'string' ? req.query.host : 'local';
  const host = hostName !== 'local' ? findHostByName(loadHosts(), hostName) : null;
  if (hostName !== 'local' && !host) return res.status(404).json({ error: 'unknown host' });

  const runner = createReachabilityAwareRunner(host);

  try {
    const tree = await readTree(runner, root);
    res.json(tree);
  } catch (error) {
    if (isTransportFailure(error)) {
      return res.status(503).json({ error: 'host unreachable', detail: error.message, host: hostName });
    }
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/file-preview', async (req, res) => {
  const filePath = typeof req.query.filePath === 'string' ? req.query.filePath : '';
  if (!filePath) return res.status(400).json({ error: 'invalid path' });

  const hostName = typeof req.query.host === 'string' ? req.query.host : 'local';
  const host = hostName !== 'local' ? findHostByName(loadHosts(), hostName) : null;
  if (hostName !== 'local' && !host) return res.status(404).json({ error: 'unknown host' });

  const runner = createReachabilityAwareRunner(host);

  try {
    const preview = await readFilePreview(runner, filePath);
    res.json({
      ...preview,
      path: filePath,
      name: path.basename(filePath),
      extension: path.extname(filePath),
    });
  } catch (error) {
    if (isTransportFailure(error)) {
      return res.status(503).json({ error: 'host unreachable', detail: error.message, host: hostName });
    }
    const status = error.message === 'not a file' ? 400 : 500;
    res.status(status).json({ error: status === 400 ? 'invalid path' : error.message });
  }
});

// -------------------------------------------------------------------
// REST API: File upload (drag-and-drop / paste support)
// -------------------------------------------------------------------
const UPLOAD_DIR = '/tmp/codedeck-drops';
const UPLOAD_MAX_SIZE = 20 * 1024 * 1024; // 20MB

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        cb(null, UPLOAD_DIR);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, file, cb) => {
      const sanitized = sanitizeFilename(file.originalname);
      cb(null, `${Date.now()}-${sanitized}`);
    },
  }),
  limits: { fileSize: UPLOAD_MAX_SIZE },
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large (max 20MB)' });
      }
      return res.status(500).json({ error: 'Failed to save file', detail: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const hostName = typeof req.body?.host === 'string' ? req.body.host : 'local';
    if (hostName === 'local') {
      return res.status(201).json({ path: req.file.path });
    }

    const host = findHostByName(loadHosts(), hostName);
    if (!host) {
      return res.status(404).json({ error: 'unknown host' });
    }

    const runner = createReachabilityAwareRunner(host);
    const remoteDir = '/tmp/codedeck-drops';
    const remotePath = `${remoteDir}/${path.basename(req.file.path)}`;

    try {
      await runner.run('mkdir', ['-p', remoteDir]);
      await runner.copyTo(req.file.path, remotePath);
      res.status(201).json({ path: remotePath });
    } catch (error) {
      if (isTransportFailure(error)) {
        return res.status(502).json({ error: 'upload to host failed', detail: error.message, host: hostName });
      }
      res.status(502).json({ error: 'upload to host failed', detail: error.message });
    }
  });
});

// -------------------------------------------------------------------
// REST API: Browse filesystem (for directory picker)
// -------------------------------------------------------------------
app.get('/api/browse', async (req, res) => {
  const hostName = typeof req.query.host === 'string' ? req.query.host : 'local';
  const host = hostName !== 'local' ? findHostByName(loadHosts(), hostName) : null;
  if (hostName !== 'local' && !host) return res.status(404).json({ error: 'unknown host' });

  const runner = createReachabilityAwareRunner(host);
  const filter = (req.query.filter || '').toLowerCase();

  let dir = req.query.path;

  try {
    if (!dir) {
      if (runner.kind === 'local') {
        dir = process.env.HOME || '/';
      } else {
        const { stdout } = await runner.run('pwd');
        dir = stdout.trim() || '/';
      }
    }

    if (runner.kind === 'local') {
      if (!existsSync(dir)) return res.status(400).json({ error: 'path does not exist' });
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) return res.status(400).json({ error: 'not a directory' });

      const entries = await fs.readdir(dir, { withFileTypes: true });
      const result = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (filter && !entry.name.toLowerCase().includes(filter)) continue;
        const fullPath = path.join(dir, entry.name);
        result.push({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file',
          path: fullPath,
        });
      }

      result.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'dir' ? -1 : 1;
      });

      return res.json({
        current: dir,
        parent: path.dirname(dir) !== dir ? path.dirname(dir) : null,
        entries: result,
      });
    }

    // Remote handling
    try {
      await runner.run('test', ['-d', dir]);
    } catch {
      return res.status(400).json({ error: 'path does not exist or not a directory' });
    }

    const { stdout } = await runner.run('ls', ['-1pA', dir]);
    const lines = stdout.split('\n').filter(Boolean);
    const result = [];

    for (const line of lines) {
      const isDirectory = line.endsWith('/');
      const name = isDirectory ? line.slice(0, -1) : line;
      if (name.startsWith('.')) continue;
      if (filter && !name.toLowerCase().includes(filter)) continue;
      const fullPath = `${dir}${dir.endsWith('/') ? '' : '/'}${name}`;
      result.push({
        name,
        type: isDirectory ? 'dir' : 'file',
        path: fullPath,
      });
    }

    result.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'dir' ? -1 : 1;
    });

    const dirParts = dir.split('/').filter(Boolean);
    let parent = null;
    if (dir === '/') parent = null;
    else if (dirParts.length === 1) parent = '/';
    else parent = '/' + dirParts.slice(0, -1).join('/');

    res.json({
      current: dir,
      parent,
      entries: result,
    });
  } catch (err) {
    if (isTransportFailure(err)) {
      return res.status(503).json({ error: 'host unreachable', detail: err.message, host: hostName });
    }
    res.status(500).json({ error: err.message });
  }
});

// Open a file in the configured editor. Defaults to VS Code.
app.post('/api/open', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'invalid path' });

  const hostName = typeof req.body?.host === 'string' ? req.body.host : 'local';

  if (hostName === 'local') {
    if (!existsSync(filePath)) return res.status(400).json({ error: 'invalid path' });
    try {
      openFileWithCommand(filePath, resolveEditorCommand(getConfig('editorCommand')));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
    return res.json({ ok: true });
  }

  const host = findHostByName(loadHosts(), hostName);
  if (!host) {
    return res.status(404).json({ error: 'unknown host' });
  }

  try {
    const remoteCommand = `code --remote "ssh-remote+${host.sshTarget}"`;
    openFileWithCommand(filePath, resolveEditorCommand(remoteCommand));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true });
});

// Open specifically in VS Code
app.post('/api/open-vscode', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'invalid path' });

  const hostName = typeof req.body?.host === 'string' ? req.body.host : 'local';

  if (hostName === 'local') {
    if (!existsSync(filePath)) return res.status(400).json({ error: 'invalid path' });
    try {
      openFileWithCommand(filePath, resolveEditorCommand('code -r'));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
    return res.json({ ok: true });
  }

  const host = findHostByName(loadHosts(), hostName);
  if (!host) {
    return res.status(404).json({ error: 'unknown host' });
  }

  try {
    const remoteCommand = `code --remote "ssh-remote+${host.sshTarget}"`;
    openFileWithCommand(filePath, resolveEditorCommand(remoteCommand));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true });
});

// -------------------------------------------------------------------
// REST API: Terminal session allocation (backend authoritative)
// -------------------------------------------------------------------
app.post('/api/terminal', async (req, res) => {
  const projectName = typeof req.body?.projectName === 'string'
    ? req.body.projectName.trim()
    : '';

  if (!projectName) {
    return res.status(400).json({ error: 'projectName required' });
  }

  const outcome = await reserveTerminalSession(projectName);
  res.status(outcome.status).json(outcome.body);
});

/**
 * Reserve the next `${project}-N` id. Shared by the desktop (which then opens
 * a WebSocket) and the phone (which creates the session detached first), so
 * both draw from one allocator and can never hand out the same id.
 */
async function reserveTerminalSession(projectName) {
  const project = loadProjects().find(candidate => candidate.name === projectName);
  if (!project) {
    return { status: 404, body: { error: 'project not found' } };
  }

  const projectHost = project.host && project.host !== 'local'
    ? findHostByName(loadHosts(), project.host)
    : null;
  const projectReachability = projectHost
    ? hostReachability.getReachability(projectHost.name)
    : null;
  if (projectHost && projectReachability?.reachability === 'unreachable') {
    return { status: 503, body: {
      error: 'host unreachable',
      ...(projectReachability.lastError ? { detail: `${projectHost.name}: ${projectReachability.lastError}` } : {}),
      host: projectHost.name,
    } };
  }

  // The local tmux gate only applies to local projects — a remote project's
  // tmux requirement is checked per host at attach time (Spec §8.3).
  if (!projectHost) {
    const runtimeStatus = getTerminalRuntimeStatus(terminalRuntime);
    if (!runtimeStatus.terminalCreationAllowed) {
      return { status: 503, body: {
        error: runtimeStatus.terminalRuntimeBlockedMessage,
        ...runtimeStatus,
      } };
    }
  }

  try {
    // Hidden durable sessions live on the project's host — enumerate there,
    // strictly: an unreachable host fails fast instead of risking an id
    // collision with sessions we cannot see (Spec §8.1/§8.2).
    let recoverableSessionIds;
    try {
      recoverableSessionIds = projectHost
        ? await getHostRuntime(projectHost).listSessionIdsAsync({ strict: true })
        : terminalRuntime.listSessionIds?.() || [];
    } catch (err) {
      if (isTransportFailure(err)) {
        return { status: 503, body: {
          error: 'host unreachable',
          detail: `${projectHost.name}: ${err.message}`,
          host: projectHost.name,
        } };
      }
      throw err;
    }

    const allocation = allocateTerminalSessionId({
      projectName,
      activeSessionIds: Array.from(sessions.keys()),
      deletedSessionIds: Array.from(deletedSessionIds),
      recoverableSessionIds,
      reservedSessionIds: Array.from(reservedSessionIds),
    });

    if (allocation.error) {
      return { status: allocation.status, body: { error: allocation.error } };
    }

    reservedSessionIds.add(allocation.data.sessionId);
    terminalSessionWorktreeStore.clear(allocation.data.sessionId);
    return { status: 201, body: allocation.data };
  } catch (error) {
    return { status: 500, body: { error: 'Failed to allocate terminal', detail: error.message } };
  }
}

// -------------------------------------------------------------------
// REST API: Session status (for sidebar cockpit)
// -------------------------------------------------------------------
app.get('/api/sessions', (req, res) => {
  res.json(listTerminalSessions({
    sessions,
    runtime: terminalRuntime,
    projects: loadProjects(),
    deletedSessionIds,
    computeHealth: computeSessionHealth,
    computeStallReason,
    sanitizePreviewLine,
    statusCache: terminalStatusCache,
    resolveHostRuntime,
    getReachability: hostReachability.getReachability,
    worktreeStore: terminalSessionWorktreeStore,
  // Each row feeds the shared attention tracker and carries finished /
  // statusMuted / waiting, so no client keeps its own copy of those rules.
  }).map(row => sessionStateService.annotate(row)));
});

// -------------------------------------------------------------------
// REST API: Debug terminal health (rich diagnostics)
// -------------------------------------------------------------------
app.get('/api/debug/terminal-health', (req, res) => {
  const runtimeStatus = getTerminalRuntimeStatus(terminalRuntime);
  const sessionList = [];
  for (const [sessionId, entry] of sessions) {
    // Remote entries must not be resolved against the local tmux server —
    // their diagnostics report last-known values here (cache handles live).
    const isRemoteEntry = typeof entry.host === 'string' && entry.host !== 'local';
    if (!isRemoteEntry) {
      entry.cwd = terminalRuntime.getSessionCwd?.(entry, sessionId) || entry.cwd;
    }
    const executionState = entry.alive
      ? (isRemoteEntry ? undefined : terminalRuntime.getSessionExecutionState?.(sessionId)) ?? {
        executionStatus: TERMINAL_EXECUTION_UNKNOWN,
        foregroundCommand: null,
        executionReason: 'runtime_unavailable',
        executionConfidence: 'low',
      }
      : {
        executionStatus: TERMINAL_EXECUTION_DEAD,
        foregroundCommand: null,
        executionReason: 'pane_dead',
        executionConfidence: 'high',
      };

    sessionList.push({
      sessionId,
      health: computeSessionHealth(entry),
      ptyAlive: entry.alive,
      runtimeType: entry.runtimeType ?? 'pty',
      snapshotWindowLines: entry.snapshotWindowLines ?? (entry.runtimeType === 'tmux' ? TERMINAL_SNAPSHOT_WINDOW_LINES : null),
      historyGuaranteed: entry.historyGuaranteed ?? (entry.runtimeType === 'tmux'),
      historyWarningReason: entry.historyWarningReason ?? null,
      historyWarningMessage: entry.historyWarningMessage ?? null,
      ...runtimeStatus,
      wsAttached: entry.wsAttached ?? false,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      lastOutputAt: entry.lastOutputAt,
      lastOutputLine: sanitizePreviewLine(entry.lastOutputLine || ''),
      ...executionState,
      lastAttachAt: entry.lastAttachAt ?? null,
      lastDetachAt: entry.lastDetachAt ?? null,
      lastClientAckAt: entry.lastClientAckAt ?? null,
      lastReplayAt: entry.lastReplayAt ?? null,
      lastSeq: entry.lastSeq ?? 0,
      stallReason: computeStallReason(entry),
      replayBufferSize: (entry.replayBuffer || []).length,
      // Client-reported diagnostics (Phase 2 + 3)
      ...hostReachability.getReachability(entry.host ?? 'local'),
      documentVisibility: entry.documentVisibility,
      clientLastMessageAt: entry.clientLastMessageAt ?? null,
      clientLastPaintAt: entry.clientLastPaintAt ?? null,
      clientLastResizeAt: entry.clientLastResizeAt ?? null,
      clientLastSeenSeq: entry.clientLastSeenSeq ?? 0,
      clientReconnectCount: entry.clientReconnectCount ?? 0,
      events: (entry.events || []).slice(-20),
    });
  }
  res.json({
    generatedAt: new Date().toISOString(),
    status: runtimeStatus.terminalCreationAllowed ? 'ok' : 'degraded',
    runtime: runtimeStatus,
    sessions: sessionList,
  });
});

// -------------------------------------------------------------------
// REST API: Health check
// -------------------------------------------------------------------
const startedAt = Date.now();

app.get('/api/health', (req, res) => {
  const runtimeStatus = getTerminalRuntimeStatus(terminalRuntime);

  res.json({
    status: runtimeStatus.terminalCreationAllowed ? 'ok' : 'degraded',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    ...runtimeStatus,
  });
});

// -------------------------------------------------------------------
// WebSocket: Terminal (PTY) sessions
// -------------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (privateAccess.authorizeUpgrade(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// Active PTY sessions: Map<string, { pty, ws, cwd, startedAt, lastOutputAt, alive }>
const sessions = new Map();
const deletedSessionIds = new Set();
const reservedSessionIds = new Set();

// Resolve the requested runtime hint: env var > SQLite config > default 'tmux'.
// createTerminalRuntime() still enforces the tmux-required terminal contract.
const runtimeMode = process.env.CODEDECK_TERMINAL_RUNTIME
  || getConfig('terminalRuntime')
  || 'tmux';
const terminalRuntime = createTerminalRuntime(runtimeMode);
await prepareMobileDatabase(db);
const mobileStore = createMobileStore(db);
const namingStore = createNamingStore(db);
const namingCli = createCliNamingClient();
process.once('exit', () => namingCli.close());
const namingService = createNamingService({
  store: namingStore,
  generate: (settings, context) => namingCli.generate(settings, context),
  capture: async (id) => {
    if (deletedSessionIds.has(id)) throw new Error('Session deleted');
    const entry = sessions.get(id);
    const runtime = entry?.hostRuntime ?? resolveHostRuntime(id)?.hostRuntime ?? terminalRuntime;
    let context;
    const options = { onSnapshot: text => { context = text; } };
    if (runtime.getSessionStatusAsync) await runtime.getSessionStatusAsync(entry, id, options);
    else await runtime.getSessionExecutionStateAsync(id, options);
    if (typeof context !== 'string') throw new Error('Terminal snapshot unavailable');
    return context;
  },
});
app.use(createNamingRouter({
  store: namingStore, service: namingService,
  sessionExists: id => !deletedSessionIds.has(id) && (sessions.has(id) || reservedSessionIds.has(id) || namingStore.get(id) !== null),
}));
const terminalWaitingStore = createTerminalWaitingStore(db);
const terminalSessionWorktreeStore = createTerminalSessionWorktreeStore(db);
// Finished, muted and last-activity state shared by the desktop and the phone.
// Parked work that lands clears its own waiting mark here, with no browser open.
const sessionAttention = createSessionAttention({ db, now: Date.now, onLanded: sessionId => terminalWaitingStore.clear(sessionId) });
const sessionStateService = createSessionStateService({
  attention: sessionAttention, waitingStore: terminalWaitingStore, now: Date.now,
  sessionExists: id => !deletedSessionIds.has(id) && (sessions.has(id) || reservedSessionIds.has(id) || sessionAttention.knows(id)),
});
app.use(createSessionAttentionRouter({ service: sessionStateService }));
app.use(createTerminalWaitingRouter({
  store: terminalWaitingStore,
  sessionExists: id => !deletedSessionIds.has(id) && (sessions.has(id) || reservedSessionIds.has(id)),
}));
const terminalStatusCache = createTerminalStatusCache({
  runtime: terminalRuntime,
  listAllSessionIds: () => listAllHostSessionIds(terminalRuntime),
  getReachability: hostReachability.getReachability,
  onActivity: namingService.observe,
});
const pipelineRunEngineRef = { current: null };
const terminalDeleteDeps = {
  sessions, deletedSessionIds, reservedSessionIds, terminalRuntime,
  resolveHostRuntime, namingService, waitingStore: terminalWaitingStore,
  worktreeStore: terminalSessionWorktreeStore,
  sessionAttention, mobileStore, statusCache: terminalStatusCache,
  onSessionDeleted: (sessionId) => {
    pipelineRunEngineRef.current?.notifySessionClosed?.(sessionId);
  },
};
const deleteTerminalSession = createTerminalSessionDeleter(terminalDeleteDeps);
deleteProject = createProjectDeletionService({
  loadProjects, saveProjects, sessions, deleteTerminalSession,
  listSessionIds: project => {
    if (!project.host || project.host === 'local') return terminalRuntime.listSessionIdsAsync({ strict: true });
    const host = findHostByName(loadHosts(), project.host);
    if (!host) throw new Error(`Host ${project.host} for project ${project.name} is unavailable`);
    return getHostRuntime(host).listSessionIdsAsync({ strict: true });
  },
});
terminalStatusCache.refreshSessionList();
let pipelineRunStoreForMobile = null;
const mobileDiscovery = createMobileDiscovery({
  store: mobileStore, sessions, deletedSessionIds, statusCache: terminalStatusCache,
  loadProjects, resolveHostRuntime, getReachability: hostReachability.getReachability, namingStore,
  getSessionIncarnation: id => (sessions.get(id)?.hostRuntime ?? resolveHostRuntime(id)?.hostRuntime ?? terminalRuntime).getSessionIncarnationAsync(id),
  attention: sessionAttention, describeState: sessionStateService.describe,
  getSessionActivity: id => (sessions.get(id)?.hostRuntime ?? resolveHostRuntime(id)?.hostRuntime ?? terminalRuntime).getSessionActivityAsync(id),
  runNeedsOwner: id => runNeedsOwner(pipelineRunStoreForMobile?.list() ?? [], id),
});
// A missing provider is an explicit unconfigured state. A broken configured
// provider is reported; terminal operation remains independent of push delivery.
let notificationProvider = null;
if (launchSettings.CODEDECK_FIREBASE_CREDENTIALS) {
  try { notificationProvider = await initializeFcmProvider({ credentialPath: launchSettings.CODEDECK_FIREBASE_CREDENTIALS }); }
  catch { console.warn('[companion] notification_provider_initialization_failed'); }
}
let lastDesktopActivityAt = null;
const mobileNotifications = createMobileNotifications({
  db, instanceId: mobileStore.instanceId, ...mobileDiscovery,
  listDevices: mobileStore.listDevices, invalidateToken: mobileStore.invalidateToken,
  provider: notificationProvider,
  isDesktopActive: () => lastDesktopActivityAt !== null && Date.now() - lastDesktopActivityAt <= DESKTOP_PRESENCE_MS,
});
const mobileSessionStarter = createMobileSessionStarter({
  loadProjects, saveProjects, resolveHostRuntime, localRuntime: terminalRuntime, store: mobileStore, now: Date.now,
  reserveSessionId: async projectName => {
    const outcome = await reserveTerminalSession(projectName);
    if (outcome.status === 201) return outcome.body;
    if (outcome.status === 404) throw new MobileError('Project not found', 404);
    if (outcome.status === 503 && outcome.body.host) throw new MobileError(`Host ${outcome.body.host} is unreachable`, 503);
    if (outcome.status === 503) throw new MobileError(outcome.body.error, 503);
    throw new Error(`Session reservation failed with status ${outcome.status}`);
  },
  releaseReservation: sessionId => reservedSessionIds.delete(sessionId),
});
const startSessionWithWorktree = createWorktreeSessionStarter({
  start: (project, options) => mobileSessionStarter.start(project, options),
  loadProjects,
  store: terminalSessionWorktreeStore,
  now: () => new Date().toISOString(),
});
const worktreePathExists = async target => {
  try { await fs.access(target); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};
app.use(createTerminalWorktreesRouter({ service: createTerminalWorktreeService({
  findProject: name => loadProjects().find(project => project.name === name) ?? null,
  execFile,
  startSession: startSessionWithWorktree,
  pathExists: worktreePathExists,
}) }));
const taskStore = createTaskStore(db, { findProject: name => loadProjects().find(project => project.name === name) ?? null });
const taskService = createTaskService({
  taskStore,
  findProject: name => loadProjects().find(project => project.name === name) ?? null,
  execFile,
  startSession: startSessionWithWorktree,
  pathExists: worktreePathExists,
});
const RUN_STILL_WORKING = new Set(['pending', 'running', 'needs_input', 'limit_paused', 'awaiting_approval']);
const taskLanding = createTaskLanding({
  taskStore,
  findProject: name => loadProjects().find(project => project.name === name) ?? null,
  execFile,
  pathExists: worktreePathExists,
  // Read when asked: the run store is created below, after the routes are mounted.
  hasActiveRun: taskId => pipelineRunStore.list().some(run => run.taskId === taskId && RUN_STILL_WORKING.has(run.status)),
  // A finished task's runs let go of its worktree, which closes them (see run-engine cleanupWorktree).
  onTaskFinished: task => {
    for (const run of pipelineRunStore.list()) {
      if (run.taskId === task.id && run.worktreeState === 'external') pipelineRunStore.update(run.id, { worktreeState: 'released', worktreeDetail: null });
    }
  },
  // Its folder is gone, so a terminal left in it has nothing to work in.
  closeTerminals: createTaskTerminalCloser({
    listWorktreeRecords: () => terminalSessionWorktreeStore.all(),
    listRuns: () => pipelineRunStore.list(),
    isOpen: sessionId => sessions.has(sessionId) || terminalRuntime.isSessionRecoverable(sessionId),
    deleteSession: deleteTerminalSession,
  }),
});
app.use(createTasksRouter({ service: taskService, taskStore, landing: taskLanding }));

const PIPELINE_QUESTION_SCREEN_LINES = 400;
const pipelineAgentStore = createAgentStore(db);
const pipelineWorkflowStore = createWorkflowStore(db);
const pipelineSettingsStore = createSettingsStore(db);
const pipelineRunStore = createRunStore(db);
pipelineRunStoreForMobile = pipelineRunStore;
const pipelineDecisionStore = createDecisionStore(db);
const pipelineNoteStore = createNoteStore(db);
const pipelineReviewStore = createReviewStore(db);
const pipelineAnswerStore = createAnswerStore(db);
const pipelineProgressReader = createRunProgressReader();
// A task started with a run and no title is named from the run's work, by the CLI chosen for session naming.
const taskNaming = createTaskNaming({
  taskStore,
  readSettings: () => namingStore.settings(),
  generate: (settings, context) => namingCli.generate(settings, context),
  warn: message => console.warn(message),
});
const pipelineRunEngine = createRunEngine({
  runStore: pipelineRunStore,
  onNoteWritten: note => {
    taskNaming.noteWritten(note).catch(error => console.warn(`[task-naming] run=${note.runId} error=${error?.message || error}`));
  },
  setTerminalMuted: (sessionId, muted) => setObservedTerminalMuted(sessionAttention, sessionId, muted),
  readProgressCount: async run => {
    const progress = await readRunProgress({ run, workflowProgressFile: pipelineWorkflowStore.get(run.workflowId)?.progressFile ?? null, progressReader: pipelineProgressReader });
    return progress?.phaseCount > 0 && ['in_progress', 'all_done'].includes(progress.status)
      ? { tasksDone: progress.tasksDone, tasksTotal: progress.tasksTotal } : null;
  },
  decisionStore: pipelineDecisionStore,
  answerStore: pipelineAnswerStore,
  noteStore: pipelineNoteStore,
  reviewStore: pipelineReviewStore,
  createWorktree: async (run) => {
    const project = loadProjects().find(candidate => candidate.name === run.project);
    if (!project?.path) throw new Error(`Project ${run.project} not found for worktree create`);
    return createPipelineWorktree({
      homePath: run.homePath,
      worktreePath: run.worktreePath,
      branch: run.worktreeBranch,
      projectPath: project.path,
      execFile,
    });
  },
  removeWorktree: async (run) => removePipelineWorktree({
    homePath: run.homePath,
    worktreePath: run.worktreePath,
    execFile,
  }),
  listDirtyPaths: async ({ worktreePath }) => listPipelineDirtyPaths({ worktreePath, execFile }),
  pathExists: async (target) => {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  },
  startSession: async ({ project, cwd }) => {
    const started = await startSessionWithWorktree(project, { cwd });
    return started.id;
  },
  attachBackground: (sessionId, { cwd } = {}) => attachBackgroundSession(
    sessionId, sessions, terminalRuntime, deletedSessionIds,
    { cwd, onSessionEnded: endedId => { mobileStore.retireSession(endedId); terminalSessionWorktreeStore.clear(endedId); } },
  ),
  // Resume returns a step to its own terminal while that terminal can still be attached to.
  terminalAvailable: (sessionId) => backgroundSessionAvailable(
    sessionId, sessions, terminalRuntime, deletedSessionIds,
  ),
  createWorkflow: ({ write, notify }) => createTerminalWorkflow({ write, notify }),
  classifyReadiness: classifyAgentReadiness,
  // The end of the terminal's screen and scrollback, where an agent prints what it needs
  // before a NEEDS_INPUT signal. Pipeline runs use local projects only.
  readScreen: async (sessionId) => {
    const snapshot = terminalRuntime.captureAgentScreen(sessionId, PIPELINE_QUESTION_SCREEN_LINES);
    if (snapshot.historyGuaranteed !== true || typeof snapshot.data !== 'string') {
      throw new Error(`The terminal screen of ${sessionId} could not be read.`);
    }
    return snapshot.data.replace(/\r/g, '').split('\n');
  },
  readExecutionState: async (sessionId) => {
    const entry = sessions.get(sessionId);
    const entryExists = !deletedSessionIds.has(sessionId)
      && (Boolean(entry) || Boolean(resolveHostRuntime(sessionId)?.hostRuntime ?? terminalRuntime));
    const runtime = entry?.hostRuntime ?? resolveHostRuntime(sessionId)?.hostRuntime ?? terminalRuntime;
    let execution = {};
    let lines = [];
    try {
      // Capture via the runtime so tmux session names are sanitized (spaces/dots/Unicode).
      let snapshotText;
      const options = { onSnapshot: (text) => { snapshotText = text; } };
      if (typeof runtime.getSessionStatusAsync === 'function') {
        const status = await runtime.getSessionStatusAsync(entry, sessionId, options);
        execution = status?.executionState ?? {};
      } else if (typeof runtime.getSessionExecutionStateAsync === 'function') {
        execution = await runtime.getSessionExecutionStateAsync(sessionId, options);
      } else {
        execution = runtime.getSessionExecutionState?.(sessionId) ?? {};
      }
      if (typeof snapshotText === 'string') {
        lines = snapshotText.replace(/\r/g, '').split('\n');
      }
    } catch (err) {
      console.warn(`[pipelines] execution state failed session=${sessionId} error=${err.message}`);
    }
    const profile = findAgentProfile({
      foregroundCommand: execution.foregroundCommand,
      lines,
    });
    const isAlive = entry?.alive !== false && entryExists;
    return {
      executionReason: execution.executionReason,
      foregroundCommand: execution.foregroundCommand,
      lines,
      profile,
      isAlive,
      entryExists,
    };
  },
});
pipelineRunEngineRef.current = pipelineRunEngine;
// Worktrees in use from before tasks existed become tasks. A failure here is reported and
// leaves those worktrees as they were; it must not keep the terminals from starting.
try {
  const adopted = await adoptWorktrees({
    taskStore, runStore: pipelineRunStore, worktreeStore: terminalSessionWorktreeStore,
    findProject: name => loadProjects().find(project => project.name === name) ?? null,
    listWorktrees: ({ projectPath }) => listPipelineWorktrees({ projectPath, execFile }),
  });
  if (adopted.length) console.log(`[tasks] adopted ${adopted.length} existing worktree(s) as tasks`);
} catch (error) {
  console.error('[tasks] adopting existing worktrees failed:', error);
}
app.use(createPipelinesRouter({
  agentStore: pipelineAgentStore,
  workflowStore: pipelineWorkflowStore,
  settingsStore: pipelineSettingsStore,
  runStore: pipelineRunStore,
  decisionStore: pipelineDecisionStore,
  noteStore: pipelineNoteStore,
  reviewStore: pipelineReviewStore,
  answerStore: pipelineAnswerStore,
  templateStore: createTemplateStore(db),
  stepPresetStore: createStepPresetStore(db),
  taskStore,
  taskService,
  findProject: name => loadProjects().find(project => project.name === name) ?? null,
  engine: pipelineRunEngine,
  execFile,
}));

const agentHistory = createAgentHistory({ home: os.homedir(), fs: fsSync, Database: db.constructor });
app.use(createAgentSessionsRouter({
  loadProjects,
  history: agentHistory,
  startSession: projectName => startSessionWithWorktree(projectName),
  submitCommand: (sessionId, command) => submitDetachedCommand(sessionId, command, { execFile: execFileSync, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }),
}));
app.use(createMobileRouter({
  store: mobileStore, notifications: mobileNotifications,
  notificationsReady: () => notificationProvider !== null, ...mobileDiscovery,
  startSession: projectId => startSessionWithWorktree(projectId),
  setSessionState: (sessionId, patch) => sessionStateService.apply(sessionId, patch),
  terminalMetrics: () => ({
    attachments: [...sessions.values()].reduce((sum, entry) => sum + (entry.attachments?.size ?? 0), 0),
    controlConflicts: [...sessions.values()].reduce((sum, entry) => sum + (entry.controlConflicts ?? 0), 0),
  }),
}));
mobileNotifications.start();
process.once('exit', () => mobileNotifications.stop());
const sessionPruneTimer = setInterval(() => {
  const onPruned = (sessionId, entry) => {
    mobileStore.retireSession(sessionId);
    terminalSessionWorktreeStore.clear(sessionId);
    pipelineRunEngineRef.current?.notifySessionClosed?.(sessionId);
    console.log(`[terminal] pruned session=${sessionId} host=${entry.host ?? 'local'} alive=${entry.alive} wsAttached=${entry.wsAttached}`);
  };
  pruneTerminalSessions({ sessions, runtime: terminalRuntime, onPruned });
  pruneRemoteTerminalSessions({ sessions, onPruned, getReachability: hostReachability.getReachability }).catch((error) => {
    console.warn(`[terminal] remote prune failed error=${error.message}`);
  });
}, 60 * 1000);
sessionPruneTimer.unref?.();

const terminalWsOptions = {
  resolveHostRuntime,
  getReachability: hostReachability.getReachability,
  onInput: (sessionId, data) => { sessionAttention.touch(sessionId); namingService.input(sessionId, data); },
  onDesktopActivity: () => { lastDesktopActivityAt = Date.now(); },
  getSessionIncarnation: (id, { create } = {}) => create ? mobileStore.ensureIncarnation(id) : mobileStore.currentIncarnation(id),
  onSessionEnded: sessionId => { mobileStore.retireSession(sessionId); terminalSessionWorktreeStore.clear(sessionId); },
  onNewSession: sessionId => terminalSessionWorktreeStore.clear(sessionId),
  adoptSessionIncarnation: mobileStore.adoptIncarnation,
};
wss.on('connection', (ws, req) => {
  handleWsConnection(ws, req, sessions, terminalRuntime, deletedSessionIds, reservedSessionIds, terminalWsOptions);
});

// -------------------------------------------------------------------
// Kill a terminal session explicitly
// -------------------------------------------------------------------
app.delete('/api/terminal/:sessionId', createTerminalDeleteHandler(terminalDeleteDeps));

// -------------------------------------------------------------------
// Start
// -------------------------------------------------------------------
const PORT = process.env.PORT || 43001;
const clientDist = fileURLToPath(new URL('../client/dist/', import.meta.url));
app.use(express.static(clientDist));
app.get('/', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
server.listen(PORT, '127.0.0.1', () => {
  console.log(`CodeDeck server running on http://localhost:${PORT}`);
});
