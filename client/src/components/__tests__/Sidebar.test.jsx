import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    FolderOpen: Icon,
    Plus: Icon,
    Trash2: Icon,
    FolderTree: Icon,
    Pencil: Icon,
    Settings: Icon,
    FolderSearch: Icon,
    Archive: Icon,
    ArchiveRestore: Icon,
    ChevronRight: Icon,
    ChevronDown: Icon,
    Search: Icon,
    X: Icon,
    Bell: Icon,
    BellOff: Icon,
    PanelLeftClose: Icon,
    PanelLeftOpen: Icon,
    Keyboard: Icon,
    Hourglass: Icon,
    Play: Icon,
    Copy: Icon,
    MoreVertical: Icon,
  };
});

vi.mock('../DirectoryBrowser', () => ({
  default: () => null,
}));

vi.mock('../SettingsPanel', () => ({
  default: () => null,
}));

vi.mock('../BrandMark', () => ({
  default: () => null,
}));

vi.mock('../ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

vi.mock('../../utils/browserNotifications', () => ({
  createNotificationAudioContext: () => null,
  playCompletionDing: vi.fn(),
  requestNotificationPermissionFromGesture: vi.fn(async () => false),
  showBrowserNotification: vi.fn(async () => 'none'),
  shouldQueueNotificationPermissionRequest: vi.fn(() => false),
  warmNotificationAudioContext: vi.fn(async () => {}),
}));

import Sidebar from '../Sidebar';

function renderSidebar(overrides = {}) {
  return render(
    <Sidebar
      activeProjects={[]}
      waitingProjects={[]}
      shelvedProjects={[]}
      activeProject={null}
      isCompact={false}
      onSelect={vi.fn()}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onRename={vi.fn()}
      onMarkWaiting={vi.fn()}
      onActivateWaiting={vi.fn()}
      onShelve={vi.fn()}
      onUnshelve={vi.fn()}
      onToggleCompact={vi.fn()}
      onToggleFiles={vi.fn()}
      showFileTree={false}
      sessionStatus={[]}
      onBrowseFiles={vi.fn()}
      onShowShortcuts={vi.fn()}
      {...overrides}
    />
  );
}

describe('Sidebar', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mocks.showToast.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('loads the terminal finish cooldown from /api/config without making a 404-prone single-key request', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ terminalFinishCooldownSeconds: 45 }),
    });

    renderSidebar();

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/config');
    });

    expect(global.fetch).not.toHaveBeenCalledWith('/api/config/terminalFinishCooldownSeconds');
  });

  it('marks a stale-output terminal busy when executionStatus is running', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ terminalFinishCooldownSeconds: 45 }),
    });

    const view = renderSidebar({
      activeProjects: [{ name: 'Alpha', path: '/Users/dev/git/alpha/backend' }],
      sessionStatus: [{
        sessionId: 'Alpha-3',
        cwd: '/Users/dev/git/alpha/backend',
        alive: true,
        executionStatus: 'running',
        lastOutputAt: '2026-04-25T13:00:00.000Z',
        lastOutputLine: 'Waiting for deployment rollout to finish...',
      }],
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/config');
    });

    const dot = view.getByTitle('Terminal Alpha-3: busy');
    expect(dot.className).toContain('terminal-dot-busy');
  });

  it('keeps a muted running terminal neutral in the project list', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ terminalFinishCooldownSeconds: 45 }),
    });

    const view = renderSidebar({
      activeProjects: [{ name: 'Alpha', path: '/Users/dev/git/alpha/backend' }],
      mutedStatusSessionIds: new Set(['Alpha-3']),
      sessionStatus: [{
        sessionId: 'Alpha-3',
        cwd: '/Users/dev/git/alpha/backend',
        alive: true,
        executionStatus: 'running',
        lastOutputAt: '2026-04-25T13:00:00.000Z',
        lastOutputLine: 'Waiting for deployment rollout to finish...',
      }],
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/config');
    });

    expect(view.getByTitle('Status: idle')).toBeTruthy();
    const dot = view.getByTitle('Terminal Alpha-3: busy (status colors muted)');
    expect(dot.className).not.toContain('terminal-dot-busy');
  });

  it('renders unreachable remote project rows as suspended, not dead', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ terminalFinishCooldownSeconds: 45 }),
    });

    const view = renderSidebar({
      activeProjects: [{
        name: 'RemoteApp',
        path: '/srv/remote-app',
        host: 'devbox',
        reachability: 'unreachable',
        lastError: 'connect timeout',
      }],
      sessionStatus: [{
        sessionId: 'RemoteApp-1',
        cwd: '/srv/remote-app',
        host: 'devbox',
        reachability: 'unreachable',
        alive: false,
        executionStatus: 'dead',
      }],
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/config');
    });

    const row = view.getByTitle('RemoteApp — devbox unreachable').closest('.project-row');
    expect(row.style.opacity).toBe('0.62');
    expect(view.getByTitle('Status: unknown')).toBeTruthy();
    expect(view.getByTitle('Host devbox unreachable: connect timeout')).toBeTruthy();
    expect(view.getByText('unreachable')).toBeTruthy();
    expect(view.queryByText('dead')).toBeNull();
  });

  it('renders waiting projects as compact muted rows below active projects', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ terminalFinishCooldownSeconds: 45 }),
    });

    const onActivateWaiting = vi.fn();
    const view = renderSidebar({
      activeProjects: [{ name: 'Alpha', path: '/tmp/alpha' }],
      waitingProjects: [{ name: 'Beta', path: '/tmp/beta', waiting: true }],
      onActivateWaiting,
      sessionStatus: [{
        sessionId: 'Beta-1',
        cwd: '/tmp/beta',
        alive: true,
        executionStatus: 'running',
        lastOutputAt: '2026-05-11T10:00:00.000Z',
        lastOutputLine: 'long running task',
      }],
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/config');
    });

    expect(view.getByText('Waiting (1)')).toBeTruthy();
    expect(view.getByText('Beta')).toBeTruthy();
    expect(view.queryByText('Beta-1')).toBeNull();

    view.getByTitle('Beta — Waiting').click();
    expect(onActivateWaiting).toHaveBeenCalledWith('Beta');
  });

  it('keeps copy path visible and moves rename/delete into the project actions menu', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ terminalFinishCooldownSeconds: 45 }),
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    const onRename = vi.fn();
    const onRemove = vi.fn();
    const onShelve = vi.fn();
    const onMarkWaiting = vi.fn();
    const onBrowseFiles = vi.fn();
    const view = renderSidebar({
      activeProjects: [{ name: 'Alpha', path: '/tmp/alpha' }],
      waitingProjects: [{ name: 'Beta', path: '/tmp/beta', waiting: true }],
      shelvedProjects: [{ name: 'Gamma', path: '/tmp/gamma', shelved: true }],
      onRename,
      onRemove,
      onShelve,
      onMarkWaiting,
      onBrowseFiles,
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/config');
    });

    const alphaRow = view.getByTitle('Alpha').closest('.project-row');
    expect(alphaRow.children[0].textContent).toBe('Alpha');
    expect(alphaRow.children[0].querySelector('button')).toBeNull();
    expect(alphaRow.children[1].className).toContain('project-inline-actions');
    expect(alphaRow.children[1].querySelectorAll('button').length).toBeGreaterThan(0);

    const betaRow = view.getByTitle('Beta — Waiting').closest('.waiting-row');
    expect(betaRow.children[0].textContent).toBe('Beta');
    expect(betaRow.children[0].querySelector('button')).toBeNull();
    expect(betaRow.children[1].className).toContain('project-inline-actions');

    fireEvent.click(view.getByLabelText('Copy path for Alpha'));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/alpha');
    });

    fireEvent.click(view.getByLabelText('Shelve Alpha'));
    expect(onShelve).toHaveBeenCalledWith('Alpha');

    fireEvent.click(view.getByLabelText('Move Alpha to Waiting'));
    expect(onMarkWaiting).toHaveBeenCalledWith('Alpha');

    fireEvent.click(view.getByLabelText('Project actions for Alpha'));
    expect(view.getByLabelText('Project actions for Alpha').closest('.project-row').className).toContain('project-menu-open');
    expect(view.queryByText('Shelve project')).toBeNull();
    expect(view.queryByText('Move to Waiting')).toBeNull();
    fireEvent.click(view.getByText('Browse files'));
    expect(onBrowseFiles).toHaveBeenCalledWith({ name: 'Alpha', path: '/tmp/alpha' });

    fireEvent.click(view.getByLabelText('Project actions for Alpha'));
    fireEvent.click(view.getByText('Rename project'));
    const renameInput = view.getByDisplayValue('Alpha');
    fireEvent.change(renameInput, { target: { value: 'Alpha Prime' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('Alpha', 'Alpha Prime');

    fireEvent.click(view.getByLabelText('Shelve Beta'));
    expect(onShelve).toHaveBeenCalledWith('Beta');

    fireEvent.click(view.getByLabelText('Project actions for Beta'));
    expect(view.getByLabelText('Project actions for Beta').closest('.waiting-row').className).toContain('project-menu-open');
    expect(document.querySelector('.project-menu').className).toContain('project-menu-up');
    fireEvent.click(view.getByText('Remove project'));
    fireEvent.click(view.getByText('Confirm remove'));
    expect(onRemove).toHaveBeenCalledWith('Beta');

    fireEvent.click(view.getByText('Shelved (1)'));
    const gammaRow = view.getByText('Gamma').closest('.shelf-row');
    expect(gammaRow.children[0].textContent).toBe('Gamma');
    expect(gammaRow.children[0].querySelector('button')).toBeNull();
    expect(gammaRow.children[1].className).toContain('project-inline-actions');

    fireEvent.click(view.getByLabelText('Project actions for Gamma'));
    expect(view.getByLabelText('Project actions for Gamma').closest('.shelf-row').className).toContain('project-menu-open');
    expect(view.getByText('Rename project')).toBeTruthy();
    expect(view.getByText('Remove project')).toBeTruthy();
  });
});
