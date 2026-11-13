import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
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
    Hourglass: Icon,
    Search: Icon,
    Pencil: Icon,
    Play: Icon,
  };
});

vi.mock('../../Terminal', () => ({
  default: React.forwardRef(function MockTerminal(props, ref) {
    const api = React.useMemo(() => ({
      clear: vi.fn(),
      redraw: vi.fn(),
      focus: vi.fn(),
      claimControl: vi.fn(),
    }), []);
    React.useImperativeHandle(ref, () => api, [api]);
    mocks.terminalApis.set(props.sessionId, api);
    return null;
  }),
}));

vi.mock('../../PaneDivider', () => ({ default: () => null }));
vi.mock('../../TerminalInspector', () => ({ default: () => null }));
vi.mock('../../ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

import TerminalArea from '../../TerminalArea';

const PROJECT = { name: 'Gamma', path: '/tmp/gamma' };

describe('TerminalAreaAdoption', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mocks.showToast.mockReset();
    mocks.terminalApis = new Map();
    localStorage.clear();
    global.fetch = vi.fn(async (url) => ({
      ok: true,
      json: async () => (url === '/api/health' ? { terminalCreationAllowed: true } : []),
    }));
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('adopts multiple sessions in one update and activates only the flagged session', async () => {
    const onSessionsAdopted = vi.fn();
    const view = render(
      <TerminalArea
        project={PROJECT}
        sessionStatus={[
          { sessionId: 'Gamma-1', cwd: '/tmp/gamma', alive: true },
          { sessionId: 'Gamma-2', cwd: '/tmp/gamma', alive: true },
        ]}
        adoptSessions={[
          { sessionId: 'Gamma-1', activate: false },
          { sessionId: 'Gamma-2', activate: true },
        ]}
        onSessionsAdopted={onSessionsAdopted}
      />,
    );

    await waitFor(() => expect(onSessionsAdopted).toHaveBeenCalled());
    const tabs = view.getAllByTestId('terminal-tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[1].getAttribute('data-active')).toBe('true');
    expect(global.fetch.mock.calls.some(([url]) => url === '/api/terminal')).toBe(false);
  });

  it('activates an existing tab without creating a duplicate', async () => {
    localStorage.setItem(`codedeck-layout-${PROJECT.name}`, JSON.stringify({
      tabs: [{
        id: 'tab-1',
        label: 'Gamma-9',
        panes: [{ id: 'pane-Gamma-9', sessionId: 'Gamma-9', widthFraction: 1, isConnected: true }],
      }],
      activeTabId: 'tab-1',
      tabCounter: 1,
      sessionCounter: 9,
    }));
    const onSessionsAdopted = vi.fn();
    const view = render(
      <TerminalArea
        project={PROJECT}
        sessionStatus={[{ sessionId: 'Gamma-9', cwd: '/tmp/gamma', alive: true }]}
        adoptSessions={[{ sessionId: 'Gamma-9', activate: true }]}
        onSessionsAdopted={onSessionsAdopted}
      />,
    );

    await waitFor(() => expect(onSessionsAdopted).toHaveBeenCalled());
    expect(view.getAllByTestId('terminal-tab')).toHaveLength(1);
    expect(view.getByTestId('terminal-tab').getAttribute('data-active')).toBe('true');
  });
});
