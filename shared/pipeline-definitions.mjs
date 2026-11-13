const SINGLE_LINE = /[\x00-\x1f\x7f]/;
const MULTI_LINE = /[\x00-\x08\x0b-\x1f\x7f]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[\w-]{1,128}$/;
const COMPOSED_PROMPT_MAX = 16384;

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

function validateRepeat(errors, prefix, repeat) {
  if (!isPlainObject(repeat)) {
    add(errors, `${prefix}.repeat`, 'A repeat object is required');
    return;
  }
  for (const field of Object.keys(repeat)) {
    if (!['mode', 'max'].includes(field)) add(errors, `${prefix}.repeat.${field}`, 'Unknown field');
  }
  if (repeat.mode === 'once') {
    if (repeat.max !== undefined) {
      add(errors, `${prefix}.repeat.max`, 'max is not allowed when mode is once');
    }
    return;
  }
  if (repeat.mode === 'until_complete') {
    if (!Number.isInteger(repeat.max) || repeat.max < 1 || repeat.max > 100) {
      add(errors, `${prefix}.repeat.max`, 'Use a whole number from 1 to 100');
    }
    return;
  }
  add(errors, `${prefix}.repeat.mode`, 'Choose once or until_complete');
}

export function validateWorkflowBody(body, { revisionRequired = false } = {}) {
  const errors = [];
  if (!rejectUnknown(errors, body, ['name', 'nodes', 'revision'])) return errors;
  requireSingleLine(errors, 'name', body.name, { min: 1, max: 64, label: 'name' });
  requireRevision(errors, body.revision, revisionRequired);

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
  if (!rejectUnknown(errors, body, ['requestId', 'workflowId', 'project', 'input'])) return errors;
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
