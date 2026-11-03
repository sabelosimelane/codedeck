import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createCliNamingClient, validateCliSettings } from '../cli-naming-client.js';
const clients = [];
afterEach(() => clients.splice(0).forEach(c => c.close()));
function setup(output = '{"title":"Fix uploads"}', error = null) {
  let input = '';
  const execute = vi.fn((_file, _args, _options, callback) => {
    const child = new EventEmitter(); child.stdin = new PassThrough();
    child.stdin.on('data', data => { input += data; });
    child.kill = vi.fn();
    queueMicrotask(() => callback(error, output));
    return child;
  });
  const client = createCliNamingClient({ execute }); clients.push(client);
  return { client, execute, input: () => input };
}
it.each(['claude', 'codex'])('runs %s directly with exact selection and context on stdin', async provider => {
  const output = provider === 'codex' ? '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"title\\":\\"Fix uploads\\"}"}}\n' : '{"title":"Fix uploads"}';
  const { client, execute, input } = setup(output);
  expect(await client.generate({ provider, model: 'chosen-model', effort: 'low' }, 'task $(touch /tmp/no)')).toBe('Fix uploads');
  const [file, args, options] = execute.mock.calls[0];
  expect(file).toBe(provider); expect(args).toContain('chosen-model');
  expect(args.join(' ')).toContain('low'); expect(args.join(' ')).not.toContain('touch');
  expect(options).toMatchObject({ shell: false, timeout: 65000, maxBuffer: 1048576 });
  expect(input()).toContain('task $(touch /tmp/no)');
  expect(options.cwd).not.toBe(process.cwd());
});
it.each([null, {}, { provider: 'other', model: 'm', effort: null }, { provider: 'claude', model: '', effort: null }, { provider: 'claude', model: '-flag', effort: null }, { provider: 'claude', model: 'm', effort: 'invalid' }, { provider: 'codex', model: 'm' }])('rejects invalid settings %j', value => {
  expect(() => validateCliSettings(value)).toThrow();
});
it('rejects empty and oversized context before running', async () => {
  const { client, execute } = setup();
  for (const context of [null, '', 'x'.repeat(12001)]) await expect(client.generate({ provider: 'claude', model: 'm', effort: null }, context)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
it.each(['not JSON', '{"title":""}', '{"title":"x","extra":1}'])('rejects malformed output %s', async output => {
  const { client } = setup(output);
  await expect(client.generate({ provider: 'claude', model: 'm', effort: null }, 'task')).rejects.toThrow();
});
it('reports safe CLI errors without leaking process output', async () => {
  const { client } = setup('', new Error('secret'));
  await expect(client.generate({ provider: 'claude', model: 'm', effort: null }, 'task')).rejects.toThrow('CLI');
});
it('accepts no identifiable task', async () => {
  const { client } = setup('{"title":null}');
  expect(await client.generate({ provider: 'claude', model: 'm', effort: null }, 'banner')).toBeNull();
});
it.each(['__proto__', 'constructor', 'toString'])('rejects inherited provider name %s as validation error', provider => {
  expect(() => validateCliSettings({ provider, model: 'm', effort: 'low' })).toThrow('Invalid session naming settings');
});
it.each(['error', 'turn.failed'])('explains a rejected model from a Codex %s event without exposing raw output', async type => {
  const message = "The 'GPT-6-Luna' model is not supported when using Codex with a ChatGPT account. secret-context";
  const event = type === 'error' ? { type, message } : { type, error: { message } };
  const { client, execute } = setup(JSON.stringify(event), new Error('secret-process-output'));
  await expect(client.generate({ provider: 'codex', model: 'GPT-6-Luna', effort: 'medium' }, 'task')).rejects.toMatchObject({
    status: 503,
    message: 'Codex rejected the selected model "GPT-6-Luna". Model IDs are case-sensitive. Enter an exact model ID supported by your account in Session naming settings.',
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0][1]).toContain('GPT-6-Luna');
});

const customProvider = {
  id: 'kiro', command: 'kiro-cli', args: ['chat', '--no-interactive', '--model', '{model}', '{prompt}'],
  effortArgs: ['--effort', '{effort}'], input: 'argument', output: 'json',
};
it('runs a user-defined provider with its configured command and argument template', async () => {
  const { client, execute, input } = setup();
  const settings = { provider: 'kiro', model: 'chosen-model', effort: 'custom-effort', providers: [customProvider] };
  expect(validateCliSettings(settings)).toEqual(settings);
  expect(await client.generate(settings, 'task $(touch /tmp/no)')).toBe('Fix uploads');
  const [command, args, options] = execute.mock.calls[0];
  expect(command).toBe('kiro-cli');
  expect(args.slice(0, 4)).toEqual(['chat', '--no-interactive', '--model', 'chosen-model']);
  expect(args[4]).toContain('task $(touch /tmp/no)');
  expect(args.slice(-2)).toEqual(['--effort', 'custom-effort']);
  expect(options.shell).toBe(false); expect(input()).toBe('');
});
it('uses the configured response format independently of the provider name', async () => {
  const { client, execute } = setup(JSON.stringify({ type: 'result', is_error: false, result: '{"title":"Fix uploads"}' }));
  expect(await client.generate({ provider: 'cursor', model: 'custom', effort: null, providers: [{ ...customProvider, id: 'cursor', command: 'agent', output: 'json-result' }] }, 'task')).toBe('Fix uploads');
  expect(execute.mock.calls[0][1]).not.toContain('--effort');
});
it('supports renamed Codex profiles and interpolates values only once', async () => {
  const { client, execute } = setup('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"title\\":\\"Fix uploads\\"}"}}');
  expect(await client.generate({ provider: 'my-codex', model: 'custom', effort: null, providers: [{ ...customProvider, id: 'my-codex', command: '/opt/tools/codex', output: 'codex-jsonl' }] }, 'literal {model}')).toBe('Fix uploads');
  expect(execute.mock.calls[0][1][4]).toContain('literal {model}');
});
it.each(['id','command','args','effortArgs','input','output'])('requires custom provider field %s', field => {
  const profile = { ...customProvider }; delete profile[field];
  expect(() => validateCliSettings({ provider: 'kiro', model: 'm', effort: null, providers: [profile] })).toThrow();
});
it.each([
  [], null, [null], [{ ...customProvider, command: '' }], [{ ...customProvider, command: 'kiro; echo bad' }],
  [{ ...customProvider, args: ['{unknown}'] }], [{ ...customProvider, args: ['--model', '{model}'] }],
  [{ ...customProvider, input: 'stdin' }], [{ ...customProvider, output: 'anything' }],
  [{ ...customProvider, effortArgs: ['--effort'] }], [{ ...customProvider, args: ['\u0000'] }],
  [customProvider, customProvider], [{ ...customProvider, id: 'other' }],
])('rejects invalid custom provider configuration %j', providers => {
  expect(() => validateCliSettings({ provider: 'kiro', model: 'm', effort: null, providers })).toThrow();
});
it('does not discard custom profiles when they are persisted and reloaded', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { createNamingStore } = await import('../session-naming-store.js');
  const db = new Database(':memory:');
  try {
    const settings = { provider: 'kiro', model: 'm', effort: null, providers: [customProvider] };
    createNamingStore(db).saveSettings(settings);
    expect(createNamingStore(db).settings()).toEqual(settings);
    db.prepare('UPDATE session_naming_settings SET value=?').run(JSON.stringify({ ...settings, providers: [{ ...customProvider, command: null }] }));
    expect(() => createNamingStore(db).settings()).toThrow();
  } finally { db.close(); }
});
