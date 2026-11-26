import { describe, expect, it } from 'vitest';
import { MAX_QUESTIONS_LENGTH, extractQuestions, validateInputRequest } from '../pipelines/input-request.js';
import { validateRunAnswerBody } from '../../shared/pipeline-definitions.mjs';

const ID = 'fd4ed49c-1';
const QUESTIONS = `[[CDW:${ID}:QUESTIONS]]`;
const NEEDS_INPUT = `[[CDW:${ID}:NEEDS_INPUT]]`;

describe('extractQuestions', () => {
  it('keeps lettered options separate after a wrapped question and wrapped option', () => {
    const lines = [QUESTIONS,
      '  1. Which database should the new report use when',
      '     both are available?',
      '     a) The existing reporting database',
      '     b) A dedicated database with its own',
      '        backup schedule',
      '     Recommended: b) It isolates report load.',
      NEEDS_INPUT];
    expect(extractQuestions(lines, ID).questions).toBe([
      '1. Which database should the new report use when both are available?',
      'a) The existing reporting database',
      'b) A dedicated database with its own backup schedule',
      'Recommended: b) It isolates report load.',
    ].join('\n'));
  });

  it('reads the numbered questions a Codex screen shows between the questions marker and the signal', () => {
    const lines = [
      '› $feature-dev docs/todos/x.md CodeDeck workflow instruction: perform one pass of the command above…',
      '',
      '• Phase 0 is complete: 133 migration tests passed.',
      '',
      `• ${QUESTIONS}`,
      '',
      '  1. Should WhatsApp opt-in be stored per guardian or per contact number?',
      '     Recommended: per contact number, because one guardian can have several',
      '     numbers.',
      '  2. Which template language is the default? Recommended: English.',
      '',
      `• ${NEEDS_INPUT}`,
      '',
      '  Worked for 4m 59s • 01:27',
      '',
      '› Ask Codex to do anything',
    ];
    expect(extractQuestions(lines, ID)).toEqual({
      questions: [
        '1. Should WhatsApp opt-in be stored per guardian or per contact number?',
        'Recommended: per contact number, because one guardian can have several numbers.',
        '2. Which template language is the default? Recommended: English.',
      ].join('\n'),
      truncated: false,
    });
  });

  it('reads a Claude screen, where the whole message is one indented block with colour codes', () => {
    const lines = [
      `\x1b[1m⏺\x1b[0m ${QUESTIONS}`,
      '  1) May I delete the unused V46 migration?',
      '  Recommended: no, keep it until the release is tagged.',
      '  - Also: which branch should the fix target?',
      `  ${NEEDS_INPUT}`,
    ];
    expect(extractQuestions(lines, ID).questions).toBe([
      '1) May I delete the unused V46 migration?',
      'Recommended: no, keep it until the release is tagged.',
      '- Also: which branch should the fix target?',
    ].join('\n'));
  });

  it('reads questions whose markers OpenCode showed with single brackets', () => {
    const single = status => `[\x1b[4mCDW:${ID}:${status}\x1b[0m]`;
    const lines = [single('QUESTIONS'), '1. Which port? Recommended: 43100.', single('NEEDS_INPUT')];
    expect(extractQuestions(lines, ID)).toEqual({ questions: '1. Which port? Recommended: 43100.', truncated: false });
  });

  it('uses the last signal on screen and the questions marker nearest above it', () => {
    const lines = [QUESTIONS, '1. First question?', NEEDS_INPUT, 'the owner answered', QUESTIONS, '1. Second question?', NEEDS_INPUT];
    expect(extractQuestions(lines, ID).questions).toBe('1. Second question?');
  });

  it.each([
    ['the agent printed no questions marker', ['I am blocked.', NEEDS_INPUT]],
    ['the questions marker is only below the signal', [NEEDS_INPUT, QUESTIONS, '1. Late?']],
    ['nothing is written between the markers', [QUESTIONS, '', '   ', NEEDS_INPUT]],
    ['the signal is not on screen', [QUESTIONS, '1. Where is the signal?']],
    ['the markers belong to another iteration', ['[[CDW:aaaa1111-1:QUESTIONS]]', '1. Old?', '[[CDW:aaaa1111-1:NEEDS_INPUT]]']],
    ['the screen is empty', []],
  ])('reports no stated questions when %s', (_label, lines) => {
    expect(extractQuestions(lines, ID)).toEqual({ questions: null, truncated: false });
  });

  it('cuts questions longer than the limit and says so', () => {
    const long = `1. ${'x'.repeat(MAX_QUESTIONS_LENGTH + 50)}`;
    const result = extractQuestions([QUESTIONS, long, NEEDS_INPUT], ID);
    expect(result.truncated).toBe(true);
    expect(result.questions).toHaveLength(MAX_QUESTIONS_LENGTH);
    expect(result.questions).toBe(long.slice(0, MAX_QUESTIONS_LENGTH));
  });

  it('keeps questions of exactly the limit whole', () => {
    const exact = 'q'.repeat(MAX_QUESTIONS_LENGTH);
    expect(extractQuestions([QUESTIONS, exact, NEEDS_INPUT], ID)).toEqual({ questions: exact, truncated: false });
  });

  it.each([
    ['lines', 'not an array', ID],
    ['lines[1]', ['ok', 5], ID],
    ['identifier', [], undefined],
    ['identifier', [], 'has space'],
    ['identifier', [], ''],
  ])('fails loudly when %s is invalid', (field, lines, identifier) => {
    expect(() => extractQuestions(lines, identifier)).toThrow(`input request: ${field}`);
  });
});

describe('validateInputRequest', () => {
  it.each([
    null,
    { questions: null, truncated: false },
    { questions: '1. One?\nRecommended: yes.', truncated: false },
    { questions: 'q'.repeat(MAX_QUESTIONS_LENGTH), truncated: true },
  ])('accepts %j', (value) => {
    expect(validateInputRequest(value)).toEqual(value);
  });

  it.each([
    ['inputRequest', undefined],
    ['inputRequest', 'text'],
    ['inputRequest', []],
    ['inputRequest.questions', { truncated: false }],
    ['inputRequest.questions', { questions: '', truncated: false }],
    ['inputRequest.questions', { questions: '   ', truncated: false }],
    ['inputRequest.questions', { questions: 5, truncated: false }],
    ['inputRequest.questions', { questions: 'q'.repeat(MAX_QUESTIONS_LENGTH + 1), truncated: false }],
    ['inputRequest.questions', { questions: 'bell\x07', truncated: false }],
    ['inputRequest.truncated', { questions: 'One?' }],
    ['inputRequest.truncated', { questions: 'One?', truncated: 'no' }],
    ['inputRequest.truncated', { questions: null, truncated: true }],
    ['inputRequest.extra', { questions: 'One?', truncated: false, extra: 1 }],
  ])('rejects an invalid %s', (field, value) => {
    expect(() => validateInputRequest(value)).toThrow(field);
  });
});

describe('validateRunAnswerBody', () => {
  const ANSWER_MESSAGE = 'Use 1–4000 characters; new lines are allowed, other control characters are not';

  it.each([
    'Proceed with your recommendations.',
    'a',
    'x'.repeat(4000),
    '1. per contact number\n2. English',
    "'; DROP TABLE pipeline_runs; --",
    '<script>alert(1)</script>',
  ])('accepts %j', (answer) => {
    expect(validateRunAnswerBody({ answer })).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 7],
    ['an array', []],
    ['empty', ''],
    ['blank', ' \n '],
    ['4001 characters', 'x'.repeat(4001)],
    ['an escape character', 'yes\x1b[201~'],
    ['a carriage return', 'yes\rno'],
    ['a tab', 'yes\tno'],
    ['a NUL', 'yes\x00'],
  ])('rejects an answer that is %s', (_label, answer) => {
    expect(validateRunAnswerBody({ answer })).toEqual([{ field: 'answer', message: ANSWER_MESSAGE }]);
  });

  it('rejects unknown fields and a body that is not an object', () => {
    expect(validateRunAnswerBody({ answer: 'ok', extra: 1 })).toEqual([{ field: 'extra', message: 'Unknown field' }]);
    expect(validateRunAnswerBody(null)).toEqual([{ field: 'body', message: 'A JSON object is required' }]);
    expect(validateRunAnswerBody([])).toEqual([{ field: 'body', message: 'A JSON object is required' }]);
  });
});
