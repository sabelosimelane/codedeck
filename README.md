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
- **Workflow pipelines** — configure agents and multi-step workflows, run them in isolated Git worktrees, and watch progress across projects
- **Descriptive session titles** — optional background naming through configurable local CLIs, with manual rename and retry
- **Session search** — find past agent-CLI conversations and resume one in its project
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

Agent status comes from the live prompt, status, and footer region of each CLI pane, with 20 seconds of silence vetoing a stale working marker. Input dialogs appear as **Needs input**; working sub-agent panes and background shells keep the session **Running**. An idle agent with a live background shell therefore shows as Running.
6. Use the pane **eye icon** — or **Cmd/Ctrl+Shift+M** on the active pane — to mute/show status colors without changing the terminal's real running/idle/finished state.
7. Click the **hourglass** on a tab — beside its close button — or press **Cmd/Ctrl+Shift+U** on the active tab, to mark it waiting when you have handed its work to an agent. Waiting tabs shrink, dim and group to the left of the tab bar, their status indicators stop pulsing everywhere (tab, pane header, and sidebar), and the sidebar shows a count per project. The mark clears itself as soon as the work finishes or the session dies, so the finished styling and completion notification still reach you. Phone pushes are held while the desktop UI has been used in the last two minutes.
8. Click the **folder icon** on any project row to browse its files — clicking a file opens it in your configured editor.
9. Toast notifications confirm every action and surface errors.

## Session search

Click the search icon in the terminal tab bar or press **Cmd/Ctrl+Shift+S**.
The modal lists past Claude Code, Codex, Cursor, and Antigravity conversations
for the current project, with an option to search all local projects. It reads
each CLI's own history. Untitled conversations show their first prompt. Choose
a conversation to resume it in a new terminal tab in its project.

Claude Code and Codex history is limited to interactive sessions. Cursor and
Antigravity cannot be filtered for headless runs, so delegated runs may appear.
Session search covers local projects only.

## Copying terminal text

On macOS, hold **Option/Alt** and drag over the text, then press **Cmd+C**.
The display pauses while you select; the agent keeps running and output is held
until you press **Esc**, type, or click once to resume. That first click only
resumes the display; subsequent clicks reach the terminal application normally.
The highlight stays after copying. Selection alone does not copy, and terminal
OSC 52 sequences cannot read or overwrite the clipboard. Clipboard failures
appear as a toast. Resizing or reconnecting ends selection with a notice.

## Workflow pipelines

Open **Settings → Workflows** to add agents, choose a
Setup agent, and save an ordered workflow. Each node has a prompt, an agent and
either a single pass or repetition until completion with a maximum pass count.
`{input}` in prompts is replaced once with the input supplied when starting a run.
Write a skill as `/name` at the start of a prompt (for example `/feature-dev {input}`).
Codex invokes skills with `$`, so when the CLI running the step is Codex, CodeDeck sends
that leading `/name` as `$name`; the rest of the prompt is sent as written.

An agent is a launch command plus a reset command. For Claude Code, Codex and Cursor,
pick the provider, type a model ID and choose an effort; CodeDeck builds the launch
command and shows it. A blank model or effort uses the CLI's default. Cursor model
names include the effort, so it has no separate effort choice. **Skip permission
prompts** adds the CLI's own bypass flag; without it a run pauses whenever the agent
asks for permission. A built command starts with `command`, so the shell runs the CLI
itself: an alias or shell function with the same name (for example `codex='codex --yolo'`)
does not apply to it. Choose **Custom command** to write the command yourself (aliases,
extra flags, other CLIs). A model ID is not checked until a run launches the agent.

Select a local Git repository project and click **Run workflow** beside Session
search. Preflight blocks ineligible projects and warns that uncommitted changes
will not enter the run. CodeDeck creates a branch and a worktree beside the home
repository, runs Setup first, then opens each step in a new terminal tab. Setup
must leave the worktree clean before the workflow's nodes can begin.

The dialog's **Worktree** list offers a new worktree (the default) and every
existing working tree of the repository: the project's own checkout and its
linked worktrees, each with its branch and whether it has uncommitted changes.
A run in an existing worktree uses it as it is: there is no Setup step, no setup
agent is needed, and CodeDeck never removes that worktree. When such a run ends
or is stopped, **Dismiss run** closes it and leaves the worktree in place. A
worktree with no branch checked out, a missing directory, a directory git cannot
read, or an open run already using it cannot be chosen.

When an agent needs something from you it pauses the run. CodeDeck asks every agent
to list its questions, each with the answer it recommends, before it pauses. The runs
bar shows that list under the run, with a box to type your answer and **Accept
recommendations** to tell the agent to go with its own suggestions. Your answer is
typed into the agent's terminal for you; answering in the terminal yourself works
too. If the agent did not list its questions, the runs bar says so and you read its
terminal. A dialog the agent shows while starting (trust or permission) is answered
in the terminal only. The sidebar count for a project turns to the warning colour
while one of its runs waits for you, and the phone gets an "Input requested" push.

The runs bar shows steps, passes, branch and available controls. **Stop** stops
automation; the agent may still be working. **Resume** warns about that terminal
and creates a fresh attempt. At the pass limit, **Continue** advances to the next
step. Runs survive browser disconnects. A backend restart marks active runs
**interrupted**, ready for an explicit Resume. The sidebar counts each project's
open runs, including runs that need attention or worktree cleanup.

Completion removes a clean worktree and keeps its branch. Modified or untracked
files block removal and appear in the runs bar; resolve them and choose **Clean up
worktree**. CodeDeck never forces removal. These pipelines use local projects;
remote projects are ineligible.

## Session naming

Open **Settings → Session naming** and select a provider, an exact case-sensitive
model ID, and optional reasoning effort. Claude Code and Codex are initial editable
profiles, not a fixed provider list. **Add provider** lets you capture another CLI;
**Remove provider** removes its profile. Changes take effect only after saving.
Existing Claude/Codex selections remain valid. Legacy Conduit settings are retained
but require a CLI selection; existing titles are preserved.

Each profile has an executable name or absolute path, a JSON array of arguments,
optional effort arguments, a prompt input method, and a response format. Use
`{model}` in the arguments; use `{prompt}` exactly once for argument input, or
choose standard input and omit `{prompt}`. Effort arguments use `{effort}` and are
omitted when effort is blank. Use `[]` when the CLI does not support effort.
Arguments are passed directly without a shell. Configure the CLI for non-interactive
use and disable tools; authenticate through the CLI, not secrets in the saved arguments.

For example, a **Cursor** profile can use executable `agent`, argument input, no
effort arguments, the **JSON result envelope** response format, and:

```json
["--print", "--trust", "--mode", "ask", "--output-format", "json", "--model", "{model}", "{prompt}"]
```

A **Kiro** profile can use executable `kiro-cli`, argument input,
`["--effort", "{effort}"]` for effort arguments, **Title JSON on stdout**, and:

```json
["chat", "--no-interactive", "--model", "{model}", "{prompt}"]
```

See [Kiro's CLI reference](https://kiro.dev/docs/cli/reference/cli-commands/)
for flags supported by your installed version. Kiro was not installed for live
verification of this example. The command must emit the requested title JSON without
banners; CLIs with another output shape need a wrapper that emits title JSON.

Response formats are explicit: **Title JSON on stdout** expects
`{"title":"Short title"}` (or `{"title":null}`); **JSON result envelope** expects
a successful `type: "result"`, `is_error: false` envelope whose `result` is that JSON
string; **Codex JSON event stream** reads a single completed agent message. Invalid
responses fail naming without substituting another provider or changing the title.

After a submitted task starts running, CodeDeck sends a bounded terminal excerpt to
the selected local CLI for a short title. This works through the shared local/remote terminal activity
interface. Naming runs independently of terminal input, output, and navigation. Empty Enter presses do not arm naming. Startup
banners alone can return insufficient context and wait for another submission.

Use the pencil beside a pane's name to rename it. Manual titles take precedence over
pending generation. Failed naming retains the current label, shows the reason, and retries automatically every
10 seconds for up to one minute after the first failure. Each retry captures fresh terminal
context. After that window, **Retry naming** or a new task submission starts a fresh attempt.
Titles persist across reloads; a split tab uses its first pane's title. Hover a label to
see the original session ID. Existing sessions are eligible on their next submitted task;
there is no retrospective bulk naming.

CodeDeck bounds naming excerpts to 12,000 characters and does not persist them.
The configured CLI and its provider have their own retention policies. Naming runs
from a temporary directory, with a 65-second process timeout and a 1 MiB output limit.
The CLI runs on the CodeDeck server, including when the terminal itself is remote.

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
