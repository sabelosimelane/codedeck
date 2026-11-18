import { ACCEPT_RECOMMENDATIONS_ANSWER } from '../../../shared/pipeline-definitions.mjs';

/**
 * The questions an agent listed before it paused, read from the text CodeDeck took off its
 * screen: a numbered list, each item a question and, after "Recommended:", the answer the
 * agent would go with. Returns null when the text is not such a list, so the caller shows it
 * as written.
 */
export function parseQuestions(questions) {
  if (typeof questions !== 'string' || questions.trim() === '') throw new TypeError('questions must be a nonempty string');
  const items = [];
  for (const line of questions.split('\n')) {
    const start = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (start) items.push({ number: Number(start[1]), text: start[2].trim() });
    else if (items.length > 0 && line.trim() !== '') items.at(-1).text += ` ${line.trim()}`;
    else if (line.trim() !== '') return null; // text before the first item: not a plain list
  }
  if (items.length === 0) return null;
  return items.map(({ number, text }) => {
    const split = /^(.*?)\s*\bRecommended:\s*(.*)$/i.exec(text);
    const question = (split ? split[1] : text).trim();
    const recommended = split && split[2].trim() !== '' ? split[2].trim() : null;
    return { number, question, recommended };
  });
}

/**
 * One message for the agent from the owner's answer to each question, or null while a
 * question is still unanswered. `answers[i]` is `{ choice: 'recommended' | 'own', text }`.
 */
export function composeAnswer(questions, answers, note) {
  if (!Array.isArray(questions) || !Array.isArray(answers) || questions.length === 0 || answers.length !== questions.length) throw new TypeError('answers: one answer per question is required');
  if (typeof note !== 'string') throw new TypeError('note must be a string');
  const lines = [];
  for (const [index, answer] of answers.entries()) {
    const { number, recommended } = questions[index];
    if (answer?.choice !== 'recommended' && answer?.choice !== 'own') throw new TypeError(`answers[${index}].choice must be recommended or own`);
    if (typeof answer.text !== 'string') throw new TypeError(`answers[${index}].text must be a string`);
    if (answer.choice === 'recommended') {
      if (recommended === null) return null;
      lines.push(`${number}. As you recommend: ${recommended}`);
    } else {
      if (answer.text.trim() === '') return null;
      lines.push(`${number}. ${answer.text.trim()}`);
    }
  }
  const extra = note.trim();
  if (extra === '' && answers.every(answer => answer.choice === 'recommended')) return ACCEPT_RECOMMENDATIONS_ANSWER;
  return extra === '' ? lines.join('\n') : `${lines.join('\n')}\n\nAlso: ${extra}`;
}
