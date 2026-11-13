import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import SessionSearch from '../SessionSearch';

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));

const alpha = { cli: 'claude', conversationId: 'a', title: 'Fix login', firstPrompt: 'Please fix login', project: 'Alpha', cwd: '/tmp/alpha', updatedAt: Date.now() };
const beta = { cli: 'codex', conversationId: 'b', title: null, firstPrompt: 'Inspect tests', project: 'Beta', cwd: '/tmp/beta', updatedAt: Date.now() - 60000 };
const result = (data = [alpha], hasNextPage = false, sources = []) => ({ data, page: { currentPage: 0, size: 25, totalElements: data.length, totalPages: hasNextPage ? 2 : 1, hasNextPage }, sources });
const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const project = { name: 'Alpha', path: '/tmp/alpha' };

function open(props = {}) {
  const onClose = vi.fn();
  const onResumed = vi.fn();
  const view = render(<SessionSearch project={project} onClose={onClose} onResumed={onResumed} {...props} />);
  return { ...view, onClose, onResumed };
}

beforeEach(() => { mocks.showToast.mockReset(); global.fetch = vi.fn(async () => response(result())); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Session search', () => {
  it('loads this project newest first, focuses search, and closes with Escape or overlay click', async () => {
    const view = open();
    expect(screen.getByRole('textbox', { name: 'Search conversations' })).toBe(document.activeElement);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('project=Alpha'), expect.anything()));
    expect(global.fetch.mock.calls[0][0]).toContain('sort=-updatedAt');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(view.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('session-search-overlay'));
    expect(view.onClose).toHaveBeenCalledTimes(2);
  });

  it('toggles all projects and filters by CLI', async () => {
    open();
    await screen.findByText('Fix login');
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    await waitFor(() => expect(global.fetch.mock.calls.at(-1)[0]).not.toContain('project='));
    fireEvent.change(screen.getByRole('combobox', { name: 'CLI' }), { target: { value: 'codex' } });
    await waitFor(() => expect(global.fetch.mock.calls.at(-1)[0]).toContain('cli=codex'));
  });

  it('debounces query and ignores a stale response', async () => {
    let resolveOld;
    global.fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(response(result([beta])));
    open();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'tests' } });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    await screen.findByText('“Inspect tests”');
    await act(async () => resolveOld(response(result([alpha]))));
    expect(screen.queryByText('Fix login')).toBeNull();
    expect(global.fetch.mock.calls.at(-1)[0]).toContain('q=tests');
  });

  it('loads one more page only when offered', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(response(result([alpha], true))).mockResolvedValueOnce(response(result([beta])));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('“Inspect tests”');
    expect(global.fetch.mock.calls[0][0]).toContain('page=0');
    expect(global.fetch.mock.calls[1][0]).toContain('page=1');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows loading, empty, API error, and unreachable states', async () => {
    let resolve;
    global.fetch = vi.fn(() => new Promise(r => { resolve = r; }));
    const view = open();
    expect(screen.getByText('Loading conversations…')).toBeTruthy();
    await act(async () => resolve(response(result([]))));
    expect(screen.getByText('No conversations found')).toBeTruthy();
    view.unmount();
    global.fetch = vi.fn(async () => response({ message: 'Bad search' }, false, 400));
    open();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Bad search');
    cleanup();
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    open();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Server unreachable');
  });

  it('shows unavailable CLIs, title and quoted first prompt with full hover text', async () => {
    global.fetch = vi.fn(async () => response(result([alpha, beta], false, [{ cli: 'cursor', available: false }, { cli: 'agy', available: false }])));
    open();
    await screen.findByText('Fix login');
    expect(screen.getByText('Fix login').getAttribute('title')).toBe('Fix login');
    expect(screen.getByText('“Inspect tests”').getAttribute('title')).toBe('Inspect tests');
    expect(screen.getByText(/Cursor.*Antigravity.*no history/i)).toBeTruthy();
  });

  it('shows remote-project message and permits all-projects search', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(response({ message: 'Session search covers local projects only' }, false, 409))
      .mockResolvedValue(response(result([beta])));
    open({ project: { name: 'Remote', path: '/remote', host: 'ssh' } });
    expect(await screen.findByText('Session search covers local projects only')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    await screen.findByText('“Inspect tests”');
  });

  it('moves highlight with arrows and resumes with Enter after backend confirmation', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(response(result([alpha, beta])))
      .mockResolvedValueOnce(response({ sessionId: 'Beta-9', project: 'Beta', cli: 'codex', conversationId: 'b' }, true, 201));
    const view = open();
    await screen.findByText('Fix login');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(view.onResumed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'Beta-9', project: 'Beta' })));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ cli: 'codex', conversationId: 'b', project: 'Beta' });
  });

  it('keeps modal open and shows API message on failed resume', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(response(result())).mockResolvedValueOnce(response({ message: 'Already resuming' }, false, 409));
    const view = open();
    fireEvent.click(await screen.findByRole('button', { name: /Fix login/ }));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Already resuming' }));
    expect(view.onClose).not.toHaveBeenCalled();
  });

  it('blocks second selection while resume is pending', async () => {
    let finish;
    global.fetch = vi.fn().mockResolvedValueOnce(response(result([alpha, beta])))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Fix login/ }));
    expect(screen.getByText('Resuming…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Inspect tests/ }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await act(async () => finish(response({ sessionId: 'Alpha-9', project: 'Alpha' }, true, 201)));
  });
});
