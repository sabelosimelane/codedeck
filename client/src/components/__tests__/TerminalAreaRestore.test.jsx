import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  terminalApis: new Map(),
}));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    Plus: Icon,
    X: Icon,
    Columns: Icon,
    Eraser: Icon,
    Bug: Icon,
    Paintbrush: Icon,
    TerminalSquare: Icon,
  };
});

vi.mock('../Terminal', () => ({
  default: React.forwardRef(function MockTerminal(props, ref) {
    const api = React.useMemo(() => ({
      clear: vi.fn(),
      redraw: vi.fn(),
      focus: vi.fn(),
    }), []);

    React.useImperativeHandle(ref, () => api, [api]);
    mocks.terminalApis.set(props.sessionId, api);
    return null;
  }),
}));

vi.mock('../PaneDivider', () => ({
  default: () => null,
}));

vi.mock('../TerminalInspector', () => ({
  default: () => null,
}));

vi.mock('../ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

import TerminalArea from '../TerminalArea';

const PROJECT = { name: 'BookMe', path: '/tmp/bookme' };
const LAYOUT_KEY = `codedeck-layout-${PROJECT.name}`;

const SAVED_LAYOUT = {
  tabs: [
    {
      id: 'tab-4',
      label: 'BookMe-9',
      panes: [
        {
          id: 'pane-BookMe-9',
          sessionId: 'BookMe-9',
          widthFraction: 1,
          isConnected: true,
        },
      ],
    },
  ],
  activeTabId: 'tab-4',
  tabCounter: 4,
  sessionCounter: 9,
};

describe('TerminalArea restore fallback', () => {
  let originalFetch;
  let onSessionStatusRefresh;

  beforeEach(() => {
    originalFetch = global.fetch;
    mocks.showToast.mockReset();
    mocks.terminalApis = new Map();
    onSessionStatusRefresh = vi.fn();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('preserves but does not render the saved layout when /api/sessions fails during restore', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(SAVED_LAYOUT));
    global.fetch = vi.fn().mockRejectedValue(new Error('backend unavailable'));

    const view = render(<TerminalArea project={PROJECT} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/sessions');
    });

    await waitFor(() => {
      expect(view.getByText('No terminals open')).toBeTruthy();
      expect(view.queryByText('BookMe-9')).toBeNull();
      expect(mocks.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Server unreachable' });
      expect(localStorage.getItem(LAYOUT_KEY)).toBe(JSON.stringify(SAVED_LAYOUT));
    });

    await new Promise(resolve => setTimeout(resolve, 350));
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(JSON.stringify(SAVED_LAYOUT));
  });

  it('publishes restore-time session snapshots to the app shell', async () => {
    const liveSessions = [
      { sessionId: 'BookMe-9', cwd: '/tmp/bookme', alive: true, wsAttached: true },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => liveSessions,
    });

    render(<TerminalArea project={PROJECT} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);

    await waitFor(() => {
      expect(onSessionStatusRefresh).toHaveBeenCalledWith(liveSessions);
    });
  });

  it('renders pane header status from backend execution state', async () => {
    const liveSessions = [
      {
        sessionId: 'BookMe-9',
        cwd: '/tmp/bookme',
        alive: true,
        wsAttached: true,
        executionStatus: 'running',
        executionReason: 'shell_without_prompt',
        foregroundCommand: 'bash',
      },
    ];

    global.fetch = vi.fn(async (url) => {
      if (url === '/api/health') {
        return {
          ok: true,
          json: async () => ({ terminalCreationAllowed: true }),
        };
      }

      if (url === '/api/sessions') {
        return {
          ok: true,
          json: async () => liveSessions,
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const view = render(
      <TerminalArea project={PROJECT} sessionStatus={liveSessions} onSessionStatusRefresh={onSessionStatusRefresh} />
    );

    await waitFor(() => {
      expect(view.getAllByText('BookMe-9').length).toBeGreaterThan(0);
    });

    const statusDot = view.getByTitle('BookMe-9: running (shell_without_prompt)');
    expect(statusDot.className).toContain('terminal-dot-busy');
    expect(view.getByText('Running')).toBeTruthy();
  });

  it('creates new terminals with a backend-issued session id', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      tabs: [],
      activeTabId: null,
      tabCounter: 4,
      sessionCounter: 9,
    }));

    global.fetch = vi.fn(async (url, options = {}) => {
      if (url === '/api/sessions') {
        return {
          ok: true,
          json: async () => [],
        };
      }

      if (url === '/api/terminal' && options.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ sessionId: 'BookMe-12' }),
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const view = render(
      <TerminalArea project={PROJECT} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />
    );

    await waitFor(() => {
      expect(view.getByText('No terminals open')).toBeTruthy();
    });

    fireEvent.click(view.getByText('Open terminal'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/terminal', expect.objectContaining({
        method: 'POST',
      }));
      expect(view.getAllByText('BookMe-12').length).toBeGreaterThan(0);
    });
  });

  it('hydrates live sessions from sessionStatus after an empty restore snapshot', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      tabs: [],
      activeTabId: null,
      tabCounter: 4,
      sessionCounter: 9,
    }));

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const liveSessions = [
      { sessionId: 'BookMe-9', cwd: '/tmp/bookme', alive: true, wsAttached: true },
    ];

    const view = render(
      <TerminalArea project={PROJECT} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />
    );

    await waitFor(() => {
      expect(view.getByText('No terminals open')).toBeTruthy();
    });

    view.rerender(
      <TerminalArea project={PROJECT} sessionStatus={liveSessions} onSessionStatusRefresh={onSessionStatusRefresh} />
    );

    await waitFor(() => {
      expect(view.queryByText('No terminals open')).toBeNull();
      expect(view.getAllByText('BookMe-9').length).toBeGreaterThan(0);
    });
  });

  it('lets the user manually re-measure a pane layout from the header', async () => {
    let liveSessions = [
      { sessionId: 'BookMe-9', cwd: '/tmp/bookme', alive: true, wsAttached: true },
    ];

    global.fetch = vi.fn(async (url) => {
      if (url === '/api/sessions') {
        return {
          ok: true,
          json: async () => liveSessions,
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const view = render(
      <TerminalArea project={PROJECT} sessionStatus={liveSessions} onSessionStatusRefresh={onSessionStatusRefresh} />
    );

    await waitFor(() => {
      expect(view.getAllByText('BookMe-9').length).toBeGreaterThan(0);
    });

    fireEvent.click(view.container.querySelector('[title="Re-measure terminal layout"]'));

    expect(mocks.terminalApis.get('BookMe-9')?.redraw).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith({ type: 'success', message: 'Re-measuring terminal layout...' });
  });

  it('persists an empty layout immediately after closing the last terminal', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(SAVED_LAYOUT));

    let liveSessions = [
      { sessionId: 'BookMe-9', cwd: '/tmp/bookme', alive: true, wsAttached: true },
    ];

    global.fetch = vi.fn(async (url, options = {}) => {
      if (url === '/api/sessions') {
        return {
          ok: true,
          json: async () => liveSessions,
        };
      }

      if (url === '/api/terminal/BookMe-9' && options.method === 'DELETE') {
        liveSessions = [];
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const firstView = render(
      <TerminalArea project={PROJECT} sessionStatus={liveSessions} onSessionStatusRefresh={onSessionStatusRefresh} />
    );

    await waitFor(() => {
      expect(firstView.getAllByText('BookMe-9').length).toBeGreaterThan(0);
    });

    fireEvent.click(firstView.container.querySelector('.pane-close-btn'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/terminal/BookMe-9', { method: 'DELETE' });
    });

    expect(localStorage.getItem(LAYOUT_KEY)).toBe(JSON.stringify({
      tabs: [],
      activeTabId: null,
      tabCounter: 4,
      sessionCounter: 9,
    }));
  });
});
