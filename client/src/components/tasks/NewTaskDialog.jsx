import React, { useEffect, useId, useState } from 'react';
import { Button, Dialog, Field, Note } from '../ui/index.jsx';
import { listProjectRepositories } from '../../utils/projectRepositoriesApi.js';
import { TaskRepositories, TaskTitleInput } from './NewTaskFields.jsx';

const FALLBACK = 'Something went wrong. Please try again.';

/**
 * A task needs a title; CodeDeck prepares its own copy of the project to work in. In a project
 * with several repositories (`withRepositories`) the owner also ticks the ones the task
 * includes; the rest stay readable and can be added to the task later.
 */
export default function NewTaskDialog({ projectName, withRepositories = false, onCreate, onClose }) {
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  // null while they are being read; the backend says which exist and where each stands.
  const [repositories, setRepositories] = useState(null);
  const [ticked, setTicked] = useState(new Set());
  const formId = useId();

  useEffect(() => {
    if (!withRepositories) return undefined;
    let alive = true;
    const load = async () => {
      try {
        const list = await listProjectRepositories(projectName);
        if (!alive) return;
        setRepositories(list);
        // A task starts in the project's own repository unless the owner says otherwise.
        setTicked(new Set(list.filter(entry => entry.own && entry.usable).map(entry => entry.name)));
      } catch (failure) {
        if (alive) setError(failure instanceof Error ? failure.message : FALLBACK);
      }
    };
    load();
    return () => { alive = false; };
  }, [projectName, withRepositories]);

  // The repository the task starts in comes first: the project's own when it is ticked.
  const chosen = repositories === null ? [] : [...repositories.filter(entry => entry.own), ...repositories.filter(entry => !entry.own)]
    .filter(entry => ticked.has(entry.name)).map(entry => entry.name);
  const ready = title.trim().length > 0 && !pending && (!withRepositories || chosen.length > 0);

  const toggle = (name) => setTicked((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      await onCreate({ project: projectName, title: title.trim(), ...(withRepositories ? { repositories: chosen } : {}) });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : FALLBACK);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog title="New task" subtitle="A piece of work with its own copy of the project, so several can be in progress at once."
      onClose={onClose} busy={pending}
      footer={<>
        <Button onClick={onClose} disabled={pending}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} disabled={!ready}>{pending ? 'Creating…' : 'Create task'}</Button>
      </>}>
      <form id={formId} onSubmit={submit} style={{ display: 'contents' }}>
        <Field label="What are you working on?" hint="The copy starts from the project's current commit. Uncommitted changes and files Git ignores are not carried over.">
          <TaskTitleInput value={title} onChange={setTitle} autoFocus />
        </Field>
        {withRepositories && repositories === null && error === null && <Note>Reading the project&apos;s repositories…</Note>}
        {withRepositories && repositories !== null && <TaskRepositories repositories={repositories} ticked={ticked} onToggle={toggle} disabled={pending} />}
        {error && <Note tone="danger" role="alert">{error}</Note>}
      </form>
    </Dialog>
  );
}
