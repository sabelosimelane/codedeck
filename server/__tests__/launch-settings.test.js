import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeCompanionAccess, LAUNCH_SETTING_NAMES, readLaunchSettings, resolveLaunchSettings } from '../launch-settings.js';

let dir;
let file;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck-launch-')); file = path.join(dir, 'launch.env'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = content => fs.writeFileSync(file, content);

describe('reading the launch settings file', () => {
  it('reads every setting, ignoring blank lines and comments', () => {
    write('# companion\nCODEDECK_SERVE_ORIGIN=https://deck.tail.test:8443\n\nCODEDECK_TAILSCALE_OWNER = owner@example.test\r\nCODEDECK_FIREBASE_CREDENTIALS=/keys/service-account.json\n');
    expect(readLaunchSettings(file)).toEqual({
      CODEDECK_SERVE_ORIGIN: 'https://deck.tail.test:8443',
      CODEDECK_TAILSCALE_OWNER: 'owner@example.test',
      CODEDECK_FIREBASE_CREDENTIALS: '/keys/service-account.json',
    });
  });
  it('has no settings when the file does not exist', () => expect(readLaunchSettings(file)).toEqual({}));
  it.each([[undefined], [null], [''], ['launch.env']])('requires an absolute file path (%j)', value => {
    expect(() => readLaunchSettings(value)).toThrow('Launch settings: the file must be an absolute path');
  });
  it('reports a file it cannot read', () => {
    expect(() => readLaunchSettings(dir)).toThrow(`Launch settings: cannot read ${dir} (EISDIR)`);
  });
  it.each([
    ['CODEDECK_SERVE_ORIGIN', 'line 1 is not NAME=value'],
    ['=https://deck.tail.test', 'line 1 is not NAME=value'],
    ['# ok\nCODEDECK_PORT=1', 'line 2 names an unknown setting CODEDECK_PORT'],
    ['CODEDECK_SERVE_ORIGIN=a\nCODEDECK_SERVE_ORIGIN=b', 'line 2 repeats CODEDECK_SERVE_ORIGIN'],
    ['CODEDECK_TAILSCALE_OWNER=', 'line 1 gives CODEDECK_TAILSCALE_OWNER no value'],
    ['CODEDECK_TAILSCALE_OWNER="owner@example.test"', 'line 1 quotes CODEDECK_TAILSCALE_OWNER; write the value without quotes'],
    ["CODEDECK_FIREBASE_CREDENTIALS='/keys/a.json'", 'line 1 quotes CODEDECK_FIREBASE_CREDENTIALS; write the value without quotes'],
  ])('rejects %j', (content, problem) => {
    write(content);
    expect(() => readLaunchSettings(file)).toThrow(`Launch settings: ${file} ${problem}`);
  });
  it('never repeats a value in its message', () => {
    write('CODEDECK_TAILSCALE_OWNER="owner@example.test"');
    expect(() => readLaunchSettings(file)).toThrow(expect.objectContaining({ message: expect.not.stringContaining('owner@example.test') }));
  });
});

describe('settling each launch setting', () => {
  const saved = { CODEDECK_SERVE_ORIGIN: 'https://deck.tail.test:8443', CODEDECK_TAILSCALE_OWNER: 'owner@example.test' };
  it('uses the file when the environment says nothing', () => {
    expect(resolveLaunchSettings({}, saved, file)).toEqual({ ...saved, CODEDECK_FIREBASE_CREDENTIALS: null });
  });
  it('uses the environment when the file says nothing', () => {
    expect(resolveLaunchSettings({ CODEDECK_FIREBASE_CREDENTIALS: '/keys/a.json', PATH: '/bin' }, {}, file))
      .toEqual({ CODEDECK_SERVE_ORIGIN: null, CODEDECK_TAILSCALE_OWNER: null, CODEDECK_FIREBASE_CREDENTIALS: '/keys/a.json' });
  });
  it('accepts the same value from both', () => {
    expect(resolveLaunchSettings({ ...saved }, saved, file)).toMatchObject(saved);
  });
  it('refuses to choose between two different values', () => {
    expect(() => resolveLaunchSettings({ CODEDECK_TAILSCALE_OWNER: 'other@example.test' }, saved, file))
      .toThrow(`Launch settings: CODEDECK_TAILSCALE_OWNER is set in the environment and set differently in ${file}`);
  });
  it('names every setting and nothing else', () => {
    expect(Object.keys(resolveLaunchSettings({}, {}, file))).toEqual(LAUNCH_SETTING_NAMES);
  });
});

describe('saying whether the phone can connect', () => {
  it('says phone access is off and what would turn it on', () => {
    expect(describeCompanionAccess({ CODEDECK_SERVE_ORIGIN: null, CODEDECK_TAILSCALE_OWNER: null, CODEDECK_FIREBASE_CREDENTIALS: null }))
      .toBe('phone access is off: CODEDECK_SERVE_ORIGIN and CODEDECK_TAILSCALE_OWNER are not set, so every phone request is refused');
  });
  it('says where phone access is allowed from, without the owner', () => {
    const line = describeCompanionAccess({ CODEDECK_SERVE_ORIGIN: 'https://deck.tail.test:8443', CODEDECK_TAILSCALE_OWNER: 'owner@example.test', CODEDECK_FIREBASE_CREDENTIALS: null });
    expect(line).toBe('phone access is on through https://deck.tail.test:8443; push notifications are not configured');
    expect(line).not.toContain('owner@example.test');
  });
  it('says when push notifications are configured', () => {
    expect(describeCompanionAccess({ CODEDECK_SERVE_ORIGIN: 'https://deck.tail.test:8443', CODEDECK_TAILSCALE_OWNER: 'owner@example.test', CODEDECK_FIREBASE_CREDENTIALS: '/keys/a.json' }))
      .toBe('phone access is on through https://deck.tail.test:8443; push notifications are configured');
  });
});
