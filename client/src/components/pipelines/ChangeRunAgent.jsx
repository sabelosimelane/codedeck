import React, { useEffect, useState } from 'react';
import { listAgents } from '../../utils/pipelinesApi';
import { parseAgent } from '../../utils/pipelineRecords';
import { Button, Dialog, Field, Note, Select } from '../ui/index.jsx';

const timingText = {
  dispatch: 'This agent will take the step when it starts.',
  pass: 'The current pass keeps its agent. This choice applies at the next pass or round.',
  round: 'This choice applies if the workflow returns to this step in another round.',
};

export default function ChangeRunAgent({ run, step, timing, onSave, onClose }) {
  const [snapshot, setSnapshot] = useState(() => ({ step, timing, updatedAt: run.updatedAt }));
  const [agents, setAgents] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    listAgents({ signal: controller.signal }).then(records => {
      if (!controller.signal.aborted) setAgents(records.map(parseAgent));
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, []);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await onSave(run.id, { expectedUpdatedAt: snapshot.updatedAt, stepOverrides: { [snapshot.step.name]: draft } });
      onClose();
    } catch (failure) {
      setError(failure.errors?.map(item => item.message).join('. ') || failure.message);
      setStale(failure.status === 409);
      setBusy(false);
    }
  }

  function review() {
    setSnapshot({ step, timing, updatedAt: run.updatedAt });
    setDraft('');
    setStale(false);
    setError('');
  }

  const current = snapshot.step;
  const unchanged = draft === (current.nextAgentId ?? current.agentId);
  return (
    <Dialog title={`Change agent for ${current.name}`} subtitle={timingText[snapshot.timing]} onClose={onClose} busy={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button>
        {stale && timing !== null && run.updatedAt !== snapshot.updatedAt && <Button onClick={review}>Review latest assignments</Button>}
        <Button variant="primary" disabled={busy || stale || !draft || unchanged || !agents?.length} onClick={save}>Save</Button></>}>
      <p>Current agent · {current.agentName}</p>
      {current.nextAgentName && <p>{snapshot.timing === 'round' ? 'Next round' : 'Next pass'} · {current.nextAgentName}</p>}
      {error && <Note tone="danger" role="alert">{error}</Note>}
      {!agents && !error && <span role="status">Loading agents…</span>}
      {agents?.length === 0 && <Note>Add a saved agent in Settings → Agents.</Note>}
      {agents?.length > 0 && <Field label="Saved agent">
        <Select label="Saved agent" value={draft} onChange={setDraft} disabled={busy || stale}>
          <option value="">Choose an agent</option>
          {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </Select>
      </Field>}
    </Dialog>
  );
}
