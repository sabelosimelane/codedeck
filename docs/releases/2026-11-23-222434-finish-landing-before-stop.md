## [2026-11-23] - A landing is finished before the backend stops

### Executive Summary
* Merging a task of CodeDeck itself changed the backend's own files, so `node --watch` stopped the backend in the middle of the merge: the commit was merged and the folder removed, but the branch stayed and the task was still recorded as active. The backend now finishes landing actions before it exits.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `merge` in `server/tasks/task-landing.js` runs `git merge`, removes the folder, deletes the branch and only then records the task as merged. SIGTERM had no handler, so the process died between those steps.
  * **Solution:** `server/shutdown.js` (new, `createShutdown`) waits on SIGTERM and SIGINT for `taskLanding.idle()` and then exits; after 60 seconds it logs that work is unfinished and exits with a failure. Node's watcher starts the next process only after this one is gone. `idle()` on the landing service resolves when no landing action is running or queued.
* **🧪 Tests:**
  * `server/__tests__/shutdown.test.js` (new) — waits for work in progress, the limit, a failed wait, one signal only, argument checks.
  * `server/__tests__/task-landing.test.js` — `idle()` resolves only after a merge under way is recorded, and after queued and failed actions.
