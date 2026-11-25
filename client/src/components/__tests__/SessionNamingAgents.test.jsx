import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SessionNamingSettings from '../SessionNamingSettings';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast }) }));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const agent = (id, name, launchCommand) => ({ id, name, launchCommand, resetCommand: '/clear', revision: 1, createdAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z' });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('lists defined agents, disables custom commands, and saves agent and effort only', async () => {
  let saved = { agentId: '', effort: null };
  const agents = [agent(A, 'Claude', 'command claude --model fable'), agent(B, 'Cursor', 'command agent --model auto'), agent(C, 'Custom', 'my-alias --model x')];
  const fetch = vi.fn(async (url, options) => {
    if (url.startsWith('/api/pipelines/agents?')) return { ok: true, json: async () => ({ data: agents, page: { hasNextPage: false } }) };
    if (url === '/api/session-naming/settings') {
      if (options?.method === 'PUT') saved = JSON.parse(options.body);
      return { ok: true, json: async () => saved };
    }
    throw new Error(url);
  }); vi.stubGlobal('fetch', fetch);
  render(<SessionNamingSettings />);
  await waitFor(() => expect(screen.getByRole('option', { name: 'Claude' })).toBeTruthy());
  expect(screen.getByRole('option', { name: /Custom.*custom command/i }).disabled).toBe(true);
  expect(screen.queryByLabelText('Naming model')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add provider' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Naming agent'), { target: { value: A } });
  fireEvent.change(screen.getByLabelText('Naming effort'), { target: { value: 'high' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save naming settings' }));
  await waitFor(() => expect(saved).toEqual({ agentId: A, effort: 'high' }));
  expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Session naming settings saved' });
});

it('reloads available agents when the naming tab opens after an agent is added', async () => {
  let records = [agent(A, 'Claude', 'command claude --model fable')];
  vi.stubGlobal('fetch', vi.fn(async url => url.startsWith('/api/pipelines/agents?')
    ? { ok: true, json: async () => ({ data: records, page: { hasNextPage: false } }) }
    : { ok: true, json: async () => ({ agentId: '', effort: null }) }));
  const view = render(<SessionNamingSettings active={false} />);
  await screen.findByRole('option', { name: 'Claude' });
  records = [...records, agent(B, 'Cursor', 'command agent --model auto')];
  view.rerender(<SessionNamingSettings active />);
  expect(await screen.findByRole('option', { name: 'Cursor' })).toBeTruthy();
});
