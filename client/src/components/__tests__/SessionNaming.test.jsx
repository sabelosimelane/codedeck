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
  it('saves the selected effort through the main Settings Save button and restores it on reload', async () => {
    let saved = { ...settings, effort: 'minimal' };
    const fetch = vi.fn((url, options) => {
      if (url.includes('/catalog')) return ok({ data: [{ ...providers[0], effort: ['minimal', 'low', 'high'] }], page: { hasNextPage: false } });
      if (url === '/api/session-naming/settings') {
        if (options?.method === 'PUT') saved = { ...JSON.parse(options.body), hasCredential: true };
        return ok(saved);
      }
      return ok({});
    });
    vi.stubGlobal('fetch', fetch);
    const view = render(<SettingsPanel />);
    await screen.findByRole('option', { name: 'minimal' });
    fireEvent.change(screen.getByLabelText('Naming effort'), { target: { value: 'low' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(saved.effort).toBe('low'));
    view.unmount();
    render(<SettingsPanel />);
    await screen.findByRole('option', { name: 'minimal' });
    expect(screen.getByLabelText('Naming effort').value).toBe('low');
  });
  it('keeps naming changes unsaved and reports failure when the main Save is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      if (url.includes('/catalog')) return ok({ data: providers, page: { hasNextPage: false } });
      if (options?.method === 'PUT') return Promise.resolve({ ok: false, json: async () => ({ detail: 'Selection rejected' }) });
      return ok(url.includes('/session-naming/') ? { ...settings, effort: 'low' } : {});
    }));
    render(<SettingsPanel />);
    await screen.findByRole('option', { name: 'low' });
    fireEvent.change(screen.getByLabelText('Naming effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await screen.findByRole('alert');
    expect(screen.getByText(/Unsaved naming settings/)).toBeTruthy();
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
  it('reverts unsaved naming effort through the main Settings Revert button', async () => {
    vi.stubGlobal('fetch', vi.fn(url => {
      if (url.includes('/catalog')) return ok({ data: providers, page: { hasNextPage: false } });
      return ok(url.includes('/session-naming/') ? { ...settings, effort: 'low' } : {});
    }));
    render(<SettingsPanel />);
    await screen.findByRole('option', { name: 'low' });
    fireEvent.change(screen.getByLabelText('Naming effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(screen.getByLabelText('Naming effort').value).toBe('low');
  });

  it('loads catalog dropdowns, clears dependent choices, and saves exact selection without returning a credential', async () => {
    const fetch = vi.fn((url, options) => {
      if (url.includes('/catalog')) return ok({ data: providers, page: { hasNextPage: false } });
      if (options?.method === 'PUT') return ok({ ...settings, provider: 'beta', model: 'other' });
      return ok(settings);
    }); vi.stubGlobal('fetch', fetch);
    render(<SessionNamingSettings />);
    await screen.findByRole('option', { name: 'small' });
    expect(screen.getByLabelText('Conduit credential').value).toBe('');
    fireEvent.change(screen.getByLabelText('Naming provider'), { target: { value: 'beta' } });
    expect(screen.getByLabelText('Naming model').value).toBe('');
    fireEvent.change(screen.getByLabelText('Naming model'), { target: { value: 'other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save naming settings' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/session-naming/settings', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ baseUrl: settings.baseUrl, provider: 'beta', model: 'other', effort: null }) })));
    expect(screen.queryByText('secret-value')).toBeNull();
  });
  it('tests unsaved connection and refreshes catalog without silently choosing a model', async () => {
    vi.stubGlobal('fetch', vi.fn(url => {
      if (url.includes('/connection-test')) return ok({ connectionId: 'preview' });
      if (url.includes('/catalog')) return ok({ data: providers, page: { hasNextPage: false } });
      return ok({ baseUrl: '', provider: '', model: '', effort: null, hasCredential: false });
    }));
    render(<SessionNamingSettings />);
    const input = await screen.findByLabelText('Conduit endpoint');
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'http://conduit.test' } });
    fireEvent.change(screen.getByLabelText('Conduit credential'), { target: { value: 'secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection / refresh catalog' }));
    await screen.findByRole('option', { name: 'alpha' });
    expect(screen.getByLabelText('Naming provider').value).toBe('');
    expect(screen.getByLabelText('Naming model').value).toBe('');
  });
  it('shows a connection failure without hiding the form', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Connection failed'))));
    render(<SessionNamingSettings />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Connection failed');
    expect(screen.getByLabelText('Conduit endpoint')).toBeTruthy();
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
