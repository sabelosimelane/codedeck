import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('lucide-react', () => {
  const Icon = () => null;
  return { X: Icon, Play: Icon };
});

import RoleList from '../RoleList';
import TeamList from '../TeamList';
import RunWorkflowDialog from '../RunWorkflowDialog';

const TIMEOUTS = { agentReadySeconds: 120, resetSettleSeconds: 15, finalSignalIdleSeconds: 24, lostPromptSeconds: 30, stallWarningMinutes: 15 };

const STAMPS = { revision: 1, createdAt: '2026-11-24T11:00:00.000Z', updatedAt: '2026-11-24T11:00:00.000Z' };
const LOCAL = { kind: 'local', id: null, version: null, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null };
const HEAD = 'a'.repeat(40);

const AGENTS = [
  { ...STAMPS, id: '11111111-1111-4111-8111-111111111111', name: 'Claude', launchCommand: 'claude', resetCommand: '/clear' },
  { ...STAMPS, id: '11111111-1111-4111-8111-111111111112', name: 'Codex', launchCommand: 'codex', resetCommand: '/clear' },
];
const ROLES = ['Thinking partner', 'Planner', 'Committer'].map((name, i) => ({
  ...STAMPS, id: `22222222-2222-4222-8222-22222222222${i}`, name, description: `${name} role`,
}));
const BRAINSTORM = {
  ...STAMPS,
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Brainstorm to spec',
  kind: 'build',
  description: 'Talk an idea through.',
  agentsDecide: false,
  progressFile: null,
  source: LOCAL,
  nodes: [
    { name: 'Brainstorm', role: 'Thinking partner', prompt: 'Talk {input}', repeat: { mode: 'once' }, readOnly: true, approval: false, askOwner: true },
    { name: 'Specify', role: 'Planner', prompt: 'Specify {input}', repeat: { mode: 'once' }, readOnly: false, approval: true, askOwner: false },
    { name: 'Commit', role: 'Committer', prompt: 'Commit {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
  ],
};
const DEV_TEAM = {
  ...STAMPS,
  id: '44444444-4444-4444-8444-444444444441',
  name: 'Dev Team',
  members: [
    { role: 'Planner', agentId: AGENTS[0].id },
    { role: 'Committer', agentId: AGENTS[1].id },
  ],
};
const FULL_TEAM = {
  ...STAMPS,
  id: '44444444-4444-4444-8444-444444444442',
  name: 'Full Team',
  members: [
    { role: 'Thinking partner', agentId: AGENTS[0].id },
    { role: 'Planner', agentId: AGENTS[0].id },
    { role: 'Committer', agentId: AGENTS[1].id },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.mockReset();
});

describe('RoleList and TeamList structured roles', () => {
  it('disables Delete on a role that is used by a workflow or team', () => {
    render(
      <RoleList
        definitions={{ roles: ROLES, workflows: [BRAINSTORM], teams: [DEV_TEAM], templates: [], stepPresets: [] }}
        onChanged={vi.fn()}
        onDirtyChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Delete role Thinking partner' }).disabled).toBe(true);
    expect(screen.getAllByText(/Used by 1 workflow · 1 team/).length).toBe(2);
  });

  it('shows workflow coverage and missing roles on TeamList', () => {
    render(
      <TeamList
        definitions={{ teams: [DEV_TEAM, FULL_TEAM], agents: AGENTS, workflows: [BRAINSTORM], roles: ROLES }}
        onChanged={vi.fn()}
        onDirtyChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Needs roles for: Brainstorm to spec \(missing: Thinking partner\)/)).toBeTruthy();
    expect(screen.getByText(/Covers all 1 workflow/)).toBeTruthy();
  });
});

describe('RunWorkflowDialog team role compatibility', () => {
  function mockDialogApi(teams) {
    global.fetch = vi.fn(async (url) => {
      const target = String(url);
      const json = body => ({ ok: true, status: 200, json: async () => body });
      if (target.endsWith('/pipelines/settings')) return json({ setupAgentId: AGENTS[0].id, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1 });
      if (target.includes('/agents')) return json({ data: AGENTS, page: { hasNextPage: false } });
      if (target.includes('/teams')) return json({ data: teams, page: { hasNextPage: false } });
      if (target.includes('/workflows')) return json({ data: [BRAINSTORM], page: { hasNextPage: false } });
      if (target.includes('/preflight')) return json({ project: 'Demo', eligible: true, reasons: [], dirty: false, branch: 'main', head: HEAD });
      if (target.includes('/tasks/worktree-candidates')) return json({ data: [], page: { currentPage: 0, size: 100, totalElements: 0, totalPages: 0, hasNextPage: false } });
      if (target.includes('/worktrees')) return json({ data: [{ path: '/git/demo', name: 'demo', branch: 'main', head: HEAD, current: true, dirty: false, selectable: true, reason: null }], page: { hasNextPage: false } });
      throw new Error(`unexpected request ${target}`);
    });
  }

  it('blocks Start when no team covers Thinking partner, then unlocks when Brainstorm step is disabled', async () => {
    mockDialogApi([DEV_TEAM]);
    const onStart = vi.fn(async () => ({ id: 'r1' }));
    render(<RunWorkflowDialog projectName="Demo" tasks={[]} onClose={vi.fn()} onStart={onStart} />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Team' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Workflow assignments' })).toBeNull();
    expect(screen.getByRole('option', { name: /Dev Team — missing: Thinking partner/ }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'New idea' } });
    expect(screen.getByRole('button', { name: 'Start' }).disabled).toBe(true);

    // Disabling Brainstorm leaves only Planner + Committer, which Dev Team covers!
    fireEvent.click(screen.getByRole('checkbox', { name: 'Run Brainstorm' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Team' }).value).toBe(DEV_TEAM.id));
    expect(screen.getByRole('button', { name: 'Start' }).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      teamId: DEV_TEAM.id,
      disabledSteps: ['Brainstorm'],
    })));
  });

  it('auto-selects a compatible team and allows per-step agent overrides', async () => {
    mockDialogApi([DEV_TEAM, FULL_TEAM]);
    const onStart = vi.fn(async () => ({ id: 'r2' }));
    render(<RunWorkflowDialog projectName="Demo" tasks={[]} onClose={vi.fn()} onStart={onStart} />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Team' }).value).toBe(FULL_TEAM.id));
    expect(screen.getByRole('option', { name: /Dev Team — missing: Thinking partner/ }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'New idea' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Specify agent' }), { target: { value: AGENTS[1].id } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      teamId: FULL_TEAM.id,
      stepOverrides: { Specify: AGENTS[1].id },
    })));
  });
});
