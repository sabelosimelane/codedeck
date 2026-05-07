import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
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
      shelvedProjects={[]}
      activeProject={null}
      isCompact={false}
      onSelect={vi.fn()}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onRename={vi.fn()}
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
});
