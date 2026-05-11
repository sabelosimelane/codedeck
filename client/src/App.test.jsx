import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, fireEvent, screen } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('./components/Sidebar', () => ({
  default: ({ activeProjects = [], waitingProjects = [], onSelect, onActivateWaiting }) => (
    <div>
      {activeProjects.map(project => (
        <button key={project.name} onClick={() => onSelect(project)}>
          {project.name}
        </button>
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
  default: () => null,
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

import App from './App';

describe('App session polling', () => {
  let originalFetch;

  beforeEach(() => {
    vi.useFakeTimers();
    originalFetch = global.fetch;
    mocks.showToast.mockReset();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not start a new /api/sessions poll while the previous one is still in flight', async () => {
    let sessionRequestCount = 0;

    global.fetch = vi.fn((url) => {
      if (url === '/api/projects') {
        return Promise.resolve({
          ok: true,
          json: async () => [],
        });
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

  it('refreshes /api/sessions immediately when selecting a project', async () => {
    let sessionRequestCount = 0;

    global.fetch = vi.fn((url) => {
      if (url === '/api/projects') {
        return Promise.resolve({
          ok: true,
          json: async () => [{ name: 'Gamma', path: '/tmp/gamma' }],
        });
      }

      if (url === '/api/sessions') {
        sessionRequestCount += 1;
        return Promise.resolve({
          ok: true,
          json: async () => [],
        });
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
      if (url === '/api/projects' && !options.method) {
        projectRequestCount += 1;
        return Promise.resolve({
          ok: true,
          json: async () => projectRequestCount === 1
            ? [{ name: 'Gamma', path: '/tmp/gamma', waiting: true, waitingAt: '2026-05-11T10:00:00.000Z' }]
            : [{ name: 'Gamma', path: '/tmp/gamma', waiting: false, waitingAt: null }],
        });
      }

      if (url === '/api/projects/Gamma' && options.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ name: 'Gamma', path: '/tmp/gamma', waiting: false, waitingAt: null }),
        });
      }

      if (url === '/api/sessions') {
        sessionRequestCount += 1;
        return Promise.resolve({
          ok: true,
          json: async () => [],
        });
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
});
