import React, { useMemo, useState } from 'react';
import { Button, Note, TextArea } from '../ui';
import { composeAnswer, parseQuestions } from '../../utils/inputQuestions.js';

const ANSWER_MAX = 4000;

/** One question: the agent's recommendation chosen to begin with, or the owner's own words. */
function QuestionCard({ item, answer, disabled, onChange }) {
  const own = answer.choice === 'own';
  return (
    <div role="group" aria-label={`Question ${item.number}`} className="task-question" data-answered={own ? answer.text.trim() !== '' : true}>
      <span className="task-question-number" aria-hidden="true">{item.number}</span>
      <div className="task-question-body">
        <p className="task-question-text">{item.question}</p>
        {item.recommended !== null && (
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
 * What a run is waiting for. Listed questions are shown one by one, each answered with the
 * agent's recommendation or the owner's own words, and sent as one numbered answer. The
 * backend types the answer into the agent's terminal.
 */
export default function QuestionsPanel({ run, onAnswer }) {
  if (!run || typeof run !== 'object') throw new Error('questions panel: run is required');
  if (typeof onAnswer !== 'function') throw new Error('questions panel: onAnswer must be a function');
  const request = run.inputRequest;
  const text = request?.questions ?? null;
  const questions = useMemo(() => (text === null ? null : parseQuestions(text)), [text]);
  const [answers, setAnswers] = useState(() => (questions ?? []).map(item => ({ choice: item.recommended === null ? 'own' : 'recommended', text: '' })));
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const send = async (answer) => {
    if (sending) return;
    setSending(true);
    // `onAnswer` resolves to the updated run, or null when the answer was not delivered.
    const delivered = await onAnswer(run.id, answer);
    setSending(false);
    if (delivered) { setDraft(''); setNote(''); }
  };

  const listed = questions !== null && answers.length === questions.length;
  const composed = listed ? composeAnswer(questions, answers, note) : null;
  const missing = listed ? answers.filter((answer, index) => (answer.choice === 'own' ? answer.text.trim() === '' : questions[index].recommended === null)).length : 0;

  return (
    <div role="group" aria-label={`${run.workflowName} needs your input`} className="task-questions">
      {request === null && <Note>The agent is showing a dialog in its terminal. Answer it there.</Note>}
      {request !== null && text === null && <Note>The agent did not say what it needs. Read its terminal, then answer here or there.</Note>}
      {text !== null && !listed && <div className="task-questions-written">{text}</div>}
      {listed && questions.map((item, index) => (
        <QuestionCard key={item.number} item={item} answer={answers[index]} disabled={sending || !run.actions?.answer}
          onChange={next => setAnswers(current => current.map((answer, position) => (position === index ? next : answer)))} />
      ))}
      {request?.truncated && <Note tone="warning">The list was cut here. Read the rest in the agent&apos;s terminal.</Note>}
      {run.actions?.answer && listed && (
        <div className="task-questions-footer">
          <TextArea label="Anything else for the agent" rows={1} maxLength={ANSWER_MAX} value={note} disabled={sending}
            placeholder="Anything else for the agent (optional)" onChange={setNote} />
          <div className="task-questions-send">
            {missing > 0 && <span className="task-questions-missing">{`${missing} of ${questions.length} still ${missing === 1 ? 'needs' : 'need'} your answer`}</span>}
            <Button variant="primary" disabled={sending || composed === null} onClick={() => send(composed)}>{sending ? 'Sending…' : 'Send answers'}</Button>
          </div>
        </div>
      )}
      {run.actions?.answer && !listed && (
        <div className="task-questions-footer">
          <TextArea label="Your answer" rows={2} maxLength={ANSWER_MAX} value={draft} disabled={sending}
            placeholder="Type your answer; it is sent to the agent's terminal" onChange={setDraft} />
          <div className="task-questions-send">
            <Button variant="primary" disabled={sending || draft.trim() === ''} onClick={() => send(draft.trim())}>{sending ? 'Sending…' : 'Send answer'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
