import React from 'react';
import NoteContent from '../components/tasks/NoteContent.jsx';

/**
 * What an open step has to read: its notes, the decisions its agent made by itself, what the owner
 * answered and how the owner reviewed it. Each is loaded when its chip is tapped; the app's loaders
 * toast a failure and resolve null, which is said here rather than shown as empty.
 */
const KINDS = [
  { kind: 'notes', label: 'Notes', when: () => true },
  { kind: 'decisions', label: 'Decisions', when: run => run.agentsDecide === true },
  { kind: 'answers', label: 'Your answers', when: () => true },
  { kind: 'reviews', label: 'Your reviews', when: (run, step) => step.approval === true },
];

function NotesList({ items }) {
  if (items.length === 0) return <p className="m-task-phase">No notes yet.</p>;
  return (
    <ul className="m-records" aria-label="Notes">
      {items.map(note => (
        <li key={note.id}>
          <p className="m-record-head m-mono">{[`Pass ${note.pass}`, note.summary].filter(Boolean).join(' · ')}</p>
          {note.status === 'written' && note.content ? <NoteContent content={note.content} /> : <p className="m-task-phase">This pass left no note.</p>}
        </li>
      ))}
    </ul>
  );
}

function RecordList({ kind, items }) {
  if (items.length === 0) return <p className="m-task-phase">None yet.</p>;
  return (
    <ul className="m-records" aria-label={kind}>
      {items.map(item => (
        <li key={item.id}>
          {kind === 'reviews'
            ? <p className="m-record-head m-mono">{`Attempt ${item.attempt} · ${item.verdict === 'approved' ? 'Approved' : `Sent back: ${item.comment}`}`}</p>
            : (
              <>
                {item.questions && <pre className="m-record-asked">{item.questions}</pre>}
                <p className="m-record-answer">{item.answer}</p>
              </>
            )}
        </li>
      ))}
    </ul>
  );
}

export default function StepDetail({ run, step, onLoadNotes, onLoadRecords }) {
  if (!run?.id) throw new Error('step detail: run is required');
  if (!step || !Number.isInteger(step.index)) throw new Error('step detail: step is required');
  if (typeof onLoadNotes !== 'function') throw new Error('step detail: onLoadNotes must be a function');
  if (typeof onLoadRecords !== 'function') throw new Error('step detail: onLoadRecords must be a function');
  const [shown, setShown] = React.useState(null);
  const [loaded, setLoaded] = React.useState({ state: 'idle', items: [] });
  React.useEffect(() => {
    if (shown === null) return undefined;
    let active = true;
    setLoaded({ state: 'loading', items: [] });
    (async () => {
      try {
        const page = shown === 'notes' ? await onLoadNotes(run.id, 0, step.index) : await onLoadRecords(shown, run.id, step.index);
        if (!active) return;
        if (page === null) setLoaded({ state: 'error', items: [] });
        else setLoaded({ state: 'ready', items: shown === 'notes' ? page.notes : page.items });
      } catch (error) {
        console.warn(`Step ${step.index} ${shown} could not be loaded: ${error?.message}`);
        if (active) setLoaded({ state: 'error', items: [] });
      }
    })();
    return () => { active = false; };
  }, [shown, run.id, step.index, onLoadNotes, onLoadRecords]);

  if (step.status === 'pending' && step.attempt === 0) return <p className="m-task-phase">Nothing to read until this step starts.</p>;
  const kinds = KINDS.filter(entry => entry.when(run, step));
  return (
    <div className="m-step-detail">
      <div className="m-chips-row">
        {kinds.map(entry => (
          <button key={entry.kind} type="button" className="m-chip m-press" aria-pressed={shown === entry.kind}
            onClick={() => setShown(current => (current === entry.kind ? null : entry.kind))}>{entry.label}</button>
        ))}
      </div>
      {shown !== null && (loaded.state === 'ready'
        ? (shown === 'notes' ? <NotesList items={loaded.items} /> : <RecordList kind={shown} items={loaded.items} />)
        : <p className="m-task-phase">{loaded.state === 'error' ? 'These could not be loaded.' : 'Loading…'}</p>)}
    </div>
  );
}
