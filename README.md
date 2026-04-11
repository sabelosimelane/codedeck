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
6. Click the **folder icon** on any project row to browse its files — clicking a file opens it in VS Code by default, or in the command configured under Settings.
7. Toast notifications confirm every action and surface errors.

## Terminal Resilience

CodeDeck includes built-in terminal resilience features for debugging and recovering misbehaving panes:

- **Debug inspector** — click the bug icon on any terminal pane to see its health status, lifecycle event timeline, and diagnostic snapshot. Health is classified as `healthy`, `detached`, `reconnecting`, `stalled`, `replaying`, or `dead`.
- **Recovery actions** — the inspector offers Reconnect (drop and re-establish socket), Resync (request replay without teardown), and Redraw (force xterm repaint and resize sync).
- **Visibility-aware recovery** — when you return to a backgrounded tab, CodeDeck detects the refocus and automatically resizes, resyncs dimensions, and replays missed output.
- **Replay buffer** — the backend maintains a bounded per-session output buffer. On reconnect or refocus, missed output is replayed so you don't lose context. If the buffer overflows, you're notified, but durable `tmux` sessions reduce how often recovery depends on replay alone.
- **Heartbeat & stall detection** — the client sends periodic heartbeats with diagnostics. The backend detects when a pane view is stale (browser throttled, paint lagging, or ack lag) and surfaces the reason in the inspector.

### Terminal Runtime

CodeDeck now defaults to `tmux`-backed terminal sessions. That makes long-running builds, tails, and log-heavy panes much more resilient when you switch projects or the browser detaches. If `tmux` is not installed, the server falls back to raw PTY mode automatically.

You can still override the runtime explicitly:

```bash
# Force durable tmux-backed sessions
CODEDECK_TERMINAL_RUNTIME=tmux ./server.sh start

# Force legacy raw PTY sessions
CODEDECK_TERMINAL_RUNTIME=pty ./server.sh start
```

`tmux` mode preserves sessions across browser detaches and server restarts. Raw PTY mode is simpler, but relies much more heavily on the bounded replay buffer.

### Optional: Prevent macOS Sleep

Set `CODEDECK_CAFFEINATE=1` before starting to wrap the server under `caffeinate -i`, preventing idle sleep while CodeDeck is running.

## Config

Projects and settings are stored in SQLite at `~/.codedeck.db`.
Available settings currently include:

- `defaultPath` for the add-project browser starting directory
- `editorCommand` for file-click opening behavior (defaults to `code -r`)

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
