import { describe, expect, it } from 'vitest';
import { composeAnswer, parseQuestions, recommendationLead, splitAssistantQuestions } from '../inputQuestions.js';
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
      { number: 1, question: 'Should we really store first name and last name separately, or just speak the first word of the existing name?', recommended: 'Speak the first word of the existing name; no storage or app change.', options: [], recommendedLetter: null },
      { number: 2, question: 'Which outputs should switch to the first name?', recommended: 'Both voice calls use the first name.', options: [], recommendedLetter: null },
      { number: 3, question: 'Anything else?', recommended: null, options: [], recommendedLetter: null },
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

  it.each(['b) Best fit because it is isolated.', '(b) Best fit because it is isolated.'])('parses options and finds the recommended letter in %s', recommendation => {
    expect(parseQuestions(`1. Which database?\na) Shared\nb) Dedicated\nc) Embedded\nRecommended: ${recommendation}`)).toEqual([{
      number: 1, question: 'Which database?', recommended: recommendation,
      options: [{ letter: 'a', text: 'Shared' }, { letter: 'b', text: 'Dedicated' }, { letter: 'c', text: 'Embedded' }],
      recommendedLetter: 'b',
    }]);
  });

  it('keeps non-consecutive option lines in the question and leaves options empty', () => {
    expect(parseQuestions('1. Which database?\na) Shared\nc) Embedded\nRecommended: c) Fast')).toEqual([{
      number: 1, question: 'Which database? a) Shared c) Embedded', recommended: 'c) Fast', options: [], recommendedLetter: null,
    }]);
  });

  it('does not mark a choice recommended when the recommendation has no listed letter', () => {
    expect(parseQuestions('1. Which database?\na) Shared\nb) Dedicated\nRecommended: It depends on capacity.')[0].recommendedLetter).toBeNull();
  });
  it.each(['A fresh index is best.', 'A — because it is fast', 'B because it is isolated'])('does not treat prose as a recommendation letter: %s', recommendation => {
    expect(parseQuestions(`1. Which?\na) Shared\nb) Dedicated\nRecommended: ${recommendation}`)[0].recommendedLetter).toBeNull();
    expect(recommendationLead(recommendation)).toBeNull();
  });
  it.each([['(B) because', 'b', 'because'], ['B) because', 'b', 'because'], ['b. because', 'b', 'because'], ['b — because', 'b', 'because'], ['b: because', 'b', 'because'], ['b', 'b', '']])('extracts valid recommendation lead %s', (text, letter, reason) => {
    expect(recommendationLead(text)).toEqual({ letter, reason });
  });
});

describe('composing the owner’s answer', () => {
  const questions = parseQuestions(LIST);
  const optionQuestion = parseQuestions('1. Which database?\na) Shared\nb) Dedicated\nRecommended: b) Isolated.');

  it('sends the chosen option and accepts the recommended option with an empty note', () => {
    expect(composeAnswer(optionQuestion, [{ choice: 'option', letter: 'a', text: 'Shared' }], '')).toBe('1. (a) Shared');
    expect(composeAnswer(optionQuestion, [{ choice: 'option', letter: 'b', text: 'Dedicated' }], '')).toBe(ACCEPT_RECOMMENDATIONS_ANSWER);
    expect(composeAnswer(optionQuestion, [{ choice: 'option', letter: 'b', text: 'Dedicated' }], 'Please explain')).toBe('1. (b) Dedicated\n\nAlso: Please explain');
  });

  it('rejects an option letter not listed for that question', () => {
    expect(() => composeAnswer(optionQuestion, [{ choice: 'option', letter: 'c', text: 'Other' }], '')).toThrow(TypeError);
  });

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

describe('splitAssistantQuestions', () => {
  it('leaves a reply without questions as it is', () => {
    expect(splitAssistantQuestions('All done.')).toEqual({ text: 'All done.', list: null, questions: null });
  });
  it('reads a closed list at the end of a reply', () => {
    const split = splitAssistantQuestions('Before.\n[[QUESTIONS]]\n1. Stop the run?\nRecommended: Yes\n[[/QUESTIONS]]\n');
    expect(split.text).toBe('Before.');
    expect(split.questions).toEqual([{ number: 1, question: 'Stop the run?', recommended: 'Yes', options: [], recommendedLetter: null }]);
  });
  it('keeps a list it cannot read as written', () => {
    expect(splitAssistantQuestions('[[QUESTIONS]]\nShould I stop?\n[[/QUESTIONS]]')).toEqual({ text: '', list: 'Should I stop?', questions: null });
  });
  it('shows a reply whose list is followed by more text in full, not as questions', () => {
    const content = 'A\n[[QUESTIONS]]\n1. Q?\n[[/QUESTIONS]]\nmore';
    expect(splitAssistantQuestions(content)).toEqual({ text: content, list: null, questions: null });
  });
  it('rejects content that is not text', () => {
    expect(() => splitAssistantQuestions(null)).toThrow('content must be text');
  });
});
