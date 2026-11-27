/**
 * The tools CodeDeck's own MCP server gives the assistant. They only read CodeDeck's state
 * or file a proposal the owner still approves on its card, so the bridge allows them
 * without a permission prompt. The MCP server test keeps this list equal to what it registers.
 */
export const CODEDECK_ASSISTANT_TOOLS = Object.freeze([
  'get_situation', 'get_task_landing', 'list_runs', 'read_run_notes', 'read_todo',
  'propose_close', 'propose_commit', 'propose_merge', 'propose_new_task', 'propose_pull_request', 'propose_start_run',
]);

const TOOL_NAMES = new Set(CODEDECK_ASSISTANT_TOOLS.map(name => `mcp__codedeck__${name}`));

/**
 * Whether an ACP permission request is for one of CodeDeck's own assistant tools. The title
 * is text the model can shape, so this reads the Claude adapter's metadata instead: the
 * tool name Claude Code resolved and the server it came from. `source: 'dynamic'` is a server
 * the session was started with (CodeDeck's); a server of the same name from project or user
 * configuration has another source. Anything else, including agents without this metadata,
 * stays the owner's to answer.
 */
export function isCodedeckAssistantTool(toolCall) {
  const meta = toolCall._meta?.claudeCode;
  return meta?.mcpServer?.name === 'codedeck' && meta.mcpServer.source === 'dynamic' && TOOL_NAMES.has(meta.toolName);
}
