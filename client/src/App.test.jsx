import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('./components/Sidebar', () => ({
  default: ({ activeProjects = [], onSelect }) => (
    <div>
      {activeProjects.map(project => (
        <button key={project.name} onClick={() => onSelect(project)}>
          {project.name}
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
          json: async () => [{ name: 'BookMe', path: '/tmp/bookme' }],
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

    fireEvent.click(screen.getByRole('button', { name: 'BookMe' }));

    expect(sessionRequestCount).toBe(2);
  });
});
