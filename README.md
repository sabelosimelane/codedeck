<p align="center">
  <img src="client/public/favicon.svg" alt="CodeDeck" width="200" />
</p>

# CodeDeck

A browser-based terminal workspace for developers who juggle multiple projects. Split panes, project switching, file browsing — no IDE overhead. Especially useful for CLI-based agentic coding workflows where each project needs 3-4 terminals running simultaneously.

![CodeDeck — multi-project terminal workspace](docs/images/hero.png)

## Features

- **Multi-project workspace** — organize terminals by project, switch between them instantly
- **Unlimited split panes** — side-by-side terminals with draggable dividers per tab
- **Live sidebar cockpit** — per-project status (active/idle/dead), terminal count, elapsed time
- **Waiting tabs** — park a tab you have handed to an agent: it shrinks, dims and groups left, then clears itself the moment the work lands
- **Per-project file browsing** — browse any project's files and open them in your editor
- **Truthful terminal scrollback** — VS Code-style scrolling, snapshot-first reconnects, and visible warnings when preserved history cannot be guaranteed
- **Terminal resilience** — debug inspector, transport replay catch-up, visibility-aware recovery, heartbeat monitoring
- **Durable sessions** — tmux-backed sessions survive browser detaches and server restarts
- **Descriptive session titles** — optional background naming through Conduit, with manual rename and retry
- **Toast notifications** — success/error feedback on every action, no silent failures

## Setup

Prerequisites: Node.js 22+, npm 10+, and `tmux` (required for terminal sessions).

```bash
# Install dependencies
npm install

# Start both servers (backend :43001, frontend :43000)
./server.sh start

# Manage the service
./server.sh stop     # Stop gracefully
./server.sh restart  # Restart
./server.sh status   # Check status
./server.sh logs     # Show recent logs
```

Open `http://localhost:43000` in your browser.

## Usage

1. Click **+** in the sidebar to add a project (give it a name and the absolute path).
2. Click a project to open a terminal scoped to that directory.
3. Use **Split right** (columns icon) to add side-by-side terminal panes — drag dividers to resize, double-click to reset.
4. Use **+** in the tab bar to open new terminal tabs. Each tab has its own set of panes.
5. The sidebar shows live status per project: terminal count, activity indicator (green = active, gray = idle, red = dead), and elapsed time.
6. Use the pane **eye icon** — or **Cmd/Ctrl+Shift+M** on the active pane — to mute/show status colors without changing the terminal's real running/idle/finished state.
7. Click the **hourglass** on a tab — beside its close button — or press **Cmd/Ctrl+Shift+U** on the active tab, to mark it waiting when you have handed its work to an agent. Waiting tabs shrink, dim and group to the left of the tab bar, their status indicators stop pulsing everywhere (tab, pane header, and sidebar), and the sidebar shows a count per project. The mark clears itself as soon as the work finishes or the session dies, so the finished styling and completion notification still reach you.
8. Click the **folder icon** on any project row to browse its files — clicking a file opens it in your configured editor.
9. Toast notifications confirm every action and surface errors.

## Session naming

Open **Settings → Session naming**, enter your Conduit base URL and API credential,
then **Test connection / refresh catalog**. Explicitly choose a provider, model, and
optional reasoning effort before saving. Availability and choices come from Conduit.
The credential stays on the backend in a private file and is never returned to the browser.

After a submitted task starts running, CodeDeck sends a bounded terminal excerpt to
Conduit for a short title. This works through the shared local/remote terminal activity
interface. Naming runs independently of terminal input, output, and navigation. Empty Enter presses do not arm naming. Startup
banners alone can return insufficient context and wait for another submission.

Use the pencil beside a pane's name to rename it. Manual titles take precedence over
pending generation. Failed naming retains the current label, shows the reason, and retries automatically every
10 seconds for up to one minute after the first failure. Each retry captures fresh terminal
context. After that window, **Retry naming** or a new task submission starts a fresh attempt.
Titles persist across reloads; a split tab uses its first pane's title. Hover a label to
see the original session ID. Existing sessions are eligible on their next submitted task;
there is no retrospective bulk naming.

CodeDeck holds naming excerpts only in memory (at most 12,000 characters each). Conduit
and its selected provider have their own retention policies. The `/execute` response must
report the selected provider and model; substitutions or malformed results fail naming
instead of updating the title. Configure Conduit project defaults/routing accordingly.

## Terminal Resilience

CodeDeck includes built-in resilience features for debugging and recovering misbehaving panes:

- **Debug inspector** — click the bug icon on any pane to see health status, lifecycle timeline, and diagnostics
- **Recovery actions** — Reconnect, Resync (transport catch-up without teardown), and Redraw (force repaint)
- **Truthful reconnects** — every attach/reconnect clears stale browser history and reseeds from a fresh tmux snapshot of the recent 10,000-line window
- **Visibility-aware recovery** — returning to a backgrounded tab automatically resizes, resyncs, and catches up missed live output
- **Replay buffer** — bounded per-session output buffer is transport-only catch-up, not the preserved-history authority
- **Heartbeat & stall detection** — detects stale views (throttled, paint lag) and surfaces the reason

### Terminal Runtime

CodeDeck requires `tmux` for all terminal sessions. If `tmux` is missing, the UI blocks terminal creation and prompts you to install it instead of silently downgrading durability.

```bash
# Supported terminal runtime contract
CODEDECK_TERMINAL_RUNTIME=tmux ./server.sh start
```

Legacy non-`tmux` runtime values are ignored; the backend still enforces tmux-required terminals.

### Prevent macOS Sleep

Set `CODEDECK_CAFFEINATE=1` to wrap the server under `caffeinate -i`, preventing idle sleep.

## Config

Projects and settings are stored in SQLite at `~/.codedeck.db`:

- `defaultPath` — starting directory for the project picker
- `editorCommand` — command for opening files (defaults to `code -r`)

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

See [docs/steering/](docs/steering/) for detailed architecture, tech stack, and project structure.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
