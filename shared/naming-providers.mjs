// Initial profiles, not an allow-list. Users can edit, add and remove profiles.
export const defaultNamingProviders = [
  {
    id: 'claude', command: 'claude',
    args: ['--print', '--output-format', 'text', '--model', '{model}', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--settings', '{"disableAllHooks":true}'],
    effortArgs: ['--effort', '{effort}'], input: 'stdin', output: 'json',
  },
  {
    id: 'codex', command: 'codex',
    args: ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--model', '{model}', '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"', '-'],
    effortArgs: ['-c', 'model_reasoning_effort="{effort}"'], input: 'stdin', output: 'codex-jsonl',
  },
];

export function namingProviderErrors(providers) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  if (!Array.isArray(providers) || providers.length < 1 || providers.length > 16) {
    add('providers', 'Configure 1–16 providers'); return errors;
  }
  const ids = new Set();
  providers.forEach((p, index) => {
    const key = `providers[${index}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) { add(key, 'A provider object is required'); return; }
    if (typeof p.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(p.id) || ids.has(p.id)) add(`${key}.id`, 'Use a unique provider name of 1–64 letters, numbers, underscores or hyphens');
    ids.add(p.id);
    if (typeof p.command !== 'string' || p.command.length > 1024 || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\/[a-zA-Z0-9_./ -]+)$/.test(p.command)) add(`${key}.command`, 'Use an executable name or absolute path, without arguments');
    for (const field of ['args', 'effortArgs']) {
      if (!Array.isArray(p[field]) || p[field].length > 64 || !p[field].every(a => typeof a === 'string' && a.length <= 2048 && !/[\x00-\x1f\x7f]/.test(a))) {
        add(`${key}.${field}`, 'Use a JSON array of at most 64 argument strings, each at most 2048 characters without control characters'); continue;
      }
      const permitted = field === 'args' ? ['{model}', '{prompt}'] : ['{effort}'];
      if (p[field].some(a => (a.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) ?? []).some(token => !permitted.includes(token)))) add(`${key}.${field}`, `Allowed placeholders: ${permitted.join(', ')}`);
      if (field === 'args' && !p.args.some(a => a.includes('{model}'))) add(`${key}.args`, 'Include {model} to pass the selected model');
      if (field === 'effortArgs' && p.effortArgs.length && !p.effortArgs.some(a => a.includes('{effort}'))) add(`${key}.effortArgs`, 'Include {effort}, or use an empty array when effort is unsupported');
    }
    if (!['stdin', 'argument'].includes(p.input)) add(`${key}.input`, 'Choose stdin or argument');
    if (Array.isArray(p.args) && p.args.every(a => typeof a === 'string')) {
      const prompts = p.args.reduce((count, a) => count + (a.match(/\{prompt\}/g) ?? []).length, 0);
      if ((p.input === 'stdin' && prompts !== 0) || (p.input === 'argument' && prompts !== 1)) add(`${key}.args`, 'Use exactly one {prompt} for argument input, and none for stdin');
    }
    if (!['json', 'json-result', 'codex-jsonl'].includes(p.output)) add(`${key}.output`, 'Choose json, json-result or codex-jsonl');
  });
  return errors;
}
