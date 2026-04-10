# CodeDeck

A lightweight multi-project terminal workspace. No IDE overhead — just your projects, your terminals, and your default editor.

## Setup

```bash
# Install dependencies
cd server && npm install
cd ../client && npm install

# Start the backend (runs on :3001)
cd server && npm run dev

# In another terminal, start the frontend (runs on :3000)
cd client && npm run dev
```

Open `http://localhost:3000` in your browser.

## Usage

1. Click **+** in the sidebar to add a project (give it a name and the absolute path).
2. Click a project to open a terminal scoped to that directory.
3. Use the **+** in the terminal bar to open more terminals, or the split button for side-by-side.
4. Toggle the **file tree** icon in the sidebar header to browse files — clicking a file opens it in your default editor (VS Code, etc.).

## Config

Projects are stored in `~/.codedeck.json`. You can edit this file directly if you prefer.

```json
{
  "projects": [
    { "name": "message-triage", "path": "/Users/sabside/code/message-triage" },
    { "name": "gateway", "path": "/Users/sabside/code/gateway" },
    { "name": "luna", "path": "/Users/sabside/code/luna" }
  ]
}
```

## Architecture

```
Browser (React + xterm.js)
  ↕ WebSocket (terminal I/O)
  ↕ REST (projects, files, open)
Node.js server (Express + node-pty)
  ↕ PTY pool (one per terminal tab)
  ↕ fs (file tree reads)
  ↕ exec('open') → default editor
```

## Phase 2 (planned)

Workflow panel above the terminal area for orchestrating tasks across projects.
