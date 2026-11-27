import { AGENT_PRESETS } from '../../shared/agent-presets.mjs';

const MODELS = ['default', 'opus', 'fable', 'sonnet', 'haiku'];
const EFFORTS = AGENT_PRESETS.find(preset => preset.id === 'claude').efforts;
const DEFAULT = Object.freeze({ model: 'default', effort: null });

export function validateAssistantSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('assistant settings body must be an object');
  const errors = [];
  if (!MODELS.includes(value.model)) errors.push({ field: 'model', message: 'Choose default, opus, fable, sonnet or haiku' });
  if (value.effort !== null && !EFFORTS.includes(value.effort)) errors.push({ field: 'effort', message: 'Choose a Claude effort or null' });
  for (const field of Object.keys(value)) if (!['model', 'effort'].includes(field)) errors.push({ field, message: 'Unknown field' });
  if (errors.length) throw Object.assign(new TypeError(`Invalid assistant settings: ${errors.map(item => item.field).join(', ')}`), { errors });
  return { model: value.model, effort: value.effort };
}

export function createAssistantSettingsStore(db) {
  if (typeof db?.exec !== 'function' || typeof db?.prepare !== 'function') throw new TypeError('assistant settings db is required');
  db.exec('CREATE TABLE IF NOT EXISTS assistant_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
  const settings = () => {
    const row = db.prepare('SELECT value FROM assistant_settings WHERE id=1').get();
    if (!row) return { ...DEFAULT };
    let parsed;
    try { parsed = JSON.parse(row.value); }
    catch (error) { throw new TypeError(`Invalid assistant settings value JSON: ${error.message}`); }
    return validateAssistantSettings(parsed);
  };
  return {
    settings,
    saveSettings(value) {
      const valid = validateAssistantSettings(value);
      if (valid.model === 'default' && valid.effort === null) db.prepare('DELETE FROM assistant_settings WHERE id=1').run();
      else db.prepare('INSERT INTO assistant_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(valid));
      return valid;
    },
  };
}
