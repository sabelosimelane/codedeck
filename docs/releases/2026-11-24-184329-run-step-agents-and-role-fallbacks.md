## [2026-11-24] - Change agents during workflow runs and configure quota fallbacks

### Executive Summary
* Owners can change the saved agent for an individual step while a workflow run is active. The change belongs to that run only: work already dispatched finishes its current pass, and the new agent takes effect at the next pass or dispatch. Teams can also assign an optional fallback agent to each role. When a supported CLI reports a settled usage-limit refusal, the unfinished pass restarts on that role's fallback and eligible remaining work moves to it; the run reports a clear limit failure when no usable fallback is available.

### Technical Details
* **✨ New Feature:**
  * `client/src/components/tasks/TaskView.jsx`, `client/src/components/pipelines/ChangeRunAgent.jsx` — per-step Change agent action and saved-agent picker for active runs, with queued/effective agent states, empty and stale states, and run-scoped updates.
  * `client/src/components/pipelines/TeamList.jsx` — optional fallback agent selection for each team role.
  * `server/pipelines/run-machine.js`, `server/pipelines/run-engine.js` — queue a manual replacement until a new logical pass is dispatched; persist per-role fallback snapshots and safely restart quota-refused passes with a new attempt and terminal, preserving recovery state and attribution.
  * `server/agent-profiles/{agy,claude,codex,cursor,muse}.js` — recognize supported usage-limit screens at idle prompts across all five CLI profiles.
* **🔌 API/Interface:**
  * `shared/pipeline-definitions.mjs`, `server/routes/pipelines.js` — validate role fallback assignments and support revision-checked single-step changes during active runs while retaining stopped-run team reassignment.
  * `client/src/hooks/usePipelineRuns.js`, `client/src/utils/pipelineRecords.js`, `client/src/utils/pipelineRunRecords.js` — validate, persist and present queued/effective agent and fallback metadata.
* **🗄️ Persistence and audit:**
  * `server/pipelines/library-store.js`, `server/pipelines/run-store.js`, `server/pipelines/team-attribution.js`, `server/pipelines/run-audit.js` — store optional team fallbacks and run snapshots, retain attempt and terminal history, and record takeover reason and actual agent attribution.
* **🧪 Tests:**
  * Server tests cover schemas, storage, API errors/revision conflicts, active dispatch boundaries, per-role fallback, all five quota readers, takeover/failure paths, terminal workflow and attribution.
  * Client tests cover agent selection, team fallback editing and run-record validation.
  * `server/__tests__/fixtures/quota-screens.js` — supported and rejected CLI screen fixtures.
* **📝 Specification:**
  * `docs/specifications/2026-11-24-172650-run-step-agents-and-role-fallbacks-spec.md` — full requirements, boundaries, persistence, recovery, error and acceptance design.
