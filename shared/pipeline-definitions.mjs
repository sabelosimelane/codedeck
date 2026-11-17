const SINGLE_LINE = /[\x00-\x1f\x7f]/;
const MULTI_LINE = /[\x00-\x08\x0b-\x1f\x7f]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[\w-]{1,128}$/;
const COMPOSED_PROMPT_MAX = 16384;
const PROGRESS_CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

export function isProgressFilePath(value, max = 300) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || PROGRESS_CONTROL.test(value)
    || value.startsWith('/') || value.startsWith('~') || value.includes('\\') || !/\.md$/i.test(value)) return false;
  return value.split('/').every(segment => segment !== '' && segment !== '..');
}

export function isProgressFileTemplate(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 300
    && !PROGRESS_CONTROL.test(value)
    && isProgressFilePath(value.replaceAll('{input}', 'x.md'), Infinity);
}

function add(errors, field, message) {
  errors.push({ field, message });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(errors, body, allowed) {
  if (!isPlainObject(body)) {
    add(errors, 'body', 'A JSON object is required');
    return false;
  }
  for (const field of Object.keys(body)) {
    if (!allowed.includes(field)) add(errors, field, 'Unknown field');
  }
  return true;
}

function requireSingleLine(errors, field, value, { min, max, label }) {
  if (typeof value !== 'string') {
    add(errors, field, `${label} is required`);
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || SINGLE_LINE.test(value)) {
    add(errors, field, `Use ${min}–${max} characters on one line without control characters`);
  }
}

function requireNonBlankSingleLine(errors, field, value, { max, label }) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || SINGLE_LINE.test(value)) {
    add(errors, field, `${label} must contain 1–${max} characters on one line without control characters`);
  }
}

function requireRevision(errors, revision, required) {
  if (revision === undefined) {
    if (required) add(errors, 'revision', 'revision is required');
    return;
  }
  if (!Number.isInteger(revision) || revision < 1) {
    add(errors, 'revision', 'Use a whole number of 1 or more');
  }
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function validateAgentBody(body, { revisionRequired = false } = {}) {
  const errors = [];
  if (!rejectUnknown(errors, body, ['name', 'launchCommand', 'resetCommand', 'revision'])) return errors;
  requireSingleLine(errors, 'name', body.name, { min: 1, max: 64, label: 'name' });
  requireNonBlankSingleLine(errors, 'launchCommand', body.launchCommand, { max: 2048, label: 'launchCommand' });
  requireNonBlankSingleLine(errors, 'resetCommand', body.resetCommand, { max: 256, label: 'resetCommand' });
  requireRevision(errors, body.revision, revisionRequired);
  return errors;
}

// Which fields each repeat mode takes. `loop_back` sends the run back to an earlier node.
const REPEAT_FIELDS = {
  once: ['mode'],
  until_complete: ['mode', 'max'],
  loop_back: ['mode', 'to', 'max'],
};
const REPEAT_KNOWN = ['mode', 'to', 'max'];

function validateRepeat(errors, prefix, repeat) {
  if (!isPlainObject(repeat)) {
    add(errors, `${prefix}.repeat`, 'A repeat object is required');
    return;
  }
  const allowed = REPEAT_FIELDS[repeat.mode];
  if (!allowed) {
    add(errors, `${prefix}.repeat.mode`, 'Choose once, until_complete or loop_back');
    return;
  }
  for (const field of Object.keys(repeat)) {
    if (allowed.includes(field)) continue;
    add(errors, `${prefix}.repeat.${field}`, REPEAT_KNOWN.includes(field)
      ? `${field} is not allowed when mode is ${repeat.mode}`
      : 'Unknown field');
  }
  if (allowed.includes('max') && (!Number.isInteger(repeat.max) || repeat.max < 1 || repeat.max > 100)) {
    add(errors, `${prefix}.repeat.max`, 'Use a whole number from 1 to 100');
  }
}

const nodeNameKey = node => (isPlainObject(node) && typeof node.name === 'string' ? node.name.trim().toLowerCase() : '');

/**
 * The index of the node that node `index` loops back to, or -1 when its repeat names no
 * earlier node. Names match as node names are compared for uniqueness: trimmed, any case.
 */
export function loopTargetIndex(nodes, index) {
  const repeat = nodes[index]?.repeat;
  if (!isPlainObject(repeat) || repeat.mode !== 'loop_back' || typeof repeat.to !== 'string') return -1;
  const wanted = repeat.to.trim().toLowerCase();
  if (wanted === '') return -1;
  const target = nodes.findIndex(node => nodeNameKey(node) === wanted);
  return target >= 0 && target < index ? target : -1;
}

/** A loop runs its nodes in order, round after round; two loops may not share a node. */
function validateLoops(errors, nodes) {
  const loops = [];
  nodes.forEach((node, index) => {
    if (!isPlainObject(node) || !isPlainObject(node.repeat) || node.repeat.mode !== 'loop_back') return;
    const field = `nodes[${index}].repeat.to`;
    const target = loopTargetIndex(nodes, index);
    if (target < 0) {
      add(errors, field, 'Choose an earlier node to loop back to');
      return;
    }
    // Every loop found so far ends before this node, so they overlap when this one starts inside it.
    const clash = loops.find(loop => target <= loop.end);
    if (clash) {
      add(errors, field, `Loops cannot share a node; this one overlaps the loop that ends at ${nodes[clash.end].name.trim()}`);
      return;
    }
    loops.push({ start: target, end: index });
  });
}

export function validateWorkflowBody(body, { revisionRequired = false } = {}) {
  const errors = [];
  if (!rejectUnknown(errors, body, ['name', 'agentsDecide', 'progressFile', 'nodes', 'revision'])) return errors;
  requireSingleLine(errors, 'name', body.name, { min: 1, max: 64, label: 'name' });
  requireRevision(errors, body.revision, revisionRequired);
  // Whether agents settle their own questions during a run instead of pausing for the owner.
  if (typeof body.agentsDecide !== 'boolean') add(errors, 'agentsDecide', 'Use true or false');
  if (body.progressFile !== undefined && body.progressFile !== null && (
    (typeof body.progressFile === 'string' && PROGRESS_CONTROL.test(body.progressFile))
    || !isProgressFileTemplate(typeof body.progressFile === 'string' ? body.progressFile.trim() : body.progressFile)
  )) {
    add(errors, 'progressFile', 'Use a relative Markdown path of 1–300 characters inside the worktree');
  }

  if (!Array.isArray(body.nodes) || body.nodes.length < 1 || body.nodes.length > 32) {
    add(errors, 'nodes', 'Configure 1–32 nodes');
    return errors;
  }

  const seenNames = new Set();
  body.nodes.forEach((node, index) => {
    const prefix = `nodes[${index}]`;
    if (!isPlainObject(node)) {
      add(errors, prefix, 'A node object is required');
      return;
    }
    for (const field of Object.keys(node)) {
      if (!['name', 'agentId', 'prompt', 'repeat'].includes(field)) {
        add(errors, `${prefix}.${field}`, 'Unknown field');
      }
    }
    if (typeof node.name !== 'string' || !node.name.trim() || node.name.trim().length > 64 || SINGLE_LINE.test(node.name)) {
      add(errors, `${prefix}.name`, 'Use 1–64 characters on one line without control characters');
    } else {
      const key = node.name.trim().toLowerCase();
      if (seenNames.has(key)) add(errors, `${prefix}.name`, 'Node names must be unique within the workflow');
      seenNames.add(key);
    }
    if (!isUuid(node.agentId)) add(errors, `${prefix}.agentId`, 'Use a UUID of an existing agent');
    if (
      typeof node.prompt !== 'string'
      || !node.prompt.trim()
      || node.prompt.length > 8192
      || MULTI_LINE.test(node.prompt)
    ) {
      add(errors, `${prefix}.prompt`, 'Use 1–8192 characters without terminal control codes');
    }
    validateRepeat(errors, prefix, node.repeat);
  });
  validateLoops(errors, body.nodes);

  return errors;
}

export function validateSettingsBody(body) {
  const errors = [];
  if (!rejectUnknown(errors, body, ['setupAgentId', 'revision'])) return errors;
  if (body.setupAgentId !== null && !isUuid(body.setupAgentId)) {
    add(errors, 'setupAgentId', 'Use null or a UUID of an existing agent');
  }
  requireRevision(errors, body.revision, true);
  return errors;
}

export function validateRunStartBody(body) {
  const errors = [];
  if (!rejectUnknown(errors, body, ['requestId', 'workflowId', 'project', 'input', 'worktreePath'])) return errors;
  if (typeof body.requestId !== 'string' || !REQUEST_ID_RE.test(body.requestId)) {
    add(errors, 'requestId', 'Use 1–128 letters, digits, underscores or hyphens');
  }
  if (!isUuid(body.workflowId)) add(errors, 'workflowId', 'Use a workflow UUID');
  if (typeof body.project !== 'string' || !body.project.trim() || SINGLE_LINE.test(body.project)) {
    add(errors, 'project', 'A project name is required');
  }
  if (
    typeof body.input !== 'string'
    || body.input.length > 4096
    || SINGLE_LINE.test(body.input)
  ) {
    add(errors, 'input', 'Use 0–4096 characters on one line without control characters');
  }
  // Left out, the run gets a new worktree. Given, it names an existing worktree of the project.
  if (body.worktreePath !== undefined) {
    const value = body.worktreePath;
    if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || SINGLE_LINE.test(value)) {
      add(errors, 'worktreePath', 'Use the absolute path of an existing worktree, 1–4096 characters on one line, or leave it out for a new worktree');
    }
  }
  return errors;
}

/** The answer that accepts every recommendation an agent listed with its questions. */
export const ACCEPT_RECOMMENDATIONS_ANSWER = 'Proceed with your recommendations.';

// An answer is pasted into the agent's terminal: new lines are text, any other control
// character (an escape sequence could end the paste) is refused.
const ANSWER_CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/;

/** Body of POST /runs/:id/answer: what the owner tells an agent that signalled NEEDS_INPUT. */
export function validateRunAnswerBody(body) {
  const errors = [];
  if (!rejectUnknown(errors, body, ['answer'])) return errors;
  const { answer } = body;
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 4000 || ANSWER_CONTROL.test(answer)) {
    add(errors, 'answer', 'Use 1–4000 characters; new lines are allowed, other control characters are not');
  }
  return errors;
}

/** Single-pass `{input}` replacement; optionally records a field error when over the engine limit. */
export function composePrompt(prompt, input, errors, field = 'input') {
  // Callback form inserts literally — a string replacement would interpret $&, $$, etc.
  const composed = String(prompt).replaceAll('{input}', () => String(input));
  if (errors && composed.length > COMPOSED_PROMPT_MAX) {
    add(errors, field, `Composed prompt must be at most ${COMPOSED_PROMPT_MAX} characters`);
  }
  return composed;
}

export const PROMPT_COMPOSED_MAX = COMPOSED_PROMPT_MAX;
