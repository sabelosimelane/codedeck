import React, { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import './ui.css';

/** A button with one of the app's looks. `variant`: secondary (default), primary, danger, ghost or link. */
export function Button({ variant = 'secondary', size = 'medium', type = 'button', className, children, ...rest }) {
  return <button type={type} className={className ? `ui-button ${className}` : 'ui-button'} data-variant={variant} data-size={size} {...rest}>{children}</button>;
}

/**
 * A modal dialog: closes on Escape and on a click outside, unless `busy`. `footer` holds its
 * actions; `width` is its widest size in pixels.
 */
export function Dialog({ title, subtitle, onClose, closeLabel = 'Close', footer, width = 480, busy = false, children }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  return (
    <div className="ui-overlay" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="ui-dialog" role="dialog" aria-modal="true" aria-label={title} style={{ '--ui-dialog-width': `${width}px` }}>
        <div className="ui-dialog-header">
          <div>
            <h2 className="ui-dialog-title">{title}</h2>
            {subtitle && <p className="ui-dialog-subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="ui-icon-button" aria-label={closeLabel} disabled={busy} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ui-dialog-body">{children}</div>
        {footer && <div className="ui-dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** A labelled form control with an optional action beside the label, a hint and an error. */
export function Field({ label, hint, error, action, children }) {
  return (
    <div className="ui-field">
      <div className="ui-field-heading">
        <span className="ui-field-label" aria-hidden="true">{label}</span>
        {action}
      </div>
      {children}
      {hint && <span className="ui-field-hint">{hint}</span>}
      {error && <span className="ui-field-error" role="alert">{error}</span>}
    </div>
  );
}

/** A one-line text input. `label` names it for assistive technology; `onChange` receives the text. */
export function TextInput({ label, value, onChange, invalid = false, ...rest }) {
  return <input className="ui-input" aria-label={label} aria-invalid={invalid || undefined} value={value} spellCheck={false} onChange={event => onChange(event.target.value)} {...rest} />;
}

export function TextArea({ label, value, onChange, invalid = false, rows = 3, ...rest }) {
  return <textarea className="ui-input" aria-label={label} aria-invalid={invalid || undefined} value={value} rows={rows} onChange={event => onChange(event.target.value)} {...rest} />;
}

export function Select({ label, value, onChange, children, ...rest }) {
  return <select className="ui-input" aria-label={label} value={value} onChange={event => onChange(event.target.value)} {...rest}>{children}</select>;
}

/** A small set of exclusive choices shown side by side. `options`: `{ value, label, disabled?, title? }`. */
export function SegmentedControl({ label, value, onChange, options }) {
  if (!Array.isArray(options) || options.length < 2) throw new Error('segmented control: at least two options are required');
  return (
    <div className="ui-segmented" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button key={option.value} type="button" role="radio" className="ui-segment" aria-checked={option.value === value}
          disabled={option.disabled} title={option.title} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

/** A short aside inside a form: what a choice means, or a warning about it. */
export function Note({ tone = 'plain', children, ...rest }) {
  return <div className="ui-note" data-tone={tone} {...rest}>{children}</div>;
}

export function Badge({ children }) {
  return <span className="ui-badge">{children}</span>;
}

/** Asks the owner to confirm one action. `onConfirm` may be async; the dialog stays up, busy, until it settles. */
export function ConfirmDialog({ title, children, confirmLabel, tone = 'primary', onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={onCancel} busy={busy} width={440}
      footer={<><Button onClick={onCancel} disabled={busy}>Cancel</Button><Button variant={tone} onClick={confirm} disabled={busy} autoFocus>{confirmLabel}</Button></>}>
      <div className="ui-field-hint" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{children}</div>
    </Dialog>
  );
}

/** Asks for one line of text. Submitting a blank or unchanged-when-`requireChange` value is not offered. */
export function PromptDialog({ title, subtitle, label, initialValue = '', maxLength, placeholder, confirmLabel, requireChange = false, onSubmit, onCancel }) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const ready = value.trim().length > 0 && !(requireChange && value.trim() === initialValue.trim()) && !busy;
  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try { await onSubmit(value.trim()); } finally { setBusy(false); }
  };
  return (
    <Dialog title={title} subtitle={subtitle} onClose={onCancel} busy={busy} width={440}
      footer={<><Button onClick={onCancel} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" form={id} disabled={!ready}>{confirmLabel}</Button></>}>
      <form id={id} onSubmit={submit}>
        <Field label={label}>
          <TextInput label={label} value={value} onChange={setValue} maxLength={maxLength} placeholder={placeholder} autoFocus />
        </Field>
      </form>
    </Dialog>
  );
}
