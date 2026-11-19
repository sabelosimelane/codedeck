import React, { useEffect, useState } from 'react';
import { useToast } from '../ToastContext';
import { Button, Dialog, Note } from '../ui/index.jsx';
import { addTaskRepository } from '../../utils/tasksApi.js';
import { listProjectRepositories } from '../../utils/projectRepositoriesApi.js';

const FALLBACK = 'Something went wrong. Please try again.';

/**
 * Gives an open task a copy of one more of its project's repositories. Offered are the
 * repositories the task never had: one that was merged or closed in it cannot come back.
 * The backend creates the copy and its branch; nothing is prepared in it.
 */
export default function AddRepositoryDialog({ task, onAdded, onClose }) {
  const { showToast } = useToast();
  const [repositories, setRepositories] = useState(null);
  const [failure, setFailure] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const listed = await listProjectRepositories(task.project);
        if (alive) setRepositories(listed);
      } catch (error) {
        if (alive) setFailure(error instanceof Error ? error.message : FALLBACK);
      }
    };
    load();
    return () => { alive = false; };
  }, [task.project]);

  const had = new Set(task.worktrees.map(worktree => worktree.repository));
  const offered = repositories === null ? [] : repositories.filter(entry => !had.has(entry.name));

  const add = async (entry) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const next = await addTaskRepository(task.id, entry.name);
      showToast({ type: 'success', message: `${entry.name} added to ${task.title}. It was not prepared: install what it needs before building or testing there.` });
      onAdded(next);
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : FALLBACK;
      showToast({ type: 'error', message });
      setRefusal(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Add a repository to this task" width={520} busy={busy} onClose={onClose}
      subtitle={`"${task.title}" gets its own copy of the repository and a branch for it, started from the repository's current commit.`}
      footer={<Button onClick={onClose} disabled={busy}>Cancel</Button>}>
      {repositories === null && failure === null && <span className="ui-field-hint">Reading the project&apos;s repositories…</span>}
      {failure && <Note tone="danger" role="alert">{failure}</Note>}
      {repositories !== null && offered.length === 0 && <Note>Every repository of this project is, or was, part of this task.</Note>}
      {offered.length > 0 && (
        <ul aria-label="Repositories that can be added" style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
          {offered.map(entry => (
            <li key={entry.name} data-repository={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' }}>
              <span style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 6, flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-primary)' }}>
                <strong>{entry.name}</strong>
                {entry.usable && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{entry.branch === null ? 'from its current commit' : `from ${entry.branch}`}</span>}
                {!entry.usable && <span style={{ fontSize: 12, color: 'var(--warning)' }}>{entry.reason.message}</span>}
              </span>
              <Button size="small" aria-label={`Add ${entry.name}`} onClick={() => add(entry)} disabled={busy || !entry.usable}>Add</Button>
            </li>
          ))}
        </ul>
      )}
      {offered.length > 0 && <Note>No Setup step runs for a repository added now. Install its dependencies and copy the local files it needs yourself, or have the next step do it, before building or testing there.</Note>}
      {refusal && <Note tone="danger" role="alert">{refusal}</Note>}
    </Dialog>
  );
}
