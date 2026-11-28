import { randomUUID } from 'node:crypto';
import { validateWorkflowBody, isProgressFileTemplate, isUuid, loopTargetIndex, WORKFLOW_KINDS, DESCRIPTION_MAX } from '../../shared/pipeline-definitions.mjs';
import { WORKFLOW_TEMPLATES, PREVIOUS_BUG_FIX_PROMPTS, PREVIOUS_VERIFICATION_PROMPTS } from '../../shared/workflow-templates.mjs';
import { canonicalDefinition } from '../../shared/workflow-changes.mjs';
import { isUuidV4 } from '../../shared/workflow-package.mjs';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const SINGLE_LINE = /[\x00-\x1f\x7f]/;
const SOURCE_KINDS = ['local', 'builtin', 'imported'];
const BUILT_IN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_VERSION_MAX = 2 ** 31 - 1;

function fieldError(id, field, message) {
  throw new Error(`pipeline_workflows row ${id} field ${field}: ${message}`);
}

const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    return false;
  }
  // Date.parse rolls an impossible date over (Feb 30 becomes Mar 2), so the
  // calendar components must form a real date on their own.
  const parts = ISO_PARTS.exec(value);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return Boolean(daysInMonth) && day >= 1 && day <= daysInMonth
    && Number(parts[4]) <= 23 && Number(parts[5]) <= 59 && Number(parts[6]) <= 59;
}

function requireIso(id, field, value) {
  if (!isIsoTimestamp(value)) {
    fieldError(id, field, 'must be an ISO-8601 timestamp');
  }
  return value;
}

function requireName(id, value) {
  if (typeof value !== 'string') fieldError(id, 'name', 'must be a string');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64 || SINGLE_LINE.test(value) || trimmed !== value) {
    fieldError(id, 'name', 'must be 1–64 trimmed single-line characters');
  }
  return trimmed;
}

function requireRevision(id, value) {
  if (!Number.isInteger(value) || value < 1) {
    fieldError(id, 'revision', 'must be an integer ≥ 1');
  }
  return value;
}

function requireFlag(id, field, value) {
  if (value !== 0 && value !== 1) fieldError(id, field, 'must be 0 or 1');
  return value === 1;
}

function requireProgressFile(id, value) {
  if (value === null) return null;
  if (!isProgressFileTemplate(value) || value.trim() !== value) fieldError(id, 'progress_file', 'must be a trimmed relative Markdown path');
  return value;
}

function requireKind(id, value) {
  if (!WORKFLOW_KINDS.includes(value)) fieldError(id, 'kind', `must be one of ${WORKFLOW_KINDS.join(', ')}`);
  return value;
}

function requireDescription(id, value) {
  if (typeof value !== 'string' || value.length > DESCRIPTION_MAX || SINGLE_LINE.test(value) || value.trim() !== value) {
    fieldError(id, 'description', `must be up to ${DESCRIPTION_MAX} trimmed single-line characters`);
  }
  return value;
}

function requireSourceKind(id, value) {
  if (!SOURCE_KINDS.includes(value)) fieldError(id, 'source_kind', `must be one of ${SOURCE_KINDS.join(', ')}`);
  return value;
}

function requireSourceId(id, kind, value) {
  if (kind === 'local') {
    if (value !== null) fieldError(id, 'source_id', 'must be null for a local workflow');
    return null;
  }
  if (kind === 'builtin') {
    if (typeof value !== 'string' || value.length < 1 || value.length > 64 || !BUILT_IN_ID.test(value)) {
      fieldError(id, 'source_id', 'must be a 1–64 character slug of lower-case letters, digits and dashes');
    }
    return value;
  }
  if (!isUuidV4(value)) fieldError(id, 'source_id', 'must be a UUID v4');
  return value;
}

function requireSourceVersion(id, kind, value) {
  if (kind === 'local') {
    if (value !== null) fieldError(id, 'source_version', 'must be null for a local workflow');
    return null;
  }
  if (!Number.isInteger(value) || value < 1 || value > SOURCE_VERSION_MAX) {
    fieldError(id, 'source_version', `must be an integer 1–${SOURCE_VERSION_MAX}`);
  }
  return value;
}

function requireSourceBase(id, kind, value) {
  if (kind === 'local') {
    if (value !== null) fieldError(id, 'source_base', 'must be null for a local workflow');
    return null;
  }
  if (value === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fieldError(id, 'source_base', 'must be valid JSON');
  }
  const errors = validateWorkflowBody(parsed, { template: true });
  if (errors.length) fieldError(id, 'source_base', errors[0].message);
  return parsed;
}

function requireSourceUpdatedAt(id, value) {
  if (value === null) return null;
  return requireIso(id, 'source_updated_at', value);
}

function parseNodes(id, raw) {
  let nodes;
  try {
    nodes = JSON.parse(raw);
  } catch {
    fieldError(id, 'nodes', 'must be valid JSON');
  }
  const errors = validateWorkflowBody({ name: 'x', agentsDecide: false, nodes });
  const nodeErrors = errors.filter(e => e.field === 'nodes' || e.field.startsWith('nodes['));
  if (nodeErrors.length) {
    fieldError(id, 'nodes', nodeErrors[0].message);
  }
  nodes.forEach((node, index) => {
    if (typeof node.role !== 'string') fieldError(id, `nodes[${index}].role`, 'must be a string');
    if (typeof node.askOwner !== 'boolean') fieldError(id, `nodes[${index}].askOwner`, 'must be true or false');
    if (node.enabled !== undefined && typeof node.enabled !== 'boolean') fieldError(id, `nodes[${index}].enabled`, 'must be true or false');
  });
  return nodes;
}

function assertValidBody(body, { revisionRequired }) {
  const errors = validateWorkflowBody(body, { revisionRequired });
  if (errors.length) {
    const first = errors[0];
    throw new Error(`pipeline_workflows: ${first.field}: ${first.message}`);
  }
}

function hydrate(row) {
  const id = row.id;
  if (!isUuid(id)) fieldError(id ?? 'unknown', 'id', 'must be a UUID v4');
  const record = {
    id,
    name: requireName(id, row.name),
    description: requireDescription(id, row.description),
    kind: requireKind(id, row.kind),
    agentsDecide: requireFlag(id, 'agents_decide', row.agents_decide),
    progressFile: requireProgressFile(id, row.progress_file),
    nodes: parseNodes(id, row.nodes),
    revision: requireRevision(id, row.revision),
    createdAt: requireIso(id, 'created_at', row.created_at),
    updatedAt: requireIso(id, 'updated_at', row.updated_at),
    source: {
      kind: requireSourceKind(id, row.source_kind),
      id: null,
      version: null,
      base: null,
      updatedAt: null,
    },
  };
  const kind = record.source.kind;
  record.source.id = requireSourceId(id, kind, row.source_id);
  record.source.version = requireSourceVersion(id, kind, row.source_version);
  record.source.base = requireSourceBase(id, kind, row.source_base);
  record.source.updatedAt = requireSourceUpdatedAt(id, row.source_updated_at);
  return record;
}

function isUniqueConflict(err) {
  return err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(err.message));
}

function normalizeRepeat(nodes, index) {
  const { repeat } = nodes[index];
  if (repeat.mode === 'once') return { mode: 'once' };
  if (repeat.mode === 'until_complete') return { mode: 'until_complete', max: repeat.max };
  // A loop is stored under the name of the node it returns to, as that node is stored.
  return { mode: 'loop_back', to: nodes[loopTargetIndex(nodes, index)].name.trim(), max: repeat.max };
}

/**
 * The definition a built-in workflow is saved, linked and compared from (Spec §5.1):
 * the template's body without agents. Every step travels with its role; the team
 * supplies the agent when a run starts.
 */
export function builtinTemplateDefinition(template) {
  if (template === null || typeof template !== 'object' || Array.isArray(template)) {
    throw new TypeError('builtinTemplateDefinition: a template object is required');
  }
  if (!Number.isInteger(template.version) || template.version < 1) {
    throw new TypeError(`builtinTemplateDefinition: template ${template.id ?? 'unknown'} needs an integer version ≥ 1`);
  }
  const definition = {
    name: template.name,
    description: template.description,
    kind: template.kind,
    agentsDecide: template.agentsDecide,
    progressFile: template.progressFile,
    nodes: (template.nodes ?? []).map(node => ({
      name: node?.name,
      role: node?.role,
      prompt: node?.prompt,
      repeat: node?.repeat === undefined ? undefined : { ...node.repeat },
      readOnly: node?.readOnly,
      approval: node?.approval,
      askOwner: node?.askOwner,
      ...(node?.enabled === undefined ? {} : { enabled: node.enabled }),
    })),
  };
  const errors = validateWorkflowBody(definition, { template: true });
  if (errors.length) {
    throw new TypeError(`builtinTemplateDefinition: template ${template.id ?? 'unknown'} is not a valid definition: ${errors[0].field} ${errors[0].message}`);
  }
  return definition;
}

/** Definitions compare without the workflow's own name: the name is the owner's (§6.2). */
function canonicalWithoutName(definition) {
  return JSON.stringify({ ...canonicalDefinition(definition), name: '' });
}

function normalizeNodes(nodes) {
  return nodes.map((node, index) => ({
    name: node.name.trim(),
    role: node.role.trim(),
    prompt: node.prompt,
    repeat: normalizeRepeat(nodes, index),
    readOnly: node.readOnly ?? false,
    approval: node.approval ?? false,
    askOwner: node.askOwner ?? false,
    ...(node.enabled === false ? { enabled: false } : {}),
  }));
}

export function createWorkflowStore(db, { now = () => new Date().toISOString() } = {}) {
  if (!db) throw new Error('pipeline_workflows: a database handle is required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nodes TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      agents_decide INTEGER NOT NULL DEFAULT 0,
      progress_file TEXT,
      kind TEXT NOT NULL DEFAULT 'other',
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pipeline_workflows_name_ci
      ON pipeline_workflows (lower(name));
  `);
  // Workflows saved before agents could decide for themselves left every decision to the owner.
  if (!db.prepare('PRAGMA table_info(pipeline_workflows)').all().some(column => column.name === 'agents_decide')) {
    db.exec('ALTER TABLE pipeline_workflows ADD COLUMN agents_decide INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare('PRAGMA table_info(pipeline_workflows)').all().some(column => column.name === 'progress_file')) {
    db.exec('ALTER TABLE pipeline_workflows ADD COLUMN progress_file TEXT');
  }

  // Workflows saved before kinds and descriptions existed have neither.
  if (!db.prepare('PRAGMA table_info(pipeline_workflows)').all().some(column => column.name === 'kind')) {
    db.exec("ALTER TABLE pipeline_workflows ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'");
  }
  if (!db.prepare('PRAGMA table_info(pipeline_workflows)').all().some(column => column.name === 'description')) {
    db.exec("ALTER TABLE pipeline_workflows ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }

  // Workflows saved before sources were remembered have none: they are local.
  const workflowColumns = () => db.prepare('PRAGMA table_info(pipeline_workflows)').all().map(column => column.name);
  if (!workflowColumns().includes('source_kind')) {
    db.exec("ALTER TABLE pipeline_workflows ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'local'");
  }
  if (!workflowColumns().includes('source_id')) {
    db.exec('ALTER TABLE pipeline_workflows ADD COLUMN source_id TEXT');
  }
  if (!workflowColumns().includes('source_version')) {
    db.exec('ALTER TABLE pipeline_workflows ADD COLUMN source_version INTEGER');
  }
  if (!workflowColumns().includes('source_base')) {
    db.exec('ALTER TABLE pipeline_workflows ADD COLUMN source_base TEXT');
  }
  if (!workflowColumns().includes('source_updated_at')) {
    db.exec('ALTER TABLE pipeline_workflows ADD COLUMN source_updated_at TEXT');
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS pipeline_workflows_source
    ON pipeline_workflows (source_kind, source_id) WHERE source_kind <> 'local'`);
  // A dismissed built-in is never offered as new again — not even when the linked
  // workflow that caused the dismissal is deleted (§4.2, §5.1).
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_builtin_dismissals (
      template_id TEXT PRIMARY KEY,
      dismissed_at TEXT NOT NULL
    );
  `);
  // The one-time linking of saved workflows to built-ins (§5.4) runs once per database.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_workflow_source_link (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      linked_at TEXT NOT NULL
    );
  `);

  const currentVerificationPrompt = (templateId, stepName) => WORKFLOW_TEMPLATES
    .find(template => template.id === templateId).nodes.find(node => node.name === stepName).prompt;
  const quickChangeTest = currentVerificationPrompt('quick-change', 'Review & Test');
  const troubleshootVerify = currentVerificationPrompt('troubleshoot', 'Verify');

  // Linked copies use the versioned update path so its comparison keeps the original base.
  const LOCAL_VERIFICATION_PROMPT_UPGRADES = new Map([
    [PREVIOUS_VERIFICATION_PROMPTS['bug-fix'], currentVerificationPrompt('bug-fix', 'Test')],
    [PREVIOUS_VERIFICATION_PROMPTS['quick-change'], quickChangeTest],
    [PREVIOUS_VERIFICATION_PROMPTS.troubleshoot, troubleshootVerify],
    [PREVIOUS_VERIFICATION_PROMPTS.unphasedBugFix, PREVIOUS_BUG_FIX_PROMPTS.Test],
  ]);

  const builtInPrompt = (templateId, name) => WORKFLOW_TEMPLATES.find(template => template.id === templateId).nodes.find(item => item.name === name).prompt;
  const STOCK_PROMPT_UPGRADES = new Map([
    [
      'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown.',
      'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. Check whether any referenced or read-only repository must change; if a repository is missing from this task\'s worktrees, ask to add it in this same NEEDS_INPUT pass. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown.',
    ],
    [
      'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown. Record the agreed acceptance checks in your note, including how each outcome will be verified and which checks need external evidence.',
      'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. Check whether any referenced or read-only repository must change; if a repository is missing from this task\'s worktrees, ask to add it in this same NEEDS_INPUT pass. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown. Record the agreed acceptance checks in your note. For each, say how an agent will verify it itself on this machine: the command, or the app run from the worktree with test data, a test sign-in, an emulator or simulator. Mark a check owner-only only when it needs what no agent here can have (a physical device, a real account or recipient, production); give the reason and what an agent will verify of it instead, and list these under the heading Owner checks, each with what the owner should do and expect. The owner carries them out after the run; no step waits for them.',
    ],
    [
      'Read {input} and restate what is being asked for in your own words. Change nothing. Check that you know who it is for and what they need to do with it, what it must do in each case including errors and empty states, what is out of scope, what existing behaviour must stay the same, and how it will be shown to work. First look for each of these yourself in the code, the documents and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the requirements as you now understand them, what you found yourself, what the owner told you, and what is still open.',
      'Read {input} and restate what is being asked for in your own words. Change nothing. Check that you know who it is for and what they need to do with it, what it must do in each case including errors and empty states, what is out of scope, what existing behaviour must stay the same, and how it will be shown to work. Check whether any referenced or read-only repository must change; if a repository is missing from this task\'s worktrees, ask to add it in this same NEEDS_INPUT pass. First look for each of these yourself in the code, the documents and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the requirements as you now understand them, what you found yourself, what the owner told you, and what is still open.',
    ],
    [
      'Review all changes on this branch (both uncommitted changes and any commits since the base commit) against the Specify note. Fix every defect you find and record your findings and fixes.',
      'Review the changes on this branch (both uncommitted changes and any commits since the base commit) against the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified work. Fix every defect you find, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record your findings and fixes.',
    ],
    [
      'Review the changes on this branch (both uncommitted changes and any commits since the base commit) against the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified work. Fix every defect you find and record your findings and fixes.',
      'Review the changes on this branch (both uncommitted changes and any commits since the base commit) against the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified work. Fix every defect you find, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record your findings and fixes.',
    ],
    [
      'Review all feature changes on this branch (both uncommitted changes and any commits since the base commit) against plan.md and the task. Fix every defect and record findings and fixes.',
      'Review the feature changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the task. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record findings and fixes.',
    ],
    [
      'Review the feature changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the task. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect and record findings and fixes.',
      'Review the feature changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the task. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record findings and fixes.',
    ],
    [
      'Review all feature changes on this branch (both uncommitted changes and any commits since the base commit) against plan.md and the specification named in the Specify note. Fix every defect and record findings and fixes.',
      'Review the feature changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the specification named in the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record findings and fixes.',
    ],
    [
      'Review the feature changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the specification named in the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect and record findings and fixes.',
      'Review the feature changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the specification named in the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect, do not run broad test suites that the Test step will run next (run a targeted test only when needed to verify a defect you fixed yourself), and record findings and fixes.',
    ],
    [
      'Read the Requirements note. Write the specification for {input} as a Markdown file beside the specifications this project already keeps, following their conventions; if it keeps none, put the file in its docs folder. Cover the behaviour in each case, the rules and their edge cases, changes to data and interfaces, what must stay the same, what is out of scope, and acceptance checks that can be tested. Change no code. In your run note give the path of the file, summarise the specification, and list every decision you made that the requirements did not settle.',
      'Read the Requirements note and the code it touches. Write the specification for {input} as a Markdown file beside the specifications this project already keeps, following their conventions; if it keeps none, put the file in its docs folder. Cover the behaviour in each case, the rules and their edge cases, changes to data and interfaces, what must stay the same, what is out of scope, and acceptance checks that can be tested. Then write plan.md in the run notes folder named by its README. Size the plan to the change: work one developer can build and test in a single sitting is one phase. Add a phase only for a further piece of working behaviour that builds on the one before it, never a phase that only checks or adds tests, and use at most 4 phases. Put each acceptance check as a task in the phase that builds what it checks. Say in each such task how an agent will verify it itself on this machine. A check that needs what no agent here can have (a physical device, a real account or recipient, production) is owner-only and is not a task: list it under ## Owner checks at the end of plan.md as a plain bullet without a box, with the reason, what the owner should do and expect, and what an agent verifies of it instead. The owner carries these out after the run; no step waits for them. Use ## Phase N: <title> sections with - [ ] tasks. The phases together must cover every acceptance check. Change no code. In your run note give the path of the file, summarise the specification and the plan, say why it has as many phases as it has, and list every decision you made that the requirements did not settle.',
    ],
    [
      'Test the phase just built. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. When none is left, run the full test suite once, across the whole project. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
      'Test the phase just built. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. Set up what a check needs yourself (the app run from the worktree, test data, a test sign-in, an emulator or simulator); do not ask the owner for an environment or for evidence you can produce. The Owner checks in plan.md do not wait: verify what an agent can of each and repeat them in your note with what the owner should do and expect. If an unticked task turns out to need what no agent here can have, or an artifact from a later step, use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether it becomes an owner check; when the owner says so, move it to Owner checks in plan.md. Do not repeat passing tests on an unchanged diff. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
    ],
    [
      'Test the phase just built. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. If an unticked check is waiting for owner evidence or an artifact from a later step, use NEEDS_INPUT with the evidence collected so far to obtain the owner evidence or an explicit owner deferral instead of repeating passing tests on an unchanged diff. When none is left, run the full test suite once, across the whole project. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
      'Test the phase just built. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. Set up what a check needs yourself (the app run from the worktree, test data, a test sign-in, an emulator or simulator); do not ask the owner for an environment or for evidence you can produce. The Owner checks in plan.md do not wait: verify what an agent can of each and repeat them in your note with what the owner should do and expect. If an unticked task turns out to need what no agent here can have, or an artifact from a later step, use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether it becomes an owner check; when the owner says so, move it to Owner checks in plan.md. Do not repeat passing tests on an unchanged diff. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
    ],
    [
      'Test the phase just built against the acceptance checks in the specification named in the Specify note. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. When none is left, run the full test suite once, across the whole project. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
      'Test the phase just built against the acceptance checks in the specification named in the Specify note. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. Set up what a check needs yourself (the app run from the worktree, test data, a test sign-in, an emulator or simulator); do not ask the owner for an environment or for evidence you can produce. The Owner checks in plan.md do not wait: verify what an agent can of each and repeat them in your note with what the owner should do and expect. If an unticked task turns out to need what no agent here can have, or an artifact from a later step, use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether it becomes an owner check; when the owner says so, move it to Owner checks in plan.md. Do not repeat passing tests on an unchanged diff. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
    ],
    [
      'Test the phase just built against the acceptance checks in the specification named in the Specify note. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. If an unticked check is waiting for owner evidence or an artifact from a later step, use NEEDS_INPUT with the evidence collected so far to obtain the owner evidence or an explicit owner deferral instead of repeating passing tests on an unchanged diff. When none is left, run the full test suite once, across the whole project. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
      'Test the phase just built against the acceptance checks in the specification named in the Specify note. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. Set up what a check needs yourself (the app run from the worktree, test data, a test sign-in, an emulator or simulator); do not ask the owner for an environment or for evidence you can produce. The Owner checks in plan.md do not wait: verify what an agent can of each and repeat them in your note with what the owner should do and expect. If an unticked task turns out to need what no agent here can have, or an artifact from a later step, use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether it becomes an owner check; when the owner says so, move it to Owner checks in plan.md. Do not repeat passing tests on an unchanged diff. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
    ],
    // Built-in prompts from before agents owned the test environment and owner-only checks stopped pausing a run.
    [
      'Read the Analyse note. In your run note specify the fix for {input}: the behaviour to change, what must stay the same, likely files, and tests that will prove it. Change no code. Record the agreed acceptance checks in your note, including how each outcome will be verified and which checks need external evidence.',
      'Read the Analyse note. In your run note specify the fix for {input}: the behaviour to change, what must stay the same, likely files, and tests that will prove it. Change no code. Record the agreed acceptance checks in your note. For each, say how an agent will verify it itself on this machine: the command, or the app run from the worktree with test data, a test sign-in, an emulator or simulator. Mark a check owner-only only when it needs what no agent here can have (a physical device, a real account or recipient, production); give the reason and what an agent will verify of it instead, and list these under the heading Owner checks, each with what the owner should do and expect. The owner carries them out after the run; no step waits for them.',
    ],
    [
      'Run tests covering the change and the agreed checks from the Specify note. Start your note with a one-line outcome that says what changed. List the agreed checks and evidence for each. For a failed agreed check, missing in-scope implementation, or a new regression, record the reproduction and work needed and report CONTINUE. For an apparently unrelated failure, run the same command on the recorded base commit under equivalent conditions. Record both revisions, the command and matching failure before treating it as pre-existing. When the cause is uncertain, run the smallest comparison that distinguishes it. If still unresolved, use NEEDS_INPUT with the evidence and a specific question. When implementation exists but proof needs a device, account or other external access, use NEEDS_INPUT. Say what passed, what is pending and exactly what would verify it (for example, "Backend verified. Phone prompt pending."). Only the owner may explicitly defer a check or narrow scope. Record their decision verbatim. Report COMPLETE only when every agreed check has evidence or an explicit owner-approved scope change.',
      PREVIOUS_BUG_FIX_PROMPTS.Test,
    ],
    [
      'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically. Commit all work in the worktree to the current branch with a message describing the fix for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. In your final note carry forward the verified outcome, evidence for each agreed check and any owner-approved deferrals, followed by each repository, branch and HEAD.',
      'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically. Commit all work in the worktree to the current branch with a message describing the fix for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. In your final note carry forward the verified outcome, evidence for each agreed check, any owner-approved deferrals and, under the heading Owner checks, every check the owner still has to carry out with what to do and expect, followed by each repository, branch and HEAD.',
    ],
    [
      'Read {input} and the code it touches. Change nothing. Check whether any referenced or read-only repository must change, what behaviour must change, what must stay the same, likely files, and tests that will prove it. First look for each of these yourself in the code and documents. For anything you could not find and cannot safely assume, or if a repository is missing from this task\'s worktrees, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the scope and likely files. Record the agreed acceptance checks in your note, including how each outcome will be verified and which checks need external evidence.',
      'Read {input} and the code it touches. Change nothing. Check whether any referenced or read-only repository must change, what behaviour must change, what must stay the same, likely files, and tests that will prove it. First look for each of these yourself in the code and documents. For anything you could not find and cannot safely assume, or if a repository is missing from this task\'s worktrees, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the scope and likely files. Record the agreed acceptance checks in your note. For each, say how an agent will verify it itself on this machine: the command, or the app run from the worktree with test data, a test sign-in, an emulator or simulator. Mark a check owner-only only when it needs what no agent here can have (a physical device, a real account or recipient, production); give the reason and what an agent will verify of it instead, and list these under the heading Owner checks, each with what the owner should do and expect. The owner carries them out after the run; no step waits for them.',
    ],
    [
      'Review the changes on this branch against the Scope note, fix any defect you find, and run tests covering the change and the agreed checks from the Scope note. On a repeat pass, read your previous note and focus on what changed since that pass. Start your note with a one-line outcome that says what changed. List the agreed checks and evidence for each. For a failed agreed check, missing in-scope implementation, or a new regression, record the reproduction and work needed and report CONTINUE. For an apparently unrelated failure, run the same command on the recorded base commit under equivalent conditions. Record both revisions, the command and matching failure before treating it as pre-existing. When the cause is uncertain, run the smallest comparison that distinguishes it. If still unresolved, use NEEDS_INPUT with the evidence and a specific question. When implementation exists but proof needs a device, account or other external access, use NEEDS_INPUT. Say what passed, what is pending and exactly what would verify it (for example, "Backend verified. Phone prompt pending."). Only the owner may explicitly defer a check or narrow scope. Record their decision verbatim. Report COMPLETE only when every agreed check has evidence or an explicit owner-approved scope change.',
      quickChangeTest,
    ],
    [
      'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically. Commit all work in the worktree to the current branch with a message describing the change for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. In your final note carry forward the verified outcome, evidence for each agreed check and any owner-approved deferrals, followed by each repository, branch and HEAD.',
      'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically. Commit all work in the worktree to the current branch with a message describing the change for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. In your final note carry forward the verified outcome, evidence for each agreed check, any owner-approved deferrals and, under the heading Owner checks, every check the owner still has to carry out with what to do and expect, followed by each repository, branch and HEAD.',
    ],
    [
      'Read what {input} asks for and the code it touches. Change no code. Write plan.md in the run notes folder named by its README. Size the plan to the change: work one developer can build and test in a single sitting is one phase. Add a phase only for a further piece of working behaviour that builds on the one before it, never a phase that only checks or adds tests, and use at most 4 phases. Put each acceptance check as a task in the phase that builds what it checks. Use ## Phase N: <title> sections with - [ ] tasks. In your run note summarise the plan and say why it has as many phases as it has.',
      'Read what {input} asks for and the code it touches. Change no code. Write plan.md in the run notes folder named by its README. Size the plan to the change: work one developer can build and test in a single sitting is one phase. Add a phase only for a further piece of working behaviour that builds on the one before it, never a phase that only checks or adds tests, and use at most 4 phases. Put each acceptance check as a task in the phase that builds what it checks. Say in each such task how an agent will verify it itself on this machine. A check that needs what no agent here can have (a physical device, a real account or recipient, production) is owner-only and is not a task: list it under ## Owner checks at the end of plan.md as a plain bullet without a box, with the reason, what the owner should do and expect, and what an agent verifies of it instead. The owner carries these out after the run; no step waits for them. Use ## Phase N: <title> sections with - [ ] tasks. In your run note summarise the plan and say why it has as many phases as it has.',
    ],
    [
      'Test the phase just built. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. If an unticked check is waiting for owner evidence or an artifact from a later step, use NEEDS_INPUT with the evidence collected so far to obtain the owner evidence or an explicit owner deferral instead of repeating passing tests on an unchanged diff. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
      'Test the phase just built. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. Set up what a check needs yourself (the app run from the worktree, test data, a test sign-in, an emulator or simulator); do not ask the owner for an environment or for evidence you can produce. The Owner checks in plan.md do not wait: verify what an agent can of each and repeat them in your note with what the owner should do and expect. If an unticked task turns out to need what no agent here can have, or an artifact from a later step, use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether it becomes an owner check; when the owner says so, move it to Owner checks in plan.md. Do not repeat passing tests on an unchanged diff. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
    ],
    [
      'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically. Commit all work in the worktree to the current branch with a message describing the feature for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. In your final note carry forward the verified outcome, evidence for each agreed check and any owner-approved deferrals, followed by each repository, branch and HEAD.',
      'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically. Commit all work in the worktree to the current branch with a message describing the feature for {input}. Include untracked files. Do not push. Finish only when git status shows a clean tree. In your final note carry forward the verified outcome, evidence for each agreed check, any owner-approved deferrals and, under the heading Owner checks, every check the owner still has to carry out with what to do and expect, followed by each repository, branch and HEAD.',
    ],
    [
      'Read the Requirements note and the code it touches. Write the specification for {input} as a Markdown file beside the specifications this project already keeps, following their conventions; if it keeps none, put the file in its docs folder. Cover the behaviour in each case, the rules and their edge cases, changes to data and interfaces, what must stay the same, what is out of scope, and acceptance checks that can be tested. Then write plan.md in the run notes folder named by its README. Size the plan to the change: work one developer can build and test in a single sitting is one phase. Add a phase only for a further piece of working behaviour that builds on the one before it, never a phase that only checks or adds tests, and use at most 4 phases. Put each acceptance check as a task in the phase that builds what it checks. Use ## Phase N: <title> sections with - [ ] tasks. The phases together must cover every acceptance check. Change no code. In your run note give the path of the file, summarise the specification and the plan, say why it has as many phases as it has, and list every decision you made that the requirements did not settle.',
      'Read the Requirements note and the code it touches. Write the specification for {input} as a Markdown file beside the specifications this project already keeps, following their conventions; if it keeps none, put the file in its docs folder. Cover the behaviour in each case, the rules and their edge cases, changes to data and interfaces, what must stay the same, what is out of scope, and acceptance checks that can be tested. Then write plan.md in the run notes folder named by its README. Size the plan to the change: work one developer can build and test in a single sitting is one phase. Add a phase only for a further piece of working behaviour that builds on the one before it, never a phase that only checks or adds tests, and use at most 4 phases. Put each acceptance check as a task in the phase that builds what it checks. Say in each such task how an agent will verify it itself on this machine. A check that needs what no agent here can have (a physical device, a real account or recipient, production) is owner-only and is not a task: list it under ## Owner checks at the end of plan.md as a plain bullet without a box, with the reason, what the owner should do and expect, and what an agent verifies of it instead. The owner carries these out after the run; no step waits for them. Use ## Phase N: <title> sections with - [ ] tasks. The phases together must cover every acceptance check. Change no code. In your run note give the path of the file, summarise the specification and the plan, say why it has as many phases as it has, and list every decision you made that the requirements did not settle.',
    ],
    [
      'Test the phase just built against the acceptance checks in the specification named in the Specify note. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. If an unticked check is waiting for owner evidence or an artifact from a later step, use NEEDS_INPUT with the evidence collected so far to obtain the owner evidence or an explicit owner deferral instead of repeating passing tests on an unchanged diff. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
      'Test the phase just built against the acceptance checks in the specification named in the Specify note. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. Set up what a check needs yourself (the app run from the worktree, test data, a test sign-in, an emulator or simulator); do not ask the owner for an environment or for evidence you can produce. The Owner checks in plan.md do not wait: verify what an agent can of each and repeat them in your note with what the owner should do and expect. If an unticked task turns out to need what no agent here can have, or an artifact from a later step, use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether it becomes an owner check; when the owner says so, move it to Owner checks in plan.md. Do not repeat passing tests on an unchanged diff. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
    ],
    [
      'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically. Commit all work in the worktree to the current branch with a message describing the feature for {input}. Include the specification and untracked files. Do not push. Finish only when git status shows a clean tree. In your final note carry forward the verified outcome, evidence for each agreed check and any owner-approved deferrals, followed by each repository, branch and HEAD.',
      'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically. Commit all work in the worktree to the current branch with a message describing the feature for {input}. Include the specification and untracked files. Do not push. Finish only when git status shows a clean tree. In your final note carry forward the verified outcome, evidence for each agreed check, any owner-approved deferrals and, under the heading Owner checks, every check the owner still has to carry out with what to do and expect, followed by each repository, branch and HEAD.',
    ],
    [
      'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. Check whether any referenced or read-only repository must change; if a repository is missing from this task\'s worktrees, ask to add it in this same NEEDS_INPUT pass. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown. Record the agreed acceptance checks in your note, including how each outcome will be verified and which checks need external evidence.',
      'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. Check whether any referenced or read-only repository must change; if a repository is missing from this task\'s worktrees, ask to add it in this same NEEDS_INPUT pass. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown. Record the agreed acceptance checks in your note. For each, say how an agent will verify it itself on this machine: the command, or the app run from the worktree with test data, a test sign-in, an emulator or simulator. Mark a check owner-only only when it needs what no agent here can have (a physical device, a real account or recipient, production); give the reason and what an agent will verify of it instead, and list these under the heading Owner checks, each with what the owner should do and expect. The owner carries them out after the run; no step waits for them.',
    ],
    [
      'Read the agreed checks in the Clarify note. Repeat the original symptom check from the Investigate note, run the Prove test and tests around the change. Start your note with a one-line outcome that says what changed. List the agreed checks and evidence for each. For a failed agreed check, missing in-scope implementation, or a new regression, record the reproduction and work needed and report CONTINUE. For an apparently unrelated failure, run the same command on the recorded base commit under equivalent conditions. Record both revisions, the command and matching failure before treating it as pre-existing. When the cause is uncertain, run the smallest comparison that distinguishes it. If still unresolved, use NEEDS_INPUT with the evidence and a specific question. When implementation exists but proof needs a device, account or other external access, use NEEDS_INPUT. Say what passed, what is pending and exactly what would verify it (for example, "Backend verified. Phone prompt pending."). Only the owner may explicitly defer a check or narrow scope. Record their decision verbatim. Report COMPLETE only when every agreed check has evidence or an explicit owner-approved scope change.',
      troubleshootVerify,
    ],
    [
      'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically. Commit all work in the worktree to the current branch with a message naming the cause of {input} and the fix. Include untracked files. Do not push. Finish only when git status shows a clean tree. In your final note carry forward the verified outcome, evidence for each agreed check and any owner-approved deferrals, followed by each repository, branch and HEAD.',
      'Before committing, update CHANGELOG.md with the date and a full description of the changes, and write the same entry to its own file under docs/releases/ (creating docs/releases/ if it does not exist) named YYYY-MM-DD-HHmmss-<short-slug>.md using the current date and time so release files sort chronologically. Commit all work in the worktree to the current branch with a message naming the cause of {input} and the fix. Include untracked files. Do not push. Finish only when git status shows a clean tree. In your final note carry forward the verified outcome, evidence for each agreed check, any owner-approved deferrals and, under the heading Owner checks, every check the owner still has to carry out with what to do and expect, followed by each repository, branch and HEAD.',
    ],
    // The three build workflows from before Test repaired a test-only or evidence-only gap itself instead of sending it back for a round.
    [
      'Read the todo file docs/{input}, its session notes and the specification it names. Build the first phase in it with unticked tasks, and only that phase. Write failing tests first, make them pass, tick each task when done, add to the todo\'s session notes what the next round needs to know, leave changes uncommitted for Review and Test (do not run git commit), and record what changed.',
      builtInPrompt('feature-build-from-spec', 'Develop'),
    ],
    [
      'Test the phase just built in the todo file docs/{input} against the acceptance checks of the specification it names. Untick any task that does not hold. While a phase in the todo still has unticked tasks, run only the tests for that phase. Set up what a check needs yourself (the app run from the worktree, test data, a test sign-in, an emulator or simulator); do not ask the owner for an environment or for evidence you can produce. If an unticked task turns out to need what no agent here can have (a physical device, a real account or recipient, production), use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether the owner will check it themselves; when the owner says so, tick it, mark it "owner check" in the todo and list it in your note with what the owner should do and expect. Do not repeat passing tests on an unchanged diff. When no phase has unticked tasks, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in the todo has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
      builtInPrompt('feature-build-from-spec', 'Test'),
    ],
    [
      'Build the first phase in plan.md with unticked tasks. Write failing tests first, make them pass, tick each task when done, leave changes uncommitted for Review and Commit (do not run git commit), and record what changed.',
      builtInPrompt('feature-build', 'Develop'),
    ],
    [
      'Test the phase just built. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. Set up what a check needs yourself (the app run from the worktree, test data, a test sign-in, an emulator or simulator); do not ask the owner for an environment or for evidence you can produce. The Owner checks in plan.md do not wait: verify what an agent can of each and repeat them in your note with what the owner should do and expect. If an unticked task turns out to need what no agent here can have, or an artifact from a later step, use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether it becomes an owner check; when the owner says so, move it to Owner checks in plan.md. Do not repeat passing tests on an unchanged diff. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
      builtInPrompt('feature-build', 'Test'),
    ],
    [
      'Build the first phase in plan.md with unticked tasks, following the specification named in the Specify note. Write failing tests first, make them pass, tick each task when done, leave changes uncommitted for Review and Commit (do not run git commit), and record what changed.',
      builtInPrompt('feature-from-requirements', 'Develop'),
    ],
    [
      'Test the phase just built against the acceptance checks in the specification named in the Specify note. Untick any task that does not hold. While a phase in plan.md still has unticked tasks, run only the tests for that phase. Set up what a check needs yourself (the app run from the worktree, test data, a test sign-in, an emulator or simulator); do not ask the owner for an environment or for evidence you can produce. The Owner checks in plan.md do not wait: verify what an agent can of each and repeat them in your note with what the owner should do and expect. If an unticked task turns out to need what no agent here can have, or an artifact from a later step, use NEEDS_INPUT once with what you tried and the evidence collected so far, and ask whether it becomes an owner check; when the owner says so, move it to Owner checks in plan.md. Do not repeat passing tests on an unchanged diff. When none is left, run the full test suite once for each repository with code changes, one suite at a time and never in parallel. Report CONTINUE while any phase in plan.md has unticked tasks. Report COMPLETE only when every task is ticked and the full test suite passes.',
      builtInPrompt('feature-from-requirements', 'Test'),
    ],
  ]);

  // An older stock prompt maps to the one after it; follow the chain so it reaches the newest in one start.
  function upgradedStockPrompt(prompt) {
    let current = STOCK_PROMPT_UPGRADES.get(prompt);
    for (let hops = 0; current !== undefined && STOCK_PROMPT_UPGRADES.has(current); hops += 1) {
      if (hops >= STOCK_PROMPT_UPGRADES.size) throw new Error('stock prompt upgrades form a cycle');
      current = STOCK_PROMPT_UPGRADES.get(current);
    }
    return current;
  }

  const STOCK_FEATURE_FROM_REQ_PLAN_PROMPT = 'Read the specification named in the Specify note and the code it touches. Change no code. Write plan.md in the run notes folder named by its README. Size the plan to the change: work one developer can build and test in a single sitting is one phase. Add a phase only for a further piece of working behaviour that builds on the one before it, never a phase that only checks or adds tests, and use at most 4 phases. Put each acceptance check as a task in the phase that builds what it checks. Use ## Phase N: <title> sections with - [ ] tasks. The phases together must cover every acceptance check. In your run note summarise the plan and say why it has as many phases as it has.';

  // A Bug fix still holding the unchanged Specify, Develop, Review and Test from before it was phased
  // gets all four phased prompts and a Test loop of 8 rounds. They change only together: a phased
  // Develop after an owner's own Specify would look for a plan.md nobody writes. Changes nodes in place.
  const PHASED_BUG_FIX_STEPS = ['Specify', 'Develop', 'Review', 'Test'];
  const phasedBugFixNodes = WORKFLOW_TEMPLATES.find(template => template.id === 'bug-fix').nodes;
  function phasedBugFix(nodes) {
    const steps = PHASED_BUG_FIX_STEPS.map(name => nodes.find(item => item?.name === name && item.prompt === PREVIOUS_BUG_FIX_PROMPTS[name]));
    if (steps.some(step => !step)) return false;
    for (const step of steps) step.prompt = phasedBugFixNodes.find(item => item.name === step.name).prompt;
    const test = steps.at(-1);
    if (test.repeat?.mode === 'loop_back' && test.repeat.max === 3) test.repeat = { ...test.repeat, max: 8 };
    return true;
  }

  const upgradeNodes = db.transaction(() => {
    const save = db.prepare('UPDATE pipeline_workflows SET nodes = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, kind, nodes, source_kind FROM pipeline_workflows').all()) {
      const isLocal = requireSourceKind(row.id, row.source_kind) === 'local';
      let nodes;
      try { nodes = JSON.parse(row.nodes); } catch { fieldError(row.id, 'nodes', 'must be valid JSON'); }
      if (!Array.isArray(nodes)) fieldError(row.id, 'nodes', 'must be an array');
      let changed = false;
      const upgraded = nodes.map(node => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
        const hadAgentId = Object.hasOwn(node, 'agentId');
        const emptyRole = typeof node.role !== 'string' || !node.role.trim();
        const missingProps = !Object.hasOwn(node, 'readOnly') || !Object.hasOwn(node, 'approval') || emptyRole || !Object.hasOwn(node, 'askOwner');
        const localVerificationPrompt = isLocal ? LOCAL_VERIFICATION_PROMPT_UPGRADES.get(node.prompt) : undefined;
        const nextPrompt = upgradedStockPrompt(node.prompt) ?? localVerificationPrompt;
        const capUntrackedLoop = ['bugfix', 'troubleshoot'].includes(row.kind)
          && ['Test', 'Verify'].includes(node.name)
          && node.repeat?.mode === 'loop_back'
          && node.repeat?.max === 5;
        const capBuildLoop = row.kind === 'build'
          && node.name === 'Test'
          && node.repeat?.mode === 'loop_back'
          && node.repeat?.max === 12;
        if (!hadAgentId && !missingProps && !nextPrompt && !capUntrackedLoop && !capBuildLoop) return node;
        changed = true;
        const { agentId: _droppedAgentId, ...rest } = node;
        const fallbackRole = (typeof node.name === 'string' && node.name.trim() ? node.name.trim().slice(0, 32).trim() : 'Step') || 'Step';
        return {
          ...rest,
          ...(!Object.hasOwn(rest, 'readOnly') ? { readOnly: false } : {}),
          ...(!Object.hasOwn(rest, 'approval') ? { approval: false } : {}),
          ...(emptyRole ? { role: fallbackRole } : {}),
          ...(!Object.hasOwn(rest, 'askOwner') ? { askOwner: false } : {}),
          ...(nextPrompt ? { prompt: nextPrompt } : {}),
          ...(capUntrackedLoop ? { repeat: { ...rest.repeat, max: 3 } } : {}),
          ...(capBuildLoop ? { repeat: { ...rest.repeat, max: 8 } } : {}),
        };
      }).filter((node, index, list) => {
        const dropMergedPlan = node?.name === 'Plan'
          && node?.prompt === STOCK_FEATURE_FROM_REQ_PLAN_PROMPT
          && list[index - 1]?.name === 'Specify'
          && list[index - 1]?.prompt?.includes('Then write plan.md in the run notes folder');
        if (dropMergedPlan) changed = true;
        return !dropMergedPlan;
      });
      if (phasedBugFix(upgraded)) changed = true;
      if (changed) {
        save.run(JSON.stringify(upgraded), row.id);
      }
    }
  });
  upgradeNodes();

  const read = db.prepare('SELECT * FROM pipeline_workflows WHERE id = ?');
  const readAll = db.prepare('SELECT * FROM pipeline_workflows ORDER BY lower(name), id');
  function prepareSourceForWrite(id, source) {
    if (source === undefined) return { kind: 'local', sourceId: null, version: null, base: null, updatedAt: null };
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      fieldError(id, 'source_kind', 'must be an object with kind, id, version, base and updatedAt');
    }
    const kind = requireSourceKind(id, source.kind);
    const sourceId = requireSourceId(id, kind, source.id ?? null);
    const version = requireSourceVersion(id, kind, source.version ?? null);
    // Every hydrate guard is mirrored here so a refused write throws before the
    // insert and never leaves a row the next read would fail on.
    if (kind === 'local' && (source.base ?? null) !== null) {
      fieldError(id, 'source_base', 'must be null for a local workflow');
    }
    let base = null;
    if ((source.base ?? null) !== null) {
      if (typeof source.base !== 'object' || Array.isArray(source.base)) {
        fieldError(id, 'source_base', 'must be a workflow definition or null');
      }
      const errors = validateWorkflowBody(source.base, { template: true });
      if (errors.length) fieldError(id, 'source_base', errors[0].message);
      base = JSON.stringify(source.base);
    } else if (kind !== 'local') {
      base = null;
    }
    const updatedAt = source.updatedAt ?? null;
    if (updatedAt !== null) requireIso(id, 'source_updated_at', updatedAt);
    return { kind, sourceId, version, base, updatedAt };
  }

  const insert = db.prepare(`
    INSERT INTO pipeline_workflows
      (id, name, nodes, revision, created_at, updated_at, agents_decide, progress_file, kind, description, source_kind, source_id, source_version, source_base, source_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE pipeline_workflows
    SET name = ?, nodes = ?, revision = ?, updated_at = ?, agents_decide = ?, progress_file = ?, kind = ?, description = ?, source_updated_at = NULL
    WHERE id = ? AND revision = ?
  `);
  const removeStmt = db.prepare('DELETE FROM pipeline_workflows WHERE id = ?');

  const get = id => {
    if (!isUuid(id)) throw new Error('pipeline_workflows: id must be a UUID');
    const row = read.get(id);
    if (!row) return null;
    const record = hydrate(row);
    if (record.id !== id) {
      throw new Error(`pipeline_workflows row ${id} field id: persisted identity does not match key`);
    }
    return record;
  };

  const dismissBuiltin = db.prepare(`
    INSERT OR IGNORE INTO pipeline_builtin_dismissals (template_id, dismissed_at) VALUES (?, ?)
  `);

  function requireTemplateId(templateId) {
    if (typeof templateId !== 'string' || templateId.length < 1 || templateId.length > 64 || !BUILT_IN_ID.test(templateId)) {
      throw new Error(`pipeline_builtin_dismissals row ${String(templateId ?? 'unknown')} field template_id: must be a 1–64 character slug of lower-case letters, digits and dashes`);
    }
    return templateId;
  }

  function requireDismissedAt(templateId, value) {
    if (!isIsoTimestamp(value)) {
      throw new Error(`pipeline_builtin_dismissals row ${templateId} field dismissed_at: must be an ISO-8601 timestamp`);
    }
    return value;
  }

  function writeDismissal(templateId, dismissedAt) {
    const validId = requireTemplateId(templateId);
    const validAt = requireDismissedAt(validId, dismissedAt);
    dismissBuiltin.run(validId, validAt);
  }

  return {
    get,
    list() {
      return readAll.all().map(hydrate);
    },
    create(body, { source } = {}) {
      assertValidBody(body, { revisionRequired: false });
      const id = randomUUID();
      const prepared = prepareSourceForWrite(id, source);
      const stamp = now();
      const name = body.name.trim();
      const nodes = normalizeNodes(body.nodes);
      try {
        insert.run(id, name, JSON.stringify(nodes), 1, stamp, stamp, body.agentsDecide ? 1 : 0, body.progressFile?.trim() ?? null, body.kind ?? 'other', (body.description ?? '').trim(),
          prepared.kind, prepared.sourceId, prepared.version, prepared.base, prepared.updatedAt);
      } catch (err) {
        if (isUniqueConflict(err)) {
          throw new Error(`pipeline_workflows: ${String(err.message).includes('pipeline_workflows_source') ? 'source already linked' : 'name already exists'}`);
        }
        throw err;
      }
      return get(id);
    },
    update(id, body) {
      if (!isUuid(id)) throw new Error('pipeline_workflows: id must be a UUID');
      assertValidBody(body, { revisionRequired: true });
      const current = get(id);
      if (!current) throw new Error(`pipeline_workflows row ${id}: not found`);
      if (current.revision !== body.revision) {
        throw new Error(`pipeline_workflows row ${id}: revision conflict`);
      }
      const name = body.name.trim();
      const nodes = normalizeNodes(body.nodes);
      const stamp = now();
      let result;
      try {
        result = updateStmt.run(name, JSON.stringify(nodes), current.revision + 1, stamp, body.agentsDecide ? 1 : 0, body.progressFile?.trim() ?? null, body.kind ?? 'other', (body.description ?? '').trim(), id, body.revision);
      } catch (err) {
        if (isUniqueConflict(err)) {
          throw new Error('pipeline_workflows: name already exists');
        }
        throw err;
      }
      if (result.changes !== 1) {
        throw new Error(`pipeline_workflows row ${id}: revision conflict`);
      }
      return get(id);
    },
    remove(id) {
      if (!isUuid(id)) throw new Error('pipeline_workflows: id must be a UUID');
      db.transaction(() => {
        const row = read.get(id);
        if (!row) return;
        // Deleting a linked built-in dismisses it, so it does not come back as new (§5.1).
        if (row.source_kind === 'builtin' && typeof row.source_id === 'string' && row.source_id) {
          writeDismissal(row.source_id, now());
        }
        removeStmt.run(id);
      })();
    },
    /** Dismissed built-ins with when they were dismissed, oldest first. */
    builtinDismissals() {
      return db.prepare('SELECT template_id AS templateId, dismissed_at AS dismissedAt FROM pipeline_builtin_dismissals ORDER BY dismissed_at, template_id')
        .all()
        .map(row => ({
          templateId: requireTemplateId(row.templateId),
          dismissedAt: requireDismissedAt(row.templateId, row.dismissedAt),
        }));
    },
    /** Dismiss a shipped built-in without linking it; repeating it changes nothing (§5.3). */
    dismissBuiltinTemplate(templateId) {
      writeDismissal(templateId, now());
    },
    /** Adding a dismissed built-in links it again and lifts the dismissal (§4.2). */
    undismissBuiltinTemplate(templateId) {
      db.prepare('DELETE FROM pipeline_builtin_dismissals WHERE template_id = ?').run(requireTemplateId(templateId));
    },
    /**
     * One-time linking of saved workflows to built-ins (§5.4). A `local` workflow
     * whose name equals a shipped template's name (case-insensitive) and whose kind
     * equals its kind becomes `builtin` for that template — unless another workflow
     * already links it. An identical definition keeps its base (up to date);
     * otherwise the base is unknown (null) and the builder offers a comparison.
     */
    linkBuiltinSources({ templates = WORKFLOW_TEMPLATES } = {}) {
      const marker = db.prepare('SELECT linked_at FROM pipeline_workflow_source_link WHERE id = 1').get();
      if (marker) {
        if (!isIsoTimestamp(marker.linked_at)) {
          throw new Error('pipeline_workflow_source_link row 1 field linked_at: must be an ISO-8601 timestamp');
        }
        return { linked: [] };
      }
      const linkedAt = now();
      if (!isIsoTimestamp(linkedAt)) {
        throw new Error('pipeline_workflow_source_link row 1 field linked_at: must be an ISO-8601 timestamp');
      }
      const linked = [];
      db.transaction(() => {
        const saved = readAll.all().map(hydrate);
        const taken = new Set(saved
          .filter(workflow => workflow.source.kind === 'builtin' && workflow.source.id)
          .map(workflow => workflow.source.id));
        for (const template of templates) {
          if (taken.has(template.id)) continue;
          const candidate = saved.find(workflow => workflow.source.kind === 'local'
            && workflow.name.trim().toLowerCase() === String(template.name).trim().toLowerCase()
            && workflow.kind === template.kind);
          if (!candidate) continue;
          const definition = builtinTemplateDefinition(template);
          const identical = canonicalWithoutName(candidate) === canonicalWithoutName(definition);
          db.prepare(`UPDATE pipeline_workflows
            SET source_kind = 'builtin', source_id = ?, source_version = ?, source_base = ?
            WHERE id = ?`).run(template.id, template.version, identical ? JSON.stringify(definition) : null, candidate.id);
          taken.add(template.id);
          linked.push(candidate.name);
        }
        db.prepare('INSERT INTO pipeline_workflow_source_link (id, linked_at) VALUES (1, ?)').run(linkedAt);
      })();
      return { linked };
    },
    /**
     * On start, after the hand-written upgrades and the first-start seed (§5.2): every
     * `builtin` workflow whose template ships a higher version and whose current
     * definition still equals its base takes the new definition. Nodes keep the
     * `agentId` of the node with the same name; a new node gets `agentId: null`
     * (assigned by team role when a run starts). `revision` goes up by one and the
     * update is logged; an edited workflow or an invalid new definition is left as
     * it is (the invalid one logged with the workflow id) and the start goes on.
     */
    applyBuiltinUpdates({ templates = WORKFLOW_TEMPLATES, now: clock = now, log = (...args) => console.log(...args) } = {}) {
      if (typeof clock !== 'function') throw new TypeError('applyBuiltinUpdates: now must be a function');
      const shipped = new Map(templates.map(template => [template.id, template]));
      const updated = [];
      for (const workflow of readAll.all().map(hydrate)) {
        if (workflow.source.kind !== 'builtin' || !workflow.source.id) continue;
        const template = shipped.get(workflow.source.id);
        if (!template) continue; // No longer shipped: an ordinary workflow (§5.5).
        if (!Number.isInteger(template.version) || template.version <= workflow.source.version) continue;
        // Edited or unknown-base workflows are left alone with no log (§5.2); only an
        // unchanged linked copy is a candidate, and only then is an invalid new
        // definition refused and logged with the workflow id.
        const unchanged = workflow.source.base !== null
          && canonicalWithoutName(workflow) === canonicalWithoutName(workflow.source.base);
        if (!unchanged) continue;
        try {
          const definition = builtinTemplateDefinition(template);
          const nodes = normalizeNodes(definition.nodes);
          const stamp = requireIso(workflow.id, 'updated_at', clock());
          const applied = db.prepare(`UPDATE pipeline_workflows
            SET description = ?, kind = ?, agents_decide = ?, progress_file = ?,
              nodes = ?, revision = revision + 1, updated_at = ?,
              source_version = ?, source_base = ?, source_updated_at = ?
            WHERE id = ? AND revision = ?`).run(
            definition.description, definition.kind, definition.agentsDecide ? 1 : 0, definition.progressFile,
            JSON.stringify(nodes), stamp, template.version, JSON.stringify(definition), stamp, workflow.id, workflow.revision,
          );
          if (applied.changes !== 1) throw new Error('revision conflict');
          updated.push(workflow.name);
          log(`[workflows] ${workflow.name} updated to built-in version ${template.version}`);
        } catch (err) {
          log(`[workflows] ${workflow.id}: built-in update refused: ${err.message}`);
        }
      }
      return { updated };
    },
  };
}
