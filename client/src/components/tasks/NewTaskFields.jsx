import React from 'react';
import { TextInput } from '../ui/index.jsx';

/**
 * What a new task is asked for, wherever one is started: its title and, in a project with
 * several repositories, the ones it includes. New task and Run workflow both use these, so the
 * same choice reads the same in both.
 */
export const TASK_TITLE_MAX = 80;

/** The title of a new task. `optional`: it may be left empty, and the task is then named from its run's work. */
export function TaskTitleInput({ value, onChange, optional = false, ...rest }) {
  return <TextInput label="Task title" value={value} onChange={onChange} maxLength={TASK_TITLE_MAX}
    placeholder={optional ? 'Named from the work once the run starts, or type a title' : 'For example: WhatsApp replies'} {...rest} />;
}

/**
 * The repositories of the project, each with where its copy would start from, to tick the ones
 * the task includes. `startsIn` names the repository a run starts in: it is always included, so
 * its row is ticked and cannot be changed here.
 */
export function TaskRepositories({ repositories, ticked, onToggle, startsIn = null, disabled = false }) {
  if (!Array.isArray(repositories)) throw new Error('repositories must be an array');
  if (!(ticked instanceof Set)) throw new Error('ticked must be a Set');
  if (typeof onToggle !== 'function') throw new Error('onToggle must be a function');
  if (startsIn !== null && !repositories.some(entry => entry.name === startsIn)) throw new Error(`startsIn must be one of the repositories: ${startsIn}`);
  const included = entry => entry.usable && (entry.name === startsIn || ticked.has(entry.name));
  return (
    <fieldset aria-label="Repositories" style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, border: 'none' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Repositories</span>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>The task gets its own copy of each one ticked. The others stay readable and can be added to the task later.</span>
      {repositories.map(entry => (
        <label key={entry.name} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, color: entry.usable ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          <input type="checkbox" aria-label={entry.name} checked={included(entry)} disabled={!entry.usable || disabled || entry.name === startsIn} onChange={() => onToggle(entry.name)} />
          <span>{entry.name}</span>
          {entry.usable && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{entry.branch === null ? 'from its current commit' : `from ${entry.branch}`}</span>}
          {entry.usable && entry.name === startsIn && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>the run starts here</span>}
          {!entry.usable && <span style={{ fontSize: 12, color: 'var(--warning)' }}>{entry.reason.message}</span>}
        </label>
      ))}
      {!repositories.some(included) && <span style={{ fontSize: 12, color: 'var(--warning)' }}>Tick at least one repository.</span>}
    </fieldset>
  );
}
