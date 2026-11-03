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
