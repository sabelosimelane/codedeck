import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { spawn } from 'node-pty';
import { exec } from 'child_process';

const app = express();
app.use(express.json());

// -------------------------------------------------------------------
// Config: define your projects here (or load from a JSON file later)
// -------------------------------------------------------------------
const CONFIG_PATH = path.join(process.env.HOME || '/root', '.codedeck.json');

async function loadProjects() {
  if (existsSync(CONFIG_PATH)) {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  }
  // Default example config
  return {
    projects: []
  };
}

async function saveProjects(config) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// -------------------------------------------------------------------
// REST API: Projects
// -------------------------------------------------------------------
app.get('/api/projects', async (req, res) => {
  const config = await loadProjects();
  res.json(config.projects);
});

app.post('/api/projects', async (req, res) => {
  const { name, path: projectPath } = req.body;
  if (!name || !projectPath) return res.status(400).json({ error: 'name and path required' });
  if (!existsSync(projectPath)) return res.status(400).json({ error: 'path does not exist' });

  const config = await loadProjects();
  if (config.projects.find(p => p.path === projectPath)) {
    return res.status(409).json({ error: 'project already exists' });
  }
  config.projects.push({ name, path: projectPath });
  await saveProjects(config);
  res.status(201).json({ name, path: projectPath });
});

app.put('/api/projects/:name', async (req, res) => {
  const { name: newName, path: newPath } = req.body;
  if (!newName || !newPath) return res.status(400).json({ error: 'name and path required' });
  if (!existsSync(newPath)) return res.status(400).json({ error: 'path does not exist' });

  const config = await loadProjects();
  const idx = config.projects.findIndex(p => p.name === req.params.name);
  if (idx === -1) return res.status(404).json({ error: 'project not found' });

  config.projects[idx] = { name: newName, path: newPath };
  await saveProjects(config);
  res.json({ name: newName, path: newPath });
});

app.delete('/api/projects/:name', async (req, res) => {
  const config = await loadProjects();
  config.projects = config.projects.filter(p => p.name !== req.params.name);
  await saveProjects(config);
  res.json({ ok: true });
});

// -------------------------------------------------------------------
// REST API: File tree
// -------------------------------------------------------------------
const IGNORED = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'target', '.idea', '__pycache__', '.DS_Store']);

async function readTree(dir, depth = 0, maxDepth = 3) {
  if (depth >= maxDepth) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        type: 'dir',
        path: fullPath,
        children: await readTree(fullPath, depth + 1, maxDepth),
      });
    } else {
      result.push({ name: entry.name, type: 'file', path: fullPath });
    }
  }

  return result.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'dir' ? -1 : 1;
  });
}

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
  if (!existsSync(dir)) return res.status(400).json({ error: 'path does not exist' });

  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'not a directory' });

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result = [];

    for (const entry of entries) {
      // Skip hidden files/dirs (starting with .)
      if (entry.name.startsWith('.')) continue;
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
// WebSocket: Terminal (PTY) sessions
// -------------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/terminal' });

// Active PTY sessions: Map<string, pty>
const sessions = new Map();

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const cwd = params.get('cwd') || process.env.HOME;
  const sessionId = params.get('sessionId') || `s-${Date.now()}`;
  const cols = parseInt(params.get('cols') || '120');
  const rows = parseInt(params.get('rows') || '30');

  let ptyProcess = sessions.get(sessionId);

  if (!ptyProcess) {
    const shell = process.env.SHELL || '/bin/zsh';
    ptyProcess = spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    sessions.set(sessionId, ptyProcess);

    ptyProcess.onExit(() => {
      sessions.delete(sessionId);
      ws.close();
    });
  }

  // PTY → Browser
  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  // Browser → PTY
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'input') {
        ptyProcess.write(parsed.data);
      } else if (parsed.type === 'resize') {
        ptyProcess.resize(parsed.cols, parsed.rows);
      }
    } catch {
      // Raw string input fallback
      ptyProcess.write(msg.toString());
    }
  });

  ws.on('close', () => {
    // Keep PTY alive for reconnection — only kill on explicit close
  });

  // Send session info
  ws.send(JSON.stringify({ type: 'session', sessionId }));
});

// -------------------------------------------------------------------
// Kill a terminal session explicitly
// -------------------------------------------------------------------
app.delete('/api/terminal/:sessionId', (req, res) => {
  const pty = sessions.get(req.params.sessionId);
  if (pty) {
    pty.kill();
    sessions.delete(req.params.sessionId);
  }
  res.json({ ok: true });
});

// -------------------------------------------------------------------
// Start
// -------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`CodeDeck server running on http://localhost:${PORT}`);
});
