export class NamingError extends Error {
  constructor(message, status = 400, errors = []) {
    super(message); this.status = status; this.errors = errors;
  }
}

export function requireField(ok, field, expectation) {
  if (!ok) throw new NamingError(`Invalid ${field}: ${expectation}`, 400, [{ field, message: expectation }]);
}
export const isText = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

export function validateEndpoint(baseUrl) {
  requireField(isText(baseUrl, 2048), 'baseUrl', 'Provide an HTTP or HTTPS base URL');
  let url;
  try { url = new URL(baseUrl); } catch { throw new NamingError('Invalid baseUrl', 400, [{ field: 'baseUrl', message: 'Provide an HTTP or HTTPS base URL' }]); }
  requireField(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'baseUrl', 'Use HTTP(S) without embedded credentials, query, or fragment');
  return url.toString().replace(/\/$/, '');
}

export function validateSettings(value) {
  requireField(value && typeof value === 'object' && !Array.isArray(value), 'settings', 'An object is required');
  const errors = [];
  let baseUrl;
  try { baseUrl = validateEndpoint(value.baseUrl); } catch (error) { errors.push(...error.errors); }
  for (const key of ['provider', 'model']) if (!isText(value[key])) errors.push({ field: key, message: 'Choose a catalog value (1–256 characters)' });
  if (value.effort !== null && !isText(value.effort, 64)) errors.push({ field: 'effort', message: 'Choose a catalog value or null' });
  if (errors.length) throw new NamingError('Invalid session naming settings', 400, errors);
  return { baseUrl, provider: value.provider, model: value.model, effort: value.effort };
}

export function validateCatalog(value) {
  requireField(value && isText(value.defaultProvider), 'catalog.defaultProvider', 'A provider ID is required');
  requireField(Array.isArray(value.providers), 'catalog.providers', 'An array is required');
  const ids = new Set();
  return value.providers.map((p, index) => {
    const key = `providers[${index}]`;
    requireField(p && isText(p.id) && !ids.has(p.id), `${key}.id`, 'A unique provider ID is required'); ids.add(p.id);
    for (const field of ['enabled', 'available']) requireField(typeof p[field] === 'boolean', `${key}.${field}`, 'A boolean is required');
    for (const field of ['models', 'effort', 'toolPolicies']) requireField(Array.isArray(p[field]) && p[field].every(v => isText(v)), `${key}.${field}`, 'An array of nonempty strings is required');
    requireField(isText(p.defaultModel), `${key}.defaultModel`, 'A model ID is required');
    requireField(p.capabilities && typeof p.capabilities === 'object' && !Array.isArray(p.capabilities) && Object.values(p.capabilities).every(v => typeof v === 'boolean'), `${key}.capabilities`, 'Boolean capabilities are required');
    // Project only validated fields into CodeDeck's public catalog contract.
    return { id: p.id, enabled: p.enabled, available: p.available, models: [...p.models], effort: [...p.effort], defaultModel: p.defaultModel, capabilities: { ...p.capabilities }, toolPolicies: [...p.toolPolicies] };
  });
}

export function validateSelection(settings, providers) {
  const provider = providers.find(p => p.id === settings.provider);
  requireField(provider?.enabled && provider?.available, 'provider', 'Choose an enabled, available provider');
  requireField(provider.models.includes(settings.model), 'model', 'Choose an advertised model');
  requireField(settings.effort === null || provider.effort.includes(settings.effort), 'effort', 'Choose an advertised effort');
  return provider;
}

export function validateTitle(title) {
  requireField(isText(title, 60) && title === title.trim(), 'title', 'Use 1–60 characters on one line without surrounding whitespace');
  return title;
}
export function parseTitle(response) {
  requireField(typeof response === 'string' && response.length <= 2048, 'response', 'A short JSON response is required');
  let result;
  try { result = JSON.parse(response); } catch { throw new NamingError('Invalid title response', 502); }
  requireField(result && !Array.isArray(result) && Object.keys(result).length === 1 && Object.hasOwn(result, 'title'), 'response.title', 'Expected exactly {title: string | null}');
  return result.title === null ? null : validateTitle(result.title);
}

export function validateRecord(r) {
  requireField(r && isText(r.sessionId), 'sessionId', 'A session ID is required');
  requireField(['waiting', 'queued', 'generating', 'named', 'failed', 'manual'].includes(r.state), 'state', 'A naming state is required');
  requireField(['generated', 'manual', null].includes(r.source), 'source', 'A title source or null is required');
  requireField(Number.isSafeInteger(r.revision) && r.revision >= 0, 'revision', 'A nonnegative revision is required');
  requireField(r.error === null || isText(r.error, 512), 'error', 'A safe error or null is required');
  requireField(r.title === null || isText(r.title, 60), 'title', 'A bounded title or null is required');
  requireField(!['named', 'manual'].includes(r.state) || (r.title !== null && r.source === (r.state === 'manual' ? 'manual' : 'generated')), 'title', 'Completed titles must have matching sources');
  return r;
}
