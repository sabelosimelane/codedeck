## [2026-11-25] - Choose agent effort per team role

### Executive Summary
* Teams can now assign one saved agent to multiple roles or teams at different efforts. Each agent's saved effort remains its default, while a team member can override it independently for the primary agent and optional fallback. Effort-only trial adoption updates the existing role without creating a duplicate agent.

### Technical Details
* **✨ New Feature:**
  * Team member records accept optional `effort` and `fallbackEffort` values. The team editor lists the selected preset agent's supported efforts, shows the effective choice in team summaries and inherited assignment dialogs, and clears incompatible choices when an agent is changed.
  * Run snapshots pin the selected launch command at the team member's chosen effort. Unsupported efforts and custom-command agents are rejected with field errors; existing teams without overrides retain their saved commands.
  * Trial nomination uses the member's effective effort. Adopting an effort-only result updates the team role in place; donor adoption still creates an agent copy and clears the role override.
* **🛠️ Codebase:**
  * Updated shared preset and team validation, team persistence, pipeline API validation and run snapshot creation, team trial behavior, client team editing and inherited agent displays, and the README/API contract documentation.
* **🧪 Tests and verification:**
  * Added coverage for command rewriting, validation and persistence, API compatibility, run pinning, trial adoption, and client controls.
  * The live scratch-instance round trip verified one saved agent assigned at high and medium efforts, including separate launch commands after reload. A local test executable stood in for the CLI; no provider account was used.
  * Full server suite: 4,213 passed, 5 failed, 3 skipped; full client suite: 1,962 passed, 24 failed. The same five failing files in each suite failed at base `ef52ced`, so those failures were recorded as pre-existing. The client build succeeded, and `git diff --check` passed.
