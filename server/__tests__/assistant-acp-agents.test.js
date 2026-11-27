import { describe, expect, it } from 'vitest';
import { assistantProfileFor } from '../assistant/acp-agents.js';
import { buildLaunchCommand } from '../../shared/agent-presets.mjs';

const agent = provider => ({ id: provider, name: provider, launchCommand: buildLaunchCommand({ provider, model: '', effort: '', skipPermissions: false }).command });
describe('assistant ACP profiles', () => {
  it.each([['claude', 'default', 'set_mode', 'effort', 'system_prompt'], ['codex', 'read-only', 'set_mode', 'reasoning_effort', 'first_prompt'], ['agy', 'default', 'set_mode', 'thought_level', 'first_prompt'], ['muse', 'promptUnmatched', 'set_mode', null, 'first_prompt'], ['opencode', 'plan', 'config_option', 'effort', 'first_prompt']])('%s has a held mode and explicit brief delivery', (provider, mode, via, effortOption, briefDelivery) => {
    expect(assistantProfileFor(agent(provider))).toMatchObject({ heldMode: { id: mode, via }, effortOption, briefDelivery });
  });
  it('refuses Cursor and custom commands with a reason', () => {
    expect(() => assistantProfileFor(agent('cursor'))).toThrow('Cursor has no Agent Client Protocol server');
    expect(() => assistantProfileFor({ id: 'custom', launchCommand: 'my-agent' })).toThrow('custom command');
  });
});
