import React, { useState } from 'react';
import { Button, TextArea } from '../ui';
import { composeAnswer, recommendationLead } from '../../utils/inputQuestions.js';
import './task-view.css';

export const ANSWER_MAX = 4000;
const answerDrafts = new Map();

/** One question: the agent's recommendation chosen to begin with, or the owner's own words. */
function QuestionCard({ item, answer, disabled, onChange }) {
  const own = answer.choice === 'own';
  const hasOptions = item.options.length > 0;
  return (
    <div role="group" aria-label={`Question ${item.number}`} className="task-question" data-answered={own ? answer.text.trim() !== '' : answer.choice !== null}>
      <span className="task-question-number" aria-hidden="true">{item.number}</span>
      <div className="task-question-body">
        <p className="task-question-text">{item.question}</p>
        {hasOptions && item.recommendedLetter === null && item.recommended !== null && (
          <p className="task-question-recommended">Recommended: {item.recommended}</p>
        )}
        {hasOptions && (
          <div className="task-question-choices">
            {item.options.map(option => {
              const chosen = answer.choice === 'option' && answer.letter === option.letter;
              const recommended = item.recommendedLetter === option.letter;
              const reason = recommended ? recommendationLead(item.recommended)?.reason : null;
              return (
                <label key={option.letter} className="task-question-choice" data-chosen={chosen}>
                  <input type="radio" name={`question-${item.number}`} checked={chosen} disabled={disabled}
                    onChange={() => onChange({ choice: 'option', letter: option.letter })} />
                  <span><span className="task-question-choice-label">{option.letter}) {option.text}{recommended && ' Recommended'}</span>
                    {recommended && reason && <span className="task-question-recommended">{reason}</span>}</span>
                </label>
              );
            })}
            <label className="task-question-choice" data-chosen={own}>
              <input type="radio" name={`question-${item.number}`} checked={own} disabled={disabled}
                onChange={() => onChange({ choice: 'own', text: '' })} />
              <span className="task-question-choice-label">My own answer</span>
            </label>
          </div>
        )}
        {!hasOptions && item.recommended !== null && (
          <div className="task-question-choices">
            <label className="task-question-choice" data-chosen={!own}>
              <input type="radio" name={`question-${item.number}`} checked={!own} disabled={disabled} onChange={() => onChange({ ...answer, choice: 'recommended' })} />
              <span><span className="task-question-choice-label">Go with the recommendation</span><span className="task-question-recommended">{item.recommended}</span></span>
            </label>
            <label className="task-question-choice" data-chosen={own}>
              <input type="radio" name={`question-${item.number}`} checked={own} disabled={disabled} onChange={() => onChange({ ...answer, choice: 'own' })} />
              <span className="task-question-choice-label">My own answer</span>
            </label>
          </div>
        )}
        {own && (
          <TextArea label={`Your answer to question ${item.number}`} rows={2} maxLength={ANSWER_MAX} value={answer.text} disabled={disabled}
            placeholder="Type your answer" onChange={value => onChange({ ...answer, text: value })} />
        )}
      </div>
    </div>
  );
}

/**
 * Listed questions from an agent, each answered with its recommendation, a listed option or
 * the owner's own words, and sent as one numbered answer. Drafts survive a remount under the
 * same `draftKey`. `onSend` resolves truthy when the answer was delivered. `afterQuestions`
 * is shown between the last question and the send controls.
 */
export default function QuestionsForm({ questions, draftKey, canSend, onSend, afterQuestions = null }) {
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('questions form: questions must be a nonempty list');
  if (typeof draftKey !== 'string' || !draftKey) throw new Error('questions form: draftKey is required');
  if (typeof canSend !== 'boolean') throw new Error('questions form: canSend must be a boolean');
  if (typeof onSend !== 'function') throw new Error('questions form: onSend must be a function');
  const saved = answerDrafts.get(draftKey);
  const [answers, setAnswers] = useState(() => saved?.answers ?? questions.map(item => item.options.length > 0
    ? (item.recommendedLetter === null ? { choice: null, text: '' } : { choice: 'option', letter: item.recommendedLetter })
    : { choice: item.recommended === null ? 'own' : 'recommended', text: '' }));
  const [note, setNote] = useState(() => saved?.note ?? '');
  const [sending, setSending] = useState(false);
  const updateAnswers = update => setAnswers(current => {
    const next = typeof update === 'function' ? update(current) : update;
    answerDrafts.set(draftKey, { ...answerDrafts.get(draftKey), answers: next });
    return next;
  });
  const updateNote = value => { setNote(value); answerDrafts.set(draftKey, { ...answerDrafts.get(draftKey), note: value }); };
  const send = async answer => {
    if (sending) return;
    setSending(true);
    const delivered = await onSend(answer);
    setSending(false);
    if (delivered) { answerDrafts.delete(draftKey); setNote(''); }
  };

  const missing = answers.filter((answer, index) => (answer.choice === 'own' ? answer.text.trim() === ''
    : answer.choice === 'option' ? false : answer.choice === 'recommended' ? questions[index].recommended === null : true)).length;
  const composed = missing === 0 ? composeAnswer(questions, answers, note) : null;
  return <>
    {questions.map((item, index) => (
      <QuestionCard key={item.number} item={item} answer={answers[index]} disabled={sending || !canSend}
        onChange={next => updateAnswers(current => current.map((answer, position) => (position === index ? next : answer)))} />
    ))}
    {afterQuestions}
    {canSend && (
      <div className="task-questions-footer">
        <TextArea label="Anything else for the agent" rows={1} maxLength={ANSWER_MAX} value={note} disabled={sending}
          placeholder="Anything else for the agent (optional)" onChange={updateNote} />
        <div className="task-questions-send">
          {missing > 0 && <span className="task-questions-missing">{`${missing} of ${questions.length} still ${missing === 1 ? 'needs' : 'need'} your answer`}</span>}
          <Button variant="primary" disabled={sending || composed === null} onClick={() => send(composed)}>{sending ? 'Sending…' : 'Send answers'}</Button>
        </div>
      </div>
    )}
  </>;
}
