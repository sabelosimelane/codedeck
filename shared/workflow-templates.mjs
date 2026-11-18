// Starting points are shared data; choosing agents and saving remain owner actions.
const once = () => Object.freeze({ mode: 'once' });
const loop = (max, to = 'Develop') => Object.freeze({ mode: 'loop_back', to, max });
const node = (name, role, prompt, repeat = once(), readOnly = false, approval = false) =>
  Object.freeze({ name, role, prompt, repeat, readOnly, approval });

export const WORKFLOW_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'bug-fix', name: 'Bug fix', kind: 'bugfix', description: 'Investigate, agree on a fix, build, review, test and commit.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Analyse', 'Investigator', 'Investigate {input} and reproduce it where possible. Change no code. In your run note record observations, the root cause and its evidence with files and lines and commands and output, what you ruled out, options for a fix, and your recommendation.', once(), true, true),
      node('Specify', 'Planner', 'Read the Analyse note. In your run note specify the fix for {input}: the behaviour to change, what must stay the same, likely files, and tests that will prove it. Change no code.', once(), true, true),
      node('Develop', 'Developer', 'Implement the Specify note for {input}. Write a failing test first, then make it pass. Keep the change as small as the specification allows. Record what changed and what remains.'),
      node('Review', 'Reviewer', 'Review the uncommitted changes against the Specify note. Fix every defect you find and record your findings and fixes.'),
      node('Test', 'Tester', 'Run tests covering the change and the checks named in the Specify note. If anything fails or the specification is incomplete, record exactly what and report CONTINUE so Develop runs again. Report COMPLETE only when everything passes.', loop(5)),
      node('Commit', 'Committer', 'Commit all work in the worktree to the current branch with a message describing the fix for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree.'),
    ]),
  }),
  Object.freeze({
    id: 'feature-build', name: 'Feature build', kind: 'build', description: 'Plan phases, build each one, review, test and commit.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Plan', 'Planner', 'Read what {input} asks for and the code it touches. Change no code. Write plan.md in the run notes folder named by its README. Use ## Phase N: <title> sections with - [ ] tasks small enough to build and test in one round. Summarise the plan in your run note.', once(), true, true),
      node('Develop', 'Developer', 'Build the first phase in plan.md with unticked tasks. Write failing tests first, make them pass, tick each task when done, and record what changed.'),
      node('Review', 'Reviewer', 'Review the uncommitted feature changes against plan.md and the task. Fix every defect and record findings and fixes.'),
      node('Test', 'Tester', 'Test the phase just built. Untick any task that does not hold. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and tests pass.', loop(12)),
      node('Commit', 'Committer', 'Commit all work in the worktree to the current branch with a message describing the feature for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree.'),
    ]),
  }),
  Object.freeze({
    id: 'troubleshoot', name: 'Troubleshoot', kind: 'troubleshoot', description: 'Gather evidence, agree on a cause, prove it with a failing test, fix and verify.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Gather evidence', 'Investigator', 'Investigate {input}. Change no code. Collect evidence from three independent angles before forming any opinion: what the logs and error output show, what the data or state shows, and what the code does on the path involved. In your run note record each observation with the command you ran and its output, or the file and line you read. Keep what you saw separate from what you conclude, and list what you could not check.', once(), true),
      node('Hypothesise', 'Investigator', 'Read the Gather evidence note. Change no code. In your run note state the most likely cause of {input}, the evidence for it, the evidence against it, the other causes you ruled out and why, and the single test that would prove or disprove the cause. If the evidence does not support one cause, say so and ask for what is missing.', once(), true, true),
      node('Prove', 'Tester', 'Write the test named in the Hypothesise note so that it fails for the stated cause of {input}, and run it. Change no production code. If the test passes, the hypothesis is wrong: record what you saw and report NEEDS_INPUT. Otherwise record the test and its failing output.'),
      node('Fix', 'Developer', 'Make the failing test from the Prove note pass with the smallest change that removes the cause. Do not weaken or delete the test. Record what changed and why it removes the cause.'),
      node('Verify', 'Tester', 'Run the test from the Prove note and the tests around the change, and repeat the checks from the Gather evidence note that showed the problem. If the problem still shows or anything else fails, record exactly what and report CONTINUE so Fix runs again. Report COMPLETE only when the symptom is gone and the tests pass.', loop(5, 'Fix')),
      node('Commit', 'Committer', 'Commit all work in the worktree to the current branch with a message naming the cause of {input} and the fix. Include untracked files. Do not push. Finish only when git status shows a clean tree.'),
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
    nodes: template.nodes.map(({ name, role, prompt, repeat, readOnly, approval }) => ({ name, role, agentId: '', prompt, repeat: { ...repeat }, readOnly, approval })),
  };
}
