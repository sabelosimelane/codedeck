import React, { useCallback, useEffect, useState } from 'react';
import { Button, IconButton } from '../../ui/index.jsx';
import { X } from 'lucide-react';
import { loadDefinitions } from '../../../utils/pipelineRecords';
import { useToast } from '../../ToastContext';
import Improvements from './Improvements';
import WorkflowList from '../WorkflowList';
import { failureMessage } from '../definitionForm';
import '../pipeline-settings.css';
import './workflows-screen.css';

/**
 * The workflow builder: every workflow on the left, the one being built on the right with
 * its steps, the open step and what that step's agent is sent. Nothing here is
 * authoritative; every list is read from the backend and every save goes to it.
 */
export default function WorkflowsScreen({ onClose, projects = [] }) {
  const { showToast } = useToast();
  const [definitions, setDefinitions] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [view, setView] = useState('builder');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      setDefinitions(await loadDefinitions());
      setLoadError(null);
    } catch (failure) {
      const message = failureMessage(failure);
      setLoadError(message);
      showToast({ type: 'error', message });
    }
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  const close = useCallback(() => {
    if (dirty && !window.confirm('Close the builder and discard the unsaved changes to this workflow?')) return;
    onClose();
  }, [dirty, onClose]);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div className="workflows-screen" role="dialog" aria-modal="true" aria-label="Workflow builder">
      <header className="workflows-screen-header">
        <nav aria-label="Workflow views" className="workflow-views">
          <button aria-pressed={view === 'builder'} onClick={() => setView('builder')}>Workflow builder</button>
          <button aria-pressed={view === 'improvements'} onClick={() => setView('improvements')}>Improvements</button>
        </nav>
        <span className="pipeline-hint">Agents and the setup agent are in Settings → Workflows.</span>
        <IconButton aria-label="Close the workflow builder" onClick={close}><X size={16} /></IconButton>
      </header>
      {view === 'improvements' && (
        <Improvements workflows={definitions?.workflows ?? []} projects={projects} onChanged={load} />
      )}
      <div hidden={view !== 'builder'} style={view === 'builder' ? undefined : { display: 'none' }}
        className="workflows-screen-body pipeline-settings">
        {loadError && (
          <div className="pipeline-load-error">
            <span role="alert">{loadError}</span>
            <Button onClick={load}>Retry</Button>
          </div>
        )}
        {definitions === null && !loadError && <p className="pipeline-empty" role="status">Loading…</p>}
        {definitions !== null && (
          <WorkflowList variant="builder" workflows={definitions.workflows} agents={definitions.agents} templates={definitions.templates}
            stepPresets={definitions.stepPresets} onChanged={load} onDirtyChange={setDirty} />
        )}
      </div>
    </div>
  );
}
