import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }));

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
    Sun: Icon,
    Moon: Icon,
    Monitor: Icon,
  };
});
vi.mock('../DirectoryBrowser', () => ({ default: () => null }));
vi.mock('../SettingsPanel', () => ({ default: () => null }));
vi.mock('../BrandMark', () => ({ default: () => null }));
vi.mock('../../theme', () => ({ getThemeMode: () => 'dark', cycleThemeMode: vi.fn(), THEME_MODES: ['dark', 'light', 'system'] }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('../../utils/browserNotifications', () => ({
  createNotificationAudioContext: () => null,
  playCompletionDing: vi.fn(),
  requestNotificationPermissionFromGesture: vi.fn(async () => false),
  showBrowserNotification: vi.fn(async () => 'none'),
  shouldQueueNotificationPermissionRequest: vi.fn(() => false),
  warmNotificationAudioContext: vi.fn(async () => {}),
}));

import Sidebar from '../Sidebar';

const alpha = { name: 'Alpha', path: '/tmp/alpha' };
const beta = { name: 'Beta', path: '/tmp/beta' };

function renderSidebar(overrides = {}) {
  return render(
    <Sidebar
      activeProjects={[alpha, beta]}
      waitingProjects={[]}
      shelvedProjects={[]}
      activeProject={alpha}
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

describe('Sidebar waiting tab count', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    mocks.showToast.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('shows no badge when a project has no waiting tabs', () => {
    const view = renderSidebar({ waitingSessionIds: new Set() });
    expect(view.queryByTestId('project-waiting-count-Alpha')).toBeNull();
  });

  it('counts only the waiting tabs belonging to each project', () => {
    const view = renderSidebar({ waitingSessionIds: new Set(['Alpha-1', 'Alpha-3', 'Beta-2']) });

    const alphaBadge = view.getByTestId('project-waiting-count-Alpha');
    expect(alphaBadge.textContent).toBe('2');
    expect(alphaBadge.getAttribute('title')).toBe('2 tabs waiting on an agent');

    const betaBadge = view.getByTestId('project-waiting-count-Beta');
    expect(betaBadge.textContent).toBe('1');
    expect(betaBadge.getAttribute('title')).toBe('1 tab waiting on an agent');
  });

  it('hides the badge in compact mode, where there is no room for it', () => {
    const view = renderSidebar({ isCompact: true, waitingSessionIds: new Set(['Alpha-1']) });
    expect(view.queryByTestId('project-waiting-count-Alpha')).toBeNull();
  });

  it('does not require the waiting prop to render', () => {
    const view = renderSidebar();
    expect(view.queryByTestId('project-waiting-count-Alpha')).toBeNull();
  });
});
