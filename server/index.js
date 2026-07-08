import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { spawn as spawnProcess } from 'child_process';
import multer from 'multer';
import db from './db.js';
import {
  handleWsConnection,
  reseedRemoteDetachedSessions,
  computeSessionHealth,
  computeStallReason,
  sanitizePreviewLine,
  SESSION_DELETED_CLOSE_CODE,
  SESSION_DELETED_CLOSE_REASON,
} from './ws-handler.js';
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
import { collectSystemResources } from './system-resources.js';

const app = express();
app.use(express.json());

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
app.use(createProjectsRouter({
  loadProjects,
  saveProjects,
  loadHosts,
  createRunner: createReachabilityAwareRunner,
  getReachability: hostReachability.getReachability,
}));

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

  const project = loadProjects().find(candidate => candidate.name === projectName);
  if (!project) {
    return res.status(404).json({ error: 'project not found' });
  }

  const projectHost = project.host && project.host !== 'local'
    ? findHostByName(loadHosts(), project.host)
    : null;
  const projectReachability = projectHost
    ? hostReachability.getReachability(projectHost.name)
    : null;
  if (projectHost && projectReachability?.reachability === 'unreachable') {
    return res.status(503).json({
      error: 'host unreachable',
      ...(projectReachability.lastError ? { detail: `${projectHost.name}: ${projectReachability.lastError}` } : {}),
      host: projectHost.name,
    });
  }

  // The local tmux gate only applies to local projects — a remote project's
  // tmux requirement is checked per host at attach time (Spec §8.3).
  if (!projectHost) {
    const runtimeStatus = getTerminalRuntimeStatus(terminalRuntime);
    if (!runtimeStatus.terminalCreationAllowed) {
      return res.status(503).json({
        error: runtimeStatus.terminalRuntimeBlockedMessage,
        ...runtimeStatus,
      });
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
        return res.status(503).json({
          error: 'host unreachable',
          detail: `${projectHost.name}: ${err.message}`,
          host: projectHost.name,
        });
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
      return res.status(allocation.status).json({ error: allocation.error });
    }

    reservedSessionIds.add(allocation.data.sessionId);
    res.status(201).json(allocation.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to allocate terminal', detail: error.message });
  }
});

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
  }));
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
const wss = new WebSocketServer({ server, path: '/ws/terminal' });

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
const terminalStatusCache = createTerminalStatusCache({
  runtime: terminalRuntime,
  listAllSessionIds: () => listAllHostSessionIds(terminalRuntime),
  getReachability: hostReachability.getReachability,
});
terminalStatusCache.refreshSessionList();
const sessionPruneTimer = setInterval(() => {
  const onPruned = (sessionId, entry) => {
    console.log(`[terminal] pruned session=${sessionId} host=${entry.host ?? 'local'} alive=${entry.alive} wsAttached=${entry.wsAttached}`);
  };
  pruneTerminalSessions({ sessions, runtime: terminalRuntime, onPruned });
  pruneRemoteTerminalSessions({ sessions, onPruned, getReachability: hostReachability.getReachability }).catch((error) => {
    console.warn(`[terminal] remote prune failed error=${error.message}`);
  });
}, 60 * 1000);
sessionPruneTimer.unref?.();

wss.on('connection', (ws, req) => {
  handleWsConnection(ws, req, sessions, terminalRuntime, deletedSessionIds, reservedSessionIds, {
    resolveHostRuntime,
    getReachability: hostReachability.getReachability,
  });
});

// -------------------------------------------------------------------
// Kill a terminal session explicitly
// -------------------------------------------------------------------
app.delete('/api/terminal/:sessionId', async (req, res) => {
  const entry = sessions.get(req.params.sessionId);

  try {
    deletedSessionIds.add(req.params.sessionId);
    reservedSessionIds.delete(req.params.sessionId);

    if (entry?.ws && entry.ws.readyState === 1) {
      try {
        entry.ws.close(SESSION_DELETED_CLOSE_CODE, SESSION_DELETED_CLOSE_REASON);
      } catch (error) {
        console.warn(`[terminal] ws close failed session=${req.params.sessionId} error=${error.message}`);
      }
    }

    // Remote sessions are killed on their own host — including detached ones
    // with no in-memory entry (e.g. after a server restart), which must never
    // be killed against the local tmux server by name collision.
    const hostRuntime = entry?.hostRuntime ?? resolveHostRuntime(req.params.sessionId)?.hostRuntime;
    if (hostRuntime) {
      await hostRuntime.killAsync(entry, req.params.sessionId);
    } else {
      terminalRuntime.kill(entry, req.params.sessionId);
    }
  } catch (error) {
    console.warn(`[terminal] delete failed session=${req.params.sessionId} error=${error.message}`);
  } finally {
    terminalStatusCache.invalidateSession(req.params.sessionId);
    sessions.delete(req.params.sessionId);
  }

  res.json({ ok: true });
});

// -------------------------------------------------------------------
// Start
// -------------------------------------------------------------------
const PORT = process.env.PORT || 43001;
server.listen(PORT, () => {
  console.log(`CodeDeck server running on http://localhost:${PORT}`);
});
