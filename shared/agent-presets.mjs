// Launch commands for the agent CLIs CodeDeck knows how to start with a model and an effort.
// A preset only composes the launch command; the saved agent still holds the command itself.

// `command` makes the shell run the CLI itself. Without it an alias or function of the same name
// (for example codex='codex --yolo') changes the command, and a repeated bypass flag stops Codex.
const launchPrefix = preset => `command ${preset.executable}`;

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MODEL_MESSAGE = 'Use letters, digits and . _ : / - only, starting with a letter or digit, at most 128 characters';

export const AGENT_PRESETS = Object.freeze([
  Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    executable: 'claude',
    efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    effortArgs: effort => `--effort ${effort}`,
    skipPermissionsFlag: '--dangerously-skip-permissions',
    modelExample: 'opus',
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    executable: 'codex',
    efforts: Object.freeze(['low', 'medium', 'high', 'xhigh']),
    effortArgs: effort => `-c model_reasoning_effort="${effort}"`,
    skipPermissionsFlag: '--dangerously-bypass-approvals-and-sandbox',
    modelExample: 'gpt-6-sol',
  }),
  Object.freeze({
    id: 'cursor',
    label: 'Cursor',
    executable: 'agent',
    // Cursor model names carry the effort (for example gpt-5.6-sol-high), so there is no effort argument.
    efforts: Object.freeze([]),
    effortArgs: null,
    skipPermissionsFlag: '--force',
    modelExample: 'gpt-5.6-sol-high',
  }),
]);

function requireType(field, value, type) {
  if (typeof value !== type) throw new TypeError(`agent preset: ${field} must be a ${type}`);
}

/**
 * The launch command for a provider, model, effort and permission choice.
 * A blank model or effort leaves that choice to the CLI's own default.
 * Returns `{ command, errors }`; `command` is null when a field is invalid.
 */
export function buildLaunchCommand({ provider, model, effort, skipPermissions }) {
  requireType('provider', provider, 'string');
  requireType('model', model, 'string');
  requireType('effort', effort, 'string');
  requireType('skipPermissions', skipPermissions, 'boolean');

  const preset = AGENT_PRESETS.find(candidate => candidate.id === provider);
  if (!preset) return { command: null, errors: [{ field: 'provider', message: 'Choose a provider' }] };

  const errors = [];
  const modelId = model.trim();
  if (modelId !== '' && !MODEL_RE.test(modelId)) errors.push({ field: 'model', message: MODEL_MESSAGE });
  if (effort !== '' && !preset.efforts.includes(effort)) {
    errors.push({ field: 'effort', message: `Choose an effort ${preset.label} accepts` });
  }
  if (errors.length > 0) return { command: null, errors };

  const parts = [launchPrefix(preset)];
  if (modelId !== '') parts.push(`--model ${modelId}`);
  if (effort !== '') parts.push(preset.effortArgs(effort));
  if (skipPermissions) parts.push(preset.skipPermissionsFlag);
  return { command: parts.join(' '), errors };
}

/**
 * The preset selection that builds exactly this command, or null when no preset does
 * (an alias, a CLI started without `command`, extra flags, another spelling): such a command is a custom one.
 */
export function parseLaunchCommand(command) {
  requireType('command', command, 'string');
  for (const preset of AGENT_PRESETS) {
    const prefix = launchPrefix(preset);
    if (command !== prefix && !command.startsWith(`${prefix} `)) continue;
    let rest = command.slice(prefix.length);
    const selection = { provider: preset.id, model: '', effort: '', skipPermissions: false };

    const model = /^ --model (\S+)/.exec(rest);
    if (model) {
      selection.model = model[1];
      rest = rest.slice(model[0].length);
    }
    for (const effort of preset.efforts) {
      const args = ` ${preset.effortArgs(effort)}`;
      if (rest === args || rest.startsWith(`${args} `)) {
        selection.effort = effort;
        rest = rest.slice(args.length);
        break;
      }
    }
    if (rest === ` ${preset.skipPermissionsFlag}`) selection.skipPermissions = true;

    // Only an exact round trip counts, so nothing in the command is dropped by showing it as a preset.
    if (buildLaunchCommand(selection).command === command) return selection;
  }
  return null;
}
