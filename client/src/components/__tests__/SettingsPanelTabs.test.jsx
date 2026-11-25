import React, { forwardRef, useEffect, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { showToast, namingSave, namingRevert } = vi.hoisted(() => ({
  showToast: vi.fn(),
  namingSave: vi.fn(async () => true),
  namingRevert: vi.fn(),
}));

vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../DirectoryBrowser', () => ({ default: () => null }));
vi.mock('../HostsSection', () => ({
  default: ({ onDirtyChange }) => (
    <div data-testid="hosts-panel">
      <button type="button" onClick={() => onDirtyChange(true)}>dirty hosts</button>
    </div>
  ),
}));
vi.mock('../pipelines/PipelineSettings', () => ({
  default: ({ onDirtyChange }) => (
    <div data-testid="workflows-panel">
      <button type="button" onClick={() => onDirtyChange(true)}>dirty workflows</button>
    </div>
  ),
}));
vi.mock('../pipelines/AgentSettings', () => ({
  default: ({ onDirtyChange }) => <div data-testid="agents-panel"><button type="button" onClick={() => onDirtyChange(true)}>dirty agents</button></div>,
}));
vi.mock('../SessionNamingSettings', () => ({
  default: forwardRef(function NamingStub({ onStateChange }, ref) {
    useImperativeHandle(ref, () => ({ save: namingSave, revert: namingRevert }));
    useEffect(() => { onStateChange({ dirty: false, busy: false, valid: true }); }, [onStateChange]);
    return (
      <div data-testid="naming-panel">
        <button type="button" onClick={() => onStateChange({ dirty: true, busy: false, valid: true })}>dirty naming</button>
        <button type="button" onClick={() => onStateChange({ dirty: true, busy: false, valid: false })}>invalid naming</button>
      </div>
    );
  }),
}));

import SettingsPanel from '../SettingsPanel';

const TAB_NAMES = ['General', 'Session naming', 'Agents', 'Hosts', 'Workflows'];
const PANEL_TEST_IDS = { 'Session naming': 'naming-panel', Agents: 'agents-panel', Hosts: 'hosts-panel', Workflows: 'workflows-panel' };

function panelOf(testId) {
  return screen.getByTestId(testId).closest('[role="tabpanel"]');
}

function selectTab(name) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  showToast.mockClear();
  namingSave.mockClear();
  namingRevert.mockClear();
});

describe('SettingsPanel tabs', () => {
  it('shows the five tabs in order with General selected', async () => {
    await renderPanel();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(TAB_NAMES);
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[0].id);
  });

  it('is 880 px wide within 90vw and 80vh tall', async () => {
    await renderPanel();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.style.width).toBe('880px');
    expect(dialog.style.maxWidth).toBe('90vw');
    expect(dialog.style.height).toBe('80vh');
  });

  it('keeps every panel mounted and shows only the selected one', async () => {
    await renderPanel();
    for (const testId of Object.values(PANEL_TEST_IDS)) expect(panelOf(testId).hidden).toBe(true);
    expect(screen.getByPlaceholderText('code -r').closest('[role="tabpanel"]').hidden).toBe(false);

    for (const [name, testId] of Object.entries(PANEL_TEST_IDS)) {
      selectTab(name);
      expect(screen.getByRole('tab', { name }).getAttribute('aria-selected')).toBe('true');
      expect(panelOf(testId).hidden).toBe(false);
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
      // General stays mounted with its loaded values while another tab is shown.
      expect(screen.getByPlaceholderText('code -r').value).toBe('cursor -r');
      expect(screen.getByPlaceholderText('code -r').closest('[role="tabpanel"]').hidden).toBe(true);
    }
  });

  it('shows the Save and Revert footer on General and Session naming only', async () => {
    await renderPanel();
    const footerShown = () => screen.queryByRole('button', { name: 'Save' }) !== null
      && screen.queryByRole('button', { name: 'Revert' }) !== null;
    const footerAbsent = () => screen.queryByRole('button', { name: 'Save' }) === null
      && screen.queryByRole('button', { name: 'Revert' }) === null;

    expect(footerShown()).toBe(true);
    selectTab('Session naming');
    expect(footerShown()).toBe(true);
    selectTab('Agents');
    expect(footerAbsent()).toBe(true);
    selectTab('Hosts');
    expect(footerAbsent()).toBe(true);
    selectTab('Workflows');
    expect(footerAbsent()).toBe(true);
  });

  it('saves naming and config together from the footer on either footer tab', async () => {
    await renderPanel();
    fireEvent.change(screen.getByPlaceholderText('code -r'), { target: { value: 'code -r' } });
    selectTab('Session naming');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Settings saved' }));
    expect(namingSave).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/config/editorCommand', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ value: 'code -r' }),
    }));
  });

  it('says why Save is unavailable when the problem is on the Session naming tab', async () => {
    await renderPanel();
    expect(screen.queryByText('Session naming has incomplete settings')).toBeNull();
    selectTab('Session naming');
    fireEvent.click(screen.getByRole('button', { name: 'invalid naming' }));
    selectTab('General');

    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    expect(screen.getByText('Session naming has incomplete settings')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Session naming' }).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-invalid')).toBe('false');
  });

  it('closes without asking when nothing is unsaved', async () => {
    const { onClose } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['General', () => fireEvent.change(screen.getByPlaceholderText('code -r'), { target: { value: 'vim' } })],
    ['Session naming', () => fireEvent.click(screen.getByRole('button', { name: 'dirty naming' }))],
    ['Hosts', () => fireEvent.click(screen.getByRole('button', { name: 'dirty hosts' }))],
    ['Agents', () => fireEvent.click(screen.getByRole('button', { name: 'dirty agents' }))],
    ['Workflows', () => fireEvent.click(screen.getByRole('button', { name: 'dirty workflows' }))],
  ])('asks before closing with unsaved changes on %s', async (tab, makeDirty) => {
    const { onClose } = await renderPanel();
    selectTab(tab);
    makeDirty();
    selectTab('General');

    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(window.confirm).toHaveBeenCalledWith('Close settings and discard unsaved changes?');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks before closing from the backdrop too', async () => {
    const { onClose } = await renderPanel();
    fireEvent.change(screen.getByPlaceholderText('code -r'), { target: { value: 'vim' } });
    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByTestId('settings-overlay'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('settings-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
