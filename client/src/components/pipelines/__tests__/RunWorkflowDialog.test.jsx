import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return { X: Icon, Play: Icon };
});

import RunWorkflowDialog from '../RunWorkflowDialog';

const workflows = [
  { id: '11111111-1111-1111-1111-111111111111', name: 'Feature' },
  { id: '22222222-2222-2222-2222-222222222222', name: 'Review' },
];

describe('RunWorkflowDialog', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/workflows')) {
        return {
          ok: true,
          json: async () => ({ data: workflows, page: { hasNextPage: false } }),
        };
      }
      if (String(url).includes('/preflight')) {
        return {
          ok: true,
          json: async () => ({
            project: 'Demo',
            eligible: true,
            reasons: [],
            dirty: false,
            branch: 'main',
            head: 'a'.repeat(40),
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('loads workflows and starts a run with the selected input', async () => {
    const onStart = vi.fn(async () => ({ id: 'r1' }));
    const onClose = vi.fn();
    render(<RunWorkflowDialog projectName="Demo" onClose={onClose} onStart={onStart} />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workflow' })).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow' }), {
      target: { value: workflows[0].id },
    });
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'ship the feature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(onStart).toHaveBeenCalledWith({
      workflowId: workflows[0].id,
      input: 'ship the feature',
      requestId: expect.stringMatching(/^[\w-]{1,128}$/),
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('blocks Start when preflight is ineligible and lists reasons', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/workflows')) {
        return { ok: true, json: async () => ({ data: workflows, page: { hasNextPage: false } }) };
      }
      return {
        ok: true,
        json: async () => ({
          project: 'Demo',
          eligible: false,
          reasons: [{ code: 'not_git_toplevel', message: 'Project path is not a git top-level working tree.' }],
          dirty: false,
          branch: null,
          head: null,
        }),
      };
    });

    render(<RunWorkflowDialog projectName="Demo" onClose={() => {}} onStart={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/not a git top-level/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Start' }).disabled).toBe(true);
  });

  it('warns about uncommitted changes without blocking Start', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/workflows')) {
        return { ok: true, json: async () => ({ data: workflows, page: { hasNextPage: false } }) };
      }
      return {
        ok: true,
        json: async () => ({
          project: 'Demo',
          eligible: true,
          reasons: [],
          dirty: true,
          branch: 'main',
          head: 'a'.repeat(40),
        }),
      };
    });

    render(<RunWorkflowDialog projectName="Demo" onClose={() => {}} onStart={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Uncommitted changes in this checkout will not be in the run's worktree/i)).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' }).disabled).toBe(false));
  });
});
