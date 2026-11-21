import React from 'react';
import { Select } from '../ui/index.jsx';

/** The same Git worktree choice in New task and Run workflow. */
export default function WorktreeCandidatePicker({ candidates, value, onChange, disabled = false }) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');
  return <Select label="Existing worktree" value={value} onChange={onChange} disabled={disabled}>
    {candidates.map(entry => <option key={entry.path} value={entry.path} disabled={!entry.selectable}>
      {`${entry.name} · ${entry.repository} · ${entry.branch ?? 'detached'} · ${entry.uncommittedCount === null ? 'unreadable' : `${entry.uncommittedCount} uncommitted`}${entry.reason ? ` — ${entry.reason.message}` : ''}`}
    </option>)}
  </Select>;
}
