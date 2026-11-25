import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createCliNamingClient } from '../cli-naming-client.js';
import { buildLaunchCommand } from '../../shared/agent-presets.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const clients = [];
afterEach(() => clients.splice(0).forEach(client => client.close()));
function setup(provider = 'claude', output = '{"title":"Fix uploads"}', error = null) {
  let input = '';
  const agentStore = { get: () => ({ id: ID, launchCommand: buildLaunchCommand({ provider, model: 'chosen-model', effort: '', skipPermissions: false }).command }) };
  const execute = vi.fn((_file, _args, _options, callback) => {
    const child = new EventEmitter(); child.stdin = new PassThrough();
    child.stdin.on('data', data => { input += data; }); child.kill = vi.fn();
    queueMicrotask(() => callback(error, output, '')); return child;
  });
  const client = createCliNamingClient({ execute, agentStore }); clients.push(client);
  return { client, execute, input: () => input, settings: { agentId: ID, effort: null } };
}
it('keeps terminal context out of executable arguments for stdin profiles', async () => {
  const { client, execute, input, settings } = setup();
  expect(await client.generate(settings, 'task $(touch /tmp/no)')).toBe('Fix uploads');
  const [file, args, options] = execute.mock.calls[0];
  expect(file).toBe('claude'); expect(args.join(' ')).not.toContain('touch');
  expect(options).toMatchObject({ shell: false, timeout: 65000, maxBuffer: 1048576 });
  expect(options.cwd).not.toBe(process.cwd());
  expect(input()).toContain('task $(touch /tmp/no)');
});
it('rejects empty and oversized context before running', async () => {
  const { client, execute, settings } = setup();
  for (const context of [null, '', 'x'.repeat(12001)]) await expect(client.generate(settings, context)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
it.each(['not JSON', '{"title":""}', '{"title":"x","extra":1}'])('rejects malformed output %s', async output => {
  const { client, settings } = setup('claude', output);
  await expect(client.generate(settings, 'task')).rejects.toThrow();
});
it('reports safe CLI errors without leaking process output', async () => {
  const { client, settings } = setup('claude', '', new Error('secret'));
  const error = await client.generate(settings, 'task').catch(value => value);
  expect(error.message).toContain('CLI failed'); expect(error.message).not.toContain('secret');
});
it('accepts no identifiable task', async () => {
  const { client, settings } = setup('claude', '{"title":null}');
  expect(await client.generate(settings, 'banner')).toBeNull();
});
it.each(['error', 'turn.failed'])('explains a rejected Codex model from a %s event', async type => {
  const message = "The 'chosen-model' model is not supported when using Codex with a ChatGPT account. secret-context";
  const event = type === 'error' ? { type, message } : { type, error: { message } };
  const { client, settings } = setup('codex', JSON.stringify(event), new Error('secret'));
  await expect(client.generate(settings, 'task')).rejects.toMatchObject({ status: 503, message: expect.stringContaining('chosen-model') });
});
it('uses a separate JSON reviewer contract and rejects non-Claude/Codex agents', async () => {
  const { client, input, settings } = setup('claude', JSON.stringify({ type: 'result', is_error: false, result: '{"proposal":null,"cost":123}' }));
  expect(await client.review(settings, { instructions: 'Review', rubric: 'Evidence', evidence: [] })).toEqual({ proposal: null, cost: null });
  expect(input()).toContain('Evidence'); expect(input()).not.toContain('Name the user task');
  const cursor = setup('cursor');
  await expect(cursor.client.review(cursor.settings, { instructions: 'Review', rubric: 'Evidence' })).rejects.toThrow('Claude or Codex');
});
it('records Claude billing and redacts credential fields for review', async () => {
  const { client, input, settings } = setup('claude', JSON.stringify({ type: 'result', is_error: false, total_cost_usd: .014, result: '{"proposal":null,"cost":123}' }));
  expect(await client.review(settings, { instructions: 'Review', rubric: 'Inspect', evidence: [{ note: 'Authorization: Bearer placeholder_secret_token' }] })).toEqual({ proposal: null, cost: .014 });
  expect(input()).not.toContain('placeholder_secret_token');
});
