import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SessionNamingSettings from '../SessionNamingSettings';
import SettingsPanel from '../SettingsPanel';
import SessionTitleActions from '../SessionTitleActions';
import { getTerminalTabLabel } from '../../utils/terminalTabLabel';
import { useSessionTitles } from '../../hooks/useSessionTitles';
vi.mock('../HostsSection', () => ({ default: () => null }));
vi.mock('../pipelines/PipelineSettings', () => ({ default: () => null }));
vi.mock('../pipelines/AgentSettings', () => ({ default: () => null }));
const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast }) }));
const ok = body => Promise.resolve({ ok: true, json: async () => body });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const records = [
  { id: A, name: 'Claude', launchCommand: 'command claude --model fable', resetCommand: '/clear', revision: 1, createdAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z' },
  { id: B, name: 'Codex', launchCommand: 'command codex --model gpt-6-luna', resetCommand: '/clear', revision: 1, createdAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z' },
];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function stubSettings(initial = { agentId: A, effort: 'low' }, failSave = false) {
  let saved = initial;
  const fetch = vi.fn((url, options) => {
    if (url.startsWith('/api/pipelines/agents?')) return ok({ data: records, page: { hasNextPage: false } });
    if (url === '/api/session-naming/settings') {
      if (options?.method === 'PUT') {
        if (failSave) return Promise.resolve({ ok: false, json: async () => ({ message: 'Selection rejected' }) });
        saved = JSON.parse(options.body);
      }
      return ok(saved);
    }
    return ok({});
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, saved: () => saved };
}

describe('session naming settings', () => {
  it('saves agent and effort through the main Settings Save button', async () => {
    const backend = stubSettings();
    render(<SettingsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Session naming' }));
    await waitFor(() => expect(screen.getByLabelText('Naming agent').value).toBe(A));
    fireEvent.change(screen.getByLabelText('Naming agent'), { target: { value: B } });
    fireEvent.change(screen.getByLabelText('Naming effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(backend.saved()).toEqual({ agentId: B, effort: 'high' }));
  });
  it('reverts changes and displays save failures', async () => {
    stubSettings(undefined, true);
    render(<SettingsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Session naming' }));
    await waitFor(() => expect(screen.getByLabelText('Naming agent').value).toBe(A));
    fireEvent.change(screen.getByLabelText('Naming agent'), { target: { value: B } });
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(screen.getByLabelText('Naming agent').value).toBe(A);
    fireEvent.change(screen.getByLabelText('Naming agent'), { target: { value: B } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Selection rejected');
    expect(screen.getByText(/Unsaved naming settings/)).toBeTruthy();
  });
  it('requires an agent selection when no settings exist', async () => {
    stubSettings({ agentId: '', effort: null });
    render(<SessionNamingSettings />);
    await waitFor(() => expect(screen.getByLabelText('Naming agent').value).toBe(''));
    expect(screen.getByText('Choose an agent for session naming')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save naming settings' }).disabled).toBe(true);
  });
});

describe('session title display and actions', () => {
  it('uses the first pane title without changing identity and falls back before naming', () => {
    const panes = [{ sessionId: 'Demo-1' }, { sessionId: 'Demo-2' }];
    expect(getTerminalTabLabel(panes, 'Terminal', { 'Demo-1': { title: 'Fix login' }, 'Demo-2': { title: 'Other task' } })).toBe('Fix login');
    expect(getTerminalTabLabel(panes)).toBe('Demo-1');
    expect(panes[0].sessionId).toBe('Demo-1');
  });
  it('shows automatic retry status and the specific failure without requiring a click', () => {
    render(<SessionTitleActions sessionId="Demo-1" metadata={{ state: 'queued', error: 'Configured provider is degraded' }} />);
    expect(screen.getByRole('status').textContent).toContain('Retrying automatically');
    expect(screen.getByText('Configured provider is degraded')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry naming Demo-1' })).toBeNull();
  });
  it('persists a manual title before refreshing and exposes explicit retry', async () => {
    const fetch = vi.fn(() => ok({ title: 'My title', state: 'manual' })); vi.stubGlobal('fetch', fetch);
    const onChanged = vi.fn();
    render(<SessionTitleActions sessionId="Demo-1" metadata={{ state: 'failed', error: 'Try again' }} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename session Demo-1' }));
    fireEvent.change(screen.getByLabelText('Session title'), { target: { value: 'My title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith('/api/session-naming/titles/Demo-1', expect.objectContaining({ method: 'PUT', body: '{"title":"My title"}' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry naming Demo-1' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/session-naming/titles/Demo-1/retry', expect.objectContaining({ method: 'POST' })));
  });
  it('polls all metadata pages independently and reloads persisted titles on remount', async () => {
    const fetch = vi.fn(url => ok({ data: [{ sessionId: url.includes('page=1') ? 'Demo-2' : 'Demo-1', title: 'Persisted title', state: 'named' }], page: { hasNextPage: !url.includes('page=1') } }));
    vi.stubGlobal('fetch', fetch);
    function Probe() { const { titles } = useSessionTitles(); return <span>{titles['Demo-2']?.title}</span>; }
    const view = render(<Probe />); await screen.findByText('Persisted title'); view.unmount();
    render(<Probe />); await screen.findByText('Persisted title');
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
