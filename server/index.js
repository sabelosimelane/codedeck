import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { spawn as spawnProcess } from 'child_process';
import db from './db.js';
import { handleWsConnection, computeSessionHealth, computeStallReason } from './ws-handler.js';
import { createTerminalRuntime } from './terminal-runtime.js';
import { readTree } from './file-tree.js';
import { readFilePreview } from './file-preview.js';
import { resolveEditorCommand } from './editor-command.js';

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
  return projects.map(p => ({ shelved: false, shelvedAt: null, ...p }));
}

function saveProjects(projects) {
  setConfig('projects', projects);
}

function openFileWithCommand(filePath, commandParts) {
  const [command, ...args] = commandParts;
  const child = spawnProcess(command, [...args, filePath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// -------------------------------------------------------------------
// REST API: Projects
// -------------------------------------------------------------------
app.get('/api/projects', (req, res) => {
  res.json(loadProjects());
});

app.post('/api/projects', (req, res) => {
  const { name, path: projectPath } = req.body;
  if (!name || !projectPath) return res.status(400).json({ error: 'name and path required' });
  if (!existsSync(projectPath)) return res.status(400).json({ error: 'path does not exist' });

  const projects = loadProjects();
  if (projects.find(p => p.path === projectPath)) {
    return res.status(409).json({ error: 'project already exists' });
  }
  projects.push({ name, path: projectPath });
  saveProjects(projects);
  res.status(201).json({ name, path: projectPath });
});

app.put('/api/projects/:name', (req, res) => {
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.name === req.params.name);
  if (idx === -1) return res.status(404).json({ error: 'project not found' });

  const existing = projects[idx];
  const { name: newName, path: newPath, shelved, shelvedAt } = req.body;

  // If name or path is provided, validate and apply them
  if (newName !== undefined || newPath !== undefined) {
    const resolvedName = newName ?? existing.name;
    const resolvedPath = newPath ?? existing.path;
    if (!resolvedName || !resolvedPath) return res.status(400).json({ error: 'name and path required' });
    if (!existsSync(resolvedPath)) return res.status(400).json({ error: 'path does not exist' });
    projects[idx] = { ...existing, name: resolvedName, path: resolvedPath };
  }

  // Apply shelf fields if provided
  if (shelved !== undefined) projects[idx] = { ...projects[idx], shelved };
  if (shelvedAt !== undefined) projects[idx] = { ...projects[idx], shelvedAt };

  saveProjects(projects);
  res.json(projects[idx]);
});

app.delete('/api/projects/:name', (req, res) => {
  const projects = loadProjects();
  saveProjects(projects.filter(p => p.name !== req.params.name));
  res.json({ ok: true });
});

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
// REST API: File tree
// -------------------------------------------------------------------
app.get('/api/files', async (req, res) => {
  const { root } = req.query;
  if (!root || !existsSync(root)) return res.status(400).json({ error: 'invalid root' });
  const tree = await readTree(root);
  res.json(tree);
});

app.get('/api/file-preview', async (req, res) => {
  const filePath = typeof req.query.filePath === 'string' ? req.query.filePath : '';
  if (!filePath || !existsSync(filePath)) return res.status(400).json({ error: 'invalid path' });

  try {
    const preview = await readFilePreview(filePath);
    res.json({
      ...preview,
      path: filePath,
      name: path.basename(filePath),
      extension: path.extname(filePath),
    });
  } catch (error) {
    const status = error.message === 'not a file' ? 400 : 500;
    res.status(status).json({ error: status === 400 ? 'invalid path' : error.message });
  }
});

// -------------------------------------------------------------------
// REST API: Browse filesystem (for directory picker)
// -------------------------------------------------------------------
app.get('/api/browse', async (req, res) => {
  const dir = req.query.path || process.env.HOME || '/';
  const filter = (req.query.filter || '').toLowerCase();
  if (!existsSync(dir)) return res.status(400).json({ error: 'path does not exist' });

  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'not a directory' });

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result = [];

    for (const entry of entries) {
      // Skip hidden files/dirs (starting with .)
      if (entry.name.startsWith('.')) continue;
      // Apply server-side filter if provided
      if (filter && !entry.name.toLowerCase().includes(filter)) continue;
      const fullPath = path.join(dir, entry.name);
      result.push({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        path: fullPath,
      });
    }

    // Sort: dirs first, then alphabetical
    result.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'dir' ? -1 : 1;
    });

    res.json({
      current: dir,
      parent: path.dirname(dir) !== dir ? path.dirname(dir) : null,
      entries: result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open a file in the configured editor. Defaults to VS Code.
app.post('/api/open', (req, res) => {
  const { filePath } = req.body;
  if (!filePath || !existsSync(filePath)) return res.status(400).json({ error: 'invalid path' });

  try {
    openFileWithCommand(filePath, resolveEditorCommand(getConfig('editorCommand')));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true });
});

// Open specifically in VS Code
app.post('/api/open-vscode', (req, res) => {
  const { filePath } = req.body;
  if (!filePath || !existsSync(filePath)) return res.status(400).json({ error: 'invalid path' });

  try {
    openFileWithCommand(filePath, resolveEditorCommand('code -r'));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true });
});

// -------------------------------------------------------------------
// REST API: Session status (for sidebar cockpit)
// -------------------------------------------------------------------
app.get('/api/sessions', (req, res) => {
  const result = [];
  for (const [sessionId, entry] of sessions) {
    result.push({
      sessionId,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      lastOutputAt: entry.lastOutputAt,
      lastOutputLine: entry.lastOutputLine || '',
      alive: entry.alive,
      runtimeType: entry.runtimeType ?? 'pty',
      wsAttached: entry.wsAttached ?? false,
      lastAttachAt: entry.lastAttachAt ?? null,
      lastClientAckAt: entry.lastClientAckAt ?? null,
      lastSeq: entry.lastSeq ?? 0,
      health: computeSessionHealth(entry),
      stallReason: computeStallReason(entry),
    });
  }
  res.json(result);
});

// -------------------------------------------------------------------
// REST API: Debug terminal health (rich diagnostics)
// -------------------------------------------------------------------
app.get('/api/debug/terminal-health', (req, res) => {
  const sessionList = [];
  for (const [sessionId, entry] of sessions) {
    sessionList.push({
      sessionId,
      health: computeSessionHealth(entry),
      ptyAlive: entry.alive,
      runtimeType: entry.runtimeType ?? 'pty',
      wsAttached: entry.wsAttached ?? false,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      lastOutputAt: entry.lastOutputAt,
      lastOutputLine: entry.lastOutputLine || '',
      lastAttachAt: entry.lastAttachAt ?? null,
      lastDetachAt: entry.lastDetachAt ?? null,
      lastClientAckAt: entry.lastClientAckAt ?? null,
      lastReplayAt: entry.lastReplayAt ?? null,
      lastSeq: entry.lastSeq ?? 0,
      stallReason: computeStallReason(entry),
      replayBufferSize: (entry.replayBuffer || []).length,
      // Client-reported diagnostics (Phase 2 + 3)
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
    sessions: sessionList,
  });
});

// -------------------------------------------------------------------
// REST API: Health check
// -------------------------------------------------------------------
const startedAt = Date.now();

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    terminalRuntime: terminalRuntime.type,
  });
});

// -------------------------------------------------------------------
// WebSocket: Terminal (PTY) sessions
// -------------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/terminal' });

// Active PTY sessions: Map<string, { pty, ws, cwd, startedAt, lastOutputAt, alive }>
const sessions = new Map();

// Resolve terminal runtime mode: env var > SQLite config > default 'tmux'
const runtimeMode = process.env.CODEDECK_TERMINAL_RUNTIME
  || getConfig('terminalRuntime')
  || 'tmux';
const terminalRuntime = createTerminalRuntime(runtimeMode);

wss.on('connection', (ws, req) => {
  handleWsConnection(ws, req, sessions, terminalRuntime);
});

// -------------------------------------------------------------------
// Kill a terminal session explicitly
// -------------------------------------------------------------------
app.delete('/api/terminal/:sessionId', (req, res) => {
  const entry = sessions.get(req.params.sessionId);
  if (entry) {
    terminalRuntime.kill(entry, req.params.sessionId);
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
