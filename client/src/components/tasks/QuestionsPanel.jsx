import React, { useMemo, useState } from 'react';
import { Button, Note, TextArea } from '../ui';
import { parseQuestions } from '../../utils/inputQuestions.js';
import QuestionsForm, { ANSWER_MAX } from './QuestionsForm.jsx';

const answerDrafts = new Map();

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
  const draftKey = `${run.id}:${run.currentStepIndex ?? ''}:${run.steps?.[run.currentStepIndex]?.iteration ?? ''}:${text ?? '<free-text>'}`;
  const questions = useMemo(() => (text === null ? null : parseQuestions(text)), [text]);
  const [draft, setDraft] = useState(() => answerDrafts.get(draftKey) ?? '');
  const [sending, setSending] = useState(false);
  const updateDraft = value => { setDraft(value); answerDrafts.set(draftKey, value); };

  // `onAnswer` resolves to the updated run, or null when the answer was not delivered.
  const sendDraft = async () => {
    if (sending) return;
    setSending(true);
    const delivered = await onAnswer(run.id, draft.trim());
    setSending(false);
    if (delivered) { answerDrafts.delete(draftKey); setDraft(''); }
  };

  const listed = questions !== null;
  const truncated = request?.truncated ? <Note tone="warning">The list was cut here. Read the rest in the agent&apos;s terminal.</Note> : null;
  return (
    <div role="group" aria-label={`${run.workflowName} needs your input`} className="task-questions">
      {request === null && <Note>The agent is showing a dialog in its terminal. Answer it there.</Note>}
      {request !== null && text === null && <Note>The agent did not say what it needs. Read its terminal, then answer here or there.</Note>}
      {text !== null && !listed && <div className="task-questions-written">{text}</div>}
      {listed && <QuestionsForm key={draftKey} questions={questions} draftKey={draftKey} canSend={Boolean(run.actions?.answer)}
        onSend={answer => onAnswer(run.id, answer)} afterQuestions={truncated} />}
      {!listed && truncated}
      {run.actions?.answer && !listed && (
        <div className="task-questions-footer">
          <TextArea label="Your answer" rows={2} maxLength={ANSWER_MAX} value={draft} disabled={sending}
            placeholder="Type your answer; it is sent to the agent's terminal" onChange={updateDraft} />
          <div className="task-questions-send">
            <Button variant="primary" disabled={sending || draft.trim() === ''} onClick={sendDraft}>{sending ? 'Sending…' : 'Send answer'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
