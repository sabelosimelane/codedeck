import React from 'react';
import { afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Improvements from '../Improvements';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('opens the records counted by a card and shows unavailable historical time', async () => {
  const id = '6d079853-3e6a-474e-a094-2ff23cf81ea3',
    workflowId = '88c09e87-e36c-4e50-9f39-461b9b15783a';
  const at = new Date().toISOString();
  const row = {
    id,
    workflowId,
    name: 'Bug fix',
    revision: 2,
    project: 'Demo',
    at,
    createdAt: at,
    status: 'complete',
    flags: ['proofGap'],
    activeMs: null,
    waitMs: null,
    elapsedMs: 300,
    launches: 1,
    loops: 1,
    finalNote: true,
    workload: null,
    steps: [{ name: 'Verify', elapsedMs: 300, activeMs: null, launches: 1, loops: 1 }],
    signals: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => ({
      ok: true,
      json: async () =>
        String(url).includes('/status')
          ? {
              configured: true,
              dailyBudget: 10,
              modelRevision: 0,
              model: 'test',
              provider: 'codex',
              effort: null,
              reviewerRevision: 1,
              queued: 0,
            }
          : { data: String(url).includes('/outcomes') ? [row] : [], page: { hasNextPage: false } },
    })),
  );
  render(<Improvements workflows={[{ id: workflowId, name: 'Bug fix', revision: 2 }]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Flagged proof gaps/i }));
  expect(await screen.findByText(/Demo · Bug fix/)).toBeTruthy();
  expect(screen.getAllByText(/Unavailable/i).length).toBeGreaterThan(0);
});
it('saves a dedicated reviewer model through the revision-fenced API', async () => {
  const fetch = vi.fn(async (url, opts) => ({
    ok: true,
    json: async () =>
      String(url).includes('/status')
        ? {
            configured: true,
            provider: 'codex',
            model: 'old',
            effort: 'low',
            modelRevision: 4,
            reviewerRevision: 1,
            dailyBudget: 10,
            queued: 0,
          }
        : opts?.method
          ? {}
          : { data: [], page: { hasNextPage: false } },
  }));
  vi.stubGlobal('fetch', fetch);
  render(<Improvements workflows={[]} />);
  fireEvent.click(await screen.findByText('Reviewer model'));
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'new-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save reviewer model' }));
  expect(
    fetch.mock.calls.some(
      ([url, opts]) =>
        url.endsWith('/improvements/model') && opts.method === 'PUT' && JSON.parse(opts.body).revision === 4,
    ),
  ).toBe(true);
});

function renderPendingProposal(currentRevision, kind = 'workflow') {
  const workflowId = '88c09e87-e36c-4e50-9f39-461b9b15783a';
  const proposal = {
    id: '6d079853-3e6a-474e-a094-2ff23cf81ea3', workflowId, revision: 2,
    reviewerRevision: 1, at: new Date().toISOString(), status: 'pending',
    reason: null, effectiveAt: null, effectiveRevision: null, evaluation: null, result: null,
    draft: {
      kind, title: 'Update Clarify', reason: 'Check the spec', citations: [workflowId],
      change: 'Read the spec first', step: kind === 'workflow' ? 'Clarify' : null, test: 'Replay the run',
      counterevidence: 'The owner clarified', metric: 'loops', safeguard: 'proofGaps',
    },
  };
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    if (opts?.method === 'POST') {
      return { ok: false, status: 409, json: async () => ({ message: 'Workflow revision changed. Review fresh evidence.' }) };
    }
    const body = url.endsWith('/status')
      ? { configured: true, provider: 'codex', model: 'test', effort: null, modelRevision: 1, reviewerRevision: 1, dailyBudget: 10, queued: 0 }
      : { data: url.includes('/proposals') ? [proposal] : [], page: { hasNextPage: false } };
    return { ok: true, json: async () => body };
  }));
  render(<Improvements workflows={[{ id: workflowId, name: 'Troubleshoot', revision: currentRevision }]} />);
}

it('explains a stale revision beside the disabled approval and allows dismissal', async () => {
  renderPendingProposal(3);
  const approve = await screen.findByRole('button', { name: 'Approve workflow edit' });
  expect(approve.disabled).toBe(true);
  expect(approve.closest('article').textContent).toMatch(/revision 3/i);
  fireEvent.change(screen.getByRole('textbox', { name: 'Dismissal reason' }), { target: { value: 'Superseded' } });
  expect(screen.getByRole('button', { name: 'Dismiss' }).disabled).toBe(false);
});

it('keeps runner proposals enabled even when the workflow has moved to a newer revision', async () => {
  renderPendingProposal(4, 'runner');
  const approve = await screen.findByRole('button', { name: 'Approve proposal' });
  expect(approve.disabled).toBe(false);
});

it('shows a server rejection on the proposal when the workflow changes after loading', async () => {
  renderPendingProposal(2);
  const approve = await screen.findByRole('button', { name: 'Approve workflow edit' });
  fireEvent.click(approve);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Workflow revision changed. Review fresh evidence.');
  expect(approve.closest('article').contains(alert)).toBe(true);
});
