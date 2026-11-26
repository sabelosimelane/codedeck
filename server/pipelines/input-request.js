// What an agent is waiting for when it signals NEEDS_INPUT.
// The loop instruction (server/terminal-workflow.js) asks the agent to print a questions
// marker, a numbered list of questions with a recommendation each, and then the signal.
// The questions are read from the terminal screen between those two markers.
import { stripVTControlCharacters } from 'node:util';

export const MAX_QUESTIONS_LENGTH = 4000;

const IDENTIFIER = /^[\w-]{1,64}$/;
// Tab and new line are the only control characters questions may hold.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;
// The glyph an agent CLI draws in front of a message, and the indentation under it.
const LEADING = /^\s*(?:[•⏺●]\s+)?/u;
// These start a line of their own; any other line continues the one above it.
const STARTS_LINE = /^(?:\d{1,3}[.)]\s|[a-f][.)]\s|[-*]\s|Recommended:)/i;

function fail(field, expectation) {
  throw new TypeError(`input request: ${field} ${expectation}`);
}

/**
 * The questions an agent printed before its NEEDS_INPUT signal for this iteration.
 * `questions` is null when the agent did not state any (no marker, or nothing under it).
 * @param {string[]} lines terminal screen, top to bottom
 * @param {string} identifier the iteration identifier the loop is waiting on
 * @returns {{ questions: string | null, truncated: boolean }}
 */
export function extractQuestions(lines, identifier) {
  if (!Array.isArray(lines)) fail('lines', 'must be an array of screen lines');
  lines.forEach((line, index) => {
    if (typeof line !== 'string') fail(`lines[${index}]`, 'must be a string');
  });
  if (typeof identifier !== 'string' || !IDENTIFIER.test(identifier)) {
    fail('identifier', 'must be 1–64 letters, digits, underscores or hyphens');
  }

  const text = lines.map(line => stripVTControlCharacters(line));
  // OpenCode renders [[x]] as a markdown link, [x]: one bracket on each side is enough.
  const holds = (line, status) => new RegExp(`\\[\\[?CDW:${identifier}:${status}\\]\\]?`).test(line.replace(/\s/g, ''));
  const none = { questions: null, truncated: false };

  const signalAt = text.findLastIndex(line => holds(line, 'NEEDS_INPUT'));
  if (signalAt === -1) return none;
  const markerAt = text.slice(0, signalAt).findLastIndex(line => holds(line, 'QUESTIONS'));
  if (markerAt === -1) return none;

  const written = [];
  for (const raw of text.slice(markerAt + 1, signalAt)) {
    const line = raw.replace(LEADING, '').trimEnd();
    if (line === '') continue;
    if (written.length === 0 || STARTS_LINE.test(line)) written.push(line);
    else written[written.length - 1] += ` ${line}`;
  }
  const questions = written.join('\n');
  if (questions === '') return none;
  return questions.length > MAX_QUESTIONS_LENGTH
    ? { questions: questions.slice(0, MAX_QUESTIONS_LENGTH), truncated: true }
    : { questions, truncated: false };
}

/**
 * A run's stored input request: null when the run is not waiting on an agent's signal,
 * otherwise what `extractQuestions` returned. Throws on any other shape.
 */
export function validateInputRequest(value) {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('inputRequest', 'must be null or an object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'questions' && key !== 'truncated') fail(`inputRequest.${key}`, 'is not a known field');
  }
  const { questions, truncated } = value;
  if (questions !== null && (
    typeof questions !== 'string' || !questions.trim() || questions.length > MAX_QUESTIONS_LENGTH || CONTROL.test(questions)
  )) fail('inputRequest.questions', `must be null or 1–${MAX_QUESTIONS_LENGTH} characters without control characters`);
  if (typeof truncated !== 'boolean' || (truncated && questions === null)) {
    fail('inputRequest.truncated', 'must be a boolean, and false when there are no questions');
  }
  return { questions, truncated };
}
