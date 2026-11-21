import React, { useEffect, useId, useState } from 'react';
import { Button, Dialog, Field, Note, SegmentedControl } from '../ui/index.jsx';
import { listProjectRepositories } from '../../utils/projectRepositoriesApi.js';
import { listWorktreeCandidates, makeTaskFromWorktree } from '../../utils/tasksApi.js';
import { useToast } from '../ToastContext';
import { TaskRepositories, TaskTitleInput } from './NewTaskFields.jsx';
import WorktreeCandidatePicker from './WorktreeCandidatePicker.jsx';

const FALLBACK = 'Something went wrong. Please try again.';

/**
 * A task needs a title; CodeDeck prepares its own copy of the project to work in. In a project
 * with several repositories (`withRepositories`) the owner also ticks the ones the task
 * includes; the rest stay readable and can be added to the task later.
 */
export default function NewTaskDialog({ projectName, host, withRepositories = false, onCreate, onClose }) {
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('new');
  const [candidates, setCandidates] = useState(null);
  const [candidatePath, setCandidatePath] = useState(null);
  const [madeTask, setMadeTask] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  // null while they are being read; the backend says which exist and where each stands.
  const [repositories, setRepositories] = useState(null);
  const [ticked, setTicked] = useState(new Set());
  const formId = useId();

  useEffect(() => {
    let alive = true;
    listWorktreeCandidates(projectName).then(list => {
      if (alive) setCandidates(list);
    }).catch(failure => {
      if (alive) setError(failure instanceof Error ? failure.message : FALLBACK);
    });
    return () => { alive = false; };
  }, [projectName]);

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
  const candidate = candidates?.find(entry => entry.path === candidatePath && entry.selectable)
    ?? candidates?.find(entry => entry.selectable) ?? null;
  const ready = !pending && (source === 'existing' ? madeTask !== null || candidate !== null
    : title.trim().length > 0 && (!withRepositories || (repositories !== null && chosen.length > 0)));

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
      if (source === 'existing') {
        const task = madeTask ?? await makeTaskFromWorktree({ project: projectName, worktreePath: candidate.path,
          ...(title.trim() ? { title: title.trim() } : {}) });
        if (madeTask === null) {
          setMadeTask(task);
          showToast({ type: 'success', message: `Task “${task.title}” made from ${candidate.name}` });
        }
        await onCreate({ adoptedTask: task });
      } else {
        await onCreate({ project: projectName, ...(host && host !== 'local' ? { host } : {}), title: title.trim(), ...(withRepositories ? { repositories: chosen } : {}) });
      }
      onClose();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : FALLBACK;
      setError(message);
      showToast({ type: 'error', message });
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog title="New task" subtitle="A piece of work with its own copy of the project, so several can be in progress at once."
      onClose={onClose} busy={pending}
      footer={<>
        <Button onClick={onClose} disabled={pending}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} disabled={!ready}>{pending ? 'Creating…' : madeTask ? 'Open task' : source === 'existing' ? 'Make task' : 'Create task'}</Button>
      </>}>
      <form id={formId} onSubmit={submit} style={{ display: 'contents' }}>
        {candidates?.length > 0 && <SegmentedControl label="Task source" value={source} onChange={setSource} options={[
          { value: 'new', label: 'A new task', disabled: madeTask !== null },
          { value: 'existing', label: 'Use an existing worktree', disabled: madeTask !== null },
        ]} />}
        {source === 'existing' && <WorktreeCandidatePicker candidates={candidates ?? []} value={candidate?.path ?? ''} onChange={setCandidatePath} disabled={madeTask !== null} />}
        <Field label="What are you working on?" hint={source === 'existing'
          ? 'The worktree and its uncommitted files stay where they are.'
          : "The copy starts from the project's current commit. Uncommitted changes and files Git ignores are not carried over."}>
          <TaskTitleInput value={title} onChange={setTitle} autoFocus optional={source === 'existing'} disabled={madeTask !== null}
            {...(source === 'existing' && candidate?.branch ? { placeholder: candidate.branch.split('/').at(-1).replace(/[-_]/g, ' ').slice(0, 80) } : {})} />
        </Field>
        {source === 'new' && withRepositories && repositories === null && error === null && <Note>Reading the project&apos;s repositories…</Note>}
        {source === 'new' && withRepositories && repositories !== null && <TaskRepositories repositories={repositories} ticked={ticked} onToggle={toggle} disabled={pending} />}
        {error && <Note tone="danger" role="alert">{error}</Note>}
      </form>
    </Dialog>
  );
}
