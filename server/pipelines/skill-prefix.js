// A workflow prompt names a skill the way most agent CLIs do: `/skill arguments`.
// Codex invokes a skill with `$skill`, so the engine sends the prompt with the prefix
// of the CLI that is actually on screen (`skillPrefix` of its agent profile).

const SKILL_PREFIXES = ['/', '$'];
// Only a prompt that starts with /name followed by white space or the end: not a path
// (/usr/bin), not a namespaced command (/prompts:name), not a skill later in the text.
const LEADING_SKILL = /^\/(?=[A-Za-z0-9][A-Za-z0-9_-]*(?:\s|$))/;

/** The prompt as the CLI expects it: a leading `/skill` becomes `<skillPrefix>skill`. */
export function applySkillPrefix(prompt, skillPrefix) {
  if (typeof prompt !== 'string') throw new TypeError('skill prefix: prompt must be a string');
  if (!SKILL_PREFIXES.includes(skillPrefix)) throw new TypeError('agent profile: skill prefix must be "/" or "$"');
  return prompt.replace(LEADING_SKILL, () => skillPrefix);
}
