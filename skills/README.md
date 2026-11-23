# Skills for the built-in workflows

One built-in workflow, **Feature Build from Spec**, works through two skills instead of long
prompts: its Develop step sends `/feature-dev <todo>` and its Test step sends
`/feature-test <todo>`. A skill is a set of instructions an agent CLI loads by name, so each
CLI that runs a step of that workflow needs the skill installed. The other built-in workflows
need no skill.

| Skill | Used by | What it does |
| --- | --- | --- |
| `feature-dev` | Develop | Builds the next phase of a todo file test-first, and keeps session notes in it |
| `feature-test` | Test | Checks the phase just built against its specification: unit, integration, boot, live API and browser |

## Install

Copy the two folders into the skills folder of each agent CLI you use for those steps. For
Claude Code that is `~/.claude/skills/`:

```bash
cp -R skills/feature-dev skills/feature-test ~/.claude/skills/
```

Other CLIs keep skills elsewhere; see their documentation. CodeDeck sends a leading `/name`
as `$name` when the step's CLI is Codex.

The copies are yours afterwards: CodeDeck does not read these folders at run time and does not
update what you installed.

## What the skills expect of a project

- A todo file with `## Phase N` sections and `- [ ]` tasks, under `docs/`. The workflow's
  Progress file is `docs/{input}`, so a run is started with the todo's path inside `docs/`
  (for example `todos/2026-01-01-feature.md`).
- The project's own instructions (`CLAUDE.md` or `AGENTS.md`) saying how to run its tests and
  start it. `feature-test` uses `./server.sh` when the project has one and otherwise whatever
  those instructions give.
- For a change with a user interface, browser tools in the CLI (`feature-test` names the
  chrome-devtools MCP tools).
