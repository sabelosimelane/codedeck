import { assistantProfileFor } from './acp-agents.js';

const DEFAULT = Object.freeze({ agentId: '', effort: null });
const invalid = errors => Object.assign(new TypeError(`Invalid assistant settings: ${errors.map(item => `${item.field} (${item.message})`).join(', ')}`), { errors });
export function validateAssistantSettings(value, agentStore) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid([{ field: 'body', message: 'Use an object' }]);
  const errors = [];
  if (typeof value.agentId !== 'string' || (value.agentId !== '' && !value.agentId.trim())) errors.push({ field: 'agentId', message: 'Choose a saved agent or an empty selection' });
  if (value.effort !== null && typeof value.effort !== 'string') errors.push({ field: 'effort', message: 'Use an effort or null' });
  for (const field of Object.keys(value)) if (!['agentId', 'effort'].includes(field)) errors.push({ field, message: 'Unknown field' });
  if (!errors.some(item => item.field === 'agentId') && value.agentId !== '') {
    const agent = agentStore?.get?.(value.agentId);
    if (!agent) errors.push({ field: 'agentId', message: 'Saved agent does not exist' });
    else {
      let profile;
      try { profile = assistantProfileFor(agent); }
      catch (error) { errors.push({ field: 'agentId', message: error.message }); }
      if (profile && value.effort !== null && typeof value.effort === 'string' && !profile.efforts.includes(value.effort)) errors.push({ field: 'effort', message: profile.effortOption ? `Choose ${profile.efforts.join(', ')} or CLI default` : `${profile.label} has no ACP effort option` });
    }
  }
  if (value.agentId === '' && value.effort !== null) errors.push({ field: 'effort', message: 'Choose an agent before an effort' });
  if (errors.length) throw invalid(errors);
  return { agentId: value.agentId, effort: value.effort };
}
export function createAssistantSettingsStore(db, { agentStore } = {}) {
  if (typeof db?.exec !== 'function' || typeof db?.prepare !== 'function' || typeof agentStore?.get !== 'function') throw new TypeError('assistant settings db and agentStore are required');
  db.exec('CREATE TABLE IF NOT EXISTS assistant_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
  const settings = () => {
    const row = db.prepare('SELECT value FROM assistant_settings WHERE id=1').get();
    if (!row) return { ...DEFAULT };
    let parsed;
    try { parsed = JSON.parse(row.value); }
    catch (error) { throw new TypeError(`Invalid assistant settings value JSON: ${error.message}`); }
    return validateAssistantSettings(parsed, agentStore);
  };
  return { settings, saveSettings(value) {
    const valid = validateAssistantSettings(value, agentStore);
    if (valid.agentId === '') db.prepare('DELETE FROM assistant_settings WHERE id=1').run();
    else db.prepare('INSERT INTO assistant_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(valid));
    return valid;
  } };
}
