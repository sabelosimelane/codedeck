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
    History: Icon,
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
    Server: Icon,
  };
});

vi.mock('../ProjectLocationsDialog.jsx', () => ({
  default: ({ project, onClose }) => (
    <div role="dialog" aria-label={`Hosts and sync for ${project.name}`}><button type="button" onClick={onClose}>Done</button></div>
  ),
}));

vi.mock('../DirectoryBrowser', () => ({
  default: () => null,
}));

vi.mock('../SettingsPanel', () => ({
  default: () => null,
}));

vi.mock('../ProjectRepositoriesDialog.jsx', () => ({
  default: ({ project, onClose }) => (
    <div role="dialog" aria-label={`Repositories of ${project.name}`}><button type="button" onClick={onClose}>Done</button></div>
  ),
}));

vi.mock('../BrandMark', () => ({
  default: () => null,
}));
vi.mock('../../theme', () => ({ getThemeMode: () => 'dark', cycleThemeMode: vi.fn(), THEME_MODES: ['dark', 'light', 'system'] }));

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
  it('opens a local project\'s repositories from its menu', () => {
    const view = renderSidebar({ activeProjects: [{ name: 'Alpha', path: '/tmp/group/alpha' }], waitingProjects: [{ name: 'Beta', path: '/tmp/group/beta', waiting: true }] });
    fireEvent.click(view.getByLabelText('Project actions for Alpha'));
    fireEvent.click(view.getByText('Repositories…'));
    expect(view.getByRole('dialog', { name: 'Repositories of Alpha' })).toBeTruthy();
    // The menu closes behind the dialog.
    expect(view.queryByText('Rename project')).toBeNull();
    fireEvent.click(view.getByText('Done'));
    expect(view.queryByRole('dialog', { name: 'Repositories of Alpha' })).toBeNull();
    fireEvent.click(view.getByLabelText('Project actions for Beta'));
    fireEvent.click(view.getByText('Repositories…'));
    expect(view.getByRole('dialog', { name: 'Repositories of Beta' })).toBeTruthy();
  });

  it('opens a project\'s changes from its menu, including projects on remote hosts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [], page: { currentPage: 0, size: 20, totalElements: 0, totalPages: 0, hasNextPage: false } }) })));
    const view = renderSidebar({ activeProjects: [{ name: 'Alpha', path: '/tmp/group/alpha' }, { name: 'Remote', path: '/srv/app', host: 'devbox' }] });
    fireEvent.click(view.getByLabelText('Project actions for Remote'));
    expect(view.getByText('Changes…')).toBeTruthy();
    expect(view.getByText('Hosts & sync…')).toBeTruthy();
    fireEvent.click(view.getByLabelText('Project actions for Alpha'));
    fireEvent.click(view.getByText('Changes…'));
    expect(view.getByRole('dialog', { name: 'Changes in Alpha' })).toBeTruthy();
    expect(view.queryByText('Rename project')).toBeNull();
    await waitFor(() => expect(view.getByText('Nothing has been merged in Alpha yet.')).toBeTruthy());
    expect(fetch.mock.calls.map(call => call[0])).toContain('/api/tasks/changes?project=Alpha&page=0&size=20&sort=mergedAt,desc');
    fireEvent.click(view.getByText('Done'));
    expect(view.queryByRole('dialog', { name: 'Changes in Alpha' })).toBeNull();
    vi.unstubAllGlobals();
  });

  it('offers repositories and hosts & sync for both local and remote projects', () => {
    const view = renderSidebar({ activeProjects: [{ name: 'Remote', path: '/srv/app', host: 'devbox' }, { name: 'Here', path: '/tmp/here', host: 'local' }] });
    fireEvent.click(view.getByLabelText('Project actions for Remote'));
    expect(view.getByText('Rename project')).toBeTruthy();
    expect(view.getByText('Repositories…')).toBeTruthy();
    expect(view.getByText('Hosts & sync…')).toBeTruthy();
    fireEvent.click(view.getByLabelText('Project actions for Here'));
    expect(view.getByText('Repositories…')).toBeTruthy();
  });

  it('selecting an inactive project worktree activates its project', () => {
    const project = { name: 'Demo', path: '/tmp/demo' };
    const onSelect = vi.fn();
    const onSelectWorktree = vi.fn();
    const group = { key: '/tmp/demo-feature', path: '/tmp/demo-feature', label: 'demo-feature', branch: 'feature', isMain: false, sessionIds: [], run: null };
    const view = renderSidebar({ activeProjects: [project], activeProject: null, onSelect, onSelectWorktree,
      worktreeGroupsByProject: new Map([[project.name, [{ key: 'main', path: project.path, label: 'Main checkout', branch: null, isMain: true, sessionIds: [], run: null }, group]]]) });
    fireEvent.click(view.getByRole('button', { name: 'Select demo-feature worktree' }));
    expect(onSelect).toHaveBeenCalledWith(project);
    expect(onSelectWorktree).toHaveBeenCalledWith(project.name, group.key);
  });
  it('shows a task with a run as one entry: the run\'s terminals are folded away, the ones opened by hand stay', () => {
    const project = { name: 'Demo', path: '/tmp/demo' };
    const now = new Date().toISOString();
    const row = (sessionId, title) => ({ sessionId, cwd: '/tmp/demo-task', alive: true, title, lastOutputAt: now, lastOutputLine: `${title} output` });
    const sessionStatus = [row('Demo-1', 'Setup terminal'), row('Demo-2', 'Develop terminal'), row('Demo-3', 'My own terminal'), { ...row('Demo-5', 'Main terminal'), cwd: project.path }];
    const run = { id: 'r1', status: 'running', workflowName: 'Build', steps: [{ name: 'Setup', status: 'complete', sessionId: 'Demo-1' }, { name: 'Develop', status: 'running', sessionId: 'Demo-2' }], progress: null };
    const task = { key: '/tmp/demo-task', path: '/tmp/demo-task', label: 'demo-task', branch: 'task/x', isMain: false, sessionIds: ['Demo-1', 'Demo-2', 'Demo-3'], run, task: { id: '7a000000-0000-4000-8000-000000000001', title: 'Tag pings' } };
    const main = { key: 'main', path: project.path, label: 'Main checkout', branch: null, isMain: true, sessionIds: ['Demo-5'], run: null };
    const view = renderSidebar({ activeProjects: [project], activeProject: project, sessionStatus, worktreeGroupsByProject: new Map([[project.name, [main, task]]]) });
    expect(view.getByRole('button', { name: 'Select Tag pings worktree' }).textContent).toContain('running');
    expect(view.queryByText('Setup terminal')).toBeNull();
    expect(view.queryByText('Develop terminal')).toBeNull();
    expect(view.queryByText('Develop terminal output')).toBeNull();
    expect(view.getByText('My own terminal')).toBeTruthy();
    expect(view.getByText('Main terminal')).toBeTruthy();
  });

  it('keeps legacy session rows and omits a header for a main-only project without a run', () => {
    const project = { name: 'Demo', path: '/tmp/demo' };
    const sessionStatus = [{ sessionId: 'Demo-1', cwd: project.path, alive: true, title: 'Existing terminal' }];
    const view = renderSidebar({ activeProjects: [project], activeProject: project, sessionStatus,
      worktreeGroupsByProject: new Map([[project.name, [{ key: 'main', path: project.path, label: 'Main checkout', branch: null, isMain: true, sessionIds: ['Demo-1'], run: null }]]]) });
    expect(view.queryByTestId('worktree-group-header')).toBeNull();
    expect(view.getByText('Existing terminal').title).toBe('Demo-1');
  });
  it('shows a generated session title with the original ID available in a tooltip', () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const project = { name: 'Demo', path: '/tmp/demo' };
    const view = renderSidebar({ activeProjects: [project], activeProject: project, sessionStatus: [{ sessionId: 'Demo-1', cwd: '/tmp/demo', alive: true, title: 'Fix login redirects' }] });
    expect(view.getByText('Fix login redirects').title).toBe('Demo-1');
  });
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

  it.each(['active', 'waiting', 'shelved'])('keeps remote %s project names on their own line above host details', section => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const project = { name: 'CodeDeck', path: '/tmp/codedeck', host: 'media-server.example.ts.net' };
    const view = renderSidebar({ [`${section}Projects`]: [project] });
    if (section === 'shelved') fireEvent.click(view.getByText('Shelved (1)'));
    const name = view.getByText('CodeDeck');
    const host = view.getByTitle(`Host ${project.host}`);
    expect(name.parentElement.contains(host)).toBe(false);
    expect(host.textContent).toBe(project.host);
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

it('reopens a dismissed task from its project without invoking a second selection', () => {
  const project = { name: 'Alpha', path: '/tmp/alpha' };
  const task = { id: 'stable-task-id', title: 'Reply', project: project.name };
  const onReopenTask = vi.fn();
  const onSelect = vi.fn();
  const onSelectWorktree = vi.fn();
  const view = renderSidebar({ activeProjects: [project], onSelect, onReopenTask, onSelectWorktree,
    isTaskDismissed: candidate => candidate.id === task.id,
    worktreeGroupsByProject: new Map([[project.name, [{ key: 'main', path: project.path, isMain: true, sessionIds: [] }, { key: '/tmp/reply', task, sessionIds: [] }]]]),
  });
  fireEvent.click(view.getByRole('button', { name: 'Reopen tab: Reply' }));
  expect(onReopenTask).toHaveBeenCalledExactlyOnceWith(task);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onSelectWorktree).not.toHaveBeenCalled();
});
