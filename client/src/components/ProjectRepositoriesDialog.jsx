import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from './ToastContext';
import DirectoryBrowser from './DirectoryBrowser';
import { Badge, Button, Dialog, Note } from './ui/index.jsx';
import { addProjectRepository, getRepositoryCandidates, listProjectRepositories, removeProjectRepository } from '../utils/projectRepositoriesApi.js';

// The backend enforces this; it is repeated here only to say so before a request is refused.
export const MAX_OTHER_REPOSITORIES = 8;
const FALLBACK = 'Something went wrong. Please try again.';
const plural = (number, word) => `${number} ${number === 1 ? word : word.replace(/y$/, 'ie') + 's'}`;
const reasonOf = failure => (failure instanceof Error && failure.message ? failure.message : FALLBACK);
const parentOf = folder => folder.slice(0, Math.max(folder.replace(/\/+$/, '').lastIndexOf('/'), 1));

const styles = {
  section: { display: 'flex', flexDirection: 'column', gap: 6 },
  heading: { display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' },
  list: { display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: 0, listStyle: 'none', maxHeight: 220, overflowY: 'auto' },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)' },
  text: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
  line: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 13, color: 'var(--text-primary)' },
  muted: { fontSize: 12, color: 'var(--text-muted)' },
  path: { fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  warning: { fontSize: 12, color: 'var(--warning)' },
};

/**
 * The repositories that make up a project: its own, and the others it lists. Listing one
 * changes nothing on disk; the list lives in CodeDeck. Everything shown is read from the
 * backend, and every change goes through it and is confirmed with a toast.
 */
export default function ProjectRepositoriesDialog({ project, onClose, onChanged }) {
  if (typeof project?.name !== 'string' || !project.name || typeof project?.path !== 'string' || !project.path.startsWith('/')) {
    throw new Error('project repositories dialog: project must have a name and an absolute path');
  }
  const { showToast } = useToast();
  const [repositories, setRepositories] = useState(null);
  const [failure, setFailure] = useState(null);
  const [beside, setBeside] = useState({ candidates: [], hasNextPage: false, total: 0, pages: 0, failure: null });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [picking, setPicking] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await listProjectRepositories(project.name);
      if (!alive.current) return;
      setRepositories(next);
      setFailure(null);
    } catch (error) {
      if (alive.current) { setRepositories(null); setFailure(reasonOf(error)); }
    }
    // The repositories beside the project are a help, not a need: a failure there leaves the list usable.
    try {
      const first = await getRepositoryCandidates(project.name, 0);
      if (alive.current) setBeside({ ...first, pages: 1, failure: null });
    } catch (error) {
      if (alive.current) setBeside({ candidates: [], hasNextPage: false, total: 0, pages: 0, failure: reasonOf(error) });
    }
  }, [project.name]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  const others = repositories ? repositories.filter(entry => !entry.own) : [];
  const room = MAX_OTHER_REPOSITORIES - others.length;
  const full = repositories !== null && room <= 0;

  const showMore = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await getRepositoryCandidates(project.name, beside.pages);
      if (alive.current) setBeside(current => ({ ...next, candidates: [...current.candidates, ...next.candidates], pages: current.pages + 1, failure: null }));
    } catch (error) {
      showToast({ type: 'error', message: reasonOf(error) });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  /** Adds folders one after another and stops at the first that is refused. */
  const add = async (folders) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const added = [];
    let refused = null;
    for (const folder of folders) {
      try {
        added.push(await addProjectRepository(project.name, folder.path));
      } catch (error) {
        refused = { folder, message: reasonOf(error) };
        break;
      }
    }
    if (refused) {
      const message = folders.length === 1 ? refused.message
        : `${refused.folder.name} was not added: ${refused.message}. ${plural(added.length, 'repository')} added before it.`;
      showToast({ type: 'error', message });
      if (alive.current) setRefusal(message);
    } else {
      showToast({ type: 'success', message: added.length === 1 ? `${added[0].name} added to ${project.name}` : `${plural(added.length, 'repository')} added to ${project.name}` });
    }
    if (added.length > 0) {
      onChanged();
      await load();
    }
    if (alive.current) setBusy(false);
  };

  const remove = async (entry) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      await removeProjectRepository(project.name, entry.name);
      showToast({ type: 'success', message: `${entry.name} removed from ${project.name}. Its folder was not touched.` });
      onChanged();
      await load();
    } catch (error) {
      showToast({ type: 'error', message: reasonOf(error) });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const pick = (folder, host) => {
    setPicking(false);
    if (host !== undefined && host !== null && host !== 'local') {
      showToast({ type: 'error', message: 'Choose a folder on this computer. Repositories of a project are local.' });
      return;
    }
    add([{ name: folder.replace(/\/+$/, '').split('/').at(-1), path: folder }]);
  };

  const canAddAll = beside.candidates.length > 1 && !beside.hasNextPage && beside.total <= room;
  const isFolderWorkspace = project.workspaceMode === 'folder';

  return (
    <>
      <Dialog title={`Repositories of ${project.name}`} width={560} busy={busy} onClose={onClose}
        subtitle="The repositories that belong to this project. Its tasks and workflow runs can work in any of them. Listing one changes nothing on disk."
        footer={<>
          <Button onClick={() => setPicking(true)} disabled={busy || repositories === null || full}>Add another folder…</Button>
          <Button variant="primary" onClick={onClose} disabled={busy}>Done</Button>
        </>}>
        {repositories === null && failure === null && <span style={styles.muted}>Reading the repositories…</span>}
        {failure && (
          <Note tone="danger">
            <span role="alert">{failure}</span>
            <span><Button size="small" onClick={load}>Try again</Button></span>
          </Note>
        )}
        {repositories !== null && (
          <section style={styles.section}>
            <ul aria-label={`Repositories of ${project.name}`} style={styles.list}>
              {repositories.map(entry => (
                <li key={entry.path} data-repository={entry.name} style={styles.row}>
                  <div style={styles.text}>
                    <span style={styles.line}>
                      <strong>{entry.name}</strong>
                      {entry.own && <Badge>this project</Badge>}
                      {entry.usable && <span style={styles.muted}>{entry.branch === null ? 'no branch checked out' : `on ${entry.branch}`}</span>}
                      {entry.dirty === true && <span style={styles.warning}>uncommitted changes</span>}
                    </span>
                    {!entry.usable && <span style={styles.warning}>{entry.reason.message}</span>}
                    <span style={styles.path} title={entry.path}>{entry.path}</span>
                  </div>
                  {!entry.own && <Button size="small" aria-label={`Remove ${entry.name}`} onClick={() => remove(entry)} disabled={busy}>Remove</Button>}
                </li>
              ))}
            </ul>
            {full && <Note>{`A project can list at most ${MAX_OTHER_REPOSITORIES} other repositories.`}</Note>}
          </section>
        )}
        {refusal && <Note tone="danger" role="alert">{refusal}</Note>}
        {repositories !== null && (
          <section style={styles.section}>
            <h3 style={styles.heading}>
              <span>{isFolderWorkspace ? 'Inside this project folder, not added yet' : 'Beside this project, not added yet'}</span>
              {canAddAll && <Button size="small" onClick={() => add(beside.candidates)} disabled={busy}>{`Add all ${beside.candidates.length}`}</Button>}
            </h3>
            {beside.failure && <span style={styles.warning}>{beside.failure}</span>}
            {!beside.failure && beside.candidates.length === 0 && <span style={styles.muted}>{isFolderWorkspace ? 'No other repository is inside this project folder.' : 'No other repository is beside this project.'}</span>}
            {beside.total > room && beside.total > beside.candidates.length && <span style={styles.muted}>{`${plural(beside.total, 'repository')} are beside this project.`}</span>}
            {beside.candidates.length > 0 && (
              <span style={styles.muted}>A task starts from and merges into the folder you add, on the branch shown. Where a repository's main branch is checked out in another folder, add that folder with Add another folder….</span>
            )}
            {beside.candidates.length > 0 && (
              <ul aria-label={`Repositories beside ${project.name}`} style={styles.list}>
                {beside.candidates.map(entry => (
                  <li key={entry.path} data-repository={entry.name} style={styles.row}>
                    <div style={styles.text}>
                      <span style={styles.line}>
                        <strong>{entry.name}</strong>
                        <span style={styles.muted}>{entry.branch === null ? 'no branch checked out' : `on ${entry.branch}`}</span>
                      </span>
                      <span style={styles.path} title={entry.path}>{entry.path}</span>
                    </div>
                    <Button size="small" aria-label={`Add ${entry.name}`} onClick={() => add([entry])} disabled={busy || full}>Add</Button>
                  </li>
                ))}
              </ul>
            )}
            {beside.hasNextPage && <span><Button size="small" variant="ghost" onClick={showMore} disabled={busy}>Show more</Button></span>}
          </section>
        )}
      </Dialog>
      {picking && <DirectoryBrowser initialPath={isFolderWorkspace ? project.path : parentOf(project.path)} onSelect={pick} onCancel={() => setPicking(false)} />}
    </>
  );
}
