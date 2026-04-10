# Project Shelf — Frontend

**Spec**: `docs/specifications/project-shelf-frontend-spec.md`
**Status**: Complete
**Last completed**: Phase 4: Polish & Accessibility
**Created**: 2026-04-10

---

## Phase 1: Backend Data Model & Shelve/Unshelve API
> Extend the project object with `shelved` and `shelvedAt` fields. Update the PUT endpoint to accept these fields. Ensure backwards compatibility — existing projects without `shelved` field are treated as active.
> **Inputs:** Current project CRUD in `server/index.js`, project shape `{name, path}`
> **Outputs:** Projects can be shelved/unshelved via PUT, GET returns shelf metadata
> **Closed when:** `PUT /api/projects/:name` with `{shelved: true, shelvedAt: "..."}` persists correctly, `GET /api/projects` returns the fields, existing projects default to `shelved: false`

- [x] Update `PUT /api/projects/:name` in `server/index.js` to accept and persist `shelved` (boolean) and `shelvedAt` (ISO string or null) fields alongside existing `name` and `path` (Spec SS4)
- [x] Ensure `GET /api/projects` returns `shelved` and `shelvedAt` for each project — existing projects missing these fields default to `{shelved: false, shelvedAt: null}` (Spec SS4)
- [x] Add `shelveProject(name)` handler in `App.jsx` — calls `PUT /api/projects/:name` with `{shelved: true, shelvedAt: new Date().toISOString()}`, shows toast, refreshes projects (Spec SS8.2, SS10.3)
- [x] Add `unshelveProject(name)` handler in `App.jsx` — calls `PUT /api/projects/:name` with `{shelved: false, shelvedAt: null}`, auto-selects the project, shows toast, refreshes projects (Spec SS8.2, SS10.2)
- [x] Filter projects in `App.jsx` — split `projects` into `activeProjects` (not shelved) and `shelvedProjects` (shelved, sorted by `shelvedAt` descending) before passing to Sidebar (Spec SS8.1)
- [x] Handle shelving the active project — clear `activeProject` to null when the selected project is shelved (Spec SS10.1)
- [x] Verify: shelve a project via API → GET returns `shelved: true` → unshelve → returns `shelved: false`

## Phase 2: Sidebar Shelf Section
> Split the sidebar into active projects (top) and a collapsible shelved section (bottom). Active rows get a shelve button. Shelved rows are muted with unshelve + delete buttons.
> **Inputs:** Separated `activeProjects` and `shelvedProjects` arrays from Phase 1
> **Outputs:** Two-section sidebar, shelve/unshelve via button clicks
> **Closed when:** Can shelve a project from active section, see it appear in shelved section, unshelve it back, shelf section collapses/expands

- [x] Add shelve button (`Archive` icon, lucide-react) to active project rows in `Sidebar.jsx` — positioned before Pencil and Trash2 buttons, appears on hover (Spec SS5.2, SS9.7)
- [x] Add shelf section below active project list in `Sidebar.jsx` — divider line (`1px solid var(--border)`, 12px margin top), collapsible header showing `▸ Shelved (N)` with ChevronRight/ChevronDown icon (Spec SS5.3)
- [x] Implement expand/collapse toggle — `shelfExpanded` state in Sidebar, persisted to localStorage, collapsed by default (Spec SS8.3)
- [x] Render shelved project rows when expanded — muted text (`var(--text-muted)`), no status cockpit, `ArchiveRestore` + `Trash2` action buttons (Spec SS5.4)
- [x] Wire shelve button on active rows → calls `onShelve(project.name)` prop (Spec SS4)
- [x] Wire unshelve button on shelved rows → calls `onUnshelve(project.name)` prop (Spec SS10.2)
- [x] Wire click on shelved project row → unshelves and selects (same as unshelve button) (Spec SS10.2)
- [x] Hide shelf section entirely when no shelved projects exist (Spec SS5.6)
- [x] Style shelf header: 11px, uppercase, `letter-spacing: 0.05em`, `var(--text-muted)` (Spec SS9.3)
- [x] Style shelved rows: compact (6px vertical padding), `var(--text-muted)` text, same hover as active rows (Spec SS9.4)
- [x] Verify: shelve 3 projects → shelf section appears → expand → see 3 muted rows → unshelve one → moves back to active → shelve active project → selection clears

## Phase 3: Search & Scale
> Add search input and top-5 limit to the shelved section so it handles 20-50+ projects gracefully.
> **Inputs:** Working shelf section from Phase 2
> **Outputs:** Top 5 display limit, overflow hint, search-to-reveal
> **Closed when:** With 10+ shelved projects, only 5 show + "N more" hint, search filters the full list, clearing search restores top 5

- [x] Limit shelved project list to 5 items, show `+ N more` overflow hint below in `var(--text-muted)` 11px (Spec SS5.5)
- [x] Add search input when shelf is expanded AND more than 5 shelved projects — compact 28px height, `Search` icon prefix, placeholder "Search shelved..." (Spec SS6.1)
- [x] Implement client-side search — filter `shelvedProjects` by `name.toLowerCase().includes(query)`, instant (no debounce), show all matches sorted alphabetically (Spec SS6.2)
- [x] When search is active: show all matching results (no 5-item limit), hide "N more" hint (Spec SS5.5)
- [x] Show "No matches" centered in `var(--text-muted)` when search returns empty (Spec SS6.2)
- [x] Clear search on: Escape key, X clear button, collapsing the shelf section (Spec SS6.1)
- [x] Add `shelfSearch` state to Sidebar, reset to empty string when shelf collapses (Spec SS8.3)
- [x] Verify: shelve 10 projects → expand shelf → see 5 + "5 more" → search "old" → see matching projects → clear → back to top 5

## Phase 4: Polish & Accessibility
> Animations, edge cases, keyboard accessibility.
> **Inputs:** Fully functional shelf from Phases 1-3
> **Outputs:** Polished, accessible shelf feature
> **Closed when:** Animations feel smooth, keyboard-only usage works, all edge cases handled

- [x] Add slide animation for shelf expand/collapse — content slides down/up, 150ms ease (Spec SS9.5)
- [x] Add transition for project rows moving between sections — 200ms ease slide (Spec SS9.5)
- [x] Shelf header: `role="button"`, `aria-expanded`, focusable, Enter/Space toggles expand (Spec SS12)
- [x] Shelve/unshelve buttons: `aria-label="Shelve project"` / `aria-label="Restore project"` (Spec SS12)
- [x] Search input: `aria-label="Search shelved projects"` (Spec SS12)
- [x] Tab order: active projects → shelf header → search → shelved projects → footer (Spec SS12)
- [x] Edge case: delete last active project while shelved projects exist — empty active area, shelf still visible (Spec SS5.6)
- [x] Edge case: unshelve from search results — project moves to active, search results update (Spec SS10.2)
- [x] Verify: full keyboard-only flow — Tab to shelf header → Enter to expand → Tab to search → type query → Tab to result → Enter to unshelve

---

## Session Notes

### Session — 2026-04-10 (Phase 1-2)
**Completed**: Phase 1: Backend Data Model & Shelve/Unshelve API, Phase 2: Sidebar Shelf Section
**Key files**:
- `server/index.js` — `loadProjects()` normalizes missing shelf fields with spread defaults; PUT handler updated to merge shelf fields without requiring name/path (supports shelf-only PATCH-style calls)
- `client/src/App.jsx` — `shelveProject()` and `unshelveProject()` handlers added; `activeProjects`/`shelvedProjects` computed by filtering `projects`; new props `onShelve`/`onUnshelve` passed to Sidebar
- `client/src/components/Sidebar.jsx` — rewritten: `activeProjects`/`shelvedProjects` props, `Archive` button added to active rows (order: FolderSearch|Archive|Pencil|Trash2), shelf section with collapsible header + shelved rows, `shelfExpanded` localStorage persistence
**Architecture**: Backend uses spread merge (`{ shelved: false, shelvedAt: null, ...p }`) so existing projects get defaults on any write. PUT handler checks if `name`/`path` are present before validating path existence — enables shelf-only updates. Active/shelved split computed in App.jsx, not backend.
**Next**: Phase 4: Polish & Accessibility — slide animations, aria attributes, keyboard nav, edge cases

### Session — 2026-04-10 (Phase 4)
**Completed**: Phase 4: Polish & Accessibility
**Key files**:
- `client/src/styles/global.css` — added `shelfSlideDown` keyframe, `.shelf-content` (150ms expand animation), `.project-row` / `.shelf-row` (200ms fadeIn animation for row transitions)
- `client/src/components/Sidebar.jsx` — wrapped expanded shelf content in `<div className="shelf-content">` for slide animation; added `className="shelf-row"`, `tabIndex={0}`, `onKeyDown` Enter handler to shelved project rows
**Already done from prior phases**: shelf header role/aria-expanded/tabIndex/keyboard, aria-labels on shelve/unshelve buttons, search aria-label, empty-state guard (shows shelf when active list is empty), unshelve-from-search (works automatically via prop refresh)
**Architecture**: Row animations use React's key-based remount — no animation library needed. Collapse has no exit animation (CSS-only exit is complex); entry animation is the visible interaction.
**Feature is complete** — all 4 phases done.

### Session — 2026-04-10 (Phase 3)
**Completed**: Phase 3: Search & Scale
**Key files**:
- `client/src/components/Sidebar.jsx` — added `shelfSearch` state, `Search`/`X` imports; shelf section refactored to IIFE that computes `searchActive`, `showSearch`, `displayedProjects`, `overflowCount`; search input (28px, Search icon prefix, X clear button, Escape key clears) shown when expanded and >5 shelved; results sorted alphabetically when searching; "No matches" shown when empty; `toggleShelf` now clears search on collapse
**Architecture**: Shelf logic uses an inline IIFE `(() => { ... })()` inside JSX to compute local variables without polluting component scope. `displayedProjects` switches between top-5 slice (no search) and filtered+sorted array (search active). Overflow hint hidden when `searchActive`.
**Next**: Phase 4: Polish & Accessibility — slide animations for expand/collapse (150ms), row transitions, aria attributes, keyboard tab order
