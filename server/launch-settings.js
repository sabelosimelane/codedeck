import { readFileSync } from 'node:fs';
import path from 'node:path';

// The companion's launch settings, kept by the owner in a private file so that
// a plain restart cannot drop them. The same names may still be given in the
// environment; a name set in both places with different values is refused
// rather than guessed at. Messages name the setting, never its value.
export const LAUNCH_SETTING_NAMES = ['CODEDECK_SERVE_ORIGIN', 'CODEDECK_TAILSCALE_OWNER', 'CODEDECK_FIREBASE_CREDENTIALS'];

export function readLaunchSettings(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Launch settings: the file must be an absolute path');
  let content;
  try { content = readFileSync(file, 'utf8'); }
  catch (error) {
    // The companion is optional: no file means no saved settings.
    if (error.code === 'ENOENT') return {};
    throw new Error(`Launch settings: cannot read ${file} (${error.code})`);
  }
  const settings = {};
  content.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const where = `Launch settings: ${file} line ${index + 1}`;
    const at = line.indexOf('=');
    if (at < 1) throw new Error(`${where} is not NAME=value`);
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!LAUNCH_SETTING_NAMES.includes(name)) throw new Error(`${where} names an unknown setting ${name}`);
    if (Object.hasOwn(settings, name)) throw new Error(`${where} repeats ${name}`);
    if (!value) throw new Error(`${where} gives ${name} no value`);
    if (/^["']|["']$/.test(value)) throw new Error(`${where} quotes ${name}; write the value without quotes`);
    settings[name] = value;
  });
  return settings;
}

export function resolveLaunchSettings(env, saved, file) {
  if (!env || typeof env !== 'object') throw new Error('Launch settings: the environment is required');
  if (!saved || typeof saved !== 'object') throw new Error('Launch settings: the saved settings are required');
  return Object.fromEntries(LAUNCH_SETTING_NAMES.map(name => {
    const given = env[name];
    const kept = saved[name];
    if (given !== undefined && kept !== undefined && given !== kept) throw new Error(`Launch settings: ${name} is set in the environment and set differently in ${file}`);
    return [name, given ?? kept ?? null];
  }));
}

export function describeCompanionAccess(settings) {
  for (const name of LAUNCH_SETTING_NAMES) {
    if (settings?.[name] !== null && typeof settings?.[name] !== 'string') throw new Error(`Launch settings: ${name} must be text or null`);
  }
  if (settings.CODEDECK_SERVE_ORIGIN === null && settings.CODEDECK_TAILSCALE_OWNER === null) {
    return 'phone access is off: CODEDECK_SERVE_ORIGIN and CODEDECK_TAILSCALE_OWNER are not set, so every phone request is refused';
  }
  return `phone access is on through ${settings.CODEDECK_SERVE_ORIGIN}; push notifications are ${settings.CODEDECK_FIREBASE_CREDENTIALS === null ? 'not configured' : 'configured'}`;
}
