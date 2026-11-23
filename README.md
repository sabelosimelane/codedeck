<p align="center">
  <img src="client/public/favicon.svg" alt="CodeDeck" width="200" />
</p>

# CodeDeck

A browser-based terminal workspace for developers who juggle multiple projects. Split panes, project switching, file browsing — no IDE overhead. Especially useful for CLI-based agentic coding workflows where each project needs 3-4 terminals running simultaneously.

![CodeDeck — multi-project terminal workspace](docs/images/hero.png)

## Features

- **Multi-project workspace** — organize terminals by project, switch between them instantly
- **Unlimited split panes** — side-by-side terminals with draggable dividers per tab
- **Live sidebar cockpit** — per-project status (active/idle/dead), terminal count, elapsed time
- **Waiting tabs** — park a tab you have handed to an agent: it shrinks, dims and groups left, then clears itself the moment the work lands
- **Per-project file browsing** — browse any project's files and open them in your editor
- **Truthful terminal scrollback** — VS Code-style scrolling, snapshot-first reconnects, and visible warnings when preserved history cannot be guaranteed
- **Terminal resilience** — debug inspector, transport replay catch-up, visibility-aware recovery, heartbeat monitoring
- **Durable sessions** — tmux-backed sessions survive browser detaches and server restarts
- **Changes** — every merged task of a project, newest first, with the summary its workflow run wrote and the commit it landed as
- **Tasks** — give a piece of work a title and it gets its own copy of the project, so several things can be built at once; commit, merge, open a pull request or close it from the same place
- **Several repositories in one project** — list the repositories that belong together; a task then works across the ones you tick, each landed on its own, and Main reaches all of them without a project per repository
- **Workflow pipelines** — build multi-step workflows from templates or your own saved steps, run them inside a task, and follow each step, its notes and its terminal in one view
- **Descriptive session titles** — optional background naming through configurable local CLIs, with manual rename and retry
- **Session search** — find past agent-CLI conversations and resume one in its project
- **Toast notifications** — success/error feedback on every action, no silent failures

## Setup

Prerequisites: Node.js 22+, npm 10+, and `tmux` (required for terminal sessions).

```bash
# Install dependencies
npm install

# Start both servers (backend :43001, frontend :43000)
./server.sh start

# Manage the service
./server.sh stop     # Stop gracefully
./server.sh restart  # Restart
./server.sh status   # Check status
./server.sh logs     # Show recent logs
```

Open `http://localhost:43000` in your browser.

## Usage

1. Click **+** in the sidebar to add a project (give it a name and the absolute path).
2. Click a project to open a terminal scoped to that directory.
3. Use **Split right** (columns icon) to add side-by-side terminal panes — drag dividers to resize, double-click to reset.
4. Use **+** in the tab bar to open new terminal tabs. Each tab has its own set of panes.
5. Use the branch-plus icon beside **+**, or **New task** on the **No terminals open** card, to start a task: type what you are working on and CodeDeck opens a terminal in the task's own copy of the project. See **Tasks** below.
   The sidebar lists **Main** and each open task under its project; the switcher above the terminal tabs does the same. A task with a workflow run takes one entry there: its title, how the run stands and the phase it is on. The run's own terminals are not listed under it; one of them appears only while it needs your attention, and a terminal you opened in the task yourself stays listed. A new terminal, a split and **Cmd/Ctrl+Shift+T** open in whichever of them you are looking at, and stay there.
6. The sidebar shows live status per project: terminal count, activity indicator (green = active, gray = idle, red = dead), and elapsed time.

Agent status comes from the live prompt, status, and footer region of each CLI pane, with 20 seconds of silence vetoing a stale working marker. Input dialogs appear as **Needs input**; working sub-agent panes and background shells keep the session **Running**. An idle agent with a live background shell therefore shows as Running. Codex is also read from the run state in its footer (`Working`), because it hides its working line while it writes text; keep `run-state` in Codex's status line (the `status_line` setting in `~/.codex/config.toml`) so that CodeDeck does not take a turn that is still running for a finished one.
7. Use the pane **eye icon** — or **Cmd/Ctrl+Shift+M** on the active pane — to mute/show status colors without changing the terminal's real running/idle/finished state. Workflow runs also manage their terminals' status automatically; see **One terminal per agent** below.
8. Click the **hourglass** on a tab — beside its close button — or press **Cmd/Ctrl+Shift+U** on the active tab, to mark it waiting when you have handed its work to an agent. Waiting tabs shrink, dim and group to the left of the tab bar, their status indicators stop pulsing everywhere (tab, pane header, and sidebar), and the sidebar shows a count per project. The mark clears itself as soon as the work finishes or the session dies, so the finished styling and completion notification still reach you. Phone pushes are held while the desktop UI has been used in the last two minutes.
9. Click the **folder icon** on any project row to browse its files — clicking a file opens it in your configured editor.
10. Toast notifications confirm every action and surface errors.

## Session search

Click the search icon in the terminal tab bar or press **Cmd/Ctrl+Shift+S**.
The modal lists past Claude Code, Codex, Cursor, and Antigravity conversations
for the current project, with an option to search all local projects. It reads
each CLI's own history. Untitled conversations show their first prompt. Choose
a conversation to resume it in a new terminal tab in its project.

Claude Code and Codex history is limited to interactive sessions. Cursor and
Antigravity cannot be filtered for headless runs, so delegated runs may appear.
Session search covers local projects only.

## Copying terminal text

On macOS, hold **Option/Alt** and drag over the text, then press **Cmd+C**.
The display pauses while you select; the agent keeps running and output is held
until you press **Esc**, type, or click once to resume. That first click only
resumes the display; subsequent clicks reach the terminal application normally.
The highlight stays after copying. Selection alone does not copy, and terminal
OSC 52 sequences cannot read or overwrite the clipboard. Clipboard failures
appear as a toast. Resizing or reconnecting ends selection with a notice.

## Tasks

A task is a titled piece of work with its own copy of the project. CodeDeck creates a Git worktree and a branch for it from the project's current commit; you never name either. Tasks keep work apart, so several can be in progress at once, each with its own terminals and workflow runs.

Start one with **New task** and a title. Uncommitted changes in Main and files Git ignores (`.env.local`, installed dependencies) are not carried over. The sidebar and the switcher show the task by its title; its branch and folder are in the tooltip and under **Details**. **Rename** changes the title only.

If you already made a Git worktree outside CodeDeck, choose **Use an existing worktree** in **New task**. Select a listed worktree, optionally give it a title, and choose **Make task**. CodeDeck records it as a task and opens a terminal there. Its uncommitted files stay in place; making the task does not run Git commands that change the worktree. Worktrees already held by open tasks, missing folders, detached branches, unreadable folders, worktrees in use by a run, and worktrees whose repository checkout has no base branch cannot be selected.

The bar above a task's terminals says how it stands in Git, read every few seconds: uncommitted files, commits not yet in the branch it started from, and whether that branch has moved on. From there:

- **Commit changes** commits everything in the task with the message you give.
- **Merge into `<branch>`** merges the task into the branch it started from, in Main. It is offered only when the task is committed, Main is clean and on that branch, and no workflow run is still working in the task; otherwise the bar says what is in the way. A merge that conflicts is aborted, the conflicting files are listed, and both sides are left as they were. After a merge the task's folder is removed, its merged branch deleted and its terminals closed.
- **Open a pull request** pushes the task's branch to the remote you choose and opens a pull request with the GitHub CLI (`gh`) or a merge request with the GitLab CLI (`glab`), which must be installed and signed in. It asks first, because pushing publishes the branch. The task stays open for review fixes and links to the request.
- **Close task** removes a clean task's folder and closes its terminals. Its branch is kept, and you are told how many commits on it are not merged.

A task you merged yourself with Git, outside CodeDeck, reads **Commits already in `main`** (the branch it started from) where an untouched task reads "No changes yet". It has commits made since it started and none that the branch it started from lacks, so there is nothing left to merge: Merge and Open a pull request are disabled and say so, and **Close task** finishes it. CodeDeck does not close such a task by itself. In a task with several repositories each repository is judged on its own. A task whose branch only caught up with the branch it started from reads the same, because Git cannot tell the two apart. A task merged by squashing or rebasing still shows its commits as not yet merged, because Git sees them as different commits.

**Changes.** Open a project's menu in the sidebar and choose **Changes…** to see what was merged in it, newest first. Each change is a task: its title, when it was merged, the workflow that ran, the repositories it landed in with the branch each was merged into and the commit that checkout stood at afterwards, and a summary. The summary is the first line of the note the last step of the task's most recent run wrote; **Details** opens the rest of that note. A task merged without a run, or whose last step wrote no note, says so. The commit is kept from the merge, so a change can be found in Git after its branch is deleted; tasks merged before this was added show no commit. A task merged outside CodeDeck, or through a pull request, is not listed.

Nothing is forced: a task with uncommitted work is never removed, and a branch is deleted only once Git agrees it is merged. Files Git ignores are checked too. Ignored files and folders that are copied byte for byte in Main go with the task, and so do `node_modules`, `dist`, `build`, `target`, `.gradle` and `.codedeck`, which are rebuilt or kept elsewhere. Any other ignored file exists only in the task: the bar counts them ("2 ignored files only here"), and **Close task** lists them by name and closes only when you choose **Delete files and close**. Nothing but that choice deletes them: a merge still keeps the folder and says so, and uncommitted work still refuses Close. Worktrees CodeDeck was already using when tasks were introduced (those of open workflow runs, and ones a terminal was opened in) became tasks at the next start.

Limits: a new task has none of the project's ignored local files (a workflow run's Setup step prepares them; a task started by hand gets none), and two tasks cannot both serve an app on the same ports. Conflicts between tasks show up when you merge; CodeDeck reports them and resolves nothing itself. Tasks are for local projects.

### Projects with several repositories

Many projects are one repository among others that belong with it: a backend, a frontend and a mobile app side by side in one folder. A CodeDeck project is still one of them (its path, called its own repository here), and it can **list the others**. Open the project's menu in the sidebar and choose **Repositories…**. The dialog shows the project's repositories with the branch each is on, offers the repositories found beside the project to add with one click, each with the branch its folder is on (they are not part of the project until added), and adds any other folder with **Add another folder…**. The list lives in CodeDeck only: nothing is moved or changed on disk, no repository needs a project of its own, and removing one from the list leaves its folder alone. A repository's folder may be a worktree that holds its main branch (for example `worktrees/frontend-main`); tasks then start from and merge into that checkout.

With repositories listed:

- **Main reaches all of them.** A chooser beside the new-terminal button says which repository new terminals open in. It follows the active tab; a split stays in the repository it splits. A tab in another repository shows that repository's name.
- **A task includes the repositories you tick.** **New task** lists them, each with the branch its copy would start from; only the project's own is ticked to begin with. The task gets one copy and one branch per repository, kept together in one folder, `worktrees/<task>/<repository>`, so a reference from one repository to the one beside it (`../../backend/docs/...`) works inside the task as it does outside. The repositories you leave out stay readable at their own folders.
- **Each repository is landed on its own.** The bar above a task's terminals has one row per repository, with its own Commit changes, Merge, Open a pull request and Close. Merging or closing one keeps the task open for the others and closes only that repository's terminals; the task is finished with its last repository. **Close task** closes all of them, or none when one cannot be closed, and says which.

- **More can be added later.** **Add repository** on the bar gives an open task a copy of another of the project's repositories, also while a run is paused, so a step that stopped because it needs one can be answered by adding it. No Setup runs for a repository added this way.
- **A repository from outside the project, for one task.** Some work reaches a repository that does not belong with the project: a service this one calls, for example. **Add repository** is on every task's bar, also in a project that lists no other repository, and takes any folder: type it or choose it with **Browse…**. **New copy** is for the folder that repository is checked out in: the task gets its own copy and branch of it, like any other. **Use as it is** is for a worktree already made for the work, by you or by an agent: it joins the task with its branch and files untouched, and its work is merged into the checkout its repository is kept in. Either way the repository joins this task only (the project's list stays as it is), gets its own row on the bar, is one of the places the task's run may change from its next step on, and is landed and closed like the task's others. A repository whose folder has the same name as one the project lists cannot be added this way.

On the phone, a task in several repositories lists them and says which one its run works in.

A project that lists no other repository works exactly as before.

## Workflow pipelines

In **Run workflow → Where to work**, choose **An existing worktree** to make a worktree created outside CodeDeck into a task and start the run in it. The list shows each worktree's repository, branch and uncommitted file count. You can type a title or use one derived from its branch. The run uses that task directly, with no Setup step, so an untracked progress file already in the worktree is available. If starting the run fails after the task is made, the task remains open and the dialog switches to it for a retry.

A run is shown as its task. The header names the task and the workflow and describes the run in plain words, such as **Running**, **Needs your input**, **Waiting for your approval**, **Interrupted**, **Failed** and **Complete**; when an action is available, the highlighted button is the next thing to do. Down the left are the run's steps, each with its state in words (for example "Running · round 4 of 12"). A finished step also says how long it worked ("Done · 4m 12s"): the total over every round of a loop and every attempt after Resume or Send back. Waiting for your answer counts; waiting for your approval and time spent interrupted do not. A step that finished before this was recorded shows the time of its last start, or nothing when that is not known. The header counts the whole run from when it was started, once a second while it is going ("12m 5s"), and says what it took once it is over ("took 1h 5m"); all the time the run waited for you is part of it. An interrupted run stops counting at its last change. Select a step to see how it stands, its role and agent, and to switch to its terminal, which sits below. While a run is working, the terminal shown follows it: when the run moves to another step, that step's terminal comes to the front. A step or tab you pick yourself stays until the run moves again. The header also names the run's team ("Team: Gemini team"), adds "changed" once the team or a step's agent was changed after the run started with **Change team**, and reads "No team" for a run started without one; each step names its own agent. A team only supplies the agents for the roles it lists, so a step can still run an agent from another provider. A run started before this was added shows "No team" until a team is chosen for it. A question or an approval appears on the step that is waiting for you; that step's **Notes**, the **Decisions** its agent made by itself, and **Your reviews** open in place. A step that has not started has no terminal yet; one whose terminal was closed says so and offers a new one in the task.

An ordered workflow gives each agent a step, a prompt, and a handoff to the next step. Build workflows in the **workflow builder**, opened from **Settings → Workflows** or from **Edit workflows…** in the Run workflow dialog. It lists your workflows on the left. On the right, the workflow being built shows its steps as a rail (drag a step to reorder it), the open step with a large prompt editor, and **What the agent is sent**: the complete prompt for that step, composed by the backend the way a run composes it. The task's folder, the run notes folder and the pass identifier appear as placeholders, because only a run knows them.

A new install comes with the built-in workflows already saved: Bug fix, Quick change, Feature build, Feature from requirements, Troubleshoot and Review only, with their prompts. No agent is chosen in them. Each step names a role (Planner, Developer, Reviewer, Tester, …) and is set to **Assign by team role at launch**, so what is left to you is to add your agents under **Settings → Workflows** and make a team that gives each role an agent; a run then takes its agents from the team you pick. They are ordinary workflows: edit, rename or delete them, and a deleted one does not come back. This happens once, on the first start with an empty workflow list; an install that already has workflows gets nothing added.

To add another, start with a template in the **Add workflow** chooser, choose an agent for every step or leave it to the team role, then save. The built-in templates are **Bug fix**, **Feature build**, **Feature from requirements**, **Troubleshoot** (gather evidence, agree on a cause, prove it with a failing test, fix, verify) and **Review only** (read a change and report findings; it changes and commits nothing). Bug fix and Troubleshoot open with **Clarify**, a read-only step that checks whether your report is enough to work from: it looks for what is missing in the code, the logs and the history first, and asks you only for what it could not find, each question with the assumption it would otherwise make. Clarify is an ordinary step: you can edit, move or delete it, and add it to any other workflow from **Insert a saved step…**, where it is listed as built in. **Feature from requirements** is for a feature that is still an idea: its input is what you want, in your own words. It opens with **Requirements**, the same kind of step as Clarify with the questions a feature needs (who it is for, what it must do in each case, what is out of scope, how it will be shown to work), which is also listed as built in under **Insert a saved step…**. **Blank** starts from one empty step. **Duplicate** copies an existing workflow and its agent choices into a new unsaved draft.

A workflow has a **kind** (Build, Bug fix, Troubleshoot, Review or Other) and an optional description; both only label it and never change how a run behaves. Each step can name its **role** (Planner, Reviewer, …), which is shown beside the step and never sent to the agent.

**Save as template** saves the open workflow without its agents; it then appears in the chooser beside the built-in templates. The bookmark button on a step saves that step for reuse, and **Insert a saved step…** adds a copy of one to the end of a workflow. A step that loops back cannot be saved on its own. Templates and saved steps are copied when used, so deleting one never affects a workflow or a run.

Each new run has notes in `.codedeck/runs/<run-id-prefix>` inside its worktree. Git ignores the folder. Each step is asked to read earlier notes and write a summary of its work, decisions, remaining tasks, and paths before its final signal. CodeDeck keeps a copy of each step note when the pass ends and shows each step's notes on that step in the task view. The last step of a run, the Commit step in the built-in workflows, is also told that you read its note in the project's list of changes: it starts the note with one line that says what the run changed, then summarizes what changed and why.
Each run also keeps a **brief** in that folder, `brief.md`: what you asked for when you started the run, then every question an agent asked and the answer it got, whether you gave it or the agent decided for itself. CodeDeck rewrites it whenever a question is answered, and every step is told to read it, so what you tell one step reaches the steps after it. On the task view, **Your answers** on a step lists what that step asked you and what you said.
When steps divide work into phases, they can keep `plan.md` in that run's notes folder with `## Phase N: <title>` sections and `- [ ]` or `- [x]` tasks. Without a configured Progress file, the task view reads this plan. If it is absent or has no phases, no progress line appears; an unreadable plan is reported.

Open **Settings → Workflows** to add agents and choose a
Setup agent; build workflows there or in the workflow builder. Each node has a prompt, an agent and a
repeat rule: a single pass, repetition until completion with a maximum pass count,
or a loop back to an earlier node (see below).
Mark a node **Read-only step** to tell its agent to write only inside its run notes folder: its note, and a plan when its instructions ask for one. A run without a notes folder is told to change nothing in the worktree.
Mark **Always ask me** so a step's questions come to you even when the workflow lets agents decide; Clarify and Requirements have it on.
Mark **Wait for my approval** to pause when the step finishes. The task view shows
the step note on that step; **Approve** advances, while **Send back** takes a comment and reruns
the same step with that feedback. A step that closes a loop cannot wait for approval,
though steps inside a loop can. **Let agents decide** never skips an approval gate.
`{input}` in prompts is replaced once with the input supplied when starting a run.
The optional **Progress file** setting names a Markdown todo inside the run's worktree;
it may use `{input}`. The task view shows the first `## Phase N` section with unticked
boxes and its task count. If the file is absent or cannot be read, the bar says
"Progress file not found" or "Progress file could not be read" with its path.
A run with a Progress file is refused when that file is not in the repository at its current commit, or in the chosen worktree. When the Progress file uses `{input}`, type either the part that replaces it or the file's whole path inside the project: with `docs/{input}`, both `todos/feature.md` and `docs/todos/feature.md` name `docs/todos/feature.md`. CodeDeck looks for the file as typed first; when it is not there and the whole-path reading is, the run starts with the part, in its prompts as well. A full path from your disk is not accepted. Each step's agent is told to create, change and delete files only inside the run's worktree. It may read outside files named by its instructions, skills or project documents. If the task's own files are missing from the worktree, it asks for input instead of searching other repositories.
A run started without a progress file follows the workflow's current setting. If its
input does not form a valid path, the task view shows no phase line. A workflow with no Progress file uses the optional run notes plan above.
The Feature build template plans phases in that file, then repeats Develop, Review and Test until all tasks pass before committing. Its Plan step sizes the plan to the change: a change one developer can build and test in a sitting is one phase, a phase is always working behaviour (never checks or tests alone), and there are at most four. Each round tests only the phase it built; the full test suite runs once, when no phase is left. Feature from requirements plans the same way. A workflow made from a template before this keeps its own prompts; edit its Plan and Test steps to match. The Bug fix template gates Analyse and Specify on owner approval before implementation.
The Feature from requirements template puts three steps before that build loop. Requirements asks you what it could not find out. Specify writes the specification as a file in the repository, beside the project's other specifications, and waits for your approval; **Send back** has it revise the file. Plan turns the approved specification into phases in the run's `plan.md` and waits for your approval too. The specification is committed with the feature; the plan stays in the run notes, which Git ignores. Use Feature build when the specification or todo already exists. The specification is written during the run, so a `**Repositories**` line cannot fill in the Run dialog for it: in a project with several repositories, tick the ones the feature needs when you start, or add one while the run waits for you.
Write a skill as `/name` at the start of a prompt (for example `/feature-dev {input}`).
Codex invokes skills with `$`, so when the CLI running the step is Codex, CodeDeck sends
that leading `/name` as `$name`; the rest of the prompt is sent as written.

An agent is a launch command plus a reset command. For Claude Code, Codex and Cursor,
pick the provider, type a model ID and choose an effort; CodeDeck builds the launch
command and shows it. A blank model or effort uses the CLI's default. Cursor model
names include the effort, so it has no separate effort choice. **Skip permission
prompts** adds the CLI's own bypass flag; without it a run pauses whenever the agent
asks for permission. A built command starts with `command`, so the shell runs the CLI
itself: an alias or shell function with the same name (for example `codex='codex --yolo'`)
does not apply to it. Choose **Custom command** to write the command yourself (aliases,
extra flags, other CLIs). A model ID is not checked until a run launches the agent.

Select a local Git repository project and click **Run workflow** beside **New task**,
in the strip of Main and the project's tasks above the terminal tabs. Preflight blocks
ineligible projects. **Where to work** offers **A new task**, each open task of the
project, and **Main**. The dialog opens on the task you are looking at when a run can
start in it, and on a new task otherwise. Type a title for the new
task, or leave it empty: the task is then called after the run's input, and as soon as
a step of the run writes its note CodeDeck asks the CLI chosen under **Settings →
Session naming** for a short title that describes the work, and renames the task. A
title you typed, or one you change with **Rename**, is never replaced. Without a
session-naming CLI, or if it fails, the task keeps the title made from the input; the
failure is in the backend log and the next step note tries again. A new task gets its own copy of the project and the run
starts with Setup, which must leave that copy clean before the workflow's nodes can
begin; uncommitted changes in Main are not in it. A run in an open task or in Main
uses the place as it is: there is no Setup step and no setup agent is needed.

**Testing is the agents' job.** Setup does more than install: it runs one quick test, starts the
app from the task's copy on free ports and stops it, finds out how a test user signs in and which
emulators, simulators and browsers the machine has, and writes all of it to `environment.md` in
the run notes. What it could not make work is written there too, not asked about. Every later
step that may change files is told that the test environment is its own: it starts the app, makes
test data, signs in and uses an emulator itself, keeps `environment.md` right, and asks you for an
environment only after it tried, saying what failed. A run in an open task or in Main has no
Setup, so its first working step writes the file.

Some checks no agent on your machine can do: a physical phone, a real account or recipient,
production. In the built-in workflows the step that agrees the checks (Specify, Scope, Plan,
Clarify) says for each check how an agent will verify it, and lists the rest as **Owner checks**
with what you should do and expect; where that step waits for your approval, you see the list
there and can send it back. Owner checks do not pause the run. The test step verifies what it can
of each, and the last step's note, the one shown under **Changes**, repeats them as your list. A
run can therefore read **Complete** with owner checks still open. If a check turns out to need you
after all, the test step asks once whether it becomes an owner check. A saved workflow whose
prompts are still the built-in ones gets this wording at the next start of CodeDeck; a prompt you
edited is left as you wrote it.

**A todo can say which repositories its work touches.** Among its header lines, before the first section, a todo may carry one line:

```
**Repositories**: backend (this todo), mobile-app (docs/todos/tag-pings-phone.md), frontend (minor)
```

`this todo` is the repository the todo lives in. A path is another repository's own todo, for work there that is big enough to be planned on its own. `minor` is a repository the same run may change without a todo of its own. Whoever writes the todo decides, usually the agent that writes the specification; CodeDeck only reads the line. In the Run workflow dialog, for a new task in a project with several repositories, what the line says is filled in for you: **Start in** is the repository that holds the todo, each `minor` repository is ticked under **Repositories**, and each repository with its own todo gets a ticked "Also start a run in…" box. Change any of it; nothing starts before **Start**. Start then starts the run, and one more run in a task of its own for every box left ticked. A repository's own todo is offered only when it is committed there and its path fits the workflow's Progress file; otherwise the box says why. A line CodeDeck cannot read is shown with the reason and nothing is filled in from it. Without the line the dialog still starts where the todo is.

**Runs in a project with several repositories.** The Run workflow dialog adds **Start in**: the
repository whose copy is the run's current directory, where its notes and its progress file are.
For a new task you also tick the other repositories it includes, in the same **Repositories** list
New task shows, where the repository the run starts in is always ticked; Setup prepares each one. For
an open task you choose among the repositories it still has open, and for Main among the
project's repositories (the run then works in that repository's own folder and changes it only).
Every step is told which copies of the task it may change, and where the project's remaining
repositories are so that it can read them and never change them; if one of those must change, the
step asks you. A task takes one unfinished run at a time. When you type the full path of a file
that is in one of the project's repositories, the refusal says which repository to start in and
what to type instead.

**One terminal per agent.** A step opens a tab only when its agent has none yet in that
worktree. Otherwise it goes to the tab where that agent already runs, clears it with
the agent's reset command and sends its own prompt: two nodes that use the same agent
share one tab, and a new run in an existing worktree reuses the tabs an earlier run
left there. Nodes that use different agents get different tabs, because a terminal
holds one agent CLI. Earlier output of a shared tab stays in its scrollback; the
agent's conversation is cleared each time, including anything you typed there yourself.
A step goes back only to a terminal whose shell is still in the run's worktree; one that
is somewhere else (its shell changed folder, or tmux lost the session and a new one of
the same name was opened in the project) is set aside, and the step opens a new terminal
in the worktree.

A CLI that is still clearing or starting can drop a prompt pasted into it, and a CLI can
stop reading input altogether while its screen still shows an idle prompt (Codex has done
so right after the reset command). So while a pass runs, CodeDeck watches its terminal:
when the agent sits idle at a prompt that has not changed for 30 seconds, and has not
asked for anything in that pass, the prompt is taken to be lost and is sent once more.
If that is not taken either, CodeDeck starts the terminal again with a fresh shell in the
same folder (ending the agent and resetting the terminal's modes), starts the agent there
and sends the prompt, with nothing to clear. If the agent started again still takes
nothing, the run fails and says so, instead of showing a step as running that nothing
works on.

The launch command itself is checked the same way. When the shell in a step's terminal
shows no sign of it for three seconds (its screen has not changed, or the command is
nowhere on it), CodeDeck logs what the terminal and its attachments were doing and
types the command into the terminal once more, directly through tmux. If that does not
arrive either, the run fails, saying the launch command never reached the terminal. An
agent that starts and then exits by itself (Codex does after updating itself) fails the
run as before; **Resume** launches it again.

A run keeps only the terminal it is working in showing status; its other terminals
are muted until their step starts. When the run waits for you, that step's terminal
stays live. When the run is stopped, interrupted, failed or complete, all its
terminals are muted, until **Close run** closes them; one that stays open after
that shows its status again. A change you make with the
eye icon lasts until the run's next state change.

A task that an open run is already using, one with no branch checked out, or one
whose files are no longer on disk cannot be chosen. A run never removes the place it
works in. When a run in a task or in Main ends or is stopped, **Close run** closes
the run and the terminals it used, and leaves the task and its files as they are.

When an agent needs something from you it pauses the run. CodeDeck asks every agent
to list its questions, each with the answer it recommends, before it pauses. The task
view shows each question on its own on the waiting step, with the agent's recommendation
already chosen. Leave it, or pick **My own answer** and type yours; **Send answers** sends
one numbered answer for all of them, plus anything else you add for the agent. A request
that is not a numbered list is shown as written, with one box to answer in. Your answer is
typed into the agent's terminal for you; answering in the terminal yourself works
too. If the agent did not list its questions, the task view says so and you read its
terminal. A dialog the agent CLI shows (trust, permission, a question form), while starting
or in the middle of a pass, also pauses the run and is answered in the terminal only. The sidebar count for a project turns to the warning colour
while one of its runs waits for you, and the phone gets an "Input requested" push.
For a full-screen CLI, CodeDeck reads only the visible screen. If its question list extends beyond that screen, CodeDeck cannot read the full list and asks you instead.

**Looping a group of nodes.** Set a node's repeat to **Loop back to an earlier node**,
choose that node and a maximum number of rounds. The nodes from there to the looping
node then run in order, round after round: for example Develop → Test with Test
looping back to Develop builds and tests one phase per round. The looping node's agent
decides: when it reports work left the loop runs again, when it reports COMPLETE the
run moves on to the next node. Each node keeps the terminal tab of its agent across rounds; the
agent's context is cleared with the reset command before each new round. At the
maximum number of rounds the run pauses and **Continue** moves past the loop; the
step then reads "Stopped at its limit; you continued". Loops
cannot share a node, and the first node cannot loop.

When the loop's closing step reports work left, CodeDeck checks the number of ticked tasks in
the run's Progress file or its own `plan.md`. After two consecutive rounds without a new ticked
task, it stops before starting the next round and marks the run as waiting for you. **Resume**
gives the loop two more rounds to make progress. A run without a readable progress source is
not guarded.

**Let agents decide.** Tick this on a workflow to keep its runs going without you.
Each agent is told to go with the option it would recommend instead of asking, and to
write the decision down. If an agent pauses anyway and lists its questions, CodeDeck
answers "Proceed with your recommendations." for it and the run carries on. The task
view marks such a run **agents decide** with a count; open **Decisions** on a step
to read what was asked and answered there. You are still asked when an agent pauses
without listing what it needs, when it asks again in the same pass, when the Setup
step asks, and for a dialog an agent shows while starting. With this on, an agent's
own choice is acted on before you see it: agents that skip permission prompts will
build, commit and push on those choices.

The task view shows steps, passes, loop rounds and the available controls. **Stop** stops
automation; the agent may still be working. **Resume** starts the current step again
in its own terminal: it waits for the agent there to reach its prompt, clears it with the
agent's reset command and sends the prompt again. If the agent has exited there, it is
started again in the same tab. A new tab is opened only when that terminal was closed.
At the pass limit, **Continue** advances to the next
step. Runs survive browser disconnects. A backend restart marks active runs
**interrupted**, ready for an explicit Resume. The sidebar counts each project's
runs that are not finished. The count turns to the warning colour while any of them
cannot go on without you: one that waits for an answer, an approval or a decision at its
limit, and one that is interrupted, failed, stopped for lack of progress or stopped
because its terminal was closed. The strip of tasks above the terminals says how each
task's run stands in a word (running, needs your input, complete, failed, …).

When a run completes, it stays in view on its task as **Complete**, with its steps and
notes, and its task stays, with the work on the task's branch: commit, merge, open a
pull request or close it as described under **Tasks**.

**Close run** takes the run off the screen and closes the terminals it used: the one
each step worked in, and any a step had before. It is offered for a run that is
complete, stopped, failed or interrupted; an agent still working in one of those
terminals is stopped with it. A terminal you opened in the task yourself stays, and so
does one that another run still on screen uses. A terminal that is already gone is
skipped. The toast says how many were closed; one that could not be closed is named
and keeps its tab, which you can close by hand. The work itself is untouched: it is in
the task's files and on its branch.

Starting another run in the same task, or finishing the task, closes the run too.
Starting another run leaves the earlier run's terminals open, because the new run
goes on in the tabs its agents already have there; finishing the task closes all of
the task's terminals. These pipelines use local projects; remote
projects are ineligible.

## Session naming

Open **Settings → Session naming** and select a provider, an exact case-sensitive
model ID, and optional reasoning effort. Claude Code and Codex are initial editable
profiles, not a fixed provider list. **Add provider** lets you capture another CLI;
**Remove provider** removes its profile. Changes take effect only after saving.
Existing Claude/Codex selections remain valid. Legacy Conduit settings are retained
but require a CLI selection; existing titles are preserved.

Each profile has an executable name or absolute path, a JSON array of arguments,
optional effort arguments, a prompt input method, and a response format. Use
`{model}` in the arguments; use `{prompt}` exactly once for argument input, or
choose standard input and omit `{prompt}`. Effort arguments use `{effort}` and are
omitted when effort is blank. Use `[]` when the CLI does not support effort.
Arguments are passed directly without a shell. Configure the CLI for non-interactive
use and disable tools; authenticate through the CLI, not secrets in the saved arguments.

For example, a **Cursor** profile can use executable `agent`, argument input, no
effort arguments, the **JSON result envelope** response format, and:

```json
["--print", "--trust", "--mode", "ask", "--output-format", "json", "--model", "{model}", "{prompt}"]
```

A **Kiro** profile can use executable `kiro-cli`, argument input,
`["--effort", "{effort}"]` for effort arguments, **Title JSON on stdout**, and:

```json
["chat", "--no-interactive", "--model", "{model}", "{prompt}"]
```

See [Kiro's CLI reference](https://kiro.dev/docs/cli/reference/cli-commands/)
for flags supported by your installed version. Kiro was not installed for live
verification of this example. The command must emit the requested title JSON without
banners; CLIs with another output shape need a wrapper that emits title JSON.

Response formats are explicit: **Title JSON on stdout** expects
`{"title":"Short title"}` (or `{"title":null}`); **JSON result envelope** expects
a successful `type: "result"`, `is_error: false` envelope whose `result` is that JSON
string; **Codex JSON event stream** reads a single completed agent message. Invalid
responses fail naming without substituting another provider or changing the title.

After a submitted task starts running, CodeDeck sends a bounded terminal excerpt to
the selected local CLI for a short title. This works through the shared local/remote terminal activity
interface. Naming runs independently of terminal input, output, and navigation. Empty Enter presses do not arm naming. Startup
banners alone can return insufficient context and wait for another submission.

Use the pencil beside a pane's name to rename it. Manual titles take precedence over
pending generation. Failed naming retains the current label, shows the reason, and retries automatically every
10 seconds for up to one minute after the first failure. Each retry captures fresh terminal
context. After that window, **Retry naming** or a new task submission starts a fresh attempt.
Titles persist across reloads; a split tab uses its first pane's title. Hover a label to
see the original session ID. Existing sessions are eligible on their next submitted task;
there is no retrospective bulk naming.

CodeDeck bounds naming excerpts to 12,000 characters and does not persist them.
The configured CLI and its provider have their own retention policies. Naming runs
from a temporary directory, with a 65-second process timeout and a 1 MiB output limit.
The CLI runs on the CodeDeck server, including when the terminal itself is remote.

## Terminal Resilience

CodeDeck includes built-in resilience features for debugging and recovering misbehaving panes:

- **Debug inspector** — click the bug icon on any pane to see health status, lifecycle timeline, and diagnostics
- **Recovery actions** — Reconnect, Resync (transport catch-up without teardown), and Redraw (force repaint)
- **Truthful reconnects** — every attach/reconnect clears stale browser history and reseeds from a fresh tmux snapshot of the recent 10,000-line window
- **Visibility-aware recovery** — returning to a backgrounded tab automatically resizes, resyncs, and catches up missed live output
- **Replay buffer** — bounded per-session output buffer is transport-only catch-up, not the preserved-history authority
- **Heartbeat & stall detection** — detects stale views (throttled, paint lag) and surfaces the reason

### Terminal Runtime

CodeDeck requires `tmux` for all terminal sessions. If `tmux` is missing, the UI blocks terminal creation and prompts you to install it instead of silently downgrading durability.

```bash
# Supported terminal runtime contract
CODEDECK_TERMINAL_RUNTIME=tmux ./server.sh start
```

Legacy non-`tmux` runtime values are ignored; the backend still enforces tmux-required terminals.

### Prevent macOS Sleep

Set `CODEDECK_CAFFEINATE=1` to wrap the server under `caffeinate -i`, preventing idle sleep.

## Config

Projects and settings are stored in SQLite at `~/.codedeck.db`:

- `defaultPath` — starting directory for the project picker
- `editorCommand` — command for opening files (defaults to `code -r`)

## Architecture

```
Browser (React + xterm.js)
  ↕ WebSocket (terminal I/O)
  ↕ REST (projects, files, sessions, health)
Node.js server (Express + node-pty)
  ↕ PTY pool (one per terminal pane)
  ↕ SQLite (project config)
  ↕ fs (file tree reads)
  ↕ child_process (open files in editor)
```

See [docs/steering/](docs/steering/) for detailed architecture, tech stack, and project structure.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
