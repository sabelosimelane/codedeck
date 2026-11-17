// Starting points are shared data; choosing agents and saving remain owner actions.
const once = () => Object.freeze({ mode: 'once' });
const loop = max => Object.freeze({ mode: 'loop_back', to: 'Develop', max });
const node = (name, role, prompt, repeat = once(), readOnly = false, approval = false) =>
  Object.freeze({ name, role, prompt, repeat, readOnly, approval });

export const WORKFLOW_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'bug-fix', name: 'Bug fix', description: 'Investigate, agree on a fix, build, review, test and commit.', agentsDecide: false, progressFile: null,
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
    id: 'feature-build', name: 'Feature build', description: 'Plan phases, build each one, review, test and commit.', agentsDecide: false, progressFile: null,
    nodes: Object.freeze([
      node('Plan', 'Planner', 'Read what {input} asks for and the code it touches. Change no code. Write plan.md in the run notes folder named by its README. Use ## Phase N: <title> sections with - [ ] tasks small enough to build and test in one round. Summarise the plan in your run note.', once(), true, true),
      node('Develop', 'Developer', 'Build the first phase in plan.md with unticked tasks. Write failing tests first, make them pass, tick each task when done, and record what changed.'),
      node('Review', 'Reviewer', 'Review the uncommitted feature changes against plan.md and the task. Fix every defect and record findings and fixes.'),
      node('Test', 'Tester', 'Test the phase just built. Untick any task that does not hold. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and tests pass.', loop(12)),
      node('Commit', 'Committer', 'Commit all work in the worktree to the current branch with a message describing the feature for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree.'),
    ]),
  }),
]);

export function buildTemplateDraft(templateId) {
  if (typeof templateId !== 'string' || !templateId.trim()) throw new TypeError('templateId must be a non-empty string');
  const template = WORKFLOW_TEMPLATES.find(item => item.id === templateId);
  if (!template) throw new RangeError(`Unknown template: ${templateId}`);
  return {
    name: template.name,
    agentsDecide: template.agentsDecide,
    progressFile: template.progressFile,
    nodes: template.nodes.map(({ name, prompt, repeat, readOnly, approval }) => ({ name, agentId: '', prompt, repeat: { ...repeat }, readOnly, approval })),
  };
}
