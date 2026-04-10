import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { spawn } from 'node-pty';
import { exec } from 'child_process';
import db from './db.js';
import { handleWsConnection } from './ws-handler.js';
import { readTree } from './file-tree.js';

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

// Open a file in the system default editor
app.post('/api/open', (req, res) => {
  const { filePath } = req.body;
  if (!filePath || !existsSync(filePath)) return res.status(400).json({ error: 'invalid path' });

  // macOS: 'open', Linux: 'xdg-open', Windows: 'start'
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${filePath}"`);
  res.json({ ok: true });
});

// Open specifically in VS Code
app.post('/api/open-vscode', (req, res) => {
  const { filePath } = req.body;
  if (!filePath || !existsSync(filePath)) return res.status(400).json({ error: 'invalid path' });
  exec(`code "${filePath}"`);
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
    });
  }
  res.json(result);
});

// -------------------------------------------------------------------
// REST API: Health check
// -------------------------------------------------------------------
const startedAt = Date.now();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor((Date.now() - startedAt) / 1000) });
});

// -------------------------------------------------------------------
// WebSocket: Terminal (PTY) sessions
// -------------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/terminal' });

// Active PTY sessions: Map<string, { pty, ws, cwd, startedAt, lastOutputAt, alive }>
const sessions = new Map();

// PTY spawn factory — wraps node-pty spawn for dependency injection in tests
function spawnPty({ cwd, cols, rows }) {
  const shell = process.env.SHELL || '/bin/zsh';
  return spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}

wss.on('connection', (ws, req) => {
  handleWsConnection(ws, req, sessions, spawnPty);
});

// -------------------------------------------------------------------
// Kill a terminal session explicitly
// -------------------------------------------------------------------
app.delete('/api/terminal/:sessionId', (req, res) => {
  const entry = sessions.get(req.params.sessionId);
  if (entry) {
    entry.pty.kill();
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
