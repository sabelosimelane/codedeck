import React from 'react';

/** Asks once before an action that cannot be taken back: what it does, then the action or Cancel. */
export default function ConfirmSheet({ message, confirmLabel, danger = false, busy = false, onConfirm, onCancel }) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('confirm sheet: message is required');
  if (typeof confirmLabel !== 'string' || !confirmLabel.trim()) throw new Error('confirm sheet: confirmLabel is required');
  if (typeof onConfirm !== 'function') throw new Error('confirm sheet: onConfirm must be a function');
  if (typeof onCancel !== 'function') throw new Error('confirm sheet: onCancel must be a function');
  return (
    <div className="m-sheet-layer">
      <div className="m-backdrop" aria-hidden="true" onClick={onCancel} />
      <div className="m-sheet m-sheet-auto m-confirm" role="dialog" aria-modal="true" aria-label="Confirm">
        <span className="m-grabber" aria-hidden="true" />
        <p className="m-confirm-text">{message}</p>
        <div className="m-confirm-actions">
          <button type="button" className={`m-primary m-press${danger ? ' is-danger' : ''}`} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
          <button type="button" className="m-press m-run-dock-button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
