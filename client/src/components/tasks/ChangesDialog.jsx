import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../ToastContext';
import { Badge, Button, Dialog, Note } from '../ui/index.jsx';
import NoteContent from './NoteContent.jsx';
import { listTaskChanges } from '../../utils/tasksApi.js';
import './task-view.css';

const FALLBACK = 'Something went wrong. Please try again.';
const reasonOf = failure => (failure instanceof Error && failure.message ? failure.message : FALLBACK);
const when = stamp => new Date(stamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The note without its first line, which is the summary already shown; null when nothing follows it. */
function restOf(detail) {
  if (detail === null) return null;
  const lines = detail.split(/\r?\n/);
  const rest = lines.slice(lines.findIndex(line => line.trim()) + 1).join('\n').trim();
  return rest || null;
}

const styles = {
  count: { fontSize: 12, color: 'var(--text-muted)' },
  list: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' },
  row: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-elevated)' },
  head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  title: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' },
  time: { flexShrink: 0, fontSize: 11, color: 'var(--text-muted)' },
  summary: { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)', overflowWrap: 'anywhere' },
  none: { margin: 0, fontSize: 12, color: 'var(--text-muted)' },
  facts: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 10px', fontSize: 11, color: 'var(--text-muted)' },
  landed: { display: 'inline-flex', alignItems: 'center', gap: 6 },
  commit: { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' },
  detail: { paddingTop: 6, borderTop: '1px solid var(--border)' },
};

/**
 * What was merged in a project, the most recent first. Each change is a task: its title, the
 * summary the last step of its run wrote, and the repositories it landed in with the commit
 * each stood at. Everything shown is read from the backend; nothing here changes anything.
 */
export default function ChangesDialog({ project, onClose }) {
  if (typeof project !== 'string' || !project.trim()) throw new Error('changes dialog: project must be a name');
  if (typeof onClose !== 'function') throw new Error('changes dialog: onClose must be a function');
  const { showToast } = useToast();
  const [changes, setChanges] = useState(null);
  const [more, setMore] = useState({ hasNextPage: false, total: 0, pages: 0 });
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const alive = useRef(true);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      const first = await listTaskChanges({ project, page: 0 });
      if (!alive.current) return;
      setChanges(first.changes);
      setMore({ hasNextPage: first.hasNextPage, total: first.total, pages: 1 });
    } catch (error) {
      if (alive.current) { setChanges(null); setFailure(reasonOf(error)); }
    }
  }, [project]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  const showOlder = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await listTaskChanges({ project, page: more.pages });
      if (!alive.current) return;
      // A change merged meanwhile moves the pages by one; a change already shown is not shown twice.
      setChanges(current => [...current, ...next.changes.filter(change => !current.some(shown => shown.id === change.id))]);
      setMore(current => ({ hasNextPage: next.hasNextPage, total: next.total, pages: current.pages + 1 }));
    } catch (error) {
      showToast({ type: 'error', message: reasonOf(error) });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const toggle = id => setOpen((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const shown = changes?.length ?? 0;
  const count = `${more.total > shown ? `${shown} of ${more.total}` : shown} ${Math.max(more.total, shown) === 1 ? 'change' : 'changes'}`;

  return (
    <Dialog title={`Changes in ${project}`} width={680} onClose={onClose}
      subtitle="What was merged in this project, newest first. A change's summary is what the last step of its workflow run wrote."
      footer={<>
        {changes !== null && more.hasNextPage && <Button onClick={showOlder} disabled={busy}>Show older changes</Button>}
        <Button variant="primary" onClick={onClose}>Done</Button>
      </>}>
      {changes === null && failure === null && <span style={styles.count}>Reading the changes…</span>}
      {failure !== null && (
        <Note tone="danger" role="alert">
          <span>The changes could not be read: {failure}</span>
          <div><Button size="small" onClick={load}>Try again</Button></div>
        </Note>
      )}
      {changes !== null && changes.length === 0 && <span style={styles.count}>Nothing has been merged in {project} yet.</span>}
      {changes !== null && changes.length > 0 && (
        <>
          <span style={styles.count}>{count}</span>
          <ul style={styles.list} aria-label={`Changes in ${project}`}>
            {changes.map((change) => {
              const rest = restOf(change.detail);
              const expanded = open.has(change.id);
              return (
                <li key={change.id} style={styles.row}>
                  <div style={styles.head}>
                    <h3 style={styles.title}>{change.title}</h3>
                    <time style={styles.time} dateTime={change.mergedAt}>{when(change.mergedAt)}</time>
                  </div>
                  {change.summary !== null
                    ? <p style={styles.summary}>{change.summary}</p>
                    : <p style={styles.none}>{change.workflow === null ? 'No summary: this task was merged without a workflow run.' : 'No summary: the last step of its run wrote no note.'}</p>}
                  <div style={styles.facts}>
                    {change.workflow !== null && <Badge>{change.workflow}</Badge>}
                    {change.repositories.map(entry => (
                      <span key={entry.repository} style={styles.landed}>
                        <span>{entry.baseBranch === null ? entry.repository : `${entry.repository} into ${entry.baseBranch}`}</span>
                        {entry.commit !== null && <code style={styles.commit} title={entry.commit}>{entry.commit.slice(0, 7)}</code>}
                      </span>
                    ))}
                    {rest !== null && (
                      <Button size="small" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} details of ${change.title}`} onClick={() => toggle(change.id)}>
                        {expanded ? 'Hide details' : 'Details'}
                      </Button>
                    )}
                  </div>
                  {expanded && rest !== null && <div style={styles.detail}><NoteContent content={rest} /></div>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Dialog>
  );
}
