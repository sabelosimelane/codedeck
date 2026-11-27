import { describe, expect, it } from 'vitest';
import { buildAssistantBrief } from '../assistant/brief.js';

describe('assistant brief', () => {
  it('tells the assistant to end a reply with its questions in the list the chat turns into answer cards', () => {
    const brief = buildAssistantBrief('# Situation\n- all clear');
    expect(brief).toContain('[[QUESTIONS]]');
    expect(brief).toContain('[[/QUESTIONS]]');
    expect(brief).toMatch(/Recommended: \(a\)/);
    expect(brief.trimEnd().endsWith('- all clear')).toBe(true);
  });
  it('names the tools for finding workflows and teams and for acting on runs', () => {
    const brief = buildAssistantBrief('# Situation');
    for (const tool of ['list_teams', 'list_workflows', 'propose_stop_run', 'propose_answer_run', 'propose_resume_run']) expect(brief).toContain(tool);
  });
  it('refuses an empty situation', () => {
    expect(() => buildAssistantBrief('  ')).toThrow('brief: situationMarkdown must be non-empty text');
  });
});
