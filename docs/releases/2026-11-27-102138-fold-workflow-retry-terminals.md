## [2026-11-27] - Fold workflow retry terminals into one sidebar run entry

### Executive Summary
* Workflow runs now stay represented by one run entry in the left sidebar after a step is retried. Previous attempt terminals are carried through the run-count hook and resolved to the run's worktree, including when the retry terminal has no recorded worktree path. Ordinary terminals opened by hand remain listed, and run terminals that are finished or dead remain visible for attention.

### Technical Details
* **🛠️ Codebase:**
  * `client/src/hooks/usePipelineRunCounts.js` — preserve each step's `priorSessionIds` in the run projection used by sidebar grouping.
  * `client/src/utils/worktreeGroups.js` — resolve current and previous attempt session IDs to the newest eligible run's worktree, validate each prior session ID, and fold those terminals into the run's sidebar entry while preserving recorded session paths and attention rows.
* **🧪 Tests and verification:**
  * Added a hook-to-sidebar grouping regression test for retried terminals with both recorded and missing worktree paths; added per-field invalid prior-session-ID checks and updated the TerminalArea fixture.
  * `cd client && npx vitest run src/hooks/__tests__/usePipelineRunCountsFolding.test.jsx src/utils/__tests__/worktreeGroups.test.js src/components/__tests__/Sidebar.test.jsx src/components/__tests__/SidebarPipelineRuns.test.jsx src/components/__tests__/TerminalAreaWorktreeFilter.test.jsx --maxWorkers=1` — 5 test files and 109 tests passed.
  * `cd client && npx vite build` — succeeded. The isolated browser check showed one run entry, folded the active and ordinary retry terminals, and retained a finished retry and an independent terminal.
