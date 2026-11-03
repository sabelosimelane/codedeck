import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SessionNamingSettings from '../SessionNamingSettings';
import SettingsPanel from '../SettingsPanel';
vi.mock('../HostsSection', () => ({ default: () => null }));
import SessionTitleActions from '../SessionTitleActions';
import { getTerminalTabLabel } from '../../utils/terminalTabLabel';
import { useSessionTitles } from '../../hooks/useSessionTitles';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast }) }));
const ok = body => Promise.resolve({ ok: true, json: async () => body });
const settings = { baseUrl: 'http://conduit.test', hasCredential: true, provider: 'alpha', model: 'small', effort: null };
const providers = [
  { id: 'alpha', available: true, enabled: true, models: ['small', 'large'], effort: ['low', 'high'] },
  { id: 'beta', available: true, enabled: true, models: ['other'], effort: [] },
  { id: 'offline', available: false, enabled: true, models: ['missing'], effort: [] },
];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('session naming settings', () => {
  it('saves a CLI provider and model through the main Settings Save button', async () => {
    let saved = { provider: 'claude', model: 'sonnet', effort: 'low' };
    const fetch = vi.fn((url, options) => {
      if (url === '/api/session-naming/settings') {
        if (options?.method === 'PUT') saved = JSON.parse(options.body);
        return ok(saved);
      }
      return ok({});
    }); vi.stubGlobal('fetch', fetch);
    render(<SettingsPanel />);
    await waitFor(() => expect(screen.getByLabelText('Naming model').value).toBe('sonnet'));
    expect(screen.queryByLabelText('Conduit endpoint')).toBeNull();
    fireEvent.change(screen.getByLabelText('Naming provider'), { target: { value: 'codex' } });
    expect(screen.getByLabelText('Naming model').value).toBe('');
    fireEvent.change(screen.getByLabelText('Naming model'), { target: { value: 'chosen-model' } });
    fireEvent.change(screen.getByLabelText('Naming effort'), { target: { value: 'low' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(saved).toEqual({ provider: 'codex', model: 'chosen-model', effort: 'low' }));
    expect(fetch.mock.calls.some(([url]) => /catalog|connection-test/.test(url))).toBe(false);
  });
  it('reverts changes and displays save failures', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, options) => options?.method === 'PUT' ? Promise.resolve({ ok: false, json: async () => ({ message: 'Selection rejected' }) }) : ok({ provider: 'claude', model: 'sonnet', effort: 'low' })));
    render(<SettingsPanel />);
    await waitFor(() => expect(screen.getByLabelText('Naming model').value).toBe('sonnet'));
    fireEvent.change(screen.getByLabelText('Naming model'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(screen.getByLabelText('Naming model').value).toBe('sonnet');
    fireEvent.change(screen.getByLabelText('Naming model'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Selection rejected');
    expect(screen.getByText(/Unsaved naming settings/)).toBeTruthy();
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
