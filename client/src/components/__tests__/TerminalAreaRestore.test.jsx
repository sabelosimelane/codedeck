import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    Plus: Icon,
    X: Icon,
    Columns: Icon,
    Eraser: Icon,
    Bug: Icon,
    TerminalSquare: Icon,
  };
});

vi.mock('../Terminal', () => ({
  default: React.forwardRef(function MockTerminal(_props, _ref) {
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

  beforeEach(() => {
    originalFetch = global.fetch;
    mocks.showToast.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('preserves the saved layout when /api/sessions fails during restore', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(SAVED_LAYOUT));
    global.fetch = vi.fn().mockRejectedValue(new Error('backend unavailable'));

    render(<TerminalArea project={PROJECT} sessionStatus={[]} />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/sessions');
    });

    await waitFor(() => {
      expect(localStorage.getItem(LAYOUT_KEY)).toBe(JSON.stringify(SAVED_LAYOUT));
    });
  });
});
