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
    RotateCcw: Icon,
    Eye: Icon,
    EyeOff: Icon,
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

const PROJECT = { name: 'Gamma', path: '/tmp/gamma' };
const LAYOUT_KEY = `codedeck-layout-${PROJECT.name}`;

const SAVED_LAYOUT = {
  tabs: [
    {
      id: 'tab-4',
      label: 'Gamma-9',
      panes: [
        {
          id: 'pane-Gamma-9',
          sessionId: 'Gamma-9',
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
      expect(view.queryByText('Gamma-9')).toBeNull();
      expect(mocks.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Server unreachable' });
      expect(localStorage.getItem(LAYOUT_KEY)).toBe(JSON.stringify(SAVED_LAYOUT));
    });

    await new Promise(resolve => setTimeout(resolve, 350));
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(JSON.stringify(SAVED_LAYOUT));
  });

  it('publishes restore-time session snapshots to the app shell', async () => {
    const liveSessions = [
      { sessionId: 'Gamma-9', cwd: '/tmp/gamma', alive: true, wsAttached: true },
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

  it('renders the project name on its own row above the tab controls', async () => {
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
          json: async () => [],
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const view = render(
      <TerminalArea project={PROJECT} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />
    );

    const projectRow = view.getByTestId('terminal-project-row');
    const tabRow = view.getByTestId('terminal-tab-row');

    expect(projectRow.textContent).toContain(PROJECT.name);
    expect(tabRow.textContent).not.toContain(PROJECT.name);
    expect(projectRow.querySelector(`[title="Project: ${PROJECT.name}"]`)).toBeTruthy();
  });

  it('renders pane header status from backend execution state', async () => {
    const liveSessions = [
      {
        sessionId: 'Gamma-9',
        cwd: '/tmp/gamma',
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
      expect(view.getAllByText('Gamma-9').length).toBeGreaterThan(0);
    });

    const statusDot = view.getByTitle('Gamma-9: running (shell_without_prompt)');
    expect(statusDot.className).toContain('terminal-dot-busy');
    expect(view.getByText('Running')).toBeTruthy();
    expect(view.getByLabelText('Split right').getAttribute('title')).toContain('Split right');
    expect(view.getByLabelText('New terminal').getAttribute('title')).toContain('New terminal');
    expect(view.getByLabelText('Inspect terminal Gamma-9').getAttribute('title')).toBe('Inspect terminal Gamma-9');
    expect(view.getByLabelText('Mute status colors for Gamma-9').getAttribute('title')).toContain('Mute status colors for Gamma-9');
    expect(view.getByLabelText('Mute status colors for Gamma-9').getAttribute('title')).toContain('M');
    expect(view.getByLabelText('Clear terminal Gamma-9').getAttribute('title')).toContain('Clear terminal Gamma-9');
    expect(view.getByLabelText('Close pane Gamma-9').getAttribute('title')).toContain('Close pane Gamma-9');
  });

  it('lets a pane mute status colors without changing its status label', async () => {
    const liveSessions = [
      {
        sessionId: 'Gamma-9',
        cwd: '/tmp/gamma',
        alive: true,
        wsAttached: true,
        executionStatus: 'running',
        executionReason: 'shell_without_prompt',
      },
    ];
    const onToggleMutedStatusSession = vi.fn();

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
      <TerminalArea
        project={PROJECT}
        sessionStatus={liveSessions}
        onSessionStatusRefresh={onSessionStatusRefresh}
        mutedStatusSessionIds={new Set(['Gamma-9'])}
        onToggleMutedStatusSession={onToggleMutedStatusSession}
      />
    );

    await waitFor(() => {
      expect(view.getAllByText('Gamma-9').length).toBeGreaterThan(0);
    });

    const statusDot = view.getByTitle('Gamma-9: running (shell_without_prompt) (status colors muted)');
    expect(statusDot.className).not.toContain('terminal-dot-busy');
    expect(view.getByText('Running')).toBeTruthy();
    const showStatusColorsButton = view.getByLabelText('Show status colors for Gamma-9');
    expect(showStatusColorsButton.getAttribute('title')).toContain('Show status colors for Gamma-9');
    expect(showStatusColorsButton.getAttribute('title')).toContain('M');
    expect(showStatusColorsButton.style.color).toBe('var(--text-muted)');
    expect(showStatusColorsButton.style.background).toBe('rgba(154, 165, 184, 0.12)');
    await waitFor(() => {
      expect(view.container.querySelector('[data-status-muted="true"] > div').style.border).toContain('rgba(154, 165, 184, 0.28)');
    });

    fireEvent.click(showStatusColorsButton);
    expect(onToggleMutedStatusSession).toHaveBeenCalledWith('Gamma-9');
  });

  it('toggles the active pane status colors from the keyboard shortcut', async () => {
    const liveSessions = [
      {
        sessionId: 'Gamma-9',
        cwd: '/tmp/gamma',
        alive: true,
        wsAttached: true,
        executionStatus: 'running',
      },
    ];
    const onToggleMutedStatusSession = vi.fn();

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
      <TerminalArea
        project={PROJECT}
        sessionStatus={liveSessions}
        onSessionStatusRefresh={onSessionStatusRefresh}
        onToggleMutedStatusSession={onToggleMutedStatusSession}
      />
    );

    await waitFor(() => {
      expect(view.getAllByText('Gamma-9').length).toBeGreaterThan(0);
    });

    fireEvent.mouseDown(view.container.querySelector('.pane-wrapper'));
    fireEvent.keyDown(window, { key: 'M', ctrlKey: true, shiftKey: true });

    expect(onToggleMutedStatusSession).toHaveBeenCalledWith('Gamma-9');
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
          json: async () => ({ sessionId: 'Gamma-12' }),
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
      expect(view.getAllByText('Gamma-12').length).toBeGreaterThan(0);
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
      { sessionId: 'Gamma-9', cwd: '/tmp/gamma', alive: true, wsAttached: true },
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
      expect(view.getAllByText('Gamma-9').length).toBeGreaterThan(0);
    });
  });

  it('lets the user manually re-measure a pane layout from the header', async () => {
    let liveSessions = [
      { sessionId: 'Gamma-9', cwd: '/tmp/gamma', alive: true, wsAttached: true },
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
      expect(view.getAllByText('Gamma-9').length).toBeGreaterThan(0);
    });

    fireEvent.click(view.container.querySelector('[title="Re-measure terminal layout"]'));

    expect(mocks.terminalApis.get('Gamma-9')?.redraw).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith({ type: 'success', message: 'Re-measuring terminal layout...' });
  });

  it('persists an empty layout immediately after closing the last terminal', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(SAVED_LAYOUT));

    let liveSessions = [
      { sessionId: 'Gamma-9', cwd: '/tmp/gamma', alive: true, wsAttached: true },
    ];

    global.fetch = vi.fn(async (url, options = {}) => {
      if (url === '/api/sessions') {
        return {
          ok: true,
          json: async () => liveSessions,
        };
      }

      if (url === '/api/terminal/Gamma-9' && options.method === 'DELETE') {
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
      expect(firstView.getAllByText('Gamma-9').length).toBeGreaterThan(0);
    });

    fireEvent.click(firstView.container.querySelector('.pane-close-btn'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/terminal/Gamma-9', { method: 'DELETE' });
    });

    expect(localStorage.getItem(LAYOUT_KEY)).toBe(JSON.stringify({
      tabs: [],
      activeTabId: null,
      tabCounter: 4,
      sessionCounter: 9,
    }));
  });
});
