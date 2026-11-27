import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, fireEvent, screen, cleanup } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  startRun: vi.fn(),
}));

vi.mock('./components/Sidebar', () => ({
  default: ({ activeProjects = [], waitingProjects = [], onSelect, onActivateWaiting, onRemove, worktreeGroupsByProject, isTaskDismissed, onReopenTask }) => (
    <div>
      {activeProjects.map(project => (
        <React.Fragment key={project.name}>
          <button onClick={() => onSelect(project)}>{project.name}</button>
          <button onClick={() => onRemove(project.name)}>Remove {project.name}</button>
          {worktreeGroupsByProject.get(project.name)?.filter(group => group.task && isTaskDismissed?.(group.task)).map(({ task }) => (
            <button key={task.id} onClick={() => onReopenTask(task)}>Reopen {project.name} {task.title}</button>
          ))}
        </React.Fragment>
      ))}
      {waitingProjects.map(project => (
        <button key={project.name} onClick={() => onActivateWaiting(project.name)}>
          Waiting: {project.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./components/TerminalArea', () => ({
  default: ({ project, selectedWorktree, onOpenRunWorkflow, worktreeGroups, isTaskDismissed, onDismissTask, onTaskCreated }) => (
    <div>
      <button onClick={onOpenRunWorkflow}>Open run workflow</button>
      {worktreeGroups?.filter(group => group.task && !isTaskDismissed?.(group.task)).map(({ task }) => (
        <button key={task.id} onClick={() => onDismissTask(task)}>Dismiss {task.title}</button>
      ))}
      <button onClick={() => onTaskCreated(navigationTask(9, project.name, 'Local task'))}>Create local task</button>
      <output data-testid="task-membership">{JSON.stringify(worktreeGroups?.filter(group => group.task).map(group => [group.task.id, group.paths, group.sessionIds, group.run?.id, group.run?.status]))}</output>
      <span data-testid="selected-worktree">{selectedWorktree ?? 'none'}</span>
    </div>
  ),
}));

vi.mock('./components/pipelines/RunWorkflowDialog', () => ({
  default: ({ onStart }) => (
    <div>
      <button onClick={() => onStart({ requestId: 'first' })}>Start first run</button>
      <button onClick={() => onStart({ requestId: 'other' }, { follow: false })}>Start another run</button>
    </div>
  ),
}));

vi.mock('./components/FileTree', () => ({
  default: () => null,
}));

vi.mock('./components/FileBrowserPanel', () => ({
  default: () => null,
}));

vi.mock('./components/ProjectSwitcher', () => ({
  default: () => null,
}));

vi.mock('./components/ShortcutsOverlay', () => ({
  default: () => null,
}));

vi.mock('./components/assistant/AssistantPanel', () => ({
  default: ({ projectName, onClose }) => <aside aria-label="Project assistant">{projectName}<button onClick={onClose}>Close assistant</button></aside>,
}));

vi.mock('./components/PaneDivider', () => ({
  default: () => null,
}));

vi.mock('./components/PreviewPage', () => ({
  default: () => null,
}));

vi.mock('./components/ToastContext', () => ({
  ToastProvider: ({ children }) => children,
  useToast: () => ({ showToast: mocks.showToast }),
}));

vi.mock('./utils/fileActions', () => ({
  openFilePreviewTab: vi.fn(),
}));

vi.mock('./hooks/usePipelineRunCounts', () => ({
  usePipelineRunCounts: () => ({ runsByProject: mocks.runsByProject }),
}));

vi.mock('./hooks/usePipelineRuns', () => ({
  usePipelineRuns: () => ({
    runs: [],
    locallyStartedRunIds: new Set(),
    startRun: mocks.startRun,
    stopRun: vi.fn(),
    resumeRun: vi.fn(),
    continueRun: vi.fn(),
    cleanupRun: vi.fn(),
  }),
}));

import App from './App';
import { SYSTEM_RESOURCES_URL } from './utils/systemResourceTitle';

function okJson(json) {
  return Promise.resolve({
    ok: true,
    json: async () => json,
  });
}

function mockSystemResources(resources = {
  cpu: { usage_percent: 9.79 },
  memory: { usage_percent: 81 },
  disk: { usage_percent: 89 },
}) {
  return okJson(resources);
}

function navigationTask(n, project, title = 'Same title') {
  const stamp = '2026-11-19T08:00:00.000Z';
  const fields = { worktreePath: `/tmp/worktrees/nav-${n}`, branch: `task/t${n}`, baseBranch: 'main',
    baseCommit: 'a'.repeat(40), state: 'active', prUrl: null };
  const worktree = (suffix, first, overrides) => ({
    ...fields, repository: first ? 'backend' : 'frontend', own: first, first,
    id: `7b000000-0000-4000-8000-0000000000${n}${suffix}`, ...overrides,
  });
  return { id: `7a000000-0000-4000-8000-00000000000${n}`, project, title, revision: 1, createdAt: stamp,
    updatedAt: stamp, finishedAt: null, folder: null, ...fields,
    worktrees: [worktree(1, true), worktree(2, false, { worktreePath: `${fields.worktreePath}-front`, state: 'merged' })] };
}

describe('App polling', () => {
  let originalFetch;

  beforeEach(() => {
    vi.useFakeTimers();
    originalFetch = global.fetch;
    mocks.showToast.mockReset();
    mocks.runsByProject = new Map();
    localStorage.clear();
    document.title = 'CodeDeck';
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('dismisses only the selected project task and restores it across polls, a failed reload, and reopening', async () => {
    const task = navigationTask(1, 'Gamma');
    const other = navigationTask(2, 'Delta');
    const sessionId = 'Gamma-12';
    const empty = navigationTask(3, 'Gamma', 'Empty task');
    const run = { id: 'pause-1', project: task.project, status: 'limit_paused', workflowName: 'Fix', inheritedSessionIds: [],
      worktree: { path: task.worktreePath, branch: task.branch }, progress: null, createdAt: task.createdAt, steps: [] };
    mocks.runsByProject.set(task.project, [run]);
    let tasks = [task, other, empty];
    let unavailable = false;
    global.fetch = vi.fn(url => {
      if (url === '/api/projects') return okJson([{ name: 'Gamma', path: '/tmp/gamma', repositories: [] }, { name: 'Delta', path: '/tmp/delta', repositories: [] }]);
      if (url === '/api/sessions') return okJson([{ sessionId, project: 'Gamma', worktreePath: task.worktrees[1].worktreePath }]);
      if (String(url).startsWith('/api/tasks')) return unavailable ? Promise.reject(new Error('offline')) :
        okJson({ data: tasks, page: { currentPage: 0, size: 100, totalElements: tasks.length, totalPages: 1, hasNextPage: false } });
      return okJson([]);
    });
    localStorage.setItem('codedeck-worktree-Gamma', task.worktreePath);
    const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    const first = render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }));
    const selected = () => screen.getByTestId('selected-worktree').textContent;
    const members = () => JSON.parse(screen.getByTestId('task-membership').textContent);
    expect(selected()).toBe(task.worktreePath);
    const expected = [task.id, task.worktrees.map(row => row.worktreePath), [sessionId], run.id, run.status];
    expect(members().find(row => row[0] === task.id)).toEqual(expected);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Empty task' }));
    expect(selected()).toBe(task.worktreePath);
    expect(screen.getByRole('button', { name: 'Reopen Gamma Empty task' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Same title' }));
    expect(selected()).toBe('main');
    await flush(4000);
    expect(screen.queryByRole('button', { name: 'Dismiss Same title' })).toBeNull();
    expect(members().find(row => row[0] === task.id)).toEqual(expected);
    fireEvent.click(screen.getByRole('button', { name: 'Delta' }));
    expect(screen.getByRole('button', { name: 'Dismiss Same title' })).toBeTruthy();
    unavailable = true;
    first.unmount();
    render(<App />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen Gamma Same title' }));
    expect(selected()).toBe(task.worktreePath);
    expect(members().find(row => row[0] === task.id)).toEqual(expected);
    expect(screen.queryByRole('button', { name: 'Reopen Gamma Same title' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Same title' }));
    unavailable = false;
    tasks = [other];
    await flush(2000);
    expect(screen.queryByRole('button', { name: 'Reopen Gamma Same title' })).toBeNull();
    expect(global.fetch.mock.calls.every(([, options]) => (options?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('can dismiss and reopen a locally created empty task before the list reports it', async () => {
    global.fetch = vi.fn(url => url === '/api/projects' ? okJson([{ name: 'Gamma', path: '/tmp/gamma', repositories: [] }]) :
      String(url).startsWith('/api/tasks') ? okJson({ data: [], page: { currentPage: 0, size: 100, totalElements: 0, totalPages: 0, hasNextPage: false } }) : okJson([]));
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create local task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Local task' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen Gamma Local task' }));
    expect(screen.getByTestId('selected-worktree').textContent).toBe('/tmp/worktrees/nav-9');
  });

  it('opens the dashboard directly from the main navigation and returns to the workspace', async () => {
    window.history.replaceState({}, '', '/#improvements');
    global.fetch = vi.fn(url => String(url).includes('/api/pipelines/') ? okJson({ data: [], page: { hasNextPage: false } }) : okJson([]));
    render(<App />);
    expect(screen.getByRole('link', { name: 'Improvements' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { name: 'Workflow improvements' })).toBeTruthy();
    await act(async () => {
      window.location.hash = 'workspace';
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(screen.getByRole('link', { name: 'Workspace' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('heading', { name: 'Workflow improvements' })).toBeNull();
  });

  it('does not start a new /api/sessions poll while the previous one is still in flight', async () => {
    let sessionRequestCount = 0;

    global.fetch = vi.fn((url) => {
      if (url === SYSTEM_RESOURCES_URL) {
        return mockSystemResources();
      }

      if (url === '/api/projects') {
        return okJson([]);
      }

      if (url === '/api/sessions') {
        sessionRequestCount += 1;
        return new Promise(() => {});
      }

      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    render(<App />);

    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRequestCount).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(sessionRequestCount).toBe(1);
  });

  it('goes to the task of a run it starts, but stays put for a further run started with it', async () => {
    const STAMP = '2026-11-19T08:00:00.000Z';
    const task = (n, worktreePath) => {
      const fields = { worktreePath, branch: `task/t${n}`, baseBranch: 'main', baseCommit: 'a'.repeat(40), state: 'active', prUrl: null };
      return { id: `7a000000-0000-4000-8000-00000000000${n}`, project: 'Gamma', title: `Task ${n}`, revision: 1, createdAt: STAMP, updatedAt: STAMP, finishedAt: null, folder: null,
        ...fields, worktrees: [{ id: `7b000000-0000-4000-8000-00000000000${n}`, repository: 'gamma', own: true, first: true, ...fields }] };
    };
    global.fetch = vi.fn((url) => {
      if (url === SYSTEM_RESOURCES_URL) return mockSystemResources();
      if (url === '/api/projects') return okJson([{ name: 'Gamma', path: '/tmp/gamma', repositories: [] }]);
      if (url === '/api/sessions') return okJson([]);
      if (String(url).startsWith('/api/tasks')) return okJson({ data: [task(1, '/tmp/worktrees/first'), task(2, '/tmp/worktrees/other')], page: { currentPage: 0, size: 100, totalElements: 2, totalPages: 1, hasNextPage: false } });
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    mocks.startRun.mockReset();
    mocks.startRun
      .mockResolvedValueOnce({ id: 'r1', worktree: { path: '/tmp/worktrees/first' } })
      .mockResolvedValueOnce({ id: 'r2', worktree: { path: '/tmp/worktrees/other' } });

    render(<App />);
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }));
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(screen.getByRole('button', { name: 'Open run workflow' }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start first run' })); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('selected-worktree').textContent).toBe('/tmp/worktrees/first');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start another run' })); await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.startRun.mock.calls.map(([request]) => request.requestId)).toEqual(['first', 'other']);
    expect(screen.getByTestId('selected-worktree').textContent).toBe('/tmp/worktrees/first');
  });

  it('refreshes /api/sessions immediately when selecting a project', async () => {
    let sessionRequestCount = 0;

    global.fetch = vi.fn((url) => {
      if (url === SYSTEM_RESOURCES_URL) {
        return mockSystemResources();
      }

      if (url === '/api/projects') {
        return okJson([{ name: 'Gamma', path: '/tmp/gamma', repositories: [] }]);
      }

      if (url === '/api/sessions') {
        sessionRequestCount += 1;
        return okJson([]);
      }

      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    render(<App />);

    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRequestCount).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }));

    expect(sessionRequestCount).toBe(2);
  });

  it('activates a waiting project before selecting it', async () => {
    let sessionRequestCount = 0;
    let projectRequestCount = 0;

    global.fetch = vi.fn((url, options = {}) => {
      if (url === SYSTEM_RESOURCES_URL) {
        return mockSystemResources();
      }

      if (url === '/api/projects' && !options.method) {
        projectRequestCount += 1;
        return okJson(projectRequestCount === 1
          ? [{ name: 'Gamma', path: '/tmp/gamma', repositories: [], waiting: true, waitingAt: '2026-05-11T10:00:00.000Z' }]
          : [{ name: 'Gamma', path: '/tmp/gamma', repositories: [], waiting: false, waitingAt: null }]);
      }

      if (url === '/api/projects/Gamma' && options.method === 'PUT') {
        return okJson({ name: 'Gamma', path: '/tmp/gamma', repositories: [], waiting: false, waitingAt: null });
      }

      if (url === '/api/sessions') {
        sessionRequestCount += 1;
        return okJson([]);
      }

      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    render(<App />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Waiting: Gamma' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/projects/Gamma', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ waiting: false, waitingAt: null }),
    }));
    expect(sessionRequestCount).toBe(2);
  });

  it('shows system resources in the visible top bar and browser title and polls every 30 seconds', async () => {
    let resourcesRequestCount = 0;

    global.fetch = vi.fn((url) => {
      if (url === SYSTEM_RESOURCES_URL) {
        resourcesRequestCount += 1;
        return mockSystemResources(resourcesRequestCount === 1
          ? {
              cpu: { usage_percent: 9.79 },
              memory: { usage_percent: 81 },
              disk: { usage_percent: 89 },
            }
          : {
              cpu: { usage_percent: 12.5 },
              memory: { usage_percent: 82 },
              disk: { usage_percent: 90 },
            });
      }

      if (url === '/api/projects') {
        return okJson([]);
      }

      if (url === '/api/sessions') {
        return okJson([]);
      }

      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    render(<App />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(document.title).toBe('💻 81% · ⚡ 9.79% · 💿 89%');
    expect(screen.getByRole('region', { name: 'Local machine resources' }).textContent).toContain('💻 81% · ⚡ 9.79% · 💿 89%');
    expect(resourcesRequestCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29999);
      await Promise.resolve();
    });

    expect(resourcesRequestCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });

    expect(resourcesRequestCount).toBe(2);
    expect(document.title).toBe('🚨 💻 82% · ⚡ 12.5% · 💿 90%');
    expect(screen.getByRole('region', { name: 'Local machine resources' }).textContent).toContain('🚨 💻 82% · ⚡ 12.5% · 💿 90%');
    expect(document.querySelector("link[rel~='icon']")?.href).toContain('data:image/svg+xml');
  });

  it('shows the project delete problem detail and keeps the project listed', async () => {
    global.fetch = vi.fn((url, options = {}) => {
      if (url === SYSTEM_RESOURCES_URL) return mockSystemResources();
      if (url === '/api/projects') return okJson([{ name: 'Gamma', path: '/tmp/gamma', repositories: [] }]);
      if (url === '/api/sessions') return okJson([]);
      if (url === '/api/projects/Gamma' && options.method === 'DELETE') {
        return Promise.resolve({ ok: false, json: async () => ({ detail: 'Could not close Gamma-1.' }) });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Gamma' }));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Could not close Gamma-1.' });
    expect(screen.getByRole('button', { name: 'Gamma' })).toBeTruthy();
  });

  it('toggles the project assistant from the top bar and Cmd or Ctrl Shift L', async () => {
    global.fetch = vi.fn(url => {
      if (url === '/api/projects') return okJson([{ name: 'Gamma', path: '/tmp/gamma', repositories: [] }]);
      if (url === '/api/sessions') return okJson([]);
      if (url === SYSTEM_RESOURCES_URL) return mockSystemResources();
      if (String(url).startsWith('/api/tasks')) return okJson({ data: [], page: { currentPage: 0, size: 100, totalElements: 0, totalPages: 0, hasNextPage: false } });
      return okJson([]);
    });
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle project assistant' }));
    expect(screen.getByRole('complementary', { name: 'Project assistant' }).textContent).toContain('Gamma');
    expect(localStorage.getItem('codedeck-assistant-open')).toBe('true');
    fireEvent.keyDown(window, { key: 'L', metaKey: true, shiftKey: true });
    expect(screen.queryByRole('complementary', { name: 'Project assistant' })).toBeNull();
    expect(localStorage.getItem('codedeck-assistant-open')).toBe('false');
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('complementary', { name: 'Project assistant' })).toBeTruthy();
  });
});
