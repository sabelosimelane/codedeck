import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { delimiter } from 'node:path';
import { AGENT_PRESETS, parseLaunchCommand } from '../../shared/agent-presets.mjs';
import { ASSISTANT_ACP_PROFILES, assistantRefusal } from '../../shared/assistant-acp-profiles.mjs';

const require = createRequire(import.meta.url);
const executable = name => {
  const found = (process.env.PATH ?? '').split(delimiter).map(dir => path.join(dir, name)).find(existsSync);
  if (!found) throw new Error(`${name} executable was not found on PATH`);
  return found;
};
const packageCommand = (name, binName) => {
  const manifest = require.resolve(`${name}/package.json`);
  const bin = require(manifest).bin?.[binName];
  if (typeof bin !== 'string' || !bin) throw new Error(`${name} ACP bin is missing`);
  return { command: process.execPath, args: [path.resolve(path.dirname(manifest), bin)] };
};
const commands = Object.freeze({
  claude: () => packageCommand('@agentclientprotocol/claude-agent-acp', 'claude-agent-acp'),
  codex: () => packageCommand('@agentclientprotocol/codex-acp', 'codex-acp'),
  agy: () => ({ command: executable('agy'), args: ['acp'] }),
  muse: () => ({ command: executable('muse'), args: ['acp'] }),
  opencode: () => ({ command: executable('opencode'), args: ['acp'] }),
});
export function assistantProfileFor(agent) {
  if (!agent || typeof agent.launchCommand !== 'string') throw new TypeError('agent.launchCommand is required');
  const selection = parseLaunchCommand(agent.launchCommand);
  const provider = selection?.provider ?? null;
  const staticProfile = ASSISTANT_ACP_PROFILES.find(item => item.id === provider);
  if (!staticProfile) throw Object.assign(new Error(assistantRefusal(provider)), { name: 'AssistantAgentRefusal' });
  return Object.freeze({ ...staticProfile, command: commands[provider], selection });
}
