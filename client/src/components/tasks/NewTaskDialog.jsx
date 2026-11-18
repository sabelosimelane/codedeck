import React, { useId, useState } from 'react';
import { Button, Dialog, Field, Note, TextInput } from '../ui/index.jsx';

const TITLE_MAX = 80;

/** A task needs only a title; CodeDeck prepares its own copy of the project to work in. */
export default function NewTaskDialog({ projectName, onCreate, onClose }) {
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const formId = useId();
  const ready = title.trim().length > 0 && !pending;

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      await onCreate({ project: projectName, title: title.trim() });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Something went wrong. Please try again.');
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
          <TextInput label="Task title" value={title} onChange={setTitle} maxLength={TITLE_MAX} placeholder="For example: WhatsApp replies" autoFocus />
        </Field>
        {error && <Note tone="danger" role="alert">{error}</Note>}
      </form>
    </Dialog>
  );
}
