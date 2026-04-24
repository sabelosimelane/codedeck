# Installable PWA Shell

**Spec**: `docs/specifications/installable-pwa-shell-spec.md`
**Status**: Complete
**Last completed**: Phase 4: Final Verification + Cleanup
**Created**: 2026-04-21

## Phase 1: Installable App Shell Foundation
> Make CodeDeck eligible for Chrome-native installation as a standalone app window.
> **Inputs:** existing Vite frontend shell, current service-worker registration, Chrome on macOS
> **Outputs:** manifest-discoverable installable shell with correct app metadata and assets
> **Closed when:** Chrome offers the native install flow and the installed app opens as a standalone window while the backend is running

- [x] Add a web app manifest with relative `id`, `start_url`, and `scope`, plus standalone display metadata and CodeDeck branding (Spec §4.1, §6.3 — no hardcoded port or host assumptions)
- [x] Add install-ready icon assets for Chrome/macOS install surfaces and keep browser-tab favicon behavior aligned (Spec §4.1, §8.1–§8.2 — 192/512 PNG assets, consistent identity)
- [x] Wire the manifest and icon metadata into the HTML shell using relative asset URLs (Spec §4.2 — installability metadata exposed through the entry HTML)
- [x] Align service-worker registration/scope with Chrome installability prerequisites without changing backend contracts (Spec §4.3–§4.4, §5.1 — installed shell, same live runtime contract)
- [x] Browser verification — install from Chrome and confirm Dock launch opens a standalone `CodeDeck` app window while the backend is available (Spec §4.4, §9.1, §10.2)

## Phase 2: Truthful Shell-Only Caching
> Let the installed app reopen the UI shell without turning cached data into authoritative CodeDeck state.
> **Inputs:** prior successful online shell load, installed app launch or refresh while backend is unavailable
> **Outputs:** cached shell fallback, live-only API/WS truth, no offline terminal illusion
> **Closed when:** the app can reopen the shell with the backend down, but `/api/*`, `/ws/*`, and session/project truth still come only from the live backend

- [x] Extract request-classification/cache-policy helper logic for shell assets vs live network-only surfaces (Spec §5.1–§5.3, §10.1 — cacheable shell assets, bypass live data)
- [x] Implement service-worker fetch handling for navigation fallback plus same-origin static shell assets only (Spec §5.1–§5.4 — network-first shell, cached fallback)
- [x] Explicitly bypass `/api/*`, `/ws/*`, and any project/session/terminal payloads from cached authority (Spec §5.2–§5.3, §7.1 — backend remains authoritative)
- [x] Unit tests for cache-policy/request-classification permutations, including shell assets, API requests, and WebSocket paths (Spec §5.1–§5.3, §10.1)
- [x] Integration/browser verification — after a prior online load, launch or refresh with the backend down and confirm the installed shell shows existing truthful CodeDeck unreachable/runtime-blocked behavior instead of stale live content (Spec §5.4–§5.5, §6.2, §9.1, §10.2)

## Phase 3: Installed-App Launch Truthfulness & UX Polish
> Ensure the installed app behaves like CodeDeck, not like a separate offline product.
> **Inputs:** installed app launches with backend up/down, persisted local UI preferences, existing unreachable/runtime-blocked UX
> **Outputs:** normal live behavior when reachable, truthful failure behavior when unreachable, no custom install CTA
> **Closed when:** installed-app launches feel native enough on macOS Chrome while preserving the current CodeDeck truth model

- [x] Audit and adjust launch behavior so the installed shell reuses existing CodeDeck unreachable/runtime-blocked UX rather than a new PWA-specific empty state (Spec §6.1–§6.3 — truthful existing UX)
- [x] Ensure persisted local UI preferences remain non-authoritative when live project/session/runtime data is unavailable (Spec §6.2 — preferences may persist, live truth may not)
- [x] Remove or avoid any in-app install CTA/banner/modal so install remains Chrome-native only (Spec §4.3, §9.1 — no custom install surface)
- [x] Browser verification — launch from the Dock with backend up and backend down, confirming the app never implies stale project/session/terminal truth is live (Spec §6.1–§6.3, §9.2, §10.2)

## Phase 4: Final Verification + Cleanup
- [x] Run `cd client && npx vite build` and verify manifest/service-worker/install assets are emitted correctly (Spec §4–§5, §10.1)
- [x] Verify generated manifest, HTML metadata, and service-worker logic contain no hardcoded fixed-port localhost URLs (Spec §2.3, §6.3, §10.1, §10.3)
- [x] End-to-end verification on macOS Chrome: install, close, relaunch from Dock, backend down launch, backend recovery relaunch (Spec §9.1–§10.3)
- [x] Review user-facing copy so the feature is described as an installable shell, not an offline-capable terminal app (Spec §3.2, §5.5, §9.1)

### Session — 2026-04-24 (Phase 1 partial)
**Completed**: Phase 1 implementation tasks for manifest, icon assets, HTML metadata, and root-scoped service-worker registration.
**Key files**: `client/index.html`, `client/public/manifest.webmanifest`, `client/public/pwa-icon-192.png`, `client/public/pwa-icon-512.png`, `client/public/pwa-maskable-icon-512.png`, `client/public/notification-sw.js`, `client/src/registerServiceWorker.js`, `client/src/__tests__/registerServiceWorker.test.js`, `.workflow/installable-pwa-shell.md`.
**Verification**: `cd client && npx vitest run src/__tests__/registerServiceWorker.test.js --maxWorkers=1`; `cd client && npx vitest run --maxWorkers=1`; `cd client && npx vite build`; Chrome CDP smoke against `vite preview` reported manifest loaded, service worker ready at `/`, and zero installability errors.
**Remaining**: Manual macOS Chrome install/Dock launch verification with the backend running; do not mark Phase 1 complete until that UI-level install check passes.
**Next**: Finish Phase 1 browser verification, then Phase 2 shell-only caching policy for static shell assets while bypassing `/api/*` and `/ws/*`.

### Session — 2026-04-24 (Phase 1 completion)
**Completed**: Phase 1: Installable App Shell Foundation.
**Key files**: `docs/todos/installable-pwa-shell.md`, `.workflow/installable-pwa-shell.md`.
**Verification**: `./server.sh status` showed backend/frontend running; `curl http://localhost:43000/manifest.webmanifest` returned the CodeDeck manifest; `curl http://localhost:43001/api/health` returned `status: ok`; Chrome showed the native `Install` toolbar affordance for `http://localhost:43000`; Chrome created `~/Applications/Chrome Apps.localized/CodeDeck.app`; `open ~/Applications/Chrome Apps.localized/CodeDeck.app` launched a separate `CodeDeck` app-mode window without the browser tab strip/address bar while live CodeDeck projects/sessions were visible.
**Next**: Phase 2: Truthful Shell-Only Caching — implement explicit static-shell cache policy and keep `/api/*` plus `/ws/*` network-only.

### Session — 2026-04-24 (Phase 2)
**Completed**: Phase 2: Truthful Shell-Only Caching.
**Key files**: `client/public/pwa-cache-policy.js`, `client/public/notification-sw.js`, `client/src/__tests__/pwaCachePolicy.test.js`, `docs/todos/installable-pwa-shell.md`, `.workflow/installable-pwa-shell.md`.
**Architecture**: `pwa-cache-policy.js` classifies requests as navigation shell, shell asset, or live network-only; `notification-sw.js` uses network-first cached fallback for `/` and cache-first static shell assets while leaving `/api/*`, `/ws/*`, cross-origin, and mutating requests untouched.
**Verification**: targeted `npx vitest run src/__tests__/pwaCachePolicy.test.js src/__tests__/registerServiceWorker.test.js --maxWorkers=1`; `npx vite build`; full `npx vitest run --maxWorkers=1`; Chrome smoke on `http://localhost:43112` cached `/`, assets, manifest, and icon, then after stopping the origin still loaded the shell with `Server unreachable` while `/api/health` failed with `TypeError` and no `/api/*` cache entry existed.
**Next**: Phase 3: Installed-App Launch Truthfulness & UX Polish — audit launch/unreachable behavior, persisted preferences, and confirm no in-app install CTA exists.

### Session — 2026-04-24 (Phase 3)
**Completed**: Phase 3: Installed-App Launch Truthfulness & UX Polish.
**Key files**: `client/src/components/TerminalArea.jsx`, `client/src/utils/terminalLayout.js`, `client/public/pwa-cache-policy.js`, `client/public/notification-sw.js`, `client/src/components/__tests__/TerminalAreaRestore.test.jsx`, `client/src/components/__tests__/TerminalArea.test.js`, `client/src/__tests__/pwaCachePolicy.test.js`, `client/src/__tests__/notificationServiceWorker.test.js`, `docs/todos/installable-pwa-shell.md`, `.workflow/installable-pwa-shell.md`.
**Architecture**: `TerminalArea` now preserves saved terminal layouts as local preference data but does not render or overwrite them when `/api/sessions` cannot provide live backend truth. The service worker remains shell-only, adds Vite dev module paths as network-first shell assets, and has an inline fallback classifier so cold service-worker startup does not depend on fetching `/pwa-cache-policy.js`.
**Verification**: targeted `npx vitest run src/__tests__/notificationServiceWorker.test.js src/__tests__/pwaCachePolicy.test.js src/components/__tests__/TerminalAreaRestore.test.jsx src/components/__tests__/TerminalArea.test.js --maxWorkers=1`; full `npx vitest run --maxWorkers=1` passed 24 files / 131 tests; `npx vite build` passed; install CTA audit only found the PWA cache-policy test name; installed `~/Applications/Chrome Apps.localized/CodeDeck.app` launched with backend up showing live projects/terminals, then with frontend up and backend `43001` stopped it launched to the normal CodeDeck shell with zero projects, no session list, and no terminal panes.
**Remaining**: Phase 4 should repeat the full end-to-end pass and explicitly distinguish backend-down from full-origin-down behavior. Full-origin-down Dock launch still depends on Chrome shortcut/profile service-worker state and is best treated as a final verification/caveat check, not a project/session truthfulness requirement.
**Next**: Phase 4: Final Verification + Cleanup — artifact checks, hardcoded URL scan, end-to-end recovery relaunch, and user-facing copy review.

### Session — 2026-04-24 (Phase 4 partial verification)
**Completed**: Phase 4 artifact emission and hardcoded fixed-port URL checks.
**Verification**: prior `cd client && npx vite build` emitted `dist/index.html`, `dist/manifest.webmanifest`, `dist/notification-sw.js`, `dist/pwa-cache-policy.js`, and all three PWA PNG icons; `rg "localhost|43000|43001|127\\.0\\.0\\.1|http://|https://"` over source and built PWA shell files found only Google Fonts HTTPS links, not fixed localhost ports.
**Remaining**: End-to-end macOS Chrome install/relaunch/backend-down/recovery relaunch and user-facing copy review.

### Session — 2026-04-24 (Phase 4 completion)
**Completed**: Phase 4: Final Verification + Cleanup. Feature status is now `Complete`.
**Verification**: installed `~/Applications/Chrome Apps.localized/CodeDeck.app` launched standalone with backend up and live project/session state visible; after stopping only backend `43001` while frontend `43000` stayed available, relaunch opened the normal CodeDeck shell with no stale projects, session list, or terminal panes and existing project-load failure toasts; after `./server.sh restart`, relaunch recovered live project/session state. `rg` copy review confirmed user-facing PWA wording describes a live-runtime installable shell, not an offline-capable terminal app. Final gates passed: `git diff --check`; `cd client && npx vitest run --maxWorkers=1` (24 files / 131 tests); `cd client && npx vite build`.
**Remaining**: No remaining implementation tasks for this feature.
