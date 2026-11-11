# Android companion

The companion bundles the React/xterm frontend and connects to one private CodeDeck
instance. Android continues existing local and configured remote-host sessions.
The host must remain running and reachable through Tailscale. New sessions,
project administration, code editing and offline/queued commands are excluded.

## Build

Pinned native baseline: Capacitor 8.6.0, Android SDK 36, Gradle 8.14.3,
Android Gradle Plugin 8.13, JDK 21. Run from the repository root:

```sh
npm ci
npm run android:verify --workspace=client
CODEDECK_ANDROID_SIGNING_PROPERTIES="$HOME/.codedeck/android-signing/release.properties" npm run android:release --workspace=client
```

Use the SDK and JDK paths reported by your Android tooling in `ANDROID_HOME` and
`JAVA_HOME`. `client/android/local.properties` is local-only. APKs are generated
at `client/android/app/build/outputs/apk/debug/app-debug.apk` and
`client/android/app/build/outputs/apk/release/app-release.apk`. Release builds require a release
keystore; unsigned release builds fail explicitly. Signing properties have
`storeFile`, `storePassword`, `keyAlias`, and `keyPassword` fields.

This implementation's dedicated key is outside the checkout at
`~/.codedeck/android-signing/release.keystore`, with its mode-600 properties file
in the same directory. Back up both securely: future APK updates must use the
same key. Neither file belongs in Git or the APK.

## Private instance setup — owner approval required

Backend listener is `127.0.0.1:43001` by default. It serves the desktop build,
API and WebSocket transport on the same port. Build desktop assets first:

```sh
npm run build --workspace=client
```

Configure `CODEDECK_SERVE_ORIGIN` to the exact HTTPS origin and
`CODEDECK_TAILSCALE_OWNER` to the owner's exact Tailscale login. Configure both
or neither; partial configuration is rejected. The native origin is
`https://localhost`; desktop development explicitly permits localhost/127.0.0.1
ports 43000 and 43001. Remote requests require the owner's Serve identity header
and an allowed origin. Non-loopback connections and unauthorized upgrades fail.

The owner approved and the following Serve command was executed on 2026-11-10:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:43001
```

Do not use Funnel or bind the backend to a public interface. Localhost identity
header trust depends on the host being trusted and the backend remaining loopback-only.
See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

Read-only inspection on 2026-11-10 found this host is
`macbook-pro.tail270b30.ts.net` with owner login `sabside@gmail.com`.
Port 443 already proxies a different local application on port 18789. The
8443 listener preserves that mapping. The companion address is
`https://macbook-pro.tail270b30.ts.net:8443`.

The separate managed restart to apply the owner/origin in this launcher is:

```sh
CODEDECK_SERVE_ORIGIN=https://macbook-pro.tail270b30.ts.net:8443 CODEDECK_TAILSCALE_OWNER=sabside@gmail.com ./server.sh restart
```

Both operations were approved and executed. The restart script reported
`Server force-killed`, then successfully started the managed server. Verified
Serve mappings, backend listening only on `127.0.0.1:43001`, HTTPS capabilities
HTTP200 with the Capacitor origin, and HTTP403 for a disallowed origin. Firebase
readiness remains false. Environment settings were supplied to this launcher;
they have not been persisted in the host's normal launch configuration for future
starts. Phone HTTPS access and the desk/phone acceptance journey remain unproved.

## Firebase

Register Android application `com.codedeck.companion` in Firebase. Supply its
Android client configuration at `client/android/app/google-services.json` (ignored
by Git). This is the Firebase **Android client** file, never the backend service
account credential. Keep it out of source control. Rebuild/sync the APK
after supplying it. The APK reports a missing Firebase client configuration and
disables notification activation until configured.

Set backend `CODEDECK_FIREBASE_CREDENTIALS` to an absolute service-account JSON
path outside the checkout, readable only by the service owner. No server
credential or signing key is packaged into the APK. The capabilities endpoint
reports notification readiness independently from terminal connectivity.

Firebase handoff applied on 2026-11-10: the client configuration now targets
`codedeck-companion` and package `com.codedeck.companion`. The backend credential
is secured at `/Users/sabside/.codedeck/firebase/service-account.json` (directory
0700, file0600); its identity matches the handoff and the Downloads duplicate was
removed after verifying the secured copy. Provider initialization passed without
sending a notification. The owner approved the managed restart with
`CODEDECK_FIREBASE_CREDENTIALS` and the existing Tailscale owner/origin settings.
Executed on 2026-11-10: restart reported force-kill then successful startup;
private HTTPS capabilities confirmed `notificationsReady: true`, queue failures0,
and the backend remained bound to127.0.0.1:43001. This proves provider readiness,
not actual phone delivery. Launch settings are still supplied through environment
variables rather than persisted in the launch configuration.

Firebase-enabled Android verification and signed release builds passed. Release
signature matches the existing certificate, and APK resources contain the correct
Firebase project/app identity with no backend private key. APK SHA256:
`937f134ca79ffb998a341d4c0aa83d5a0829dc322bcf376040dd2ddfb14e0f59`.
No ADB phone was connected; installation and real delivery remain pending.

FCM payloads contain generic wording and opaque `instanceId`/`eventId` routing
data only. They omit project names, commands, output and paths. Notification
taps resolve events privately and check the tmux incarnation before opening.
Permission denial and token rotation are supported. A persisted bounded pending
queue expires deliveries after 15 minutes; transient failures retry with
exponential delay and an explicit-timeout opossum circuit breaker.

## Handoff and terminal behavior

Explicit opening, pointer interaction or typing claims control. The server
serializes claims and fences input/resizes by revision. Observers remain live at
the canonical grid size. Reconnecting, output and background activity do not
claim control. Pending input is discarded on disconnect and never replayed.
Composer drafts are local to instance and session incarnation and require Send.
Back dismisses the Android keyboard before returning to the session list.

Protocol version 2 is required. Reload desktop clients when updating the backend.
Old clients receive a clear update requirement. Durable UUIDs stored as a tmux
session option prevent old alerts from targeting reused session names.

## Starting sessions from the phone

The **+** button on Sessions opens a sheet that searches every project, grouped
as Active, Waiting and Shelved. Choosing one calls
`POST /api/mobile/v1/projects/{projectId}/sessions` (no body), which:

- reserves the next `${project}-N` id from the same allocator the desktop uses,
  so the phone and desktop can never be handed the same id;
- creates the tmux session detached in the project's folder on its own host
  (local or SSH), refusing any id whose tmux session already exists;
- restores a shelved project exactly as the desktop's unshelve does, only after
  the session exists; waiting projects stay parked;
- returns `201` with the session and a `Location` header. Errors are RFC 9457
  problems with a `traceId`; a 500's cause is logged under that trace id.

The phone then attaches through the normal companion path. The desktop counts
the new session in its sidebar at once and shows it as a tab the next time that
project's terminal area loads (opening the project or reloading). Starts are
serialized, so two quick taps create two distinct sessions, never one id twice.
`GET /projects` reports each project's `state` (`active`, `waiting`, `shelved`)
and `stateChangedAt`, filterable with `?state=`. The app requires the
`session-start` and `project-state` capabilities and reports an update
requirement against an older backend.

tmux stores names with characters outside `[A-Za-z0-9_-]` replaced by `_`
(`Equinox Local-15` → `Equinox_Local-15`). Allocation and companion discovery
map those names back to their project, and existence checks use exact `=name`
targets, because a bare tmux target prefix-matches (`-1` would find `-15`).

## Shared session state (finished, waiting, muted)

The backend owns the attention rules, so the desktop and the phone always agree.
`server/session-attention.js` keeps one SQLite row per session:

- **Finished** is set when running work goes idle (or unknown), and cleared when
  it runs again or is acknowledged. Opening the terminal on the phone, clicking
  its pane on the desktop, or "Mark as reviewed" all acknowledge it.
- **Muted** turns status colours off without changing the real state.
- **Last activity** moves only on meaningful change: work starting or finishing,
  a session ending, or the user typing (at most twice a minute). Output alone
  does not move it, so rows do not reshuffle while agents print. A session
  first seen detached takes its starting time from tmux's `session_activity`;
  on an unreachable host it stays unknown (`null`) rather than becoming "now".
- **Waiting** marks still live in `terminal_waiting`, but they are now cleared by
  the server when parked work lands (a real transition into idle while
  finished, or the session ending), even with no desktop tab open.
- A dead session id that comes back is a new terminal: nothing carries over.

The tracker is fed by the desktop's status poll (`GET /api/sessions`, whose rows
now carry `finished`, `statusMuted` and `waiting`) and by the 5-second
notification monitor. Changes go through one service:

- Desktop: `PUT /api/session-attention/{sessionId}` with `muted` and/or
  `acknowledged: true`.
- Phone: `PUT /api/mobile/v1/sessions/{sessionId}/state` with `waiting`, `muted`
  and/or `acknowledged: true`.

Both return the session's full state, reject unknown fields with field-level
errors, return 404 for an unknown session and 409 when a session is too new to
have an observed status. Phone session rows add `finished`, `muted`, `waiting`,
`needsInput` and `lastActivityAt`, sortable with `?sort=lastActivityAt,desc`.
The app requires the `session-state` capability. Mutes previously kept in a
desktop browser's `localStorage` are moved to the backend on first load.

The phone's Now view shows running work, work that needs you, and sessions
active in the last 8 hours, newest activity first; parked sessions and sessions
of waiting or shelved projects are under All. It refreshes every 5 seconds while
visible.

## Persistence and rollback

Startup performs an online SQLite backup before the first additive companion
migration. The backup includes committed WAL contents and has mode 0600. It is
named `<database>.pre-mobile-<uuid>.bak`. No existing table is removed. Restore a
matching backend/client release together; preserve durable tmux sessions. Any
database restore or service/infrastructure change needs exact-command approval.

## Acceptance record

Automated transport, API, persistence, notification and mobile tests are in the
server/client suites. Android build validation is separate from real-device proof.
Current progress and observed final commands are recorded in
[`todos/android-companion.md`](todos/android-companion.md).

Real-device acceptance must still prove desk → phone → desk, rotation and keyboard
height, multiline/paste/selection/history, reconnect without command duplication,
each agent used, and notification taps with the app backgrounded, screen locked
and process absent. Also check VPN disconnected, unavailable host, denied
permission and expired session. Android force-stop and OS delivery restrictions
are platform limitations, not guaranteed-delivery cases. Do not call the release
complete from a successful APK build alone.
