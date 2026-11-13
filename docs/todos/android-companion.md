# CodeDeck Android Companion

**Status**: In Progress
**Last completed**: implementation, final JavaScript regression and signed Android build gates; private configuration and real-device acceptance pending

## Phase 1: Shared transport
- [x] Version 2 attachments, isolated hydration/replay, controller revision fencing, durable incarnation validation; desktop handoff and regression verification.

## Phase 2: Private access and API
- [x] Loopback-only backend, owner/origin enforcement on HTTP and upgrades, paginated companion API, additive SQLite migrations with backup.

## Phase 3: Android experience
- [x] Bundled mobile React/xterm entry, native controls/composer/navigation, Android unit/lint/debug/release builds.

## Phase 4: Background notifications
- [x] Independent status monitor, durable transitions/outbox, generic FCM payloads, permissions/token rotation/private navigation.

## Phase 5: Release acceptance
- [x] Final server/client test suites and client builds.
- [x] Signed APK artifact and signing-key recovery documentation.
- [ ] Owner-approved Tailscale Serve configuration and Firebase configuration.
- [ ] Actual phone desk → phone → desk journey; closed-app/locked-screen notification proof; failure-mode checks.

## Session notes — 2026-11-10

User's supplied Android Companion plan is the source of intent. Continue existing sessions only; no mobile new-session/admin/editor features. Transport and mobile are upgraded together. No command replay after uncertain send. Notification text is generic; routing uses opaque IDs resolved privately.

### Deviations
- **Implementation scope** — User requested the complete plan; proceeding across all implementation phases rather than stopping after one feature-dev phase.
- **Existing local watcher** — `./server.sh status` showed an already-running managed development server. Its Node watcher reloaded source edits automatically; no server was started or restarted manually. The new startup path backs up SQLite before mobile migrations.
- **Durable identity** — SQLite identity alone cannot detect a tmux session replaced while the backend is stopped. Persisting an incarnation UUID as a tmux session option and reconciling SQLite against it closes that stale-notification risk.
- **Release configuration** — Owner login/HTTPS hostname, Firebase app/service-account configuration and phone availability requested; no response yet. No Tailscale/infrastructure changes authorized or executed.
  Read-only local Tailscale inspection later resolved host/owner and found port443 occupied by another app. Proposed separate8443 mapping and managed restart are in the release guide, still unexecuted.

## Verification commands

```text
npm exec --workspace=server -- vitest run --maxWorkers=1
npm exec --workspace=client -- vitest run --maxWorkers=1
npm run build --workspace=client
```

Android gates: `testDebugUnitTest lintDebug assembleDebug assembleRelease` (external signing properties configured as described in the release guide).

### Observed verification

- Final client suite: 42 files, 324 tests passed. Desktop Vite build passed (existing large-bundle warning).
- Android final `testDebugUnitTest lintDebug assembleDebug assembleRelease`: BUILD SUCCESSFUL (516 tasks); release signature verified v2 with RSA3072 key. Earlier instrumentation Java compilation also passed. Native unit checks are wrapper smoke tests; substantive mobile behavior is exercised in JavaScript.
- APK: `client/android/app/build/outputs/apk/release/app-release.apk`; SHA256 `0445bfe63da1d01eac03eb4538093c4035e425cf0814eb0eb515ab2a2b52ec4c`.
- Real local two-WebSocket tmux smoke passed shared output, control transfer both directions, stale input rejection, observer disconnect isolation. Disposable session deleted200. This is not actual-phone evidence.
- Desktop and mobile settings screens loaded in Playwright; mobile displayed missing Firebase configuration. Browser test tab closed.
- Actual companion API returned paginated83projects and5sessions; monitor diagnostics failureCount0. SQLite pre-migration backup exists mode0600.
- `adb devices -l`: no connected devices; test-created adb daemon stopped. No phone installation or Firebase delivery proved.
- Final server suite: 42 files, 833 tests passed. The first sweep had unexpected401 responses in new mobile API and unchanged hosts tests. A deterministic regression reproduced macOS wildcard IPv6/IPv4 listener shadowing; HTTP test fixtures now explicitly bind127.0.0.1 and clean up their listeners. Historical401 responder identity remains unconfirmed.

### Approved private access — 2026-11-10

Owner approved both exact Serve and managed restart commands. Executed private
HTTPS8443 proxy to127.0.0.1:43001 and restart with owner/origin environment.
Serve status confirms the existing443 mapping is preserved. Restart reported
force-kill then successful startup. HTTPS capabilities returned200; disallowed
origin returned403; backend listener is loopback-only. Firebase readiness false.
Launch environment persistence, Firebase configuration, and actual phone
acceptance remain outstanding. No additional infrastructure changes performed.

### Desktop attachment regression — 2026-11-10

Reported screenshot showed `sessionId, cwd, cols and rows must be valid.`
Reproduced against the local backend using `sentinel Local-1`: close4006.
Desktop constructs identities from project names, but the new WebSocket guard
rejected spaces and Unicode. Four valid-ID regression cases failed before the
fix. Aligned the guard with the runtime contract: nonblank text, at most256
characters, no control characters. Targeted35 tests and full server842 tests
(42 files) passed. Live noncreating probe now passes ID validation and reaches
the expected incarnation check. User's specific tab recovery remains unverified.

### Firebase handoff and release rebuild — 2026-11-10

Read the Firebase handoff doc. Verified client and service-account project
`codedeck-companion`, package `com.codedeck.companion`, and expected
service-account identity. Secured backend key outside checkout at
`$HOME/.codedeck/firebase/service-account.json` with 0700/0600 permissions;
verified copy before removing Downloads duplicate. Provider initialization passed,
without sending a push. Client JSON is ignored by Git.

`android:verify`: BUILD SUCCESSFUL17s,281 tasks. `android:release`: BUILD
SUCCESSFUL20s,248 tasks. APK signature verified v2 with same release certificate.
APK includes matching Firebase resources and no backend private key/key identifier.
New APK SHA256 `937f134ca79ffb998a341d4c0aa83d5a0829dc322bcf376040dd2ddfb14e0f59`.
No ADB devices; daemon started for inventory was stopped afterward. Live HTTPS
capabilities still report notificationsReady:false pending approved managed
restart with credential path and existing Tailscale owner/origin. Actual phone
delivery/tap and launch-environment persistence remain outstanding.

### Approved Firebase activation — 2026-11-10 10:55 SAST

Executed owner-approved managed restart with secured credential path and existing
Tailscale owner/origin. Restart reported force-kill followed by successful startup.
Private HTTPS capabilities returned notificationsReady:true, pending0/failed0/sent0,
monitor failureCount0. Backend listener remains127.0.0.1:43001. No push sent;
phone installation/delivery/tap proof and persistent launch settings remain pending.

### Mobile usability updates — 2026-11-10

Version1.1 (code2) added compact grouped session rows, hid empty projects,
loaded all discovery pages before filtering, and added project/title search,
project selection, and a live-running-only filter. Client325 tests passed;
Android verification/release passed. Published to `~/git/apk-releases`.

Version1.2 (code3) addresses reported terminal touch scrolling: installed xterm
skips touch handling when mouse reporting is active. Mobile capture listeners
now scroll the local xterm buffer directly, detach auto-follow before upward
history movement, and distinguish taps from swipes; touch pointer-down no longer
claims/focuses immediately. Red regression observed zero scrollLines calls;
after fix targeted12 and full client327 tests pass. Android unit/lint/debug
passed. Cancelled/multi-touch gestures do not send terminal input. Actual phone
scroll acceptance remains pending; local scrolling requires available scrollback.

### Alternate-screen mobile scrolling correction — 2026-11-10

User reported v1.2 still did not scroll. Read-only tmux metadata showed most
live agents in alternate screen with mouse reporting and little normal history.
A real xterm parser regression confirms alternate viewport stays at zero after
scrollLines(-3); the mobile component emitted zero expected wheel events (red).
Now swipes in mouse-enabled alternate screens dispatch wheel events to xterm,
using its protocol encoding and existing control-fenced onData path. Ordinary
normal-buffer history remains local. No arrow substitution for non-mouse apps.
Agent-owned view scrolling can affect the desktop view and claim control.

Targeted23 passed; full client330 passed. Android unit/lint/debug BUILD SUCCESSFUL
15s; signed release BUILD SUCCESSFUL12s. Same signing certificate verified.
Published v1.3/code4 to central APK repository. No phone connected to ADB;
real-device scroll acceptance remains unproved. Prior mocked scrollLines-only
coverage did not establish alternate-screen scrolling and was insufficient.

### Mobile momentum scrolling — 2026-11-10

User confirmed v1.3 scrolling works on the phone. Added flick momentum to both
local history and mouse-enabled alternate-screen agent scrolling. Velocity is
bounded and decays exponentially, with a 1.2-second maximum. New touch,
cancellation, unmount, hidden view, disconnected socket, screen-mode change,
and alternate-screen control revision changes stop continuation. Momentum does
not claim control after a handoff or accumulate delayed animation frames.

Seven regression cases failed before implementation; targeted22 then full
client337 tests passed. Android unit/lint/debug BUILD SUCCESSFUL15s. Preparing
v1.4/code5; actual phone momentum feel remains to be checked.

Signed release BUILD SUCCESSFUL12s; verified existing signing certificate.
Published v1.4/code5 to central APK repository with matching SHA256 manifest.
