// Static ACP choices shared by Settings and the server. Runtime command resolution lives on the server.
const profile = (id, label, mode, via, effortOption, efforts, briefDelivery) => Object.freeze({
  id, label, heldMode: Object.freeze({ id: mode, via }), modelOption: 'model', effortOption,
  efforts: Object.freeze(efforts), briefDelivery,
});
export const ASSISTANT_ACP_PROFILES = Object.freeze([
  profile('claude', 'Claude Code', 'default', 'set_mode', 'effort', ['low', 'medium', 'high', 'xhigh', 'max'], 'system_prompt'),
  profile('codex', 'Codex', 'read-only', 'set_mode', 'reasoning_effort', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'first_prompt'),
  profile('agy', 'Antigravity', 'default', 'set_mode', 'thought_level', ['low', 'medium', 'high', 'xhigh'], 'first_prompt'),
  profile('muse', 'Muse Code', 'promptUnmatched', 'set_mode', null, [], 'first_prompt'),
  profile('opencode', 'OpenCode', 'plan', 'config_option', 'effort', ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'first_prompt'),
]);
export function assistantRefusal(provider) {
  if (provider === 'cursor') return 'Cursor has no Agent Client Protocol server';
  if (provider === null) return 'custom command: CodeDeck cannot run it as an ACP agent';
  return `Unsupported assistant provider: ${String(provider)}`;
}
