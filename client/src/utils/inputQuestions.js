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
    if (start) items.push({ number: Number(start[1]), lines: [start[2].trim()] });
    else if (items.length > 0 && line.trim() !== '') items.at(-1).lines.push(line.trim());
    else if (line.trim() !== '') return null; // text before the first item: not a plain list
  }
  if (items.length === 0) return null;
  return items.map(({ number, lines }) => {
    const split = /^([\s\S]*?)\s*\bRecommended:\s*([\s\S]*)$/i.exec(lines.join('\n'));
    const questionLines = (split ? split[1] : lines.join('\n')).trim().split('\n');
    const recommended = split && split[2].trim() !== '' ? split[2].trim().replace(/\s+/g, ' ') : null;
    const firstOption = questionLines.findIndex(line => /^\s*[a-f][.)]\s+/.test(line));
    const optionLines = firstOption === -1 ? [] : questionLines.slice(firstOption);
    const options = optionLines.map(line => /^\s*([a-f])[.)]\s+(.+)$/.exec(line));
    const validOptions = options.length > 0 && options.length <= 6
      && options.every((option, index) => option && option[1] === String.fromCharCode(97 + index));
    const question = (validOptions ? questionLines.slice(0, firstOption) : questionLines).join(' ').replace(/\s+/g, ' ').trim();
    const choices = validOptions ? options.map(option => ({ letter: option[1], text: option[2].trim() })) : [];
    const lead = recommended === null ? null : /^(?:\(([a-f])\)|([a-f])[.)]?)(?=\s|$)/i.exec(recommended);
    const letter = lead?.[1]?.toLowerCase() ?? lead?.[2]?.toLowerCase() ?? null;
    const recommendedLetter = choices.some(option => option.letter === letter) ? letter : null;
    return { number, question, recommended, options: choices, recommendedLetter };
  });
}

/**
 * One message for the agent from the owner's answer to each question, or null while a
 * question is still unanswered. `answers[i]` selects a recommendation, listed option, or own text.
 */
export function composeAnswer(questions, answers, note) {
  if (!Array.isArray(questions) || !Array.isArray(answers) || questions.length === 0 || answers.length !== questions.length) throw new TypeError('answers: one answer per question is required');
  if (typeof note !== 'string') throw new TypeError('note must be a string');
  const lines = [];
  for (const [index, answer] of answers.entries()) {
    const { number, recommended, options, recommendedLetter } = questions[index];
    if (answer?.choice !== 'recommended' && answer?.choice !== 'own' && answer?.choice !== 'option') throw new TypeError(`answers[${index}].choice must be recommended, option or own`);
    if (answer.choice !== 'option' && typeof answer.text !== 'string') throw new TypeError(`answers[${index}].text must be a string`);
    if (answer.choice === 'recommended') {
      if (recommended === null) return null;
      lines.push(`${number}. As you recommend: ${recommended}`);
    } else if (answer.choice === 'option') {
      const option = options?.find(option => option.letter === answer.letter);
      if (!option) throw new TypeError(`answers[${index}].letter must be a listed option`);
      if (answer.text !== undefined && typeof answer.text !== 'string') throw new TypeError(`answers[${index}].text must be a string`);
      lines.push(`${number}. (${option.letter}) ${option.text}`);
    } else {
      if (answer.text.trim() === '') return null;
      lines.push(`${number}. ${answer.text.trim()}`);
    }
  }
  const extra = note.trim();
  if (extra === '' && answers.every((answer, index) => answer.choice === 'recommended'
    || (answer.choice === 'option' && answer.letter === questions[index].recommendedLetter))) return ACCEPT_RECOMMENDATIONS_ANSWER;
  return extra === '' ? lines.join('\n') : `${lines.join('\n')}\n\nAlso: ${extra}`;
}
