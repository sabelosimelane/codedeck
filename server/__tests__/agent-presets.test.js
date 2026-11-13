import { describe, expect, it } from 'vitest';
import { AGENT_PRESETS, buildLaunchCommand, parseLaunchCommand } from '../../shared/agent-presets.mjs';

const build = (provider, fields = {}) => buildLaunchCommand({ provider, model: '', effort: '', skipPermissions: false, ...fields });

describe('agent presets', () => {
  it('offers Claude Code, Codex and Cursor in that order', () => {
    expect(AGENT_PRESETS.map(preset => [preset.id, preset.label])).toEqual([
      ['claude', 'Claude Code'],
      ['codex', 'Codex'],
      ['cursor', 'Cursor'],
    ]);
  });

  it('lists the effort levels each CLI accepts; Cursor has none because its model names carry the effort', () => {
    const efforts = Object.fromEntries(AGENT_PRESETS.map(preset => [preset.id, preset.efforts]));
    expect(efforts).toEqual({
      claude: ['low', 'medium', 'high', 'xhigh', 'max'],
      codex: ['low', 'medium', 'high', 'xhigh'],
      cursor: [],
    });
  });
});

describe('buildLaunchCommand', () => {
  it.each([
    ['claude', {}, 'command claude'],
    ['claude', { model: 'opus' }, 'command claude --model opus'],
    ['claude', { effort: 'high' }, 'command claude --effort high'],
    ['claude', { model: 'claude-opus-5-5', effort: 'xhigh', skipPermissions: true }, 'command claude --model claude-opus-5-5 --effort xhigh --dangerously-skip-permissions'],
    ['codex', {}, 'command codex'],
    ['codex', { model: 'gpt-6-sol', effort: 'high' }, 'command codex --model gpt-6-sol -c model_reasoning_effort="high"'],
    ['codex', { skipPermissions: true }, 'command codex --dangerously-bypass-approvals-and-sandbox'],
    ['cursor', {}, 'command agent'],
    ['cursor', { model: 'gpt-5.6-sol-high', skipPermissions: true }, 'command agent --model gpt-5.6-sol-high --force'],
  ])('%s %j builds %s', (provider, fields, command) => {
    expect(build(provider, fields)).toEqual({ command, errors: [] });
  });

  it('trims the model', () => {
    expect(build('claude', { model: '  opus ' }).command).toBe('command claude --model opus');
  });

  // An alias such as codex='codex --yolo' would repeat the bypass flag, which Codex rejects.
  it.each(['claude', 'codex', 'cursor'])('starts %s with `command`, so a shell alias or function of that name does not change it', (provider) => {
    expect(build(provider, { skipPermissions: true }).command.startsWith('command ')).toBe(true);
  });

  it.each([
    ['a space', 'gpt 6'],
    ['a quote', "opus'"],
    ['a shell operator', 'opus;ls'],
    ['a substitution', '$(id)'],
    ['a leading dash', '-rf'],
    ['more than 128 characters', 'a'.repeat(129)],
  ])('rejects a model with %s without building a command', (_label, model) => {
    const result = build('claude', { model });
    expect(result.command).toBeNull();
    expect(result.errors).toEqual([{ field: 'model', message: 'Use letters, digits and . _ : / - only, starting with a letter or digit, at most 128 characters' }]);
  });

  it('rejects an effort the provider does not offer', () => {
    expect(build('codex', { effort: 'max' })).toEqual({
      command: null,
      errors: [{ field: 'effort', message: 'Choose an effort Codex accepts' }],
    });
    expect(build('cursor', { effort: 'high' })).toEqual({
      command: null,
      errors: [{ field: 'effort', message: 'Choose an effort Cursor accepts' }],
    });
  });

  it('rejects an unknown provider', () => {
    expect(build('gemini')).toEqual({ command: null, errors: [{ field: 'provider', message: 'Choose a provider' }] });
  });

  it.each([
    ['provider', { provider: undefined }],
    ['model', { model: null }],
    ['effort', { effort: 5 }],
    ['skipPermissions', { skipPermissions: 'yes' }],
  ])('fails loudly when %s has the wrong type', (field, override) => {
    expect(() => buildLaunchCommand({ provider: 'claude', model: '', effort: '', skipPermissions: false, ...override }))
      .toThrow(new RegExp(`agent preset: ${field}`));
  });
});

describe('parseLaunchCommand', () => {
  it.each([
    ['claude', {}],
    ['claude', { model: 'opus', effort: 'max', skipPermissions: true }],
    ['claude', { effort: 'low' }],
    ['codex', { model: 'gpt-6.1-sol', effort: 'xhigh' }],
    ['codex', { skipPermissions: true }],
    ['cursor', { model: 'cursor-grok-4.6-high-fast' }],
    ['cursor', { skipPermissions: true }],
  ])('reads back what %s %j built', (provider, fields) => {
    const selection = { provider, model: '', effort: '', skipPermissions: false, ...fields };
    expect(parseLaunchCommand(buildLaunchCommand(selection).command)).toEqual(selection);
  });

  it.each([
    ['an alias', 'cc'],
    ['a CLI started without `command`, which the shell may alias', 'claude --model opus'],
    ['a bare CLI name', 'codex'],
    ['an extra flag', 'command claude --model opus --chrome'],
    ['a different flag order', 'command claude --effort high --model opus'],
    ['an unknown effort', 'command claude --effort extreme'],
    ['surrounding spaces', ' command claude '],
    ['a prefix match only', 'command claudette'],
    ['a codex effort in another spelling', 'command codex -c model_reasoning_effort=high'],
  ])('returns null for %s, so the command is shown as custom', (_label, command) => {
    expect(parseLaunchCommand(command)).toBeNull();
  });

  it('fails loudly when the command is not a string', () => {
    expect(() => parseLaunchCommand(undefined)).toThrow(/agent preset: command/);
  });
});
