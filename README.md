# CodeDeck

A lightweight multi-project terminal workspace. No IDE overhead — just your projects, your terminals, and your default editor.

## Setup

```bash
# Install dependencies (from project root — workspace monorepo)
npm install

# Start both servers (backend :43001, frontend :43000)
./server.sh start

# Or manage individually
./server.sh stop     # Stop gracefully
./server.sh restart  # Restart
./server.sh status   # Check status
./server.sh logs     # Tail logs
```

Open `http://localhost:43000` in your browser.

## Usage

1. Click **+** in the sidebar to add a project (give it a name and the absolute path).
2. Click a project to open a terminal scoped to that directory.
3. Use **Split right** (columns icon) to add side-by-side terminal panes — drag dividers to resize, double-click to reset.
4. Use **+** in the tab bar to open new terminal tabs. Each tab has its own set of panes.
5. The sidebar shows live status per project: terminal count, activity indicator (green = active, gray = idle, red = dead), and elapsed time.
6. Click the **folder icon** on any project row to browse its files — clicking a file opens it in your default editor.
7. Toast notifications confirm every action and surface errors.

## Config

Projects are stored in SQLite at `~/.codedeck.db`.

## Architecture

```
Browser (React + xterm.js)
  ↕ WebSocket (terminal I/O)
  ↕ REST (projects, files, sessions, health)
Node.js server (Express + node-pty)
  ↕ PTY pool (one per terminal pane)
  ↕ SQLite (project config)
  ↕ fs (file tree reads)
  ↕ child_process (open files in editor)
```

## Future (planned)

Workflow panel above the terminal area for orchestrating tasks across projects.
