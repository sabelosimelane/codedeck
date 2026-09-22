import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import TerminalArea from '../TerminalArea.jsx';

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('../Terminal', () => ({ default: () => null }));
vi.mock('../PaneDivider', () => ({ default: () => null }));
vi.mock('../TerminalInspector', () => ({ default: () => null }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));

const liveSession = sessionId => ({
  sessionId,
  cwd: '/tmp/gamma',
  alive: true,
  executionStatus: 'running',
  lastOutputAt: new Date().toISOString(),
});

const sessions = ['Gamma-1', 'Gamma-2', 'Gamma-3'].map(liveSession);

function mockFetch() {
  global.fetch = vi.fn((url) => {
    if (url === '/api/health') return Promise.resolve({ ok: true, json: async () => ({ terminalCreationAllowed: true }) });
    if (url === '/api/sessions') return Promise.resolve({ ok: true, json: async () => sessions });
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

async function renderArea(props = {}) {
  const view = render(
    <TerminalArea
      project={{ name: 'Gamma', path: '/tmp/gamma' }}
      sessionStatus={sessions}
      onSessionStatusRefresh={() => {}}
      {...props}
    />
  );
  await waitFor(() => expect(screen.getAllByTestId('terminal-tab').length).toBe(3));
  return view;
}

const tabKeys = () => screen.getAllByTestId('terminal-tab').map(tab => tab.dataset.sessionId);
const tabByKey = sessionId => screen.getAllByTestId('terminal-tab').find(tab => tab.dataset.sessionId === sessionId);

describe('TerminalArea waiting tabs', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mocks.showToast.mockReset();
    localStorage.clear();
    mockFetch();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('leaves tab order and size untouched when nothing is waiting', async () => {
    await renderArea({ waitingSessionIds: new Set() });
    expect(tabKeys()).toEqual(['Gamma-1', 'Gamma-2', 'Gamma-3']);
    expect(tabByKey('Gamma-1').dataset.waiting).toBe('false');
  });

  it('groups waiting tabs to the left and marks them compact', async () => {
    await renderArea({ waitingSessionIds: new Set(['Gamma-3']) });
    expect(tabKeys()).toEqual(['Gamma-3', 'Gamma-1', 'Gamma-2']);

    const waitingTab = tabByKey('Gamma-3');
    expect(waitingTab.dataset.waiting).toBe('true');
    expect(waitingTab.getAttribute('title')).toMatch(/waiting/i);

    const waitingLabel = waitingTab.querySelector('[data-testid="terminal-tab-label"]');
    const activeLabel = tabByKey('Gamma-1').querySelector('[data-testid="terminal-tab-label"]');
    expect(parseInt(waitingLabel.style.maxWidth, 10)).toBeLessThan(parseInt(activeLabel.style.maxWidth, 10));
  });

  it('swaps the status dot for a waiting toggle that clears the mark', async () => {
    const onToggleWaiting = vi.fn();
    await renderArea({ waitingSessionIds: new Set(['Gamma-2']), onToggleWaiting });

    const toggle = screen.getByRole('button', { name: 'Clear waiting for Gamma-2' });
    fireEvent.click(toggle);
    expect(onToggleWaiting).toHaveBeenCalledWith('Gamma-2');
  });

  it('marks a tab waiting from its status dot without switching to it', async () => {
    const onToggleWaiting = vi.fn();
    await renderArea({ waitingSessionIds: new Set(), onToggleWaiting });

    fireEvent.click(screen.getByRole('button', { name: 'Mark Gamma-1 waiting' }));
    expect(onToggleWaiting).toHaveBeenCalledWith('Gamma-1');
    expect(tabByKey('Gamma-3').dataset.active).toBe('true');
  });

  it('toggles waiting for the active tab with Cmd/Ctrl+Shift+U', async () => {
    const onToggleWaiting = vi.fn();
    await renderArea({ waitingSessionIds: new Set(), onToggleWaiting });

    fireEvent.keyDown(window, { key: 'u', ctrlKey: true, shiftKey: true });
    expect(onToggleWaiting).toHaveBeenCalledWith('Gamma-3');
  });

  it('ignores the waiting shortcut when Alt is held', async () => {
    const onToggleWaiting = vi.fn();
    await renderArea({ waitingSessionIds: new Set(), onToggleWaiting });

    fireEvent.keyDown(window, { key: 'u', altKey: true, ctrlKey: true, shiftKey: true });
    expect(onToggleWaiting).not.toHaveBeenCalled();
  });

  it('clears the waiting mark once the delegated work finishes', async () => {
    const onClearWaiting = vi.fn();
    const { rerender } = await renderArea({ waitingSessionIds: new Set(['Gamma-2']), onClearWaiting });
    expect(onClearWaiting).not.toHaveBeenCalled();

    rerender(
      <TerminalArea
        project={{ name: 'Gamma', path: '/tmp/gamma' }}
        sessionStatus={sessions}
        onSessionStatusRefresh={() => {}}
        waitingSessionIds={new Set(['Gamma-2'])}
        finishedSessionIds={new Set(['Gamma-2'])}
        onClearWaiting={onClearWaiting}
      />
    );

    await waitFor(() => expect(onClearWaiting).toHaveBeenCalledWith(['Gamma-2']));
  });
});
