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

describe('Sidebar pipeline run counts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('shows project-specific counts and omits zero counts', () => {
    const view = renderSidebar({ openRunCounts: new Map([['Alpha', 2], ['Beta', 1]]) });
    expect(view.getByTitle('2 open runs').textContent).toBe('2');
    expect(view.getByTitle('1 open run').textContent).toBe('1');
  });
  it('shows a count in compact mode', () => {
    const view = renderSidebar({ isCompact: true, openRunCounts: new Map([['Alpha', 1]]) });
    expect(view.getByTitle('1 open run')).toBeTruthy();
  });
  it('omits counts when there are no open runs', () => {
    const view = renderSidebar();
    expect(view.queryByTitle(/open runs?/)).toBeNull();
  });
  it('shows counts on waiting and shelved rows', () => {
    localStorage.setItem('codedeck-shelf-expanded', 'true');
    const view = renderSidebar({ activeProjects: [], waitingProjects: [alpha], shelvedProjects: [beta], openRunCounts: new Map([['Alpha', 2], ['Beta', 1]]) });
    expect(view.getByTitle('2 open runs')).toBeTruthy();
    expect(view.getByTitle('1 open run')).toBeTruthy();
  });
});
