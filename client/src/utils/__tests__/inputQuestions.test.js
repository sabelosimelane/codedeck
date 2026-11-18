import { describe, expect, it } from 'vitest';
import { composeAnswer, parseQuestions } from '../inputQuestions.js';
import { ACCEPT_RECOMMENDATIONS_ANSWER } from '../../../../shared/pipeline-definitions.mjs';

const LIST = `1. Should we really store first name and last name separately, or just speak the first word
of the existing name?
Recommended: Speak the first word of the existing name; no storage or app change.
2. Which outputs should switch to the first name? Recommended: Both voice calls
   use the first name.
3) Anything else?`;

describe('reading the questions an agent listed', () => {
  it('splits the list into questions, each with the answer the agent recommends', () => {
    expect(parseQuestions(LIST)).toEqual([
      { number: 1, question: 'Should we really store first name and last name separately, or just speak the first word of the existing name?', recommended: 'Speak the first word of the existing name; no storage or app change.' },
      { number: 2, question: 'Which outputs should switch to the first name?', recommended: 'Both voice calls use the first name.' },
      { number: 3, question: 'Anything else?', recommended: null },
    ]);
  });

  it('returns null for text that is not a numbered list, so it is shown as written', () => {
    expect(parseQuestions('I need the staging password before I can go on.')).toBeNull();
    expect(parseQuestions('Recommended: nothing\n')).toBeNull();
  });

  it('refuses anything but text', () => {
    expect(() => parseQuestions(null)).toThrow('questions must be a nonempty string');
    expect(() => parseQuestions('  ')).toThrow('questions must be a nonempty string');
  });
});

describe('composing the owner’s answer', () => {
  const questions = parseQuestions(LIST);

  it('is the standard acceptance when every recommendation is taken and nothing is added', () => {
    const two = questions.slice(0, 2);
    expect(composeAnswer(two, [{ choice: 'recommended', text: '' }, { choice: 'recommended', text: '' }], '')).toBe(ACCEPT_RECOMMENDATIONS_ANSWER);
  });

  it('numbers each answer, quoting a recommendation that was taken, and ends with the note', () => {
    expect(composeAnswer(questions, [{ choice: 'recommended', text: '' }, { choice: 'own', text: ' Only the panic call ' }, { choice: 'own', text: 'No' }], ' Keep it short ')).toBe(
      '1. As you recommend: Speak the first word of the existing name; no storage or app change.\n2. Only the panic call\n3. No\n\nAlso: Keep it short',
    );
  });

  it('is null until every question has an answer', () => {
    expect(composeAnswer(questions, [{ choice: 'recommended', text: '' }, { choice: 'own', text: '  ' }, { choice: 'own', text: 'No' }], '')).toBeNull();
    // A question without a recommendation cannot take one.
    expect(composeAnswer(questions, [{ choice: 'recommended', text: '' }, { choice: 'recommended', text: '' }, { choice: 'recommended', text: '' }], '')).toBeNull();
  });

  it('refuses answers that do not line up with the questions', () => {
    expect(() => composeAnswer(questions, [], '')).toThrow('one answer per question');
    expect(() => composeAnswer(questions.slice(0, 1), [{ choice: 'maybe', text: '' }], '')).toThrow('choice');
  });
});
