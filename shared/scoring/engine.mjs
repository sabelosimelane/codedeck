// Pure scoring boundary. Policies depend on observations, never on a datastore or an agent runtime.
export function requireField(condition, field) {
  if (!condition) throw new TypeError('Invalid scoring field ' + field);
}

export const text = (value) => typeof value === 'string' && value.trim().length > 0;
export const count = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => count(value) && value > 0;
export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function median(values) {
  if (!values.length || values.includes(null)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function fraction(rows, matches) {
  return rows.length ? rows.filter(matches).length / rows.length : null;
}

export function createMetricRegistry(definitions) {
  requireField(Array.isArray(definitions) && definitions.length > 0, 'metric definitions');
  const metrics = new Map();
  for (const metric of definitions) {
    requireField(object(metric) && text(metric.id) && !metrics.has(metric.id), 'metric.id');
    requireField(positive(metric.version), metric.id + '.version');
    requireField(text(metric.unit), metric.id + '.unit');
    requireField(['higher', 'lower'].includes(metric.direction), metric.id + '.direction');
    requireField(typeof metric.eligible === 'function', metric.id + '.eligible');
    requireField(typeof metric.aggregate === 'function', metric.id + '.aggregate');
    metrics.set(metric.id, Object.freeze({ ...metric }));
  }
  function measure(rows, id) {
    const metric = metrics.get(id);
    requireField(metric, 'metric.id');
    const eligible = rows.filter(metric.eligible);
    const value = metric.aggregate(eligible);
    requireField(value === null || Number.isFinite(value), metric.id + '.result');
    return {
      value,
      unit: metric.unit,
      direction: metric.direction,
      version: metric.version,
      eligible: eligible.length,
      excluded: rows.length - eligible.length,
      evidenceIds: eligible.map((row) => row.id),
    };
  }
  return Object.freeze({
    definitions: Object.freeze([...metrics.values()]),
    measure,
    score: (rows) => Object.fromEntries([...metrics.keys()].map((id) => [id, measure(rows, id)])),
  });
}

export function observationsFor(policy, observations) {
  requireField(Array.isArray(observations), 'observations');
  const ids = new Set();
  return observations.map((observation, index) => {
    requireField(object(observation) && text(observation.id), 'observation[' + index + '].id');
    requireField(!ids.has(observation.id), 'duplicate observation.id ' + observation.id);
    ids.add(observation.id);
    return policy.prepare(observation);
  });
}

export function scoreEnvelope(input, policy) {
  requireField(object(input) && input.version === 1, 'input.version');
  requireField(object(policy) && text(policy.subjectType) && positive(policy.version), 'policy');
  requireField(
    typeof policy.prepare === 'function' && typeof policy.registry?.score === 'function',
    'policy implementation',
  );
  requireField(input.policyVersion === policy.version, 'policyVersion');
  requireField(
    object(input.subject) && input.subject.type === policy.subjectType && text(input.subject.id),
    'subject',
  );
  requireField(
    object(input.configuration) && text(input.configuration.id) && positive(input.configuration.revision),
    'configuration',
  );
  const rows = observationsFor(policy, input.observations);
  return {
    version: input.version,
    policyVersion: policy.version,
    subject: { type: input.subject.type, id: input.subject.id },
    configuration: { id: input.configuration.id, revision: input.configuration.revision },
    metrics: policy.registry.score(rows),
  };
}
