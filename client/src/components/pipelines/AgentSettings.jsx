import React, { useCallback, useEffect, useState } from 'react';
import AgentList from './AgentList';
import { listAgents } from '../../utils/pipelinesApi';
import { parseAgent } from '../../utils/pipelineRecords';
import { useToast } from '../ToastContext';
import { failureMessage } from './definitionForm';
import './pipeline-settings.css';

export default function AgentSettings({ onDirtyChange, active = false }) {
  const { showToast } = useToast();
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try { setAgents((await listAgents()).map(parseAgent)); setError(null); }
    catch (failure) { const message = failureMessage(failure); setError(message); showToast({ type: 'error', message }); }
  }, [showToast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (active) load(); }, [active, load]);
  if (error) return <section className="pipeline-settings"><p role="alert">{error}</p><button type="button" onClick={load}>Retry</button></section>;
  if (agents === null) return <p role="status">Loading agents…</p>;
  return <div className="pipeline-settings"><AgentList agents={agents} onChanged={load} onDirtyChange={onDirtyChange} /></div>;
}
