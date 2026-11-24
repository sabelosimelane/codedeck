import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('lucide-react', () => {
  const Icon = () => null;
  return { ArrowDown: Icon, ArrowUp: Icon, Copy: Icon, Pencil: Icon, Plus: Icon, Trash2: Icon, Upload: Icon };
});

import WorkflowList from '../WorkflowList';

const STAMPS = { createdAt: '2026-11-24T13:00:00.000Z', updatedAt: '2026-11-24T13:00:00.000Z' };
const localSource = () => ({ kind: 'local', id: null, version: null, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null });
const builtinSource = (patch = {}) => ({
  kind: 'builtin', id: 'bug-fix', version: 1, latestVersion: 1,
  updateAvailable: false, updatedToVersionAt: null, shipped: true, ...patch,
});

const workflow = (patch = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', name: 'Bug fix', kind: 'bugfix', description: 'Fix things.',
  agentsDecide: false, progressFile: null, revision: 1, source: localSource(), ...STAMPS,
  nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
  ...patch,
});

const builtinRow = (patch = {}) => ({
  id: 'bug-fix', name: 'Bug fix', kind: 'bugfix', description: 'Fix things.', version: 1,
  status: 'new', workflowId: null, ...patch,
});

const builtinReceipt = () => ({
  id: '33333333-3333-4333-8333-333333333333', name: 'Bug fix', kind: 'bugfix', description: 'Investigate, agree on a fix, build, review, test and commit.',
  agentsDecide: false, progressFile: null, revision: 1, source: builtinSource(), ...STAMPS,
  nodes: [{ name: 'Clarify', role: 'Investigator', prompt: 'Read', repeat: { mode: 'once' }, readOnly: true, approval: false, askOwner: true }],
});

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });
const emptyPage = () => jsonResponse({ data: [], page: { hasNextPage: false } });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); toast.mockClear(); });

function stubFetch(handler) {
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => handler(String(url), options)));
}

function renderList({ workflows = [], builtIns = [builtinRow()] } = {}) {
  stubFetch(async (url, options = {}) => {
    if (url.includes('/builtin-workflows') && (options.method ?? 'GET') === 'GET') {
      return jsonResponse({ data: builtIns, page: { hasNextPage: false } });
    }
    throw new Error(`unexpected request ${options.method ?? 'GET'} ${url}`);
  });
  const onChanged = vi.fn(async () => {});
  const onDirtyChange = vi.fn();
  render(<WorkflowList workflows={workflows} agents={[]} templates={[]} stepPresets={[]} variant="form" onChanged={onChanged} onDirtyChange={onDirtyChange} />);
  return { onChanged };
}

describe('new built-in workflows', () => {
  it('lists each new built-in with Add and Dismiss, and hides the section when none is new', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText(/new built-in workflow: bug fix/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /add built-in workflow bug fix/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /dismiss built-in bug fix/i })).toBeTruthy();
    cleanup();
    renderList({ builtIns: [builtinRow({ status: 'linked', workflowId: '33333333-3333-4333-8333-333333333333' })] });
    await waitFor(() => expect(screen.queryByText(/new built-in workflow/i)).toBeNull());
  });

  it('adds a new built-in and toasts success', async () => {
    let added = false;
    stubFetch(async (url, options = {}) => {
      if (url.includes('/builtin-workflows') && (options.method ?? 'GET') === 'GET') {
        return jsonResponse({ data: added ? [] : [builtinRow()], page: { hasNextPage: false } });
      }
      if (url.endsWith('/builtin-workflows/bug-fix/additions')) {
        expect(options.method).toBe('POST');
        added = true;
        return jsonResponse(builtinReceipt(), { status: 201 });
      }
      throw new Error(`unexpected request ${options.method ?? 'GET'} ${url}`);
    });
    const onChanged = vi.fn(async () => {});
    render(<WorkflowList workflows={[]} agents={[]} templates={[]} stepPresets={[]} variant="form" onChanged={onChanged} onDirtyChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /add built-in workflow bug fix/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /add built-in workflow bug fix/i }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /add built-in workflow bug fix/i })).toBeNull());
  });

  it('adds an unlinked copy with its toast when the built-in is already linked', async () => {
    const calls = [];
    stubFetch(async (url, options = {}) => {
      calls.push({ url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined });
      if (url.includes('/builtin-workflows') && (options.method ?? 'GET') === 'GET') {
        return jsonResponse({ data: [], page: { hasNextPage: false } });
      }
      if (url.endsWith('/workflows')) {
        return jsonResponse({ ...workflow({ id: '44444444-4444-4444-8444-444444444444', name: 'Bug fix 2' }), source: localSource() }, { status: 201 });
      }
      throw new Error(`unexpected request ${options.method ?? 'GET'} ${url}`);
    });
    const onChanged = vi.fn(async () => {});
    render(<WorkflowList workflows={[workflow({ source: builtinSource() })]} agents={[]} templates={[]} stepPresets={[]} variant="form" onChanged={onChanged} onDirtyChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add workflow/i }));
    fireEvent.click(screen.getByRole('button', { name: /bug fix.*investigate/i }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Added as a copy: Bug fix is already linked to the built-in.' });
    const copy = calls.find(call => call.url.endsWith('/workflows'));
    expect(copy.body.name).toBe('Bug fix 2');
  });

  it('dismisses a new built-in and toasts success', async () => {
    let dismissed = false;
    stubFetch(async (url, options = {}) => {
      if (url.includes('/builtin-workflows') && (options.method ?? 'GET') === 'GET') {
        return jsonResponse({ data: dismissed ? [] : [builtinRow()], page: { hasNextPage: false } });
      }
      if (url.endsWith('/builtin-workflows/bug-fix/dismissals')) {
        expect(options.method).toBe('POST');
        dismissed = true;
        return { ok: true, status: 204, json: async () => ({}) };
      }
      throw new Error(`unexpected request ${options.method ?? 'GET'} ${url}`);
    });
    const onChanged = vi.fn(async () => {});
    render(<WorkflowList workflows={[]} agents={[]} templates={[]} stepPresets={[]} variant="form" onChanged={onChanged} onDirtyChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /dismiss built-in bug fix/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /dismiss built-in bug fix/i }));
    await waitFor(() => expect(screen.queryByText(/new built-in workflow/i)).toBeNull());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
});

describe('built-in badges', () => {
  it('marks an updated workflow and one whose built-in no longer ships', async () => {
    renderList({ workflows: [
      workflow({ source: builtinSource({ version: 2, latestVersion: 2, updatedToVersionAt: '2026-11-24T13:05:52.000Z' }) }),
      workflow({ id: '55555555-5555-4555-8555-555555555555', name: 'Retired', source: builtinSource({ id: 'retired-thing', version: 3, latestVersion: null, shipped: false }) }),
    ], builtIns: [] });
    await waitFor(() => expect(screen.getByText('Updated to version 2')).toBeTruthy());
    expect(screen.getByText('Built-in no longer shipped')).toBeTruthy();
  });
});
