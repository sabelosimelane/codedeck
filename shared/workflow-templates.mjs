// Starting points are shared data; choosing agents and saving remain owner actions.
const once = () => Object.freeze({ mode: 'once' });
const loop = (max, to = 'Develop') => Object.freeze({ mode: 'loop_back', to, max });
const node = (name, role, prompt, repeat = once(), readOnly = false, approval = false, askOwner = false) =>
  Object.freeze({ name, role, prompt, repeat, readOnly, approval, askOwner });

// Checks that the report is enough to work from, and asks the owner only for what it could not
// find itself. Its questions always come to the owner, also in a workflow whose agents decide.
const CLARIFY_PROMPT = 'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown.';
const clarify = () => node('Clarify', 'Investigator', CLARIFY_PROMPT, once(), true, false, true);

// Clarify's counterpart for a feature: settles what is being asked for before anything is specified.
const REQUIREMENTS_PROMPT = 'Read {input} and restate what is being asked for in your own words. Change nothing. Check that you know who it is for and what they need to do with it, what it must do in each case including errors and empty states, what is out of scope, what existing behaviour must stay the same, and how it will be shown to work. First look for each of these yourself in the code, the documents and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the requirements as you now understand them, what you found yourself, what the owner told you, and what is still open.';
const requirements = () => node('Requirements', 'Analyst', REQUIREMENTS_PROMPT, once(), true, false, true);

/** Steps that ship with CodeDeck and can be inserted into any workflow, beside the owner's saved steps. */
export const BUILT_IN_STEPS = Object.freeze([
  Object.freeze({ id: 'clarify', ...clarify() }),
  Object.freeze({ id: 'requirements', ...requirements() }),
]);

const acceptance = 'Record the agreed acceptance checks in your note, including how each outcome will be verified and which checks need external evidence.';
const verification = 'Start your note with a one-line outcome that says what changed. List the agreed checks and evidence for each. For a failed agreed check, missing in-scope implementation, or a new regression, record the reproduction and work needed and report CONTINUE. For an apparently unrelated failure, run the same command on the recorded base commit under equivalent conditions. Record both revisions, the command and matching failure before treating it as pre-existing. When the cause is uncertain, run the smallest comparison that distinguishes it. If still unresolved, use NEEDS_INPUT with the evidence and a specific question. When implementation exists but proof needs a device, account or other external access, use NEEDS_INPUT. Say what passed, what is pending and exactly what would verify it (for example, "Backend verified. Phone prompt pending."). Only the owner may explicitly defer a check or narrow scope. Record their decision verbatim. Report COMPLETE only when every agreed check has evidence or an explicit owner-approved scope change.';
const commitOutcome = 'In your final note carry forward the verified outcome, evidence for each agreed check and any owner-approved deferrals, followed by each repository, branch and HEAD.';

export const WORKFLOW_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'bug-fix', name: 'Bug fix', kind: 'bugfix', description: 'Investigate, agree on a fix, build, review, test and commit.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      clarify(),
      node('Analyse', 'Investigator', 'Investigate {input} and reproduce it where possible. Change no code. In your run note record observations, the root cause and its evidence with files and lines and commands and output, what you ruled out, options for a fix, and your recommendation.', once(), true, true),
      node('Specify', 'Planner', 'Read the Analyse note. In your run note specify the fix for {input}: the behaviour to change, what must stay the same, likely files, and tests that will prove it. Change no code. ' + acceptance, once(), true, true),
      node('Develop', 'Developer', 'Implement the Specify note for {input}. Write a failing test first, then make it pass. Keep the change as small as the specification allows. Record what changed and what remains.'),
      node('Review', 'Reviewer', 'Review the uncommitted changes against the Specify note. Fix every defect you find and record your findings and fixes.'),
      node('Test', 'Tester', 'Run tests covering the change and the agreed checks from the Specify note. ' + verification, loop(5), false, false, true),
      node('Commit', 'Committer', 'Commit all work in the worktree to the current branch with a message describing the fix for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. ' + commitOutcome),
    ]),
  }),
  Object.freeze({
    id: 'feature-build', name: 'Feature build', kind: 'build', description: 'Plan phases, build each one, review, test and commit.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Plan', 'Planner', 'Read what {input} asks for and the code it touches. Change no code. Write plan.md in the run notes folder named by its README. Use ## Phase N: <title> sections with - [ ] tasks small enough to build and test in one round. Summarise the plan in your run note.', once(), true, true),
      node('Develop', 'Developer', 'Build the first phase in plan.md with unticked tasks. Write failing tests first, make them pass, tick each task when done, and record what changed.'),
      node('Review', 'Reviewer', 'Review the uncommitted feature changes against plan.md and the task. Fix every defect and record findings and fixes.'),
      node('Test', 'Tester', 'Test the phase just built. Untick any task that does not hold. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and tests pass.', loop(12)),
      node('Commit', 'Committer', 'Commit all work in the worktree to the current branch with a message describing the feature for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. ' + commitOutcome),
    ]),
  }),
  Object.freeze({
    id: 'feature-from-requirements', name: 'Feature from requirements', kind: 'build', description: 'Settle the requirements, agree a specification, plan phases, build each one, review, test and commit.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      requirements(),
      // Not read-only: the specification is a file in the repository, committed with the feature.
      node('Specify', 'Planner', 'Read the Requirements note. Write the specification for {input} as a Markdown file beside the specifications this project already keeps, following their conventions; if it keeps none, put the file in its docs folder. Cover the behaviour in each case, the rules and their edge cases, changes to data and interfaces, what must stay the same, what is out of scope, and acceptance checks that can be tested. Change no code. In your run note give the path of the file, summarise the specification, and list every decision you made that the requirements did not settle.', once(), false, true),
      node('Plan', 'Planner', 'Read the specification named in the Specify note and the code it touches. Change no code. Write plan.md in the run notes folder named by its README. Use ## Phase N: <title> sections with - [ ] tasks small enough to build and test in one round, and make the phases together cover every acceptance check. Summarise the plan in your run note.', once(), true, true),
      node('Develop', 'Developer', 'Build the first phase in plan.md with unticked tasks, following the specification named in the Specify note. Write failing tests first, make them pass, tick each task when done, and record what changed.'),
      node('Review', 'Reviewer', 'Review the uncommitted feature changes against plan.md and the specification named in the Specify note. Fix every defect and record findings and fixes.'),
      node('Test', 'Tester', 'Test the phase just built against the acceptance checks in the specification named in the Specify note. Untick any task that does not hold. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and tests pass.', loop(12)),
      node('Commit', 'Committer', 'Commit all work in the worktree to the current branch with a message describing the feature for {input}. Include the specification and untracked files. Do not push. Finish only when git status shows a clean tree.'),
    ]),
  }),
  Object.freeze({
    id: 'troubleshoot', name: 'Troubleshoot', kind: 'troubleshoot', description: 'Gather evidence, agree on a cause, prove it with a failing test, fix and verify.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Clarify', 'Investigator', CLARIFY_PROMPT + ' ' + acceptance, once(), true, false, true),
      node('Investigate', 'Investigator', 'Investigate {input}. Change no code. Record observations from logs or error output, data or state, and the relevant code path. Cite commands and output or files and lines. Identify the original symptom check for Verify to repeat. State the likely cause, evidence for it, evidence against it, alternatives ruled out and why, what you could not check, and one test that would disprove the cause. If evidence is insufficient, use NEEDS_INPUT with the specific question.', once(), true, true),
      node('Prove', 'Tester', 'Write the test named in the approved Investigate note so that it fails for the stated cause of {input}, and run it. Change no production code. If the test passes, the hypothesis is wrong: record what you saw and report NEEDS_INPUT. Otherwise record the test and its failing output.'),
      node('Fix', 'Developer', 'Make the failing test from the Prove note pass with the smallest change that removes the cause. Do not weaken or delete the test. Record what changed and why it removes the cause.'),
      node('Verify', 'Tester', 'Read the agreed checks in the Clarify note. Repeat the original symptom check from the Investigate note, run the Prove test and tests around the change. ' + verification, loop(5, 'Fix'), false, false, true),
      node('Commit', 'Committer', 'Commit all work in the worktree to the current branch with a message naming the cause of {input} and the fix. Include untracked files. Do not push. Finish only when git status shows a clean tree. ' + commitOutcome),
    ]),
  }),
  Object.freeze({
    id: 'review-only', name: 'Review only', kind: 'review', description: 'Read a change and report findings. Changes nothing and commits nothing.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Survey', 'Investigator', 'Work out what {input} covers: the branch, commits or files to review, and what the change is meant to do. Change nothing. In your run note list the files and behaviours in scope and anything you could not find.', once(), true),
      node('Review', 'Reviewer', 'Review everything listed in the Survey note. Change nothing. Look for defects, missing tests, unhandled errors, security problems and departures from the project rules. In your run note record each finding with its file and line, why it matters, and how serious it is.', once(), true),
      node('Report', 'Reviewer', 'Read the Review note and check each finding against the code once more, dropping any you cannot confirm. Change nothing. In your run note write the final report: findings ordered most serious first, each with file and line and a suggested fix, then what was checked and found sound, then what was not reviewed.', once(), true),
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
    nodes: template.nodes.map(({ name, role, prompt, repeat, readOnly, approval, askOwner }) => ({ name, role, agentId: '', prompt, repeat: { ...repeat }, readOnly, approval, askOwner })),
  };
}
