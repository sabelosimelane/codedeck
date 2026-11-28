// Starting points are shared data; choosing agents and saving remain owner actions.
const once = () => Object.freeze({ mode: 'once' });
const loop = (max, to = 'Develop') => Object.freeze({ mode: 'loop_back', to, max });
const node = (name, role, prompt, repeat = once(), readOnly = false, approval = false, askOwner = false) =>
  Object.freeze({ name, role, prompt, repeat, readOnly, approval, askOwner });

// Checks that the report is enough to work from, and asks the owner only for what it could not
// find itself. Its questions always come to the owner, also in a workflow whose agents decide.
const CLARIFY_PROMPT = 'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. Check whether any referenced or read-only repository must change; if a repository is missing from this task\'s worktrees, ask to add it in this same NEEDS_INPUT pass. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown.';
const clarify = () => node('Clarify', 'Investigator', CLARIFY_PROMPT, once(), true, false, true);

// Clarify's counterpart for a feature: settles what is being asked for before anything is specified.
const REQUIREMENTS_PROMPT = 'Read {input} and restate what is being asked for in your own words. Change nothing. Check that you know who it is for and what they need to do with it, what it must do in each case including errors and empty states, what is out of scope, what existing behaviour must stay the same, and how it will be shown to work. Check whether any referenced or read-only repository must change; if a repository is missing from this task\'s worktrees, ask to add it in this same NEEDS_INPUT pass. First look for each of these yourself in the code, the documents and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the requirements as you now understand them, what you found yourself, what the owner told you, and what is still open.';
const requirements = () => node('Requirements', 'Analyst', REQUIREMENTS_PROMPT, once(), true, false, true);

/** Built-in structured roles shipped with CodeDeck and referenced by the built-in workflows and steps. */
export const BUILT_IN_ROLES = Object.freeze([
  Object.freeze({ name: 'Investigator', description: 'Clarifies problems, reproduces issues, and surveys code without editing.' }),
  Object.freeze({ name: 'Analyst', description: 'Gathers requirements, clarifies scope, and identifies acceptance checks.' }),
  Object.freeze({ name: 'Planner', description: 'Designs specifications and phased implementation plans.' }),
  Object.freeze({ name: 'Developer', description: 'Implements planned changes and fixes with tests.' }),
  Object.freeze({ name: 'Reviewer', description: 'Audits diffs against specifications and fixes defects.' }),
  Object.freeze({ name: 'Tester', description: 'Verifies acceptance checks and runs targeted and full test suites.' }),
  Object.freeze({ name: 'Committer', description: 'Writes release notes and commits clean worktree changes.' }),
  Object.freeze({ name: 'Thinking partner', description: 'Explores and challenges ideas one question at a time before specification.' }),
]);

/** Steps that ship with CodeDeck and can be inserted into any workflow, beside the owner's saved steps. */
export const BUILT_IN_STEPS = Object.freeze([
  Object.freeze({ id: 'clarify', ...clarify() }),
  Object.freeze({ id: 'requirements', ...requirements() }),
]);

// A check is the agent's to run unless it needs what no agent on the machine can have; those are
// agreed up front as owner checks, which the owner carries out after the run and no step waits for.
const ownerOnly = 'a physical device, a real account or recipient, production';
const ownEnvironment = 'Set up what a check needs yourself (the app run from the worktree, test data, a test sign-in, an emulator or simulator); do not ask the owner for an environment or for evidence you can produce.';
const acceptance = `Record the agreed acceptance checks in your note. For each, say how an agent will verify it itself on this machine: the command, or the app run from the worktree with test data, a test sign-in, an emulator or simulator. Mark a check owner-only only when it needs what no agent here can have (${ownerOnly}); give the reason and what an agent will verify of it instead, and list these under the heading Owner checks, each with what the owner should do and expect. The owner carries them out after the run; no step waits for them.`;
const planOwnerChecks = `Say in each such task how an agent will verify it itself on this machine. A check that needs what no agent here can have (${ownerOnly}) is owner-only and is not a task: list it under ## Owner checks at the end of plan.md as a plain bullet without a box, with the reason, what the owner should do and expect, and what an agent verifies of it instead. The owner carries these out after the run; no step waits for them.`;
const testOwnerChecks = ownEnvironment + ' The Owner checks in plan.md do not wait: verify what an agent can of each and repeat them in your note with what the owner should do and expect. If an unticked task turns out to need what no agent here can have, or an artifact from a later step, use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether it becomes an owner check; when the owner says so, move it to Owner checks in plan.md. Do not repeat passing tests on an unchanged diff.';
const verificationIntro = 'Start your note with a one-line outcome that says what changed. List the agreed checks and evidence for each. ' + ownEnvironment + ' For a failed agreed check, missing in-scope implementation, or a new regression, record the reproduction and work needed and report CONTINUE. For an apparently unrelated failure, run the same command on the recorded base commit under equivalent conditions. Record both revisions, the command and matching failure before treating it as pre-existing. When the cause is uncertain, run the smallest comparison that distinguishes it. If still unresolved, use NEEDS_INPUT with the evidence and a specific question. ';
const verificationOwnerChecks = 'An owner-only check does not wait: verify what an agent can of it, and list it under Owner checks in your note with exactly what the owner should do and expect (for example, "Backend verified. Owner check: phone prompt."). If a check that is not marked owner-only turns out to need what no agent here can have, use NEEDS_INPUT once, say what you tried, and ask whether it becomes an owner check. Only the owner may drop a check or narrow scope. Record their decision verbatim. Report COMPLETE only when every agreed check has evidence, was marked owner-only when the checks were agreed or by the owner since, or has an explicit owner-approved scope change.';
const previousVerification = verificationIntro + verificationOwnerChecks;
const verification = verificationIntro
  + 'Run focused checks during repair; run the final suite once per changed repository on the final revision. '
  + verificationOwnerChecks;
const commitReleaseNotes = 'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically.';
const commitOutcome = 'In your final note carry forward the verified outcome, evidence for each agreed check, any owner-approved deferrals and, under the heading Owner checks, every check the owner still has to carry out with what to do and expect, followed by each repository, branch and HEAD.';

// A bug fix is planned in phases like a feature, so one Develop round builds one whole phase and the
// Test loop has rounds enough for every phase plus a fix each; a fix that will not fit is flagged in the
// note the owner approves, before anything is built.
const BUG_FIX_SPECIFY = 'Read the Analyse note. In your run note specify the fix for {input}: the behaviour to change, what must stay the same, likely files, and tests that will prove it. Change no code. ' + acceptance + ' Write plan.md in the run notes folder named by its README. Size the plan to the fix: a fix one developer can build and test in a single sitting is one phase. Add a phase only for a further piece of working behaviour that builds on the one before it, never a phase that only checks or adds tests, and use at most 4 phases. Put each agreed check that is not owner-only as a task in the phase that builds what it checks, and say in the task how an agent will verify it. Use ## Phase N: <title> sections with - [ ] tasks. The phases together must cover every agreed check. In your run note summarise the plan and say why it has as many phases as it has. If the agreed checks do not fit in 4 such phases, or the fix redesigns how a system works rather than correcting what goes wrong, do not stretch the phases: start your run note with a line beginning "Scope warning:" that says why, recommend narrowing the fix to the reported fault with the rest listed as follow-up work, or running the rest as a feature workflow, and plan only the narrowed fix. The owner reads this note before approving it.';
const BUG_FIX_DEVELOP = 'Build the first phase in plan.md with unticked tasks, following the Specify note for {input}. Build all of that phase, not a slice of it. Write failing tests first, make them pass, tick each task when done, leave changes uncommitted for Review and Commit (do not run git commit), and record what changed and what remains.';
const BUG_FIX_REVIEW = 'Review the changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified work. Fix every defect you find, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record your findings and fixes.';
const BUG_FIX_TEST_INTRO = 'Test the phase just built against the agreed checks from the Specify note. Untick any task in plan.md that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase and report CONTINUE. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Do not repeat passing tests on an unchanged diff. ';
const UNPHASED_BUG_FIX_TEST_INTRO = 'Run tests covering the change and the agreed checks from the Specify note. ';
const QUICK_CHANGE_TEST_INTRO = 'Review the changes on this branch against the Scope note, fix any defect you find, and run tests covering the change and the agreed checks from the Scope note. On a repeat pass, read your previous note and focus on what changed since that pass. ';
const TROUBLESHOOT_VERIFY_INTRO = 'Read the agreed checks in the Clarify note. Repeat the original symptom check from the Investigate note, run the Prove test and tests around the change. ';

// Exact version 1 verification prompts also appear in saved local copies and run snapshots.
export const PREVIOUS_VERIFICATION_PROMPTS = Object.freeze({
  'bug-fix': BUG_FIX_TEST_INTRO + previousVerification,
  'quick-change': QUICK_CHANGE_TEST_INTRO + previousVerification,
  troubleshoot: TROUBLESHOOT_VERIFY_INTRO + previousVerification,
  unphasedBugFix: UNPHASED_BUG_FIX_TEST_INTRO + previousVerification,
});

/**
 * The Bug fix prompts for the layout before phased fixes, with current verification guidance.
 * A saved Bug fix still holding all four prompts upgrades to the phased layout as a unit.
 */
export const PREVIOUS_BUG_FIX_PROMPTS = Object.freeze({
  Specify: 'Read the Analyse note. In your run note specify the fix for {input}: the behaviour to change, what must stay the same, likely files, and tests that will prove it. Change no code. ' + acceptance,
  Develop: 'Implement the Specify note for {input}. Write a failing test first, then make it pass. Keep the change as small as the specification allows. Leave changes uncommitted for Review and Commit; do not run git commit. Record what changed and what remains.',
  Review: 'Review the changes on this branch (both uncommitted changes and any commits since the base commit) against the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified work. Fix every defect you find, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record your findings and fixes.',
  Test: UNPHASED_BUG_FIX_TEST_INTRO + verification,
});

export const WORKFLOW_TEMPLATES = Object.freeze([
  Object.freeze({
    version: 2,
    id: 'bug-fix', name: 'Bug fix', kind: 'bugfix', description: 'Investigate, agree on a fix, build, review, test and commit.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      clarify(),
      node('Analyse', 'Investigator', 'Investigate {input} and reproduce it where possible. Change no code. In your run note record observations, the root cause and its evidence with files and lines and commands and output, what you ruled out, options for a fix, and your recommendation.', once(), true, false),
      node('Specify', 'Planner', BUG_FIX_SPECIFY, once(), true, true),
      node('Develop', 'Developer', BUG_FIX_DEVELOP),
      node('Review', 'Reviewer', BUG_FIX_REVIEW),
      node('Test', 'Tester', BUG_FIX_TEST_INTRO + verification, loop(8), false, false, true),
      node('Commit', 'Committer', commitReleaseNotes + ' Commit all work in the worktree to the current branch with a message describing the fix for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. ' + commitOutcome),
    ]),
  }),
  Object.freeze({
    version: 2,
    id: 'quick-change', name: 'Quick change', kind: 'build', description: 'Scope a small change, implement it, review and test in one pass, and commit.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Scope', 'Analyst', 'Read {input} and the code it touches. Change nothing. Check whether any referenced or read-only repository must change, what behaviour must change, what must stay the same, likely files, and tests that will prove it. First look for each of these yourself in the code and documents. For anything you could not find and cannot safely assume, or if a repository is missing from this task\'s worktrees, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the scope and likely files. ' + acceptance, once(), true, false, true),
      node('Develop', 'Developer', 'Implement the Scope note for {input}. Write a failing test first, then make it pass. Keep the change as small as the scope allows. Leave changes uncommitted for Review & Test and Commit; do not run git commit. Record what changed and what remains.'),
      node('Review & Test', 'Tester', QUICK_CHANGE_TEST_INTRO + verification, loop(3), false, false, true),
      node('Commit', 'Committer', commitReleaseNotes + ' Commit all work in the worktree to the current branch with a message describing the change for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. ' + commitOutcome),
    ]),
  }),
  Object.freeze({
    version: 1,
    id: 'feature-build', name: 'Feature build', kind: 'build', description: 'Plan phases, build each one, review, test and commit.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Plan', 'Planner', 'Read what {input} asks for and the code it touches. Change no code. Write plan.md in the run notes folder named by its README. Size the plan to the change: work one developer can build and test in a single sitting is one phase. Add a phase only for a further piece of working behaviour that builds on the one before it, never a phase that only checks or adds tests, and use at most 4 phases. Put each acceptance check as a task in the phase that builds what it checks. ' + planOwnerChecks + ' Use ## Phase N: <title> sections with - [ ] tasks. In your run note summarise the plan and say why it has as many phases as it has.', once(), true, true),
      node('Develop', 'Developer', 'Build the first phase in plan.md with unticked tasks. Write failing tests first, make them pass, tick each task when done, leave changes uncommitted for Review and Commit (do not run git commit), and record what changed.'),
      node('Review', 'Reviewer', 'Review the feature changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the task. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record findings and fixes.'),
      node('Test', 'Tester', 'Test the phase just built. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. ' + testOwnerChecks + ' When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.', loop(8)),
      node('Commit', 'Committer', commitReleaseNotes + ' Commit all work in the worktree to the current branch with a message describing the feature for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. ' + commitOutcome),
    ]),
  }),
  // Builds from a todo file that already exists: the todo is the plan and the place progress is read from, so there is no planning step.
  Object.freeze({
    version: 2,
    id: 'feature-build-from-spec', name: 'Feature Build from Spec', kind: 'build', description: 'Build a feature from a todo file that already exists, one phase per round: develop, review and test until every task is ticked.', agentsDecide: true, progressFile: 'docs/{input}',
    nodes: Object.freeze([
      node('Develop', 'Developer', 'Read the todo file docs/{input}, its session notes and the specification it names. When the Test note lists repairs, make each one hold exactly as it is worded before anything else. Build the first phase in it with unticked tasks, and only that phase. Write failing tests first, make them pass, tick each task when done, add to the todo\'s session notes what the next round needs to know, leave changes uncommitted for Review and Test (do not run git commit), and record what changed. Before ticking a task that names a test, read its wording again and check that the test asserts every condition it names (the kind of test, the data, each account, state or viewport); a test that passes without asserting them does not complete the task.'),
      node('Review', 'Reviewer', 'Review the changes for the phase just built in the todo file docs/{input} (both uncommitted changes and any commits since the base commit) against that phase and the specification the todo names. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record findings and fixes.'),
      node('Test', 'Tester', 'Test the phase just built in the todo file docs/{input} against the acceptance checks of the specification it names. Untick any task whose behaviour does not hold. For a task whose behaviour holds and whose only gap is a test that does not assert what the task names, or evidence you can produce that is not recorded, do not untick it: correct or add the test, or produce and record the evidence, yourself, show in your note that the test fails when the behaviour is wrong, and leave the task ticked. In doing so change no code other than tests, and never edit a test the project marks as locked; add one beside it. While a phase in the todo still has unticked tasks, run only the tests for that phase. ' + ownEnvironment + ' If an unticked task turns out to need what no agent here can have (' + ownerOnly + '), use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether the owner will check it themselves; when the owner says so, tick it, mark it "owner check" in the todo and list it in your note with what the owner should do and expect. Do not repeat passing tests on an unchanged diff. When no phase has unticked tasks, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in the todo has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.', loop(8)),
    ]),
  }),
  Object.freeze({
    version: 1,
    id: 'feature-from-requirements', name: 'Feature from requirements', kind: 'build', description: 'Settle the requirements, agree a specification, plan phases, build each one, review, test and commit.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      requirements(),
      // Not read-only: the specification is a file in the repository, committed with the feature; plan.md stays in the run notes folder.
      node('Specify', 'Planner', 'Read the Requirements note and the code it touches. Write the specification for {input} as a Markdown file beside the specifications this project already keeps, following their conventions; if it keeps none, put the file in its docs folder. Cover the behaviour in each case, the rules and their edge cases, changes to data and interfaces, what must stay the same, what is out of scope, and acceptance checks that can be tested. Then write plan.md in the run notes folder named by its README. Size the plan to the change: work one developer can build and test in a single sitting is one phase. Add a phase only for a further piece of working behaviour that builds on the one before it, never a phase that only checks or adds tests, and use at most 4 phases. Put each acceptance check as a task in the phase that builds what it checks. ' + planOwnerChecks + ' Use ## Phase N: <title> sections with - [ ] tasks. The phases together must cover every acceptance check. Change no code. In your run note give the path of the file, summarise the specification and the plan, say why it has as many phases as it has, and list every decision you made that the requirements did not settle.', once(), false, false),
      node('Develop', 'Developer', 'Build the first phase in plan.md with unticked tasks, following the specification named in the Specify note. Write failing tests first, make them pass, tick each task when done, leave changes uncommitted for Review and Commit (do not run git commit), and record what changed.'),
      node('Review', 'Reviewer', 'Review the feature changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the specification named in the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record findings and fixes.'),
      node('Test', 'Tester', 'Test the phase just built against the acceptance checks in the specification named in the Specify note. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. ' + testOwnerChecks + ' When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.', loop(8)),
      node('Commit', 'Committer', commitReleaseNotes + ' Commit all work in the worktree to the current branch with a message describing the feature for {input}. Include the specification and untracked files. Do not push. Finish only when git status shows a clean tree. ' + commitOutcome),
    ]),
  }),
  Object.freeze({
    version: 2,
    id: 'troubleshoot', name: 'Troubleshoot', kind: 'troubleshoot', description: 'Gather evidence, agree on a cause, prove it with a failing test, fix and verify.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Clarify', 'Investigator', CLARIFY_PROMPT + ' ' + acceptance, once(), true, false, true),
      node('Investigate', 'Investigator', 'Investigate {input}. Change no code. Record observations from logs or error output, data or state, and the relevant code path. Cite commands and output or files and lines. Identify the original symptom check for Verify to repeat. State the likely cause, evidence for it, evidence against it, alternatives ruled out and why, what you could not check, and one test that would disprove the cause. If evidence is insufficient, use NEEDS_INPUT with the specific question.', once(), true, true),
      node('Prove', 'Tester', 'Write the test named in the approved Investigate note so that it fails for the stated cause of {input}, and run it. Change no production code. If the test passes, the hypothesis is wrong: record what you saw and report NEEDS_INPUT. Otherwise record the test and its failing output.'),
      node('Fix', 'Developer', 'Make the failing test from the Prove note pass with the smallest change that removes the cause. Do not weaken or delete the test. Record what changed and why it removes the cause.'),
      node('Verify', 'Tester', TROUBLESHOOT_VERIFY_INTRO + verification, loop(3, 'Fix'), false, false, true),
      node('Commit', 'Committer', commitReleaseNotes + ' Commit all work in the worktree to the current branch with a message naming the cause of {input} and the fix. Include untracked files. Do not push. Finish only when git status shows a clean tree. ' + commitOutcome),
    ]),
  }),
  Object.freeze({
    version: 1,
    id: 'review-only', name: 'Review only', kind: 'review', description: 'Read a change and report findings. Changes nothing and commits nothing.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Survey', 'Investigator', 'Work out what {input} covers: the branch, commits or files to review, and what the change is meant to do. Change nothing. In your run note list the files and behaviours in scope and anything you could not find.', once(), true),
      node('Review', 'Reviewer', 'Review everything listed in the Survey note. Change nothing. Look for defects, missing tests, unhandled errors, security problems and departures from the project rules. In your run note record each finding with its file and line, why it matters, and how serious it is.', once(), true),
      node('Report', 'Reviewer', 'Read the Review note and check each finding against the code once more, dropping any you cannot confirm. Change nothing. In your run note write the final report: findings ordered most serious first, each with file and line and a suggested fix, then what was checked and found sound, then what was not reviewed.', once(), true),
    ]),
  }),
  // An idea still being shaped: a conversation with the owner, one question per pause, until it lands; then a
  // specification and a phased todo that Feature Build from Spec can build from once they are merged.
  Object.freeze({
    version: 1,
    id: 'brainstorm-to-spec', name: 'Brainstorm to spec', kind: 'build', description: 'Talk an idea through with you one question at a time until it lands, then write its specification and a phased todo for Feature Build from Spec.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Brainstorm', 'Thinking partner', 'You are the owner\'s thinking partner for the idea in {input}. Change nothing. First read the code and documents the idea touches, so that you can talk about it concretely. Then talk it through with the owner one question at a time: each time, use NEEDS_INPUT with exactly one question, with the answer you would recommend and why and, where it helps, two or three options with their trade-offs. Ask first the question whose answer changes the idea most. Build on each answer: say in a sentence what you took from it, challenge it when it conflicts with the code, with an earlier answer or with a simpler way, raise what the owner has not considered, then ask the next question. Do not ask what you can find out yourself from the code, the documents or the history. Between you, settle who it is for and what they need, what it does in each case including errors and empty states, what is out of scope, what must stay the same, and how it will be shown to work; follow the conversation rather than this list. When you believe the idea has landed, use NEEDS_INPUT once more with a short summary of what was agreed and ask whether it is ready to be specified; if the owner wants to keep going, keep going. Finish only when the owner agrees. In your run note record the idea as agreed, each decision and why, the options set aside, what is out of scope, and anything still open.', once(), true, false, true),
      node('Specify', 'Planner', 'Read the Brainstorm note and the code it touches. Write the specification for {input} as agreed there, as a Markdown file beside the specifications this project already keeps, following their conventions; if it keeps none, put it in docs/specifications. Cover the behaviour in each case, the rules and their edge cases, changes to data and interfaces, what must stay the same, what is out of scope, and acceptance checks that can be tested. Then write a todo file for building it beside the todos this project keeps, or in docs/todos: a title, a line naming the specification, ## Phase N: <title> sections with - [ ] tasks, and a ## Session notes section at the end. In a project with several repositories, add among its header lines a **Repositories**: line naming each repository the work touches, as "(this todo)", the path of its own todo, or "(minor)". Size the plan to the change: work one developer can build and test in a single sitting is one phase. Add a phase only for a further piece of working behaviour that builds on the one before it, never a phase that only checks or adds tests, and use at most 4 phases. Put each acceptance check as a task in the phase that builds what it checks, saying how an agent will verify it on this machine; a check that needs what no agent here can have (' + ownerOnly + ') goes under ## Owner checks at the end of the todo as a plain bullet without a box, with what the owner should do and expect. Change no code. In your run note give the paths of both files, the input to start Feature Build from Spec with (the todo\'s path inside docs/), a summary of the specification and the plan, why it has as many phases as it has, and every decision you made that the Brainstorm did not settle. The owner reads this note before approving it.', once(), false, true),
      node('Commit', 'Committer', 'Commit the specification and the todo file named in the Specify note to the current branch with a message naming the feature for {input}. Commit nothing else: if any other file changed, use NEEDS_INPUT and list them. Do not push. Start your note with one line that says what was specified, then give the paths of both files, the input to start Feature Build from Spec with once this task is merged, and each repository, branch and HEAD.'),
    ]),
  }),
]);

export function buildTemplateDraft(templateId) {
  if (typeof templateId !== 'string' || !templateId.trim()) throw new TypeError('templateId must be a non-empty string');
  const template = WORKFLOW_TEMPLATES.find(item => item.id === templateId);
  if (!template) throw new RangeError(`Unknown template: ${templateId}`);
  return {
    name: template.name,
    description: template.description,
    kind: template.kind,
    agentsDecide: template.agentsDecide,
    progressFile: template.progressFile,
    nodes: template.nodes.map(({ name, role, prompt, repeat, readOnly, approval, askOwner }) => ({ name, role, prompt, repeat: { ...repeat }, readOnly, approval, askOwner })),
  };
}
