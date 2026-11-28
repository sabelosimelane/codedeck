# Mobile workflow controls

**Status**: Built, not yet released to the phone
**Last completed**: Phase 4
**Repositories**: codedeck (this todo)

The phone's task screen (`client/src/mobile/TaskScreen.jsx`) offers only Resume, Continue past a
round limit, answers and Approve / Send back. Stop shows only at a round limit, and there is no
Close run, no step notes beyond a capped step's, no decisions or reviews, and no landing. The
owner falls back to the terminal for all of it.

This redesign gives the phone the desktop's run controls and landing, client only: phone
requests pass the backend's app-wide private-access middleware, and every endpoint used here
already exists. Every response is read with the desktop's own parsers (`pipelineRunRecords.js`,
`tasksApi.js`) and every action toasts its success and its failure.

Out of scope: starting a run from the phone, Change team, adding a repository to a task, and
deleting ignored files on Close (the phone never sends `deleteIgnored`; a refusal over ignored
files says to close the task on the desktop).

## Phase 1: Run controls in a dock

- [x] `runsApi.cleanup(runId)` posts `/runs/:id/cleanup` and checks `terminalsClosed` and `terminalsNotClosed`
- [x] A dock fixed at the bottom of the task screen holds the run's next action as the one highlighted button (Resume, Continue, Close run), and Stop while the run is working
- [x] Stop is offered whenever `run.actions.stop` is true and the run is not interrupted, stopped, failed or complete — not only at a round limit
- [x] Resume and Close run ask first in a confirmation sheet with the desktop's wording; Stop asks first too
- [x] Close run toasts how many terminals were closed and names any that could not be; a closed run leaves the open list and the screen goes back
- [x] The header shows the run's time (live while it is going, "took …" once over) and the desktop's warnings: paused on a terminal dialog, stopped for lack of progress

## Phase 2: Steps that open

- [x] Tapping a step opens it; the current step is open to begin with
- [x] An open step shows Notes (latest note, newest first, one page), Decisions (when the run lets agents decide) and Your reviews / Your answers when there are any, each loaded when tapped
- [x] `runsApi.listRecords(kind, runId, stepIndex)` reads one step's decisions, answers or reviews with the desktop's parsers

## Phase 3: Landing on the task screen

- [x] `runsApi` reads `/api/tasks/:id/worktrees` (every page) with `parseWorktreeLanding`, and commits, merges, opens a pull request and closes one repository's worktree
- [x] A run in a task shows a Git section: one row per repository with `landingStatus`, uncommitted count, commits ahead, and what blocks a merge (`waitingReasons`)
- [x] Each repository's actions sit on its own row of the Git section, its next step (`nextLandingStep`) highlighted; an action the backend blocks is not offered (a working run blocks them all)
- [x] Commit asks for a message; Merge and Close ask first; Open a pull request picks a remote when there is more than one, and says it publishes the branch
- [x] A refusal toasts its reasons and conflicts; a close refused over ignored files says to close on the desktop
- [x] Landing is read when the screen opens, when the run changes, after every action and on Refresh; landing calls get two minutes instead of fifteen seconds

## Phase 4: Quick actions on the Now list

- [x] A long press on a run's row opens a sheet with that run's Approve, Resume, Continue or Stop, with the same confirmations

## Session notes

- Desktop references: `components/tasks/TaskView.jsx` (action bar, confirmations, warnings),
  `components/tasks/landingSteps.js` (pure landing choices), `hooks/usePipelineRuns.js` (cleanup toasts).
- Phone app state lives in `MobileApp.jsx`; `taskHandlers` are stable and call `current.current`.
- Run client tests: `cd client && npx vitest run src/mobile --maxWorkers=1` (Node 22).
- Phone files: `TaskScreen.jsx` (dock, run time, warnings), `runControls.js`, `ConfirmSheet.jsx`,
  `StepDetail.jsx`, `LandingSection.jsx`, `RunActionsSheet` and `useLongPress` in `MobileApp.jsx`;
  `utils/runConfirmations.js` is shared with the desktop task view.
- Verified: client suite (2236 pass; 10 failures were there before: 2 in `runsApi.test.js` over
  `host: 'local'`, 8 in Sidebar/PipelineSettings over a `lucide-react` mock), mobile build, and the
  task screen at 375×812 in a preview page on test data. Not verified on a phone against a live
  instance; the APK was not rebuilt.
