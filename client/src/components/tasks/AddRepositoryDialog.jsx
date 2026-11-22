import React, { useEffect, useState } from 'react';
import { useToast } from '../ToastContext';
import { Button, Dialog, Field, Note, SegmentedControl, TextInput } from '../ui/index.jsx';
import DirectoryBrowser from '../DirectoryBrowser';
import { addTaskOutsideRepository, addTaskRepository, addTaskWorktree } from '../../utils/tasksApi.js';
import { listProjectRepositories } from '../../utils/projectRepositoriesApi.js';

const FALLBACK = 'Something went wrong. Please try again.';
const NOT_PREPARED = 'It was not prepared: install what it needs before building or testing there.';
// What is done with a folder outside the project: the task gets a new copy of its repository, or the folder itself joins the task.
const FOLDER_USES = [
  { value: 'copy', label: 'New copy' },
  { value: 'existing', label: 'Use as it is' },
];
const FOLDER_HINTS = {
  copy: 'For the folder a repository is checked out in. The task gets its own copy and a branch for it, started from the commit that folder is on; the folder itself is not changed.',
  existing: 'For a worktree already made for this work. It joins the task with its branch and files as they are, and its work is merged into the checkout its repository is kept in.',
};

/**
 * Gives an open task one more repository: a copy of one of its project's repositories the task
 * never had (one that was merged or closed in it cannot come back), or a repository from any
 * other folder, which joins this task only. The backend creates a copy and its branch, or takes
 * an existing worktree as it is; nothing is prepared in it.
 */
export default function AddRepositoryDialog({ task, onAdded, onClose }) {
  const { showToast } = useToast();
  const [repositories, setRepositories] = useState(null);
  const [failure, setFailure] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState('');
  const [folderUse, setFolderUse] = useState('copy');
  const [picking, setPicking] = useState(false);

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

  /** Runs one addition: one at a time, a toast for either outcome, and a refusal kept on screen. `success` words the toast from the task as it now is. */
  const run = async (action, success) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const next = await action();
      showToast({ type: 'success', message: success(next) });
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

  const add = entry => run(() => addTaskRepository(task.id, entry.name), () => `${entry.name} added to ${task.title}. ${NOT_PREPARED}`);

  const addFolder = () => {
    const typed = folder.trim();
    // The backend names the repository after its own folder: it is the one the task did not have before.
    const added = (next) => {
      const fresh = next.worktrees.find(worktree => !had.has(worktree.repository));
      if (!fresh) throw new Error('The task came back without the repository that was added');
      return fresh;
    };
    if (folderUse === 'existing') {
      return run(() => addTaskWorktree(task.id, typed), (next) => { const fresh = added(next); return `${fresh.repository} added to ${task.title} as it is, on its branch ${fresh.branch}.`; });
    }
    return run(() => addTaskOutsideRepository(task.id, typed), next => `${added(next).repository} added to ${task.title}. ${NOT_PREPARED}`);
  };

  return (
    <Dialog title="Add a repository to this task" width={560} busy={busy} onClose={onClose}
      subtitle={`"${task.title}" can work in one more repository: one of this project's, or one from any other folder.`}
      footer={<Button onClick={onClose} disabled={busy}>Cancel</Button>}>
      <Field label="This project's repositories" hint={offered.length > 0 ? 'The task gets its own copy of the repository and a branch for it, started from the repository\'s current commit.' : undefined}>
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
      </Field>
      <Field label="A repository from another folder" hint={FOLDER_HINTS[folderUse]}>
        <div style={{ display: 'flex', gap: 8 }}>
          <TextInput label="Folder of the repository" value={folder} onChange={setFolder} placeholder="/path/to/repository" disabled={busy} style={{ flex: 1, minWidth: 0 }}
            onKeyDown={(event) => { if (event.key === 'Enter' && folder.trim()) addFolder(); }} />
          <Button onClick={() => setPicking(true)} disabled={busy}>Browse…</Button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          {/* Wide enough for both labels: the two choices share the width equally and cut off the longer one otherwise. */}
          <div style={{ flex: '0 0 auto', width: 240 }}>
            <SegmentedControl label="What to do with the folder" value={folderUse} onChange={setFolderUse} options={FOLDER_USES} />
          </div>
          <Button variant="primary" onClick={addFolder} disabled={busy || folder.trim().length === 0}>Add folder</Button>
        </div>
      </Field>
      <Note>It joins this task only: the project&apos;s list of repositories stays as it is. No Setup step runs for a repository added now. Install its dependencies and copy the local files it needs yourself, or have the next step do it, before building or testing there.</Note>
      {refusal && <Note tone="danger" role="alert">{refusal}</Note>}
      {picking && <DirectoryBrowser initialPath={folder.trim() || undefined} host={task.host} onSelect={(chosen) => { setFolder(chosen); setPicking(false); }} onCancel={() => setPicking(false)} />}
    </Dialog>
  );
}
