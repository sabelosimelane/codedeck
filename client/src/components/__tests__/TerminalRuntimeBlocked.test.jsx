import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import TerminalArea from '../TerminalArea.jsx';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('../Terminal', () => ({
  default: () => null,
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

describe('TerminalArea tmux-required runtime gate', () => {
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

  it('shows the install-tmux prompt, disables terminal creation, and toasts on shortcut attempts', async () => {
    const onSessionStatusRefresh = vi.fn();

    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            status: 'degraded',
            terminalRuntime: 'tmux',
            terminalRuntimeContract: 'tmux_required',
            tmuxAvailable: false,
            terminalCreationAllowed: false,
            terminalRuntimeBlockedReason: 'missing_tmux',
            terminalRuntimeBlockedMessage: 'Install tmux to enable durable CodeDeck terminals.',
          }),
        });
      }

      if (url === '/api/sessions') {
        return Promise.resolve({
          ok: true,
          json: async () => [],
        });
      }

      if (url === '/api/terminal') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'BookMe-1' }),
        });
      }

      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    render(
      <TerminalArea
        project={{ name: 'BookMe', path: '/tmp/bookme' }}
        sessionStatus={[]}
        onSessionStatusRefresh={onSessionStatusRefresh}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('tmux required')).toBeTruthy();
    });

    expect(screen.getByText(/install tmux to enable durable codedeck terminals/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New terminal' }).disabled).toBe(true);
    expect(onSessionStatusRefresh).toHaveBeenCalledWith([]);

    fireEvent.keyDown(window, { key: 't', ctrlKey: true, shiftKey: true });

    expect(mocks.showToast).toHaveBeenCalledWith({
      type: 'error',
      message: 'Install tmux to enable durable CodeDeck terminals.',
    });
    expect(global.fetch).not.toHaveBeenCalledWith('/api/terminal', expect.anything());
  });
});
