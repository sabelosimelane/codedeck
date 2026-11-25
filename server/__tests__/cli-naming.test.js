import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
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
it.each(['claude', 'codex', 'cursor', 'agy', 'muse'])('redacts terminal secrets for %s before sending the prompt', async provider => {
  const output = provider === 'cursor' ? JSON.stringify({ type: 'result', is_error: false, result: '{"title":"Fix uploads"}' })
    : provider === 'agy' ? JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: { title: 'Fix uploads' } } })
    : '{"title":"Fix uploads"}';
  const { client, execute, input, settings } = setup(provider, output);
  await client.generate(settings, 'password=supersecret123 fix uploads').catch(() => {});
  const [, args] = execute.mock.calls[0];
  expect(args.join(' ') + input()).not.toContain('supersecret123');
});
it('uses a private prompt file for Muse', async () => {
  const { client, execute, settings } = setup('muse');
  let observed;
  execute.mockImplementation((_file, args, options, callback) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.kill = vi.fn();
    queueMicrotask(async () => {
      const file = args[args.indexOf('--prompt-file') + 1];
      observed = { file, cwd: options.cwd, mode: (await stat(file)).mode & 0o777, prompt: await readFile(file, 'utf8') };
      callback(null, '{"title":"Fix uploads"}', '');
    });
    return child;
  });
  expect(await client.generate(settings, 'fix uploads')).toBe('Fix uploads');
  expect(execute.mock.calls[0][1].join(' ')).not.toContain('fix uploads');
  expect(path.dirname(observed.file)).toBe(observed.cwd);
  expect(observed.mode).toBe(0o600);
  expect(observed.prompt).toContain('fix uploads');
  await expect(stat(observed.file)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('uses sandboxed stream JSON input for Antigravity', async () => {
  const output = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: { title: 'Fix uploads' } } });
  const { client, execute, input, settings } = setup('agy', output);
  expect(await client.generate(settings, 'fix uploads')).toBe('Fix uploads');
  const args = execute.mock.calls[0][1];
  expect(args).toContain('--sandbox');
  expect(args).toContain('--json-schema');
  expect(args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 2)).toEqual(['--input-format', 'stream-json']);
  expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual(['--output-format', 'stream-json']);
  expect(args.join(' ')).not.toContain('fix uploads');
  expect(JSON.parse(input().trim())).toEqual({ event: 'user', message: { role: 'user', content: [{ type: 'text', text: expect.stringContaining('fix uploads') }] } });
});
it('uses sandboxed read-only stdin for Cursor with required workspace trust', async () => {
  const { client, execute, input, settings } = setup('cursor', JSON.stringify({ type: 'result', is_error: false, result: '{"title":"Fix uploads"}' }));
  expect(await client.generate(settings, 'fix uploads')).toBe('Fix uploads');
  const args = execute.mock.calls[0][1];
  expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'enabled']);
  expect(args.slice(args.indexOf('--mode'), args.indexOf('--mode') + 2)).toEqual(['--mode', 'ask']);
  expect(args).toContain('--trust');
  expect(args).not.toContain('--approve-mcps');
  expect(args.join(' ')).not.toContain('fix uploads');
  expect(input()).toContain('fix uploads');
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
