/**
 * The tools CodeDeck's own MCP server gives the assistant. They only read CodeDeck's state
 * or file a proposal the owner still approves on its card, so the bridge allows them
 * without a permission prompt. The MCP server test keeps this list equal to what it registers.
 */
export const CODEDECK_ASSISTANT_TOOLS = Object.freeze([
  'get_situation', 'get_task_landing', 'list_runs', 'read_run_notes', 'read_todo',
  'propose_close', 'propose_commit', 'propose_merge', 'propose_new_task', 'propose_pull_request', 'propose_start_run',
]);

const TITLES = new Set(CODEDECK_ASSISTANT_TOOLS.map(name => `mcp__codedeck__${name}`));

/** Whether an ACP permission request names exactly one of CodeDeck's own assistant tools. */
export function isCodedeckAssistantTool(toolCall) {
  return TITLES.has(toolCall.title);
}
