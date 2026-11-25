import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { changeRunTeam, listAgents, listTeams } = vi.hoisted(() => ({
  changeRunTeam: vi.fn(async () => ({})),
  listAgents: vi.fn(async () => [{
    id: '11111111-1111-4111-8111-111111111111', name: 'Codex', launchCommand: 'command codex --model gpt-6-sol',
    resetCommand: '/clear', revision: 1, createdAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z',
  }]),
  listTeams: vi.fn(async () => []),
}));
vi.mock('../../../utils/pipelinesApi', async importOriginal => ({ ...await importOriginal(), changeRunTeam, listAgents, listTeams }));
import ChangeRunTeam from '../ChangeRunTeam';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('sends a step override with its selected effort', async () => {
  const run = { id: '22222222-2222-4222-8222-222222222222', updatedAt: '2026-11-25T09:00:00.000Z', currentStepIndex: 0,
    steps: [{ index: 0, kind: 'node', name: 'Develop', role: 'Developer', repeat: { mode: 'once' }, nextAgentName: 'Old' }] };
  render(<ChangeRunTeam run={run} />);
  fireEvent.click(screen.getByRole('button', { name: 'Change team' }));
  await screen.findByLabelText('Develop agent');
  fireEvent.change(screen.getByLabelText('Develop agent'), { target: { value: '11111111-1111-4111-8111-111111111111' } });
  fireEvent.change(screen.getByLabelText('Develop effort'), { target: { value: 'high' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply to run' }));
  await waitFor(() => expect(changeRunTeam).toHaveBeenCalledWith(run.id, {
    expectedUpdatedAt: run.updatedAt,
    stepOverrides: { Develop: { agentId: '11111111-1111-4111-8111-111111111111', effort: 'high' } },
  }));
});
