import { isUuid, validateWorkflowBody } from './pipeline-definitions.mjs';

const MAX_VERSION = 2 ** 31 - 1;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;
// Spec §3 names a UUID v4; the codebase's shared isUuid also accepts v1–v3 and v5.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE_KEYS = ['format', 'formatVersion', 'source', 'exportedAt', 'workflow'];
const SOURCE_KEYS = ['id', 'version'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

function isIsoUtc(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_UTC.exec(value);
  if (!match) return false;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  // Date.parse rolls an impossible date over (Feb 30 becomes Mar 2): the UTC
  // components must round-trip exactly.
  const date = new Date(time);
  const [, year, month, day, hour, minute, second] = match;
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    && date.getUTCSeconds() === Number(second);
}

/**
 * Every field of an imported package on its own; all failures are returned at
 * once so the owner can fix the file in one pass.
 */
export function validatePackage(pkg) {
  const errors = [];
  if (!isPlainObject(pkg)) return [{ field: 'package', message: 'A workflow package object is required' }];
  for (const key of Object.keys(pkg)) {
    if (!PACKAGE_KEYS.includes(key)) errors.push({ field: key, message: 'Unknown field' });
  }
  if (pkg.format !== 'codedeck.workflow') {
    errors.push({ field: 'format', message: 'Use exactly "codedeck.workflow"' });
  }
  if (pkg.formatVersion !== 1) {
    errors.push({
      field: 'formatVersion',
      message: Number.isInteger(pkg.formatVersion) && pkg.formatVersion > 1
        ? `This file was made by a newer CodeDeck (format ${pkg.formatVersion}); update CodeDeck to import it.`
        : 'Use exactly the integer 1',
    });
  }
  if (!isPlainObject(pkg.source)) {
    errors.push({ field: 'source', message: 'A source object with id and version is required' });
  } else {
    for (const key of Object.keys(pkg.source)) {
      if (!SOURCE_KEYS.includes(key)) errors.push({ field: `source.${key}`, message: 'Unknown field' });
    }
    if (!isUuidV4(pkg.source.id)) errors.push({ field: 'source.id', message: 'Use a UUID v4' });
    if (!Number.isInteger(pkg.source.version) || pkg.source.version < 1 || pkg.source.version > MAX_VERSION) {
      errors.push({ field: 'source.version', message: `Use a whole number from 1 to ${MAX_VERSION}` });
    }
  }
  if (!isIsoUtc(pkg.exportedAt)) {
    errors.push({ field: 'exportedAt', message: 'Use an ISO 8601 UTC timestamp' });
  }
  if (!isPlainObject(pkg.workflow)) {
    errors.push({ field: 'workflow', message: 'A workflow definition object is required' });
  } else {
    // A package carries a definition (§2): no id, revision or timestamps.
    if (Object.hasOwn(pkg.workflow, 'revision')
      && !validateWorkflowBody(pkg.workflow, { template: true }).some(error => error.field === 'revision')) {
      errors.push({ field: 'workflow.revision', message: 'A package workflow carries no revision' });
    }
    const bodyErrors = validateWorkflowBody(pkg.workflow, { template: true });
    for (const error of bodyErrors) errors.push({ field: `workflow.${error.field}`, message: error.message });
    if (Array.isArray(pkg.workflow.nodes)) {
      pkg.workflow.nodes.forEach((node, index) => {
        if (!isPlainObject(node)) return;
        for (const key of Object.keys(node)) {
          if (!['name', 'role', 'prompt', 'repeat', 'readOnly', 'approval', 'askOwner', 'enabled'].includes(key)) {
            errors.push({ field: `workflow.nodes[${index}].${key}`, message: 'Unknown field' });
          }
        }
        if (typeof node.role !== 'string' || !node.role.trim()) {
          errors.push({ field: `workflow.nodes[${index}].role`, message: 'Each step needs a role before it can be imported' });
        }
      });
    }
  }
  return errors;
}

function requireRecord(record) {
  if (!isPlainObject(record)) throw new TypeError('buildPackage requires a stored workflow record');
  if (!isUuid(record.id)) throw new TypeError('buildPackage requires the workflow id');
  if (!Number.isInteger(record.revision) || record.revision < 1) throw new TypeError('buildPackage requires the workflow revision');
  if (!isPlainObject(record) || !Array.isArray(record.nodes)) throw new TypeError('buildPackage requires the workflow nodes');
}

function definitionNode(node) {
  if (!isPlainObject(node)) throw new TypeError('buildPackage requires each node to be an object');
  const { agentId: _dropped, ...rest } = node;
  return rest;
}

/**
 * The package an export writes: the workflow's definition without agents,
 * with `source` naming the workflow it was exported from.
 */
export function buildPackage(record, { exportedAt = new Date().toISOString() } = {}) {
  requireRecord(record);
  if (!isIsoUtc(exportedAt)) throw new TypeError('buildPackage requires an ISO 8601 UTC exportedAt');
  const { name, description, kind, agentsDecide, progressFile, nodes } = record;
  return {
    format: 'codedeck.workflow',
    formatVersion: 1,
    source: { id: record.id, version: record.revision },
    exportedAt,
    workflow: {
      name,
      description: description ?? '',
      kind: kind ?? 'other',
      agentsDecide: agentsDecide ?? false,
      progressFile: progressFile ?? null,
      nodes: nodes.map(definitionNode),
    },
  };
}

/**
 * The file name an export is downloaded as: the workflow name lower-cased with
 * runs of non-alphanumeric characters replaced by `-`, trimmed, at most 64 chars.
 */
export function packageFileName(name) {
  if (typeof name !== 'string') throw new TypeError('packageFileName requires a workflow name');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'workflow';
  return `${slug}.codedeck-workflow.json`;
}
