import React, { forwardRef, useEffect, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { showToast } = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../DirectoryBrowser', () => ({ default: () => null }));
vi.mock('../HostsSection', () => ({
  default: () => <div data-testid="hosts-panel" />,
}));
vi.mock('../pipelines/PipelineSettings', () => ({
  default: () => <div data-testid="workflows-panel" />,
}));
vi.mock('../pipelines/AgentSettings', () => ({
  default: () => <div data-testid="agents-panel" />,
}));
vi.mock('../SessionNamingSettings', () => ({
  default: forwardRef(function NamingStub({ onStateChange }, ref) {
    useImperativeHandle(ref, () => ({ save: async () => true, revert: vi.fn() }));
    useEffect(() => { onStateChange({ dirty: false, busy: false, valid: true }); }, [onStateChange]);
    return <div data-testid="naming-panel" />;
  }),
}));

import SettingsPanel from '../SettingsPanel';
import { getResolvedTheme, getThemeMode, setThemeMode } from '../../theme';

async function renderPanel(props = {}) {
  const onClose = vi.fn();
  render(<SettingsPanel onClose={onClose} {...props} />);
  await waitFor(() => expect(screen.getByPlaceholderText('code -r').value).toBe('cursor -r'));
  return { onClose };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url, options) => ({
    ok: true,
    json: async () => (url === '/api/config' && !options ? { defaultPath: '/home/me', editorCommand: 'cursor -r' } : {}),
  })));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  act(() => { setThemeMode('system'); });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  showToast.mockClear();
  act(() => { setThemeMode('system'); });
  localStorage.clear();
});

describe('SettingsPanel appearance', () => {
  it('loads and saves Project Assistant model and effort through the General footer', async () => {
    const fetch = vi.fn(async (url, options) => ({ ok: true, json: async () => url === '/api/config' && !options ? { defaultPath: '/home/me', editorCommand: 'cursor -r' } : url === '/api/assistant/settings' ? { model: 'default', effort: null } : {} }));
    vi.stubGlobal('fetch', fetch);
    await renderPanel();
    expect(screen.getByLabelText('Assistant model').closest('[role="tabpanel"]').getAttribute('aria-labelledby')).toBe('settings-tab-general');
    fireEvent.change(screen.getByLabelText('Assistant model'), { target: { value: 'opus' } });
    fireEvent.change(screen.getByLabelText('Assistant effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/assistant/settings', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ model: 'opus', effort: 'high' }) })));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });
  it('shows the assistant settings error and keeps the draft when save fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, options) => ({
      ok: !(url === '/api/assistant/settings' && options?.method === 'PUT'),
      json: async () => url === '/api/config' && !options ? { defaultPath: '/home/me', editorCommand: 'cursor -r' } : url === '/api/assistant/settings' && options?.method === 'PUT' ? { message: 'Could not apply settings.' } : url === '/api/assistant/settings' ? { model: 'default', effort: null } : {},
    })));
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Assistant model'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Could not apply settings.' }));
    expect(screen.getByLabelText('Assistant model').value).toBe('opus');
  });
  it('offers System, Dark, and Light with the current mode pressed', async () => {
    await renderPanel();
    const group = screen.getByRole('group', { name: 'Appearance' });
    expect(group).toBeTruthy();
    expect(getThemeMode()).toBe('system');
    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('applies and persists the picked mode immediately without dirtying settings', async () => {
    const { onClose } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));

    expect(getThemeMode()).toBe('light');
    expect(getResolvedTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('codedeck-theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true');

    expect(screen.queryByText('unsaved changes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reflects a mode changed elsewhere while settings are open', async () => {
    await renderPanel();
    act(() => { setThemeMode('dark'); });

    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('false');
  });
});
