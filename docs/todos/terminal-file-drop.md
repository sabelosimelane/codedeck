# Terminal File Drop & Paste

**Spec**: `docs/specifications/terminal-file-drop-spec.md`
**Status**: Complete
**Last completed**: Phase 4: Final Verification
**Created**: 2026-04-13

## Phase 1: Backend Upload Endpoint
> File upload API — saves files to `/tmp/codedeck-drops/`, returns the path. This is the foundation both frontend gestures depend on.
> **Inputs:** multipart/form-data with a single file
> **Outputs:** `{ path: "/tmp/codedeck-drops/..." }`
> **Closed when:** Upload endpoint works for all file types, enforces 20MB limit, handles errors with correct status codes

- [x] Install `multer` (or equivalent multipart middleware) as a dependency (Spec §4)
- [x] Create `POST /api/upload` route in `server/index.js` — accept single file, validate presence, enforce 20MB limit (Spec §4.1–4.3)
- [x] File storage logic — create `/tmp/codedeck-drops/` on demand, save with `<timestamp>-<sanitized-filename>` naming (Spec §4.4)
- [x] Filename sanitization — strip characters outside alphanumeric, hyphens, underscores, dots (Spec §4.4)
- [x] Error responses — 400 (no file), 413 (too large), 500 (write failure) with `{ error }` format (Spec §4.3)
- [x] Integration tests — upload valid file, oversized file rejection, missing file rejection, filename sanitization

## Phase 2: Frontend Drag-and-Drop with Drop Zone
> Intercept drag events on terminal panes, show drop zone overlay, upload file, inject quoted path into focused PTY. This is the primary gesture.
> **Inputs:** User drags file over terminal pane
> **Outputs:** Quoted file path injected into focused terminal's PTY
> **Closed when:** Drag-and-drop works end-to-end — drop zone appears, file uploads, path lands in terminal

- [x] Add `dragover`/`dragleave`/`drop` event handlers on terminal container in `Terminal.jsx` — prevent default browser behavior (Spec §5.1)
- [x] Drop zone overlay component — semi-transparent overlay with "Drop file to paste path" label, uses CSS custom properties (Spec §5.3)
- [x] On drop: extract file from `dataTransfer.files`, upload to `POST /api/upload` (Spec §5.1)
- [x] On upload success: inject quoted path as WebSocket `input` message to focused PTY — no trailing newline (Spec §5.4)
- [x] Multiple file support — upload each file, inject all paths space-separated (Spec §6.5)
- [x] Directory detection — show error toast if a directory is dropped (Spec §6.6)
- [x] Error handling — toast on upload failure or size rejection (Spec §5.5)

## Phase 3: Clipboard Paste Support
> Intercept paste events to detect file paste (as opposed to text paste), upload, and inject path. Same mechanics as drag-and-drop but different browser event.
> **Inputs:** User pastes file from clipboard (Cmd+C file in Finder, then Cmd+V in terminal)
> **Outputs:** Quoted file path injected into focused terminal's PTY
> **Closed when:** File paste works, text paste still works normally via xterm.js passthrough

- [x] Add `paste` event handler on terminal container — check `clipboardData.files` for file entries (Spec §5.2)
- [x] If files present: prevent default, upload to `/api/upload`, inject quoted path (Spec §5.2)
- [x] If no files: let event propagate — xterm.js handles normal text paste (Spec §6.4)
- [x] Multiple file support — same space-separated injection as drag-and-drop (Spec §6.5)
- [x] Error handling — same toast feedback as drag-and-drop (Spec §5.5)

## Phase 4: Final Verification
- [x] End-to-end test: drag image onto terminal → path appears in PTY
- [x] End-to-end test: paste copied file → path appears in PTY
- [x] End-to-end test: paste regular text → xterm.js handles normally (no regression)
- [x] End-to-end test: oversized file → error toast, no path injected
- [x] Verify drop zone overlay styling matches existing CodeDeck overlays
- [x] Run full test suite — regression check

---

### Session — 2026-04-13 (Phase 1)
**Completed**: Phase 1: Backend Upload Endpoint
**Key files**: `server/index.js` (upload route at ~L168-205), `server/__tests__/upload.test.js` (11 tests)
**Architecture**: multer with diskStorage for multipart handling. Upload route uses manual `upload.single('file')(req, res, cb)` pattern to catch multer errors and map to correct status codes. `sanitizeFilename()` defined inline in index.js.
**Next**: Phase 2: Frontend Drag-and-Drop — add drag/drop handlers to `Terminal.jsx`, drop zone overlay, upload + path injection via WebSocket input message. Key file to modify: `client/src/components/Terminal.jsx`.

### Session — 2026-04-13 (Phase 2)
**Completed**: Phase 2: Frontend Drag-and-Drop with Drop Zone
**Key files**: `client/src/components/Terminal.jsx` (drag handlers ~L47-127, drop zone overlay JSX ~L569-576, styles at bottom)
**Architecture**: Drag enter/leave uses a counter ref (`dragCounterRef`) to handle nested element events correctly. `handleFilesDrop()` uploads each file sequentially, collects quoted paths, sends as single WebSocket `input` message. Directory detection checks `size === 0 && type === ''`. Drop zone overlay uses same visual pattern as reconnect overlay (blur backdrop, accent border).
**Quirks**: Client-side vitest tests need jsdom environment setup (not yet configured) — existing client tests in `__tests__/` also can't run. Server tests (121) all pass.
**Next**: Phase 3: Clipboard Paste Support — add `paste` event handler to detect file paste vs text paste, same upload+inject flow. Then Phase 4 for manual E2E verification.

### Session — 2026-04-13 (Phase 3)
**Completed**: Phase 3: Clipboard Paste Support
**Key files**: `client/src/components/Terminal.jsx` (paste handler ~L129-137, onPaste wired at ~L562)
**Architecture**: `handlePaste` callback checks `clipboardData.files` — if files present, prevents default and delegates to existing `handleFilesDrop()`. If no files, event propagates naturally so xterm.js handles normal text paste. All upload/inject/error-handling logic reused from Phase 2.
**Next**: Phase 4: Final Verification — manual E2E testing of drag-drop, file paste, text paste passthrough, oversized file rejection, and full test suite regression check.

### Session — 2026-04-13 (Phase 4)
**Completed**: Phase 4: Final Verification
**Key files**: `client/src/components/__tests__/TerminalFileDrop.test.jsx` (9 tests), `client/vitest.config.js` (new), all 3 test files in `__tests__/` fixed
**Architecture**: Set up client-side vitest with jsdom + React plugin. All client component tests now use `vi.hoisted()` for mock state and class-based mocks (vitest 4.x doesn't support `vi.fn().mockImplementation()` as constructors in ESM mock factories). Test files renamed from `.js` to `.jsx` for JSX parsing.
**Bug fixes**: Fixed mock paths in all test files — `vi.mock` resolves relative to the test file, so utility mocks needed `../../utils/` not `../utils/`. Fixed WebSocket mock — class-based mock needed so `mocks.ws` points to the same object instance the component holds (primitive properties aren't shared by reference after `Object.assign`).
**Quirks**: `vi.fn().mockImplementation(fn)` inside `vi.mock()` factory is NOT constructible in vitest 4.x with ESM — must use class-based mocks instead. Mock path resolution matters: `vi.mock('../ToastContext')` from `__tests__/` resolves to `components/ToastContext` (correct), but `vi.mock('../utils/...')` resolves to `components/utils/...` (wrong — should be `../../utils/...`).
**Result**: All 192 tests pass (71 client + 121 server). Feature complete.
