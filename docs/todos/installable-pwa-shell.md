# Installable PWA Shell

**Spec**: `docs/specifications/installable-pwa-shell-spec.md`
**Status**: In Progress
**Created**: 2026-04-21

## Phase 1: Installable App Shell Foundation
> Make CodeDeck eligible for Chrome-native installation as a standalone app window.
> **Inputs:** existing Vite frontend shell, current service-worker registration, Chrome on macOS
> **Outputs:** manifest-discoverable installable shell with correct app metadata and assets
> **Closed when:** Chrome offers the native install flow and the installed app opens as a standalone window while the backend is running

- [ ] Add a web app manifest with relative `id`, `start_url`, and `scope`, plus standalone display metadata and CodeDeck branding (Spec §4.1, §6.3 — no hardcoded port or host assumptions)
- [ ] Add install-ready icon assets for Chrome/macOS install surfaces and keep browser-tab favicon behavior aligned (Spec §4.1, §8.1–§8.2 — 192/512 PNG assets, consistent identity)
- [ ] Wire the manifest and icon metadata into the HTML shell using relative asset URLs (Spec §4.2 — installability metadata exposed through the entry HTML)
- [ ] Align service-worker registration/scope with Chrome installability prerequisites without changing backend contracts (Spec §4.3–§4.4, §5.1 — installed shell, same live runtime contract)
- [ ] Browser verification — install from Chrome and confirm Dock launch opens a standalone `CodeDeck` app window while the backend is available (Spec §4.4, §9.1, §10.2)

## Phase 2: Truthful Shell-Only Caching
> Let the installed app reopen the UI shell without turning cached data into authoritative CodeDeck state.
> **Inputs:** prior successful online shell load, installed app launch or refresh while backend is unavailable
> **Outputs:** cached shell fallback, live-only API/WS truth, no offline terminal illusion
> **Closed when:** the app can reopen the shell with the backend down, but `/api/*`, `/ws/*`, and session/project truth still come only from the live backend

- [ ] Extract request-classification/cache-policy helper logic for shell assets vs live network-only surfaces (Spec §5.1–§5.3, §10.1 — cacheable shell assets, bypass live data)
- [ ] Implement service-worker fetch handling for navigation fallback plus same-origin static shell assets only (Spec §5.1–§5.4 — network-first shell, cached fallback)
- [ ] Explicitly bypass `/api/*`, `/ws/*`, and any project/session/terminal payloads from cached authority (Spec §5.2–§5.3, §7.1 — backend remains authoritative)
- [ ] Unit tests for cache-policy/request-classification permutations, including shell assets, API requests, and WebSocket paths (Spec §5.1–§5.3, §10.1)
- [ ] Integration/browser verification — after a prior online load, launch or refresh with the backend down and confirm the installed shell shows existing truthful CodeDeck unreachable/runtime-blocked behavior instead of stale live content (Spec §5.4–§5.5, §6.2, §9.1, §10.2)

## Phase 3: Installed-App Launch Truthfulness & UX Polish
> Ensure the installed app behaves like CodeDeck, not like a separate offline product.
> **Inputs:** installed app launches with backend up/down, persisted local UI preferences, existing unreachable/runtime-blocked UX
> **Outputs:** normal live behavior when reachable, truthful failure behavior when unreachable, no custom install CTA
> **Closed when:** installed-app launches feel native enough on macOS Chrome while preserving the current CodeDeck truth model

- [ ] Audit and adjust launch behavior so the installed shell reuses existing CodeDeck unreachable/runtime-blocked UX rather than a new PWA-specific empty state (Spec §6.1–§6.3 — truthful existing UX)
- [ ] Ensure persisted local UI preferences remain non-authoritative when live project/session/runtime data is unavailable (Spec §6.2 — preferences may persist, live truth may not)
- [ ] Remove or avoid any in-app install CTA/banner/modal so install remains Chrome-native only (Spec §4.3, §9.1 — no custom install surface)
- [ ] Browser verification — launch from the Dock with backend up and backend down, confirming the app never implies stale project/session/terminal truth is live (Spec §6.1–§6.3, §9.2, §10.2)

## Phase 4: Final Verification + Cleanup
- [ ] Run `cd client && npx vite build` and verify manifest/service-worker/install assets are emitted correctly (Spec §4–§5, §10.1)
- [ ] Verify generated manifest, HTML metadata, and service-worker logic contain no hardcoded fixed-port localhost URLs (Spec §2.3, §6.3, §10.1, §10.3)
- [ ] End-to-end verification on macOS Chrome: install, close, relaunch from Dock, backend down launch, backend recovery relaunch (Spec §9.1–§10.3)
- [ ] Review user-facing copy so the feature is described as an installable shell, not an offline-capable terminal app (Spec §3.2, §5.5, §9.1)
