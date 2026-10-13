import React, { useId, useState } from 'react';
import './terminal-workflow.css';

const LABELS = { stopped: 'Stopped', running: 'Running', resetting: 'Resetting', complete: 'Complete', needs_input: 'Needs input', error: 'Error' };

export default function TerminalWorkflow({ state, pending, connected, onStart, onStop }) {
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState('');
  const [resetCommand, setResetCommand] = useState('/clear');
  const id = useId();
  const locked = state.active || pending;
  return (
    <div className="terminal-workflow" onMouseDown={event => event.stopPropagation()}>
      <div className="terminal-workflow-bar">
        <button className="terminal-action-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>Workflow</button>
        <span role="status">{pending ? 'Waiting for acknowledgement…' : LABELS[state.status]}</span>
        {state.active && <button className="terminal-action-btn" disabled={pending || !connected} onClick={onStop}>Stop</button>}
      </div>
      {state.error && <div role="alert" className="terminal-workflow-error">{state.error}</div>}
      {open && (
        <form id={id} className="terminal-workflow-form" onSubmit={event => { event.preventDefault(); if (!locked && connected && command.trim() && resetCommand.trim()) onStart(command, resetCommand); }}>
          <label htmlFor={`${id}-command`}>Command</label>
          <textarea id={`${id}-command`} rows={3} maxLength={16384} value={command} disabled={locked} onChange={event => setCommand(event.target.value)} placeholder="/feature-dev docs/todos/my-feature.md" />
          <div className="terminal-workflow-reset">
            <label htmlFor={`${id}-reset`}>Reset command</label>
            <input id={`${id}-reset`} maxLength={256} value={resetCommand} disabled={locked} onChange={event => setResetCommand(event.target.value)} />
            <button className="terminal-action-btn" type="submit" disabled={locked || !connected || !command.trim() || !resetCommand.trim()}>Start</button>
          </div>
          <small>Start your agent at an empty prompt first. Stop releases typing; it does not interrupt the agent. Workflows continue when you switch projects or disconnect. Closing the terminal or restarting CodeDeck stops the workflow.</small>
        </form>
      )}
    </div>
  );
}
