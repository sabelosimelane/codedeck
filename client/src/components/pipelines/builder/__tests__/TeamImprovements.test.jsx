import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Improvements from '../Improvements';
import { scoreTeam } from '../../../../../../shared/scoring/index.mjs';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const runId = '643ef345-2a6b-4a40-8ad6-6983197fffc0';
const observation = {
  id: runId,
  status: 'complete',
  mixed: false,
  activeMs: 9000,
  elapsedMs: 70000,
  criteria: [{ id: 'ac', text: 'The owner sees the new setting', verdict: 'met', evidenceRefs: ['note:1'] }],
  evidenceRefs: ['note:1'],
  steps: [{ role: 'Fix', activeMs: 9000 }],
};
const score = scoreTeam([observation]);
const teamId = '643ef345-2a6b-4a40-8ad6-6983197fffc1';
const trialId = '643ef345-2a6b-4a40-8ad6-6983197fffc2';
const card = {
  id: 'a'.repeat(64),
  configuration: [],
  teamId,
  name: 'Build team',
  teamRevision: 3,
  trialId: null,
  score,
};
const summary = {
  id: runId,
  at: '2026-11-19T01:00:00.000Z',
  teamId,
  teamName: 'Build team',
  teamRevision: 3,
  trialId: null,
  elapsedMs: 70000,
  project: 'Example',
  workflowName: 'Bug fix',
  status: 'complete',
  mixed: true,
  verdict: 'met',
  activeMs: 9000,
  cardId: card.id,
};
const assignments = [
  {
    stepIndex: 0,
    stepName: 'Fix',
    attempt: 1,
    role: 'Engineer',
    source: 'override',
    provider: 'codex',
    model: 'm1',
    effort: 'high',
    agentId: runId,
    agentRevision: 1,
    teamId: null,
    teamRevision: null,
    activeMs: 9000,
  },
];
const detail = {
  ...summary,
  request: 'Fix the broken setting',
  signature: 'b'.repeat(64),
  revision: 1,
  criteria: [
    {
      ...observation.criteria[0],
      source: 'request',
      proof: [{ source: 'note:1', check: 'Open the setting on device', quote: 'UI check passed' }],
    },
  ],
  sources: [
    { id: 'request', text: 'Fix the broken setting' },
    { id: 'note:1', text: 'Open the setting on device. UI check passed.' },
  ],
  attempts: assignments,
  configuration: assignments,
};
const trial = {
  id: trialId,
  teamId,
  at: summary.at,
  workflowId: runId,
  workflowRevision: 1,
  project: 'Example',
  workload: 'c'.repeat(64),
  staleReason: null,
  teamName: 'Build team',
  role: 'Fix',
  status: 'pending',
  revision: 1,
  teamRevision: 3,
  policyVersion: 1,
  goal: 'speed',
  from: { provider: 'codex', model: 'm1', effort: 'high' },
  to: { provider: 'codex', model: 'm1', effort: 'medium' },
  reason: 'Fix accounted for most active time',
  counterevidence: 'A harder case may need more effort',
  success: 'Improve speed without losing accuracy',
  baselineIds: [runId, ...['1100e100', '1100e101', '1100e102', '1100e103'].map((p) => p + runId.slice(8))],
  assignmentIds: [],
  stale: false,
  comparison: null,
  adoptedComparison: null,
};
const page = (data) => ({ data, page: { hasNextPage: false } });
function setup({ cards = [card], trials = [trial], failDecision = false, detailStatus = 'complete' } = {}) {
  let delivery = { ...detail, status: detailStatus };
  const fetch = vi.fn(async (url, options) => {
    const path = new URL(url, 'http://localhost').pathname;
    let body = page([]);
    let ok = true;
    if (path.endsWith('/improvements/status'))
      body = {
        configured: true,
        dailyBudget: 10,
        modelRevision: 1,
        model: 'test',
        provider: 'codex',
        effort: null,
        reviewerRevision: 1,
        queued: 0,
      };
    if (path.endsWith('/scorecards')) body = page(cards);
    if (path.endsWith('/trials')) body = page(trials);
    if (path.endsWith('/runs')) body = page([summary]);
    if (path.endsWith('/' + runId)) body = delivery;
    if (path.endsWith('/history'))
      body = page([
        {
          id: '1',
          signature: detail.signature,
          runId,
          revision: 1,
          at: detail.at,
          author: 'reviewer',
          criteria: detail.criteria,
          sources: detail.sources,
        },
      ]);
    if (path.endsWith('/decision') && failDecision) {
      ok = false;
      body = { message: 'Team revision changed. Review the new configuration.' };
    }
    if (path.endsWith('/corrections')) body = detail;
    return { ok, status: ok ? 200 : 409, json: async () => body };
  });
  vi.stubGlobal('fetch', fetch);
  render(<Improvements workflows={[]} />);
  return {
    fetch,
    setDelivery: (record) => {
      delivery = record;
    },
    open: async () => fireEvent.click(await screen.findByRole('button', { name: 'Teams', exact: true })),
  };
}

it('loads the team view on demand and traces the speed score to a run and its evidence', async () => {
  const { fetch, open } = setup();
  expect(fetch.mock.calls.some(([url]) => url.includes('/teams/'))).toBe(false);
  await open();
  expect(await screen.findByText('Build team')).toBeTruthy();
  expect(screen.getByText(/1 of 1 verified deliveries/)).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => url.includes('/teams/runs'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /timed deliveries/i }));
  fireEvent.click(await screen.findByRole('button', { name: /Example · Bug fix/ }));
  expect(await screen.findByText('Fix the broken setting')).toBeTruthy();
  expect(screen.getByText('The owner sees the new setting')).toBeTruthy();
  expect(screen.getAllByText('UI check passed').length).toBeGreaterThan(0);
  expect(screen.getAllByText('override')).toHaveLength(2);
  expect(fetch.mock.calls.some(([url]) => url.includes('/history'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Verdict history' }));
  expect(await screen.findByText(/Revision 1 · reviewer/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Correct verdict' }));
  fireEvent.change(screen.getByLabelText('Verdict'), { target: { value: 'missed' } });
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Rechecked on the device and reproduced the issue' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([url, o]) =>
          url.endsWith('/corrections') &&
          o.method === 'POST' &&
          JSON.parse(o.body).text === detail.criteria[0].text &&
          JSON.parse(o.body).signature === detail.signature &&
          JSON.parse(o.body).verdict === 'missed' &&
          JSON.parse(o.body).revision === 1,
      ),
    ).toBe(true),
  );
});

it.each([
  ['pending', 'Start measured trial', 'start'],
  ['pending', 'Dismiss', 'dismiss'],
  ['running', 'End trial early', 'stop'],
  ['measured', 'Adopt for this team role', 'adopt'],
])('offers the %s action %s with its revision and inline conflicts', async (status, label, action) => {
  const record = {
    ...trial,
    status,
    comparison:
      status === 'measured'
        ? { exposedRuns: 1, goal: 'speed', policyVersion: 1, verdict: 'helped', before: score, after: score }
        : null,
  };
  const { fetch, open } = setup({ trials: [record], failDecision: true });
  await open();
  const button = await screen.findByRole('button', { name: label });
  fireEvent.click(button);
  expect((await within(button.closest('article')).findByRole('alert')).textContent).toContain(
    'Team revision changed',
  );
  expect(
    fetch.mock.calls.some(
      ([url, options]) =>
        url.endsWith('/' + trialId + '/decision') &&
        JSON.parse(options.body).action === action &&
        JSON.parse(options.body).revision === 1,
    ),
  ).toBe(true);
});

it('explains stale proposals inline, allows dismissal, and shows empty scorecards', async () => {
  const { open } = setup({
    cards: [],
    trials: [{ ...trial, stale: true, staleReason: 'The team configuration changed.' }],
  });
  await open();
  const button = await screen.findByRole('button', { name: 'Start measured trial' });
  expect(button.disabled).toBe(true);
  expect(within(button.closest('article')).getByText(/configuration changed/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Dismiss' }).disabled).toBe(false);
  expect(screen.getByText(/No team scorecards/i)).toBeTruthy();
});

it('identifies same-revision scorecards by their role assignments', async () => {
  const config = { ...assignments[0], role: 'Fix', source: 'team', teamId, teamRevision: 3 };
  const { open } = setup({
    cards: [
      { ...card, configuration: [config] },
      { ...card, id: 'd'.repeat(64), configuration: [{ ...config, model: 'm2', agentRevision: 2 }] },
    ],
    trials: [],
  });
  await open();
  expect(await screen.findByText(/Fix · codex · m1 · high · agent rev 1/)).toBeTruthy();
  expect(screen.getByText(/Fix · codex · m2 · high · agent rev 2/)).toBeTruthy();
});
it('reports malformed score data in the dashboard', async () => {
  const { open } = setup({
    cards: [
      {
        ...card,
        score: {
          ...card.score,
          metrics: { ...card.score.metrics, activeMs: { ...card.score.metrics.activeMs, value: -1 } },
        },
      },
    ],
  });
  await open();
  expect((await screen.findByRole('alert')).textContent).toMatch(/activeMs.value/);
});

it('only offers corrections on delivered runs and shows attempt time and assignment provenance', async () => {
  const { open } = setup({ detailStatus: 'stopped' });
  await open();
  fireEvent.click(await screen.findByRole('button', { name: runId.slice(0, 8) }));
  expect(await screen.findByText('Fix the broken setting')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Correct verdict' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add criterion' })).toBeNull();
  expect(screen.getByText('Outside team')).toBeTruthy();
});
it('displays a newly registered score without a dashboard-specific metric renderer', async () => {
  const metric = {
    value: 12.5,
    unit: 'credits',
    direction: 'lower',
    version: 1,
    eligible: 1,
    excluded: 0,
    evidenceIds: [runId],
  };
  const { open } = setup({
    cards: [{ ...card, score: { ...score, metrics: { ...score.metrics, tokenSpend: metric } } }],
  });
  await open();
  expect(
    await screen.findByRole('button', { name: /Token spend.*12.5 credits.*lower.*1 eligible/i }),
  ).toBeTruthy();
});

it('shows both the executed check and its outcome and the scope of a trial before approval', async () => {
  const { open } = setup();
  await open();
  expect(await screen.findByText(/Next five matching runs in Example/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: runId.slice(0, 8), exact: true }));
  expect(await screen.findByText('Open the setting on device')).toBeTruthy();
});

it('keeps an open correction fenced to the reviewed evidence across refresh', async () => {
  const { open, fetch, setDelivery } = setup();
  await open();
  fireEvent.click(await screen.findByRole('button', { name: runId.slice(0, 8), exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Correct verdict' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Checked on device' } });
  setDelivery({
    ...detail,
    revision: 2,
    signature: 'f'.repeat(64),
    criteria: [{ ...detail.criteria[0], text: 'Changed requirement' }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Changed requirement');
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  await waitFor(() =>
    expect(
      fetch.mock.calls
        .filter(([url]) => url.endsWith('/corrections'))
        .map(([, o]) => JSON.parse(o.body).revision),
    ).toEqual([1]),
  );
});
