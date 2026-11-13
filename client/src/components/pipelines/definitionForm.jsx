import React, { useId } from 'react';

export function failureMessage(failure) {
  if (failure instanceof TypeError) return 'Server unreachable';
  return failure?.message || 'Pipelines request failed';
}

/** `[{ field, message }]` from the shared validator or the API, keyed by field path. */
export function errorsByField(errors) {
  const byField = {};
  for (const { field, message } of errors) {
    byField[field] = byField[field] ? `${byField[field]}. ${message}` : message;
  }
  return byField;
}

/**
 * Why a save of an existing item was refused. A 409 is either a stale revision or a taken name;
 * reading the item back tells them apart without depending on the wording of the message.
 */
export async function diagnoseSaveFailure(failure, revision, fetchLatest) {
  if (failure?.status === 404) return { kind: 'gone' };
  if (failure?.status !== 409) return { kind: 'rejected' };
  let latest;
  try {
    latest = await fetchLatest();
  } catch (lookupFailure) {
    // The original refusal is still reported to the owner by the caller.
    return { kind: lookupFailure?.status === 404 ? 'gone' : 'rejected' };
  }
  return latest.revision === revision ? { kind: 'rejected' } : { kind: 'stale', latest };
}

function Field({ caption, error, errorId, children }) {
  return (
    <div className="pipeline-field">
      <span className="pipeline-field-caption" aria-hidden="true">{caption}</span>
      {children}
      {error && <span id={errorId} className="pipeline-field-error">{error}</span>}
    </div>
  );
}

function controlProps(label, error, errorId, onChange) {
  return {
    'aria-label': label,
    'aria-invalid': Boolean(error),
    'aria-describedby': error ? errorId : undefined,
    onChange: event => onChange(event.target.value),
  };
}

export function TextField({ label, caption, value, onChange, error, multiline = false, ...rest }) {
  const errorId = useId();
  const Control = multiline ? 'textarea' : 'input';
  return (
    <Field caption={caption} error={error} errorId={errorId}>
      <Control value={value} spellCheck={false} {...controlProps(label, error, errorId, onChange)} {...rest} />
    </Field>
  );
}

export function SelectField({ label, caption, value, onChange, error, children, ...rest }) {
  const errorId = useId();
  return (
    <Field caption={caption} error={error} errorId={errorId}>
      <select value={value} {...controlProps(label, error, errorId, onChange)} {...rest}>{children}</select>
    </Field>
  );
}

/** Errors for fields that have no control of their own, so none is dropped silently. */
export function OtherErrors({ errors, shownFields }) {
  const others = Object.entries(errors).filter(([field]) => !shownFields.includes(field));
  if (others.length === 0) return null;
  return (
    <ul className="pipeline-other-errors">
      {others.map(([field, message]) => <li key={field} className="pipeline-field-error">{field}: {message}</li>)}
    </ul>
  );
}
