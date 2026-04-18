# Changelog

## [2026-04-18] - Filter focus-tracking escape sequences from terminal input

### Executive Summary
* Fixed a bug where xterm.js focus-in/focus-out escape sequences (`ESC[I` / `ESC[O`) were being forwarded to the PTY as user input when a terminal pane regained focus. This could produce unexpected shell output or confuse interactive programs. The existing inline regex that filtered Device Attribute and Cursor Position Report replies has been extracted into a standalone, tested utility and expanded to also catch focus-tracking replies.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** When a terminal pane regained focus, xterm.js emitted `\x1b[I` (focus-in) and `\x1b[O` (focus-out) control sequences via `onData`. The inline regex in Terminal.jsx only matched DA/CPR responses, so focus-tracking replies passed through and were sent to the PTY as if the user had typed them.
  * **Solution:** Extracted protocol reply detection into `isTerminalProtocolReply()` with an expanded regex covering DA, CPR, and focus-tracking sequences, then used it in Terminal.jsx's `onData` handler.
* **🛠️ Codebase:**
  * `client/src/utils/terminalProtocolReplies.js` — New utility exporting `isTerminalProtocolReply()` with a single regex matching DA primary/secondary responses, CPR replies, and focus-in/focus-out sequences.
  * `client/src/components/Terminal.jsx` — Replaced inline `TERMINAL_RESPONSE_RE` regex with imported `isTerminalProtocolReply`, updated comment to mention focus tracking.
* **🧪 Tests:**
  * `client/src/utils/__tests__/terminalProtocolReplies.test.js` — Unit tests covering known protocol replies (DA, CPR, focus-in, focus-out) and legitimate user input that must pass through.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Added integration test verifying focus-tracking replies are dropped and never forwarded to the PTY.

## [2026-04-17] - Upgrade markdown preview tables and Mermaid inspection

### Executive Summary
* Improved document previews so technical specs are much easier to read and inspect in-browser. Markdown tables now render as real responsive tables instead of dense pipe-delimited text, and Mermaid diagrams embedded inside Markdown can now be opened in a focused lightbox with zoom, pan, and modifier-wheel controls for dense architecture and sequence diagrams.

### Technical Details
* **✨ New Feature:**
  * `client/src/utils/markdownPreview.js` — Added Markdown table parsing with header/body detection, alignment support, and responsive `data-label` metadata so pipe tables render as structured HTML tables instead of plain paragraphs.
  * `client/src/components/PreviewPage.jsx` — Added Mermaid diagram lightbox support for both embedded Markdown diagrams and standalone Mermaid previews, including click-to-open inspection, toolbar zoom controls, drag-to-pan navigation, and Cmd/Ctrl+scroll zoom anchored to the pointer.
* **🛠️ Codebase:**
  * `client/src/styles/global.css` — Added polished Markdown table styling with sticky headers, zebra striping, mobile card layout, and zoom affordance cursor styling for Mermaid diagrams.
* **🧪 Tests:**
  * `client/src/utils/__tests__/markdownPreview.test.js` — Added regression coverage for Markdown table rendering, alignment handling, and inline formatting inside table cells.

## [2026-04-16] - Fail loudly when frontend/backend ports are taken

### Executive Summary
* Previously, `./server.sh start` only checked that the backend port (43001) was free before launching — if the frontend port (43000) was already held by a stale Vite process, the backend would come up but the frontend would silently pick a random port, and the user would end up with a broken workspace at the expected URL. Now both ports are checked upfront, both listeners must come up for the start to be considered successful, and Vite is configured with `strictPort` so it refuses to silently switch ports. Status output also now reports both frontend and backend separately.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `./server.sh start` only guarded the backend port, so a stale process on port 43000 would leave the frontend silently bound to a different port — the app at `http://localhost:43000` would be whatever was already there, not CodeDeck.
  * **Solution:** `server.sh` — Added a `FRONTEND_PORT` variable (default 43000), generalized `port_in_use`/`listener_pid` to take a port argument, and made `start_server` refuse to launch if either port is in use. The startup readiness loop now waits for both backend and frontend listeners before declaring success.
  * **Solution:** `client/vite.config.js` — Added `strictPort: true` so Vite fails fast if 43000 is taken instead of falling back to a random port.
* **🛠️ Codebase:**
  * `server.sh` — Start output and `status` now print frontend and backend URLs and PIDs separately. `status` also warns when either port is held by a foreign process while CodeDeck is not running.

## [2026-04-16] - Instant sidebar refresh on project switch and clearer server PID reporting

### Executive Summary
* Two small but visible polish items. Switching projects used to wait up to 2 seconds for the sidebar cockpit to reflect the new project's live sessions — now the refresh fires immediately on selection (from both the sidebar click and the ⌘⇧P project switcher). Separately, `./server.sh start` and `status` now clearly distinguish the launcher process from the backend listener process, so it's obvious which PID does what when debugging a stuck server.

### Technical Details
* **✨ New Feature:**
  * `client/src/App.jsx` — Extracted the session-status poll into a reusable `fetchSessionStatus` callback guarded by an in-flight ref. Selecting a project (sidebar or project switcher) now triggers an immediate refresh instead of waiting for the next 2s poll tick.
  * `client/src/components/TerminalArea.jsx` — Added an `onSessionStatusRefresh` prop; after the restore-time `/api/sessions` fetch, the fresh snapshot is pushed up to the app shell so the sidebar reflects it immediately.
* **🛠️ Codebase:**
  * `server.sh` — Stopped overwriting the PID file with the backend listener PID (the file now keeps the launcher PID it was created with). Start output and `status` now print both the launcher PID and the backend listener PID on separate, aligned lines.
* **🧪 Tests:**
  * `client/src/App.test.jsx` — Added a test asserting that `/api/sessions` is re-fetched immediately when a project is selected. Upgraded the Sidebar mock to render clickable project buttons so the selection path can be exercised.
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — Added a test asserting that `onSessionStatusRefresh` is called with the live sessions fetched during restore.

## [2026-04-16] - Preserve terminal layout on backend hiccups and keep tmux sessions alive

### Executive Summary
* Made durable terminal sessions feel truly durable. Previously, a transient backend blip during startup would wipe the user's saved tab/pane layout, and recoverable tmux sessions were being pruned after 30 minutes detached — so walking away from the workspace for an hour could lose terminals that tmux had every right to keep running. Now the saved layout is preserved whenever `/api/sessions` fails to respond, and recoverable tmux sessions are never pruned by the session garbage collector.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** When `/api/sessions` failed during `TerminalArea` restore (e.g., backend momentarily unreachable), the client cleared the project's saved layout from localStorage and started fresh — erasing the user's tabs and panes for a temporary network hiccup.
  * **Solution:** `client/src/components/TerminalArea.jsx` — On fetch failure, fall back to the saved layout in localStorage when one exists; only start fresh if there is no saved layout to restore from.
  * **Problem:** Recoverable tmux-backed sessions were pruned after 30 minutes of being detached, defeating the whole point of durable sessions — walk away for lunch, lose your terminals.
  * **Solution:** `server/session-gc.js` — Removed `DETACHED_RECOVERABLE_TTL_MS` entirely. Recoverable sessions now stay alive indefinitely while detached; only dead sessions and unrecoverable detached sessions are pruned.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — New test verifying that a saved layout in localStorage is preserved (not cleared) when `/api/sessions` rejects during restore.
  * `server/__tests__/session-gc.test.js` — New test verifying that recoverable tmux sessions are not pruned even after multiple days detached.

## [2026-04-16] - Prevent overlapping session polls and fix sidebar config 404

### Executive Summary
* Fixed two subtle reliability issues in the sidebar cockpit. The app was firing a new `/api/sessions` poll every 2 seconds even when the previous request had not yet returned, which could pile up in-flight requests under slow network conditions. The sidebar was also requesting a single config key from an endpoint that does not exist (`/api/config/terminalFinishCooldownSeconds`), causing a 404 on every load and silently swallowing the error. Both are now fixed and covered by tests.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** The session status polling loop in `App.jsx` started a new `/api/sessions` fetch every 2 seconds regardless of whether the previous request was still in flight, so slow responses could stack overlapping requests.
  * **Solution:** `client/src/App.jsx` — Added an in-flight guard (`polling` flag) around the session fetch so a new poll is skipped while the previous one is still pending.
  * **Problem:** Sidebar bootstrap called `/api/config/terminalFinishCooldownSeconds`, which the backend does not serve — it 404'd on every mount, and the failure was silently swallowed with an empty `catch(() => {})`.
  * **Solution:** `client/src/components/Sidebar.jsx` — Switched to `/api/config` (returns the full config object) and read `terminalFinishCooldownSeconds` from the response. Replaced the empty catch with a visible `console.warn` so load failures are no longer hidden.
* **🧪 Tests:**
  * `client/src/App.test.jsx` — New test asserting that `/api/sessions` is not re-requested while the previous poll is still in flight.
  * `client/src/components/__tests__/Sidebar.test.jsx` — New test asserting the sidebar loads the terminal finish cooldown from `/api/config` (not the 404-prone single-key endpoint).

## [2026-04-16] - Fix terminal project mix-ups and mouse scrolling

### Executive Summary
* Fixed two terminal usability issues that made the workspace feel unreliable: terminals from similarly named projects could appear under the wrong project, and mouse-wheel scrolling could feel jerky or get stuck in follow-mode while output was streaming. The update makes project-to-terminal matching exact, improves mouse takeover of terminal scrollback, and tunes terminal wheel sensitivity for a smoother browsing experience.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Terminal sessions were matched to projects with a loose `startsWith()` check, so hyphen-prefixed sibling projects with similar names could be mixed together in the UI.
  * **Solution:** `client/src/utils/terminalProjectMatch.js` — Added shared helpers for exact project session matching using the `project-name-<number>` pattern and cwd fallback.
  * **Solution:** `client/src/utils/terminalLayoutState.js` — Switched initial terminal hydration and session number parsing to the shared exact-match helpers so only the selected project's sessions restore into tabs.
  * **Solution:** `client/src/utils/terminalActivity.js` — Updated notification/project lookup logic to use exact session-to-project matching.
  * **Solution:** `client/src/components/Sidebar.jsx` — Replaced sidebar project session filtering with the shared matcher so cockpit status no longer pulls in sibling-project terminals.
  * **Problem:** Mouse-wheel takeover of terminal scrollback depended on wheel delta direction, which made follow-mode pause inconsistently on some devices/settings and could feel like one-line nudges.
  * **Solution:** `client/src/utils/terminalAutoScroll.js` — Changed auto-scroll pausing to trigger on any non-zero wheel gesture while pinned at the bottom and scrollback exists.
  * **Solution:** `client/src/components/Terminal.jsx` — Added explicit xterm wheel tuning (`scrollSensitivity`, `fastScrollSensitivity`, `smoothScrollDuration`) for more usable terminal scrolling.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalArea.test.js` — Added regression coverage for hyphen-prefixed sibling projects so the wrong sessions do not hydrate into the selected project.
  * `client/src/utils/__tests__/terminalActivity.test.js` — Added coverage proving project lookup prefers the exact matching sibling project.
  * `client/src/utils/__tests__/terminalAutoScroll.test.js` — Added regression coverage for pausing follow-mode on any wheel gesture while pinned at the bottom.
  * `client/src/components/__tests__/TerminalAutoScroll.test.jsx` — Added component-level tests for wheel-driven "Latest" button behavior and explicit xterm wheel sensitivity options.
* **🛠️ Codebase:**
  * `client/src/components/Terminal.jsx` — Kept terminal behavior aligned with the new auto-scroll and wheel-sensitivity expectations.

## [2026-04-14] - Fix shelved projects not visible beyond first five

### Executive Summary
* Expanding the shelved projects section only showed the first 5 projects with a "+ N more" label — but there was no way to browse the rest without searching by exact name. Projects beyond the top 5 were effectively hidden. Now expanding the shelf shows all shelved projects in a scrollable list, with search available to filter.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Shelved projects list was hard-capped to `slice(0, 5)` regardless of whether the section was expanded, making projects beyond the first 5 unreachable unless the user typed the exact name in search.
  * **Solution:** `client/src/components/Sidebar.jsx` — Show all shelved projects when expanded (no search filter), removed the misleading "+ N more" overflow message.
* **✨ New Feature:**
  * `client/src/components/Terminal.jsx` — Terminal web links now open in a new browser tab via explicit click handler instead of relying on xterm.js default behavior.

## [2026-04-14] - Keyboard shortcuts, project switcher, and terminal fixes

### Executive Summary
* Added a project quick-switcher (⌘⇧P), keyboard shortcuts overlay (⌘/), and active pane tracking with visual highlight. Remapped four keyboard shortcuts that conflicted with Chrome's reserved shortcuts (close window, DevTools console, bookmarks bar, bookmark all tabs) — the close-pane shortcut was closing the entire browser window. Fixed terminal garbage characters (DA response leak) appearing on project switch, and fixed pane focus not following keyboard selection.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Switching projects displayed garbage characters (`^[[?1;2c^[[>0;276;0c`) in the terminal — DA responses from xterm.js leaked to the PTY as stdin during resize.
  * **Solution:** `client/src/components/Terminal.jsx` — Added `TERMINAL_RESPONSE_RE` filter in `onData` handler to suppress DA1, DA2, and CPR responses before they reach the PTY.
  * **Problem:** Keyboard shortcut ⌘⌥1-9 (select pane) did not move cursor focus to the selected pane.
  * **Solution:** `client/src/components/Terminal.jsx` — Exposed `focus()` method via `useImperativeHandle` so `TerminalArea` can focus the xterm instance.
  * **Problem:** ⌘⇧W (close pane) closed the entire Chrome window; ⌘⇧J/⌘⇧D/⌘⇧B conflicted with Chrome DevTools, bookmarks bar, and bookmark-all-tabs.
  * **Solution:** Remapped: close pane → ⌘⇧X, new terminal → ⌘⇧T, split right → ⌘⇧E, toggle file tree → ⌘⇧F.
* **✨ New Feature:**
  * `client/src/components/ProjectSwitcher.jsx` — New fuzzy project quick-switcher modal (⌘⇧P) with arrow-key navigation, Enter to select, Escape to dismiss.
  * `client/src/components/ShortcutsOverlay.jsx` — New keyboard shortcuts reference overlay (⌘/) showing all shortcuts grouped by category with platform-aware key labels.
  * `client/src/components/TerminalArea.jsx` — Added `activePaneId` state with visual border highlight on the focused pane. Clicking a pane or using ⌘⌥1-9 updates active pane. Auto-selects adjacent pane on close.
* **🛠️ Codebase:**
  * `client/src/App.jsx` — Integrated ProjectSwitcher, ShortcutsOverlay, and new shortcut handlers (⌘⇧P, ⌘/, ⌘⇧F). Passes `onShowShortcuts` prop to Sidebar.
  * `client/src/components/Sidebar.jsx` — Added keyboard icon button in footer linking to shortcuts overlay. Updated file tree tooltip to ⌘⇧F.
  * `client/src/styles/global.css` — Added styles for project switcher modal and shortcuts overlay.

## [2026-04-13] - Resizable file tree panel and keyboard shortcut tooltips

### Executive Summary
* The file browser panel (FILES) can now be resized by dragging its right edge, making it much easier to browse projects with long filenames or deep directory trees. The width persists across sessions. Additionally, the sidebar header buttons now show keyboard shortcut hints on hover so users can discover shortcuts without checking documentation.

### Technical Details
* **✨ New Feature:**
  * `client/src/App.jsx` — Added `fileTreeWidth` state with localStorage persistence (default 260px). Renders a `PaneDivider` between the file tree and terminal area for drag-to-resize (min 180px, max 600px). Double-click resets to default width.
  * `client/src/components/FileTree.jsx` — Accepts `width` prop instead of hardcoded 240px. Set `minWidth: 180` and `flexShrink: 0` for correct flex layout during resize.
* **🛠️ Codebase:**
  * `client/src/components/Sidebar.jsx` — Added platform-aware modifier key detection (`⌘` on Mac, `Ctrl+` elsewhere). Updated sidebar toggle tooltip to show `⌘B` shortcut and file tree toggle to show `⌘⇧B` shortcut.

## [2026-04-13] - Add package-lock.json to gitignore

### Executive Summary
* Added `package-lock.json` to the project's `.gitignore` to prevent it from being tracked in version control. This keeps the repository clean since the project uses npm workspaces and the lock file is not needed for contributors.

### Technical Details
* **🛠️ Codebase:**
  * `.gitignore` — Added `package-lock.json` to the ignored files list under build artifacts section.

## [2026-04-13] - Terminal File Drop & Paste Support

### Executive Summary
* Added drag-and-drop and clipboard paste support for files on terminal panes. Dropping or pasting a file uploads it to a temp directory on the backend and injects the quoted file path into the focused terminal — enabling agentic CLI tools (like Claude Code) that accept image/file paths as input to receive screenshots and files seamlessly, without leaving the browser.

### Technical Details
* **✨ New Feature:**
  * `server/index.js` — Added `POST /api/upload` endpoint using multer for multipart file handling. Saves files to `/tmp/codedeck-drops/` with timestamp-prefixed sanitized filenames. Enforces 20MB size limit with proper error responses (400/413/500).
  * `client/src/components/Terminal.jsx` — Added drag-and-drop event handlers (dragover/dragenter/dragleave/drop) with a counter-based approach for nested element correctness. Added clipboard paste handler that detects file paste vs text paste. Drop zone overlay with dashed accent border appears during drag. Files are uploaded via fetch and quoted paths injected as WebSocket input messages.
* **🐛 Bug Fix:**
  * `client/src/components/Terminal.jsx` — Fixed replay input corruption: moved `resumeInFlightRef.current = false` after chunk writes so xterm.js terminal query responses during replay are correctly dropped. Added auto-scroll reset and focus after replay completes.
* **🛠️ Codebase:**
  * `client/vitest.config.js` — New client-side vitest config with jsdom environment and React plugin.
  * `package.json` — Added `@testing-library/react` and `jsdom` as dev dependencies.
  * `server/package.json` — Added `multer` dependency for multipart uploads.
* **🧪 Tests:**
  * `server/__tests__/upload.test.js` — 11 integration tests for upload endpoint: valid upload, size rejection, missing file, filename sanitization.
  * `client/src/components/__tests__/TerminalFileDrop.test.jsx` — 9 component tests for drag-drop and paste: file upload + path injection, error handling, drop zone overlay, directory rejection, text paste passthrough.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Tests for replay input dropping behavior.
  * `client/src/components/__tests__/hard-refresh-race.test.jsx` — Tests for hard refresh race condition handling.
* **📝 Documentation:**
  * `docs/specifications/terminal-file-drop-spec.md` — Full feature specification.
  * `docs/todos/terminal-file-drop.md` — Implementation tracking (all phases complete).

## [2026-04-13] - Enhanced Keyboard Shortcuts for Sidebar and File Browser

### Executive Summary
* Added a dedicated keyboard shortcut for toggling the file browser panel: **Cmd/Ctrl + Shift + B**. The existing **Cmd/Ctrl + B** shortcut now correctly works with both Cmd (Mac) and Ctrl (Windows/Linux) to toggle the project sidebar. This improves cross-platform keyboard navigation and provides quick access to both major UI panels without reaching for the mouse.

### Technical Details
* **🛠️ Codebase:**
  * `client/src/App.jsx` — Refactored keyboard event handling to support both Cmd and Ctrl modifiers consistently across platforms. Split shortcut logic: Cmd/Ctrl+B toggles sidebar compact mode, Cmd/Ctrl+Shift+B toggles file browser panel. Improved modifier key detection to prevent false triggers.

## [2026-04-13] - Browser Notifications and Terminal Resilience Enhancements

### Executive Summary
* This update introduces browser notifications for long-running terminal tasks, allowing you to get an alert (with sound) when a command finishes while you're in another tab. It also adds several under-the-hood improvements to terminal autoscroll behavior, automatic cleanup of abandoned terminal sessions, and a new configuration setting to customize notification timing.

### Technical Details
* **✨ New Feature:**
  * `client/public/notification-sw.js` — Service worker to handle background notification clicks and focus.
  * `client/src/utils/browserNotifications.js` — Utilities for managing notification permissions, showing notifications via Service Worker, and playing completion audio cues.
  * `client/src/components/SettingsPanel.jsx` — Added `terminalFinishCooldownSeconds` setting to control how long a task must run before it triggers a notification.
* **🛠️ Codebase:**
  * `client/src/utils/terminalActivity.js` — Implemented notification payload generation logic and project-aware session detection.
  * `client/src/components/Sidebar.jsx` — Integrated browser notification orchestration, permission request flows, and audio "warming" on user interaction.
  * `client/src/utils/terminalAutoScroll.js` — Added helpers to detect viewport position and pause autoscroll on scroll-up.
  * `server/session-gc.js` — Implemented GC logic for pruning dead or long-detached terminal sessions to prevent memory leaks.
  * `client/src/main.jsx` — Added Service Worker registration.
* **🧪 Tests:**
  * `client/src/utils/__tests__/browserNotifications.test.js` — Unit tests for notification permission and display logic.
  * `client/src/utils/__tests__/terminalActivity.test.js` — Updated tests for new completion notification logic.
  * `client/src/utils/__tests__/terminalAutoScroll.test.js` — Tests for autoscroll viewport detection.
  * `server/__tests__/session-gc.test.js` — Integration tests for terminal session garbage collection.

## [2026-04-11] - Right-Click Context Menu for Copy Path in File Trees

### Executive Summary
* Right-clicking any file or directory in the sidebar file tree or the file browser panel now shows a context menu with "Copy relative path" and "Copy path" options. This makes it easy to grab a file's path for use in terminals, scripts, or other tools without manually constructing it. Also includes terminal focus reliability improvements and WebSocket URL construction cleanup.

### Technical Details
* **✨ New Feature:**
  * `client/src/components/FileContextMenu.jsx` — new shared context menu component with "Copy relative path" (relative to project root) and "Copy path" (absolute) options, toast confirmation, dismiss on click-outside or Escape
  * `client/src/components/FileTree.jsx` — added right-click handler to file and directory rows, renders FileContextMenu with project root for relative path calculation
  * `client/src/components/FileBrowserPanel.jsx` — same context menu integration for the modal file browser panel
* **🛠️ Codebase:**
  * `client/src/components/Terminal.jsx` — extracted WebSocket URL construction to `terminalWsUrl.js` utility, moved focus handling outside try/catch in `syncTerminalViewport()` so focus isn't blocked by fit() errors, added direct focus fallback on mouseDown
  * `client/src/utils/terminalWsUrl.js` — new utility for building terminal WebSocket URLs with proper protocol detection (ws/wss)
  * `client/src/components/__tests__/terminalWsUrl.test.js` — unit tests for WebSocket URL builder
  * `.gitignore` — added `playwright-*` pattern to ignore playwright artifacts

## [2026-04-11] - Fix Sidebar Activity Dot Stuck Green Due to Tmux Status Noise

### Executive Summary
* The sidebar's green activity dot for each terminal stayed permanently lit even when no real work was happening. The root cause was tmux's default status bar refreshing every 15 seconds, which generated PTY output that reset the activity timer. This fix suppresses the tmux status bar in CodeDeck-managed sessions and introduces a separate `lastSubstantialOutputAt` timestamp that only updates on meaningful terminal output (content containing newlines), so the sidebar correctly shows idle status when terminals are inactive.

### Technical Details
* **Bug Fix:**
  * Problem: tmux's `status-interval` (default 15s) sends periodic ANSI escape sequences through the PTY, updating `lastOutputAt` continuously. The sidebar checks this timestamp against a 45-second activity window, so the terminal never appeared idle.
  * Solution (two-pronged):
    * `server/terminal-runtime.js` — added `set-option status off` when creating new tmux sessions, eliminating the periodic noise at the source.
    * `server/ws-handler.js` — added `isSubstantialOutput()` heuristic (strips ANSI, checks for newlines) and `lastSubstantialOutputAt` field that only updates on real command output.
    * `server/index.js` — exposed `lastSubstantialOutputAt` in the `GET /api/sessions` response.
    * `client/src/components/Sidebar.jsx` — switched `getTerminalStatus()` and `getProjectStatus()` to use `lastSubstantialOutputAt` for activity classification.
* **Codebase:**
  * `client/src/components/Terminal.jsx` — refactored viewport sync into a unified `syncTerminalViewport()` helper, added output buffering for hidden panes via `bufferOrWriteChunk()`/`flushPendingOutput()`, added input buffering during WebSocket reconnection, replaced reconnection banner with a centered overlay spinner.
  * `client/src/components/TerminalArea.jsx` — `disconnectPane()` now sends `DELETE /api/terminal/:sessionId` to kill the PTY, `reconnectPane()` extracted as a separate action.
  * `client/src/utils/terminalLayoutState.js` — reworked `filterLayoutByLiveSessions()` to preserve split-pane widths when all panes are still live, merge missing live sessions into new tabs, and preserve intentionally disconnected panes.
  * `client/src/utils/terminalVisibility.js` — added `shouldWriteTerminalViewport()` guard for suppressing writes to hidden panes.
  * `client/src/styles/global.css` — added `.reconnect-spinner` animation for the new reconnect overlay.
* **Tests:**
  * `server/__tests__/ws-handler.test.js` — 4 new tests covering `lastSubstantialOutputAt` initialization, ANSI-only output filtering, newline-bearing output tracking, and `lastOutputAt` preservation for diagnostics.
  * `client/src/components/__tests__/TerminalArea.test.js` — 4 new tests for layout reconciliation: live session merging, split-pane width preservation, width renormalization on pane loss, and disconnected pane preservation.
  * `client/src/components/__tests__/terminalVisibility.test.js` — 3 new tests for `shouldWriteTerminalViewport()`.

## [2026-04-11] - Durable Tmux Defaults and Terminal View Recovery

### Executive Summary
* Hardened CodeDeck’s terminal behavior for long-running work by making durable `tmux` sessions the default runtime and fixing two recovery regressions that could leave a pane looking blank or stale after reconnecting or switching tabs. This reduces the chance that active builds or noisy log streams appear to vanish when the terminal process is still alive.

### Technical Details
* **🐛 Bug Fix:**
  * Problem: reattaching to an existing session could inject a literal `^L` into the live process and fail to request replay after a pane remounted.
  * Solution:
    * `server/ws-handler.js` — stopped sending `Ctrl+L` into the PTY on reconnect and kept the session handshake focused on replay-aware recovery.
    * `client/src/components/Terminal.jsx` — now requests replay when the server reports an `existing` session, centralizes resume requests, and refreshes the xterm viewport when a tab becomes visible again.
    * `client/src/utils/terminalResume.js` — extracted replay-handshake decision logic for a focused regression point.
    * `client/src/utils/terminalVisibility.js` — extracted visibility and size guards so hidden tabs do not send invalid resize/fitting updates.
* **🛠️ Codebase:**
  * `server/index.js` — changed terminal runtime resolution to default to `tmux` instead of raw PTY when no override is configured.
  * `server/terminal-runtime.js` — updated the runtime factory default and inline documentation to reflect `tmux` as the preferred durable backend.
  * `docs/steering/product.md` — updated the product-level description to treat durable sessions as the normal runtime behavior.
  * `docs/todos/terminal-resilience-hardening.md` — corrected implementation notes so the recorded default runtime matches the current behavior.
  * `README.md` — documented `tmux` as the default runtime, explicit override commands, and the relationship between durable sessions and the bounded replay buffer.
* **🧪 Tests:**
  * `server/__tests__/ws-handler.test.js` — added coverage proving reconnect no longer writes `Ctrl+L` into the PTY.
  * `client/src/components/__tests__/terminalResume.test.js` — added regression coverage for replay requests on existing-session handshakes.
  * `client/src/components/__tests__/terminalVisibility.test.js` — added regression coverage for suppressing resize/reflow work while a terminal tab is hidden.

## [2026-04-11] - Terminal Resilience Hardening

### Executive Summary
* Implemented a full terminal resilience layer for CodeDeck across six phases. Terminals now have a pane-local debug inspector with health classification, explicit recovery actions (Reconnect, Resync, Redraw), visibility-aware refocus recovery, a heartbeat/sequence-tracked transport with bounded replay, and optional durable sessions via tmux. The backend grew from 23 to 90 unit tests. These changes address the core pain of misbehaving panes that silently stall when a browser tab is backgrounded or a WebSocket reconnects.

### Technical Details
* **✨ New Feature:**
  * `server/terminal-runtime.js` — New runtime abstraction factory; supports raw node-pty (default) and tmux-backed sessions. Both expose `spawn`, `kill`, and `isSessionRecoverable`. Uses `execFileSync` for shell-injection safety in tmux commands.
  * `client/src/components/TerminalInspector.jsx` — New modal debug inspector panel; polls `/api/debug/terminal-health` every 3s, renders health dot + label, state snapshot table, reverse-chronological event timeline, Copy Snapshot action, and Recovery Actions (Reconnect / Resync / Redraw).
* **🛠️ Codebase:**
  * `server/ws-handler.js` — Session entries extended with `wsAttached`, `lastAttachAt`, `lastDetachAt`, `lastClientAckAt`, `lastReplayAt`, `lastSeq`, `stallReason`, `events[]`, `replayBuffer`, `runtimeType`. Added `pushTimelineEvent`, `computeSessionHealth`, `computeStallReason` exports. Handles `heartbeat`, `resume`, `replay`, `visibility_change`, and `recovery_action` WebSocket messages. Monotonic `seq` assigned to each output chunk and stored in a bounded 1000-entry replay buffer. Tmux-aware PTY exit handler with capped re-attach logic.
  * `server/index.js` — `GET /api/sessions` extended with health summary fields. `GET /api/debug/terminal-health` added with per-session diagnostics and last 20 timeline events. Runtime resolved from `CODEDECK_TERMINAL_RUNTIME` env var → SQLite config → `'pty'` default. Health endpoint returns active `terminalRuntime` type.
  * `client/src/components/Terminal.jsx` — Added `lastSeenSeqRef`, `reconnectCountRef`, `resumeInFlightRef`, `heartbeatRef`, and browser-view diagnostic refs. `document.visibilitychange` listener triggers refit + resize sync + replay request on refocus. Heartbeat sends client diagnostics every 5s. `useImperativeHandle` extended with `reconnect()`, `resync()`, `redraw()` recovery methods.
  * `client/src/components/TerminalArea.jsx` — Added Bug icon button per pane to trigger the inspector; renders `TerminalInspector` with session lookup and `onAction` dispatch across tabs/panes.
  * `start.sh` — Optional `CODEDECK_CAFFEINATE=1` wraps startup under macOS `caffeinate -i` to prevent idle sleep.
* **🧪 Tests:**
  * `server/__tests__/ws-handler.test.js` — Expanded from 23 to 90 tests. Added coverage for diagnostic metadata, health classification, stall detection (3 tiers), visibility change handling, seq assignment, replay buffer bounds, resume/replay correctness (exact, overflow, empty, caught-up), recovery action handling, tmux-aware exit and reconnect, and runtimeType storage.
* **📝 Docs:**
  * `README.md` — Added Terminal Resilience section documenting inspector, recovery actions, replay buffer, tmux mode, and caffeinate.
  * `CLAUDE.md`, `docs/steering/product.md`, `docs/steering/structure.md` — Updated to reflect new components, backend patterns, message types, and test count.
  * `docs/specifications/terminal-resilience-hardening-spec.md` — Status updated from Draft to Implemented.
  * `docs/todos/terminal-resilience-hardening.md` — All 34 tasks marked complete across 6 phases with full session notes.
  * `client/dist/index.html` — Rebuilt client bundle.
