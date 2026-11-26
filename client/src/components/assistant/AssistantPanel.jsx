import React, { useEffect, useState } from 'react';
import { fetchSituation } from '../../utils/assistantApi.js';
import AssistantChat from './AssistantChat.jsx';
import './AssistantPanel.css';

function FlagMessage({ flag }) {
  const match = /“[^”]+”|docs\/todos\/[^\s,;)]+\.md/.exec(flag.message);
  if (!match) return <>{flag.message}</>;
  const start = match.index;
  return <>{flag.message.slice(0, start)}<strong>{match[0]}</strong>{flag.message.slice(start + match[0].length)}</>;
}

export default function AssistantPanel({ projectName, onClose }) {
  const [refresh, setRefresh] = useState(0);
  const [situation, setSituation] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    setSituation(null); setError(null);
    fetchSituation(projectName, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setSituation(value); }).catch(failure => {
      if (failure?.name !== 'AbortError') { setSituation(null); setError(failure.message); }
    });
    return () => controller.abort();
  }, [projectName, refresh]);
  useEffect(() => {
    const interval = setInterval(() => setRefresh(value => value + 1), 30_000);
    return () => clearInterval(interval);
  }, []);
  const unusable = situation?.repositories?.filter(repo => repo.usable === false) ?? [];
  return <aside className="assistant-panel" aria-label="Project assistant">
    <div className="assistant-panel-heading">
      <h2>Where things stand</h2>
      <div className="assistant-panel-actions">
        <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh</button>
        <button type="button" aria-label="Close assistant" onClick={onClose}>×</button>
      </div>
    </div>
    {error && <p role="alert" className="assistant-panel-error">{error}</p>}
    {!error && unusable.length > 0 && <ul className="assistant-panel-flags">{unusable.map(repo => <li key={repo.path}><strong>{repo.name}</strong>: {repo.reason.message}</li>)}</ul>}
    {!error && situation?.flags.length === 0 && unusable.length === 0 && <p>Nothing needs your attention</p>}
    {!error && situation?.flags.length > 0 && <ul className="assistant-panel-flags">{situation.flags.map((flag, index) => <li key={`${flag.code}-${index}`}><FlagMessage flag={flag} /></li>)}</ul>}
    <AssistantChat
      projectName={projectName}
      onDecision={() => setRefresh(value => value + 1)}
      onSituationFlags={flags => setSituation(previous => (previous ? { ...previous, flags } : previous))}
    />
  </aside>;
}
