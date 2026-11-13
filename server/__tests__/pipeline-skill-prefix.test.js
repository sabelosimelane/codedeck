import { describe, expect, it } from 'vitest';
import { findAgentProfileById } from '../agent-profiles/index.js';
import { applySkillPrefix } from '../pipelines/skill-prefix.js';

describe('agent profile skill prefix', () => {
  it.each([
    ['codex', '$'],
    ['claude', '/'],
    ['cursor', '/'],
    ['agy', '/'],
    ['muse', '/'],
  ])('%s invokes a skill with %s', (id, prefix) => {
    expect(findAgentProfileById(id).skillPrefix).toBe(prefix);
  });
});

describe('applySkillPrefix', () => {
  it.each([
    ['a skill with arguments', '/feature-dev docs/todos/x.md', '$feature-dev docs/todos/x.md'],
    ['a skill alone', '/ship', '$ship'],
    ['a skill followed by a new line', '/feature-test\nonly phase 2', '$feature-test\nonly phase 2'],
    ['a skill name with digits and underscores', '/qa_2 now', '$qa_2 now'],
  ])('sends %s to a $ CLI with $ in place of the leading /', (_label, prompt, sent) => {
    expect(applySkillPrefix(prompt, '$')).toBe(sent);
  });

  it.each([
    ['plain text', 'Implement the todo'],
    ['a skill that is not at the start', 'Run /feature-dev docs/todos/x.md'],
    ['leading white space', ' /feature-dev x'],
    ['a namespaced command', '/prompts:draft x'],
    ['a plugin skill', '/codex:rescue x'],
    ['a file path', '/usr/local/bin/tool --check'],
    ['a double slash', '//feature-dev'],
    ['a bare slash', '/ x'],
    ['a prompt already written with $', '$feature-dev x'],
    ['a later slash word', '/feature-dev then /feature-test'],
  ])('leaves %s as written, except a leading skill', (_label, prompt) => {
    const expected = prompt === '/feature-dev then /feature-test' ? '$feature-dev then /feature-test' : prompt;
    expect(applySkillPrefix(prompt, '$')).toBe(expected);
  });

  it('sends every prompt as written to a / CLI', () => {
    expect(applySkillPrefix('/feature-dev docs/todos/x.md', '/')).toBe('/feature-dev docs/todos/x.md');
    expect(applySkillPrefix('$feature-dev x', '/')).toBe('$feature-dev x');
  });

  it.each([undefined, null, '', '#', '$$', 5])('fails loudly on the skill prefix %j', (prefix) => {
    expect(() => applySkillPrefix('/ship', prefix)).toThrow('skill prefix must be "/" or "$"');
  });

  it.each([undefined, null, 5])('fails loudly on the prompt %j', (prompt) => {
    expect(() => applySkillPrefix(prompt, '$')).toThrow('prompt must be a string');
  });
});
