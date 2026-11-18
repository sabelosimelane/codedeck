import React, { useEffect, useRef, useState } from 'react';
import { Button, Note, TextArea } from '../ui';
import NoteContent from './NoteContent.jsx';

/**
 * A step that waits for the owner: what it concluded, its note as a document, and the two
 * things the owner can do. Sending back asks what to change first. The handlers report
 * success and failure themselves and resolve to null when the action did not go through.
 */
export default function ApprovalReview({ run, onLoadNotes, onApprove, onSendBack }) {
  if (!run?.approvalRequest) throw new Error('approval review: run.approvalRequest is required');
  for (const [name, value] of Object.entries({ onLoadNotes, onApprove, onSendBack })) {
    if (typeof value !== 'function') throw new Error(`approval review: ${name} must be a function`);
  }
  const { stepIndex, stepName, note: noteMeta } = run.approvalRequest;
  const [note, setNote] = useState({ state: 'loading', content: null });
  const [sendingBack, setSendingBack] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(null);
  const busyRef = useRef(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const page = await onLoadNotes(run.id, 0, stepIndex);
        if (!active) return;
        const latest = page?.notes?.[0];
        setNote({ state: page === null ? 'error' : 'ready', content: latest?.status === 'written' ? latest.content : null });
      } catch (error) {
        console.warn(`Step note could not be loaded: ${error?.message}`);
        if (active) setNote({ state: 'error', content: null });
      }
    })();
    return () => { active = false; };
  }, [run.id, stepIndex, onLoadNotes]);

  const act = async (kind) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    try {
      if (kind === 'approve') await onApprove(run.id);
      else if (await onSendBack(run.id, comment.trim())) { setComment(''); setSendingBack(false); }
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  return (
    <div role="group" aria-label={`${stepName} approval`} className="task-approval">
      <p className="task-approval-ask">{`${stepName} is finished. Approve it to continue, or send it back with what to change.`}</p>
      {noteMeta?.summary && <p className="task-approval-summary">{noteMeta.summary}</p>}
      <div className="task-approval-note">
        {note.state === 'loading' && <Note>Loading the step note…</Note>}
        {note.state === 'error' && <Note tone="warning">The step note could not be loaded.</Note>}
        {note.state === 'ready' && (note.content === null ? <Note>This step left no note.</Note> : <NoteContent content={note.content} />)}
      </div>
      {sendingBack && (
        <TextArea label="What should change" rows={3} maxLength={4000} value={comment} disabled={busy !== null} autoFocus
          placeholder={`What should ${stepName} change? It runs again with this.`} onChange={setComment} />
      )}
      <div className="task-approval-actions">
        {sendingBack
          ? <>
            <Button onClick={() => { setSendingBack(false); }} disabled={busy !== null}>Cancel</Button>
            <Button variant="primary" onClick={() => act('sendBack')} disabled={busy !== null || comment.trim() === ''}>{busy === 'sendBack' ? 'Sending back…' : 'Send back'}</Button>
          </>
          : <Button onClick={() => setSendingBack(true)} disabled={busy !== null}>Send back…</Button>}
        <Button variant={sendingBack ? 'secondary' : 'primary'} onClick={() => act('approve')} disabled={busy !== null}>{busy === 'approve' ? 'Approving…' : 'Approve and continue'}</Button>
      </div>
    </div>
  );
}
