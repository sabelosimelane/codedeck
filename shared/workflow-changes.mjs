import { createHash } from 'node:crypto';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The canonical form definitions are compared in (§6.1): the shape
 * `normalizeNodes` stores — trimmed names and roles, loops stored by target
 * name, flags defaulting to false, `enabled` present only when false — with
 * keys in a fixed order and `progressFile` trimmed or null.
 */
export function canonicalDefinition(definition) {
  if (!isPlainObject(definition) || !Array.isArray(definition.nodes)) {
    throw new TypeError('canonicalDefinition requires a definition with nodes');
  }
  const trimmedNames = definition.nodes.map(node => (isPlainObject(node) && typeof node.name === 'string' ? node.name.trim() : node?.name));
  // A loop is stored under the name of the node it returns to, as that node is stored.
  const loopTargetName = (to) => {
    if (typeof to !== 'string') return to;
    const wanted = to.trim().toLowerCase();
    const match = trimmedNames.findIndex(name => typeof name === 'string' && name.toLowerCase() === wanted);
    return match >= 0 ? trimmedNames[match] : to.trim();
  };
  const nodes = definition.nodes.map((node, index) => {
    if (!isPlainObject(node)) throw new TypeError(`canonicalDefinition requires node ${index} to be an object`);
    const repeat = isPlainObject(node.repeat) ? node.repeat : {};
    const normalizedRepeat = repeat.mode === 'loop_back'
      ? { mode: 'loop_back', to: loopTargetName(repeat.to), max: repeat.max }
      : repeat.mode === 'until_complete'
        ? { mode: 'until_complete', max: repeat.max }
        : { mode: 'once' };
    const canonical = {
      name: typeof node.name === 'string' ? node.name.trim() : node.name,
      role: typeof node.role === 'string' ? node.role.trim() : '',
      prompt: node.prompt,
      repeat: normalizedRepeat,
      readOnly: node.readOnly ?? false,
      approval: node.approval ?? false,
      askOwner: node.askOwner ?? false,
    };
    if (node.enabled === false) canonical.enabled = false;
    return canonical;
  });
  const progressFile = typeof definition.progressFile === 'string' && definition.progressFile.trim()
    ? definition.progressFile.trim()
    : null;
  // Stored workflows are trimmed on write, so padded in-memory values match them.
  // A definition that omits kind or description normalises to the stored
  // defaults ('other' and ''), so an accepted package hashes like its stored form.
  const name = typeof definition.name === 'string' ? definition.name.trim() : definition.name;
  const description = typeof definition.description === 'string' ? definition.description.trim() : '';
  return {
    name,
    description,
    kind: definition.kind ?? 'other',
    agentsDecide: definition.agentsDecide,
    progressFile,
    nodes,
  };
}

/** The SHA-256 of the canonical JSON string (§4.3). */
export function definitionHash(definition) {
  return createHash('sha256').update(JSON.stringify(canonicalDefinition(definition))).digest('hex');
}
