import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast }) }));

import PipelineSettings from '../PipelineSettings';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const W1 = '33333333-3333-4333-8333-333333333333';
const STALE = 'revision does not match the stored revision';

const STAMPS = { createdAt: '2026-11-13T11:00:00.000Z', updatedAt: '2026-11-13T11:00:00.000Z' };
const codex = () => ({ id: A1, name: 'codex-high', launchCommand: 'command codex --model gpt-6-sol', resetCommand: '/clear', revision: 1, ...STAMPS });
const cursor = () => ({ id: A2, name: 'cursor-fable', launchCommand: 'command agent --model fable', resetCommand: '/new', revision: 4, ...STAMPS });
const feature = () => ({
  id: W1,
  name: 'Feature',
  kind: 'other',
  description: '',
  agentsDecide: false,
  progressFile: null,
  revision: 3,
  ...STAMPS,
  nodes: [
    { name: 'Develop', role: '', agentId: A1, prompt: '/feature-dev {input}', repeat: { mode: 'until_complete', max: 20 }, readOnly: false, approval: false, askOwner: false },
    { name: 'Test', role: '', agentId: A2, prompt: '/feature-test {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
  ],
});

/** In-memory stand-in for /api/pipelines definitions, including revision checks. */
function createBackend(seed = {}) {
  const state = {
    teams: seed.teams ?? [],
    agents: seed.agents ?? [],
    workflows: seed.workflows ?? [],
    settings: seed.settings ?? { setupAgentId: null, revision: 1 },
    templates: seed.templates ?? [],
    'step-presets': seed.stepPresets ?? [],
  };
  const requests = [];
  const failures = [];
  let created = 0;
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const problem = (status, message, errors) => json({ status, message, ...(errors ? { errors } : {}) }, status);
  const newId = () => `99999999-9999-4999-8999-${String(++created).padStart(12, '0')}`;

  function collection(name, method, id, body) {
    const records = state[name];
    if (method === 'GET' && !id) return json({ data: [...records], page: { hasNextPage: false } });
    if (method === 'POST') {
      const record = { id: newId(), ...body, revision: 1, ...STAMPS };
      records.push(record);
      return json(record, 201);
    }
    const index = records.findIndex(record => record.id === id);
    if (index === -1) return problem(404, `${name} record not found`);
    if (method === 'GET') return json(records[index]);
    if (method === 'DELETE') {
      records.splice(index, 1);
      return { ok: true, status: 204, json: async () => { throw new Error('empty body'); } };
    }
    if (body.revision !== records[index].revision) return problem(409, STALE);
    records[index] = { ...records[index], ...body, revision: body.revision + 1 };
    return json(records[index]);
  }

  const fetch = vi.fn(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const [, name, id] = new URL(url, 'http://codedeck.test').pathname.replace('/api/pipelines', '').split('/');
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    requests.push({ method, path: id ? `/${name}/${id}` : `/${name}`, body });
    const failureIndex = failures.findIndex(failure => failure.method === method && failure.name === name);
    if (failureIndex !== -1) {
      const [failure] = failures.splice(failureIndex, 1);
      if (failure.network) throw new TypeError('Failed to fetch');
      return problem(failure.status, failure.message, failure.errors);
    }
    if (name === 'settings') {
      if (method === 'GET') return json(state.settings);
      if (body.revision !== state.settings.revision) return problem(409, STALE);
      state.settings = { setupAgentId: body.setupAgentId, revision: body.revision + 1 };
      return json(state.settings);
    }
    return collection(name, method, id, body);
  });

  return {
    state,
    fetch,
    failNext: (method, name, failure) => failures.push({ method, name, ...failure }),
    mutations: () => requests.filter(request => request.method !== 'GET'),
  };
}

let backend;
let onDirtyChange;

async function renderSettings(seed) {
  backend = createBackend(seed);
  vi.stubGlobal('fetch', backend.fetch);
  onDirtyChange = vi.fn();
  render(<PipelineSettings onDirtyChange={onDirtyChange} />);
  await screen.findByRole('button', { name: 'Add agent' });
}

const agents = () => within(screen.getByRole('region', { name: 'Agents' }));
const workflows = () => within(screen.getByRole('region', { name: 'Workflows' }));
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = name => {
  fireEvent.click(screen.getByRole('button', { name }));
  if (name === 'Add workflow') fireEvent.click(screen.getByRole('button', { name: 'Blank' }));
};
const toast = (kind, message) => expect(showToast).toHaveBeenCalledWith({ type: kind, message });
const lastDirty = () => onDirtyChange.mock.calls.at(-1)?.[0];
const nodeNames = () => screen.getAllByLabelText(/^Node \d+ name$/).map(input => input.value);

function fillNode(number, { name, agent, prompt, repeat, max }) {
  type(`Node ${number} name`, name);
  type(`Node ${number} agent`, agent);
  type(`Node ${number} prompt`, prompt);
  if (repeat) type(`Node ${number} repeat`, repeat);
  if (max !== undefined) type(`Node ${number} maximum passes`, max);
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  showToast.mockClear();
});

describe('PipelineSettings loading', () => {
  it('lists agents, the setup agent and workflows from the backend', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()], settings: { setupAgentId: A2, revision: 2 } });

    expect(agents().getByText('codex-high')).toBeTruthy();
    expect(agents().getByText('command codex --model gpt-6-sol')).toBeTruthy();
    expect(agents().getByText('cursor-fable')).toBeTruthy();
    expect(screen.getByLabelText('Setup agent').value).toBe(A2);
    expect(workflows().getByText('Feature')).toBeTruthy();
    expect(workflows().getByText('2 nodes: Develop → Test')).toBeTruthy();
    expect(lastDirty()).toBe(false);
  });

  it('reports a load failure with the API message and loads again on Retry', async () => {
    backend = createBackend({ agents: [codex()] });
    backend.failNext('GET', 'agents', { status: 500, message: 'An unexpected error occurred' });
    vi.stubGlobal('fetch', backend.fetch);
    render(<PipelineSettings onDirtyChange={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toBe('An unexpected error occurred');
    toast('error', 'An unexpected error occurred');
    expect(screen.queryByRole('button', { name: 'Add agent' })).toBeNull();

    click('Retry');
    await screen.findByRole('button', { name: 'Add agent' });
    expect(agents().getByText('codex-high')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the server is unreachable when the request never completes', async () => {
    backend = createBackend();
    backend.failNext('GET', 'settings', { network: true });
    vi.stubGlobal('fetch', backend.fetch);
    render(<PipelineSettings onDirtyChange={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toBe('Server unreachable');
    toast('error', 'Server unreachable');
  });
});

describe('PipelineSettings agents', () => {
  it('adds an agent with the reset command pre-filled', async () => {
    await renderSettings();
    click('Add agent');
    expect(screen.getByLabelText('Reset command').value).toBe('/clear');
    type('Agent name', 'haiku-setup');
    type('Provider', 'custom');
    type('Launch command', 'claude --model haiku --chrome');
    click('Save agent');

    expect(await agents().findByText('haiku-setup')).toBeTruthy();
    expect(backend.mutations()).toEqual([{
      method: 'POST',
      path: '/agents',
      body: { name: 'haiku-setup', launchCommand: 'claude --model haiku --chrome', resetCommand: '/clear' },
    }]);
    toast('success', 'Agent "haiku-setup" added');
    expect(screen.queryByLabelText('Agent name')).toBeNull();
  });

  it('shows each invalid field from the shared validator and sends nothing', async () => {
    await renderSettings();
    click('Add agent');
    type('Provider', 'custom');
    type('Launch command', '');
    type('Reset command', '');
    click('Save agent');

    expect(screen.getByLabelText('Agent name').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use 1–64 characters on one line without control characters')).toBeTruthy();
    expect(screen.getByText('launchCommand must contain 1–2048 characters on one line without control characters')).toBeTruthy();
    expect(screen.getByText('resetCommand must contain 1–256 characters on one line without control characters')).toBeTruthy();
    expect(backend.mutations()).toEqual([]);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('keeps the form open and toasts the API message when the name is taken', async () => {
    await renderSettings({ agents: [codex()] });
    backend.failNext('POST', 'agents', { status: 409, message: 'A agent with this name already exists' });
    click('Add agent');
    type('Agent name', 'codex-high');
    click('Save agent');

    await waitFor(() => toast('error', 'A agent with this name already exists'));
    expect(screen.getByLabelText('Agent name').value).toBe('codex-high');
    expect(backend.state.agents).toHaveLength(1);
  });

  it('renders field errors returned by the API', async () => {
    await renderSettings();
    backend.failNext('POST', 'agents', {
      status: 400,
      message: 'Validation failed',
      errors: [{ field: 'launchCommand', message: 'Launch command rejected' }],
    });
    click('Add agent');
    type('Agent name', 'x');
    click('Save agent');

    expect(await screen.findByText('Launch command rejected')).toBeTruthy();
    expect(screen.getByLabelText('Launch command').getAttribute('aria-invalid')).toBe('true');
    toast('error', 'Validation failed');
  });

  it('shows an API error for a field that has no control of its own', async () => {
    await renderSettings({ agents: [codex()] });
    backend.failNext('PUT', 'agents', {
      status: 400,
      message: 'Validation failed',
      errors: [{ field: 'revision', message: 'Use a whole number of 1 or more' }],
    });
    click('Edit agent codex-high');
    click('Save agent');

    expect(await screen.findByText('revision: Use a whole number of 1 or more')).toBeTruthy();
  });

  it('edits an agent, sending its revision', async () => {
    await renderSettings({ agents: [codex()] });
    click('Edit agent codex-high');
    expect(screen.getByLabelText('Agent name').value).toBe('codex-high');
    expect(screen.getByLabelText('Launch command').value).toBe('command codex --model gpt-6-sol');
    type('Model', 'gpt-6.1-sol');
    type('Reset command', '/new');
    click('Save agent');

    expect(await agents().findByText('command codex --model gpt-6.1-sol')).toBeTruthy();
    expect(backend.mutations()).toEqual([{
      method: 'PUT',
      path: `/agents/${A1}`,
      body: { name: 'codex-high', launchCommand: 'command codex --model gpt-6.1-sol', resetCommand: '/new', revision: 1 },
    }]);
    toast('success', 'Agent "codex-high" saved');
  });

  it('loads the latest version when the agent changed elsewhere, then saves with the new revision', async () => {
    await renderSettings({ agents: [codex()] });
    click('Edit agent codex-high');
    type('Agent name', 'mine');
    backend.state.agents[0] = { ...codex(), launchCommand: 'codex --theirs', revision: 2 };
    click('Save agent');

    await waitFor(() => toast('error', 'This agent was changed elsewhere. The latest version has been loaded.'));
    expect(screen.getByLabelText('Agent name').value).toBe('codex-high');
    expect(screen.getByLabelText('Launch command').value).toBe('codex --theirs');

    type('Agent name', 'mine');
    click('Save agent');
    expect(await agents().findByText('mine')).toBeTruthy();
    expect(backend.mutations().at(-1).body).toEqual({ name: 'mine', launchCommand: 'codex --theirs', resetCommand: '/clear', revision: 2 });
  });

  it('keeps the draft when a 409 on save is not a stale revision', async () => {
    await renderSettings({ agents: [codex(), cursor()] });
    backend.failNext('PUT', 'agents', { status: 409, message: 'A agent with this name already exists' });
    click('Edit agent codex-high');
    type('Agent name', 'cursor-fable');
    click('Save agent');

    await waitFor(() => toast('error', 'A agent with this name already exists'));
    expect(screen.getByLabelText('Agent name').value).toBe('cursor-fable');
  });

  it('closes the form when the agent no longer exists', async () => {
    await renderSettings({ agents: [codex(), cursor()] });
    click('Edit agent codex-high');
    type('Agent name', 'mine');
    backend.state.agents.shift();
    click('Save agent');

    await waitFor(() => toast('error', 'agents record not found'));
    await waitFor(() => expect(agents().queryByText('codex-high')).toBeNull());
    expect(screen.queryByLabelText('Agent name')).toBeNull();
  });

  it('says the server is unreachable when a save never completes, keeping the form', async () => {
    await renderSettings();
    backend.failNext('POST', 'agents', { network: true });
    click('Add agent');
    type('Agent name', 'codex');
    click('Save agent');

    await waitFor(() => toast('error', 'Server unreachable'));
    expect(screen.getByLabelText('Agent name').value).toBe('codex');
    expect(lastDirty()).toBe(true);
  });

  it('closes the form of an agent that is deleted while being edited', async () => {
    await renderSettings({ agents: [codex(), cursor()] });
    click('Edit agent codex-high');
    type('Agent name', 'changed');
    click('Delete agent codex-high');

    await waitFor(() => expect(agents().queryByText('codex-high')).toBeNull());
    expect(screen.queryByLabelText('Agent name')).toBeNull();
    expect(lastDirty()).toBe(false);
  });

  it('deletes an agent after confirmation', async () => {
    await renderSettings({ agents: [codex(), cursor()] });
    window.confirm.mockReturnValueOnce(false);
    click('Delete agent codex-high');
    expect(window.confirm).toHaveBeenCalledWith('Delete agent "codex-high"?');
    expect(backend.mutations()).toEqual([]);

    click('Delete agent codex-high');
    await waitFor(() => expect(agents().queryByText('codex-high')).toBeNull());
    expect(backend.mutations()).toEqual([{ method: 'DELETE', path: `/agents/${A1}`, body: undefined }]);
    toast('success', 'Agent "codex-high" deleted');
  });

  it('shows why an agent in use cannot be deleted', async () => {
    await renderSettings({ agents: [codex()], workflows: [] });
    backend.failNext('DELETE', 'agents', { status: 409, message: 'Cannot delete an agent used by a workflow' });
    click('Delete agent codex-high');

    expect((await agents().findByRole('alert')).textContent).toBe('Cannot delete an agent used by a workflow');
    toast('error', 'Cannot delete an agent used by a workflow');
    expect(agents().getByText('codex-high')).toBeTruthy();
  });

  it('asks before another agent replaces an unsaved form', async () => {
    await renderSettings({ agents: [codex(), cursor()] });
    click('Edit agent codex-high');
    click('Edit agent cursor-fable');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Agent name').value).toBe('cursor-fable');

    type('Agent name', 'unsaved');
    window.confirm.mockReturnValueOnce(false);
    click('Edit agent codex-high');
    expect(window.confirm).toHaveBeenCalledWith('Discard the unsaved changes to this agent?');
    expect(screen.getByLabelText('Agent name').value).toBe('unsaved');

    click('Edit agent codex-high');
    expect(screen.getByLabelText('Agent name').value).toBe('codex-high');
  });

  it('reports unsaved changes while an agent form differs from what was loaded', async () => {
    await renderSettings({ agents: [codex()] });
    click('Edit agent codex-high');
    expect(lastDirty()).toBe(false);
    type('Agent name', 'changed');
    expect(lastDirty()).toBe(true);
    click('Cancel');
    expect(lastDirty()).toBe(false);
    expect(screen.queryByLabelText('Agent name')).toBeNull();
  });
});

describe('PipelineSettings agent presets', () => {
  const alias = () => ({ id: A2, name: 'claude-cc', launchCommand: 'cc', resetCommand: '/clear', revision: 1, ...STAMPS });
  const command = () => screen.getByLabelText('Launch command');
  const providerOptions = () => [...screen.getByLabelText('Provider').options].map(option => [option.value, option.textContent]);

  it('opens a new agent on Claude Code with the command built for it', async () => {
    await renderSettings();
    click('Add agent');

    expect(providerOptions()).toEqual([
      ['claude', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['agy', 'Antigravity'], ['custom', 'Custom command'],
    ]);
    expect(screen.getByLabelText('Provider').value).toBe('claude');
    expect(screen.getByLabelText('Model').value).toBe('');
    expect(screen.getByLabelText('Effort').value).toBe('');
    expect(screen.getByLabelText('Skip permission prompts').checked).toBe(false);
    expect(command().value).toBe('command claude');
    expect(command().readOnly).toBe(true);
    expect(lastDirty()).toBe(false);
  });

  it('saves and reopens an Antigravity workflow agent', async () => {
    await renderSettings();
    click('Add agent');
    type('Agent name', 'Antigravity reviewer');
    type('Provider', 'agy');
    type('Model', 'gemini-4-neon-high');
    type('Effort', 'high');
    click('Save agent');

    expect(await agents().findByText('command agy --model gemini-4-neon-high --effort high')).toBeTruthy();
    click('Edit agent Antigravity reviewer');
    expect(screen.getByLabelText('Provider').value).toBe('agy');
    expect(screen.getByLabelText('Model').value).toBe('gemini-4-neon-high');
    expect(screen.getByLabelText('Effort').value).toBe('high');
    expect(screen.getByLabelText('Skip permission prompts').checked).toBe(false);
  });

  it('adds an agent from a provider, model and effort', async () => {
    await renderSettings();
    click('Add agent');
    type('Agent name', 'opus-high');
    type('Model', 'opus');
    type('Effort', 'high');
    expect(command().value).toBe('command claude --model opus --effort high');
    click('Save agent');

    expect(await agents().findByText('command claude --model opus --effort high')).toBeTruthy();
    expect(backend.mutations()).toEqual([{
      method: 'POST',
      path: '/agents',
      body: { name: 'opus-high', launchCommand: 'command claude --model opus --effort high', resetCommand: '/clear' },
    }]);
    toast('success', 'Agent "opus-high" added');
  });

  it('offers the efforts of the chosen provider and adds its permission flag when asked', async () => {
    await renderSettings();
    click('Add agent');
    const efforts = () => [...screen.getByLabelText('Effort').options].map(option => option.value);
    expect(efforts()).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);

    type('Provider', 'codex');
    expect(efforts()).toEqual(['', 'low', 'medium', 'high', 'xhigh']);
    type('Model', 'gpt-6-sol');
    type('Effort', 'xhigh');
    fireEvent.click(screen.getByLabelText('Skip permission prompts'));
    expect(command().value).toBe('command codex --model gpt-6-sol -c model_reasoning_effort="xhigh" --dangerously-bypass-approvals-and-sandbox');
  });

  it('has no effort choice for Cursor, whose model names carry it', async () => {
    await renderSettings();
    click('Add agent');
    type('Provider', 'cursor');
    expect(screen.queryByLabelText('Effort')).toBeNull();
    type('Model', 'gpt-5.6-sol-high');
    expect(command().value).toBe('command agent --model gpt-5.6-sol-high');
  });

  it('clears the model and effort when the provider changes, keeping the permission choice', async () => {
    await renderSettings();
    click('Add agent');
    type('Model', 'opus');
    type('Effort', 'max');
    fireEvent.click(screen.getByLabelText('Skip permission prompts'));
    type('Provider', 'codex');

    expect(screen.getByLabelText('Model').value).toBe('');
    expect(screen.getByLabelText('Effort').value).toBe('');
    expect(command().value).toBe('command codex --dangerously-bypass-approvals-and-sandbox');
  });

  it('shows a saved command a preset builds as that provider, model and effort', async () => {
    await renderSettings({ agents: [{ ...codex(), launchCommand: 'command codex --model gpt-6-sol -c model_reasoning_effort="high"' }] });
    click('Edit agent codex-high');

    expect(screen.getByLabelText('Provider').value).toBe('codex');
    expect(screen.getByLabelText('Model').value).toBe('gpt-6-sol');
    expect(screen.getByLabelText('Effort').value).toBe('high');
    expect(screen.getByLabelText('Skip permission prompts').checked).toBe(false);
    expect(lastDirty()).toBe(false);
  });

  it('shows a saved command that starts the CLI without `command` as a custom command, unchanged', async () => {
    const saved = 'codex --model gpt-6-sol --dangerously-bypass-approvals-and-sandbox';
    await renderSettings({ agents: [{ ...codex(), launchCommand: saved }] });
    click('Edit agent codex-high');

    expect(screen.getByLabelText('Provider').value).toBe('custom');
    expect(command().value).toBe(saved);
    expect(lastDirty()).toBe(false);
  });

  it('shows any other saved command as a custom command, unchanged', async () => {
    await renderSettings({ agents: [alias()] });
    click('Edit agent claude-cc');

    expect(screen.getByLabelText('Provider').value).toBe('custom');
    expect(command().value).toBe('cc');
    expect(command().readOnly).toBe(false);
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.queryByLabelText('Effort')).toBeNull();
    expect(screen.queryByLabelText('Skip permission prompts')).toBeNull();
    expect(lastDirty()).toBe(false);
  });

  it('carries the built command into Custom command for editing by hand', async () => {
    await renderSettings();
    click('Add agent');
    type('Agent name', 'opus-chrome');
    type('Model', 'opus');
    type('Provider', 'custom');
    expect(command().value).toBe('command claude --model opus');
    expect(command().readOnly).toBe(false);

    type('Launch command', 'claude --model opus --chrome');
    click('Save agent');
    expect(await agents().findByText('claude --model opus --chrome')).toBeTruthy();
    expect(backend.mutations().at(-1).body.launchCommand).toBe('claude --model opus --chrome');
  });

  it('shows an invalid model on its field and sends nothing', async () => {
    await renderSettings();
    click('Add agent');
    type('Agent name', 'bad');
    type('Model', 'opus; rm -rf');
    expect(command().value).toBe('');
    expect(lastDirty()).toBe(true);
    click('Save agent');

    expect(screen.getByLabelText('Model').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use letters, digits and . _ : / - only, starting with a letter or digit, at most 128 characters')).toBeTruthy();
    expect(screen.queryByText(/launchCommand must contain/)).toBeNull();
    expect(backend.mutations()).toEqual([]);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('reports a changed model as unsaved', async () => {
    await renderSettings({ agents: [codex()] });
    click('Edit agent codex-high');
    expect(lastDirty()).toBe(false);
    type('Model', 'gpt-6.1-sol');
    expect(lastDirty()).toBe(true);
    type('Model', 'gpt-6-sol');
    expect(lastDirty()).toBe(false);
  });
});

describe('PipelineSettings setup agent', () => {
  it('saves the chosen setup agent with the settings revision', async () => {
    await renderSettings({ agents: [codex(), cursor()], settings: { setupAgentId: null, revision: 5 } });
    expect(screen.getByLabelText('Setup agent').value).toBe('');
    type('Setup agent', A2);

    await waitFor(() => toast('success', 'Setup agent saved'));
    expect(backend.mutations()).toEqual([{ method: 'PUT', path: '/settings', body: { setupAgentId: A2, revision: 5 } }]);
    await waitFor(() => expect(screen.getByLabelText('Setup agent').value).toBe(A2));
  });

  it('clears the setup agent with null and the next revision', async () => {
    await renderSettings({ agents: [codex()], settings: { setupAgentId: A1, revision: 1 } });
    type('Setup agent', '');
    await waitFor(() => toast('success', 'Setup agent saved'));
    type('Setup agent', A1);
    await waitFor(() => expect(backend.mutations()).toHaveLength(2));

    expect(backend.mutations().map(request => request.body)).toEqual([
      { setupAgentId: null, revision: 1 },
      { setupAgentId: A1, revision: 2 },
    ]);
  });

  it('keeps the backend value and reloads when saving fails', async () => {
    await renderSettings({ agents: [codex(), cursor()], settings: { setupAgentId: A1, revision: 1 } });
    backend.state.settings = { setupAgentId: A2, revision: 2 };
    type('Setup agent', '');

    await waitFor(() => toast('error', STALE));
    await waitFor(() => expect(screen.getByLabelText('Setup agent').value).toBe(A2));
  });
});

describe('PipelineSettings workflows', () => {
  it('offers blank and templates, prefills role hints and creates only after agents are chosen', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature(), { ...feature(), id: A2, name: 'Bug fix' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }));
    expect(screen.getByRole('button', { name: 'Blank' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Bug fix.*Investigate/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Feature build.*Plan/ })).toBeTruthy();
    click(/Bug fix.*Investigate/);
    expect(screen.getByLabelText('Workflow name').value).toBe('Bug fix 2');
    expect(nodeNames()).toEqual(['Clarify', 'Analyse', 'Specify', 'Develop', 'Review', 'Test', 'Commit']);
    // Clarify checks the report first and always asks the owner; the work starts gated at Analyse.
    expect(screen.getByLabelText('Node 1 read-only step').checked).toBe(true);
    expect(screen.getByLabelText('Node 1 always ask me').checked).toBe(true);
    expect(screen.getByLabelText('Node 1 wait for my approval').checked).toBe(false);
    expect(screen.getByLabelText('Node 2 wait for my approval').checked).toBe(true);
    expect(screen.getByLabelText('Node 2 always ask me').checked).toBe(false);
    expect(screen.getByLabelText('Node 1 agent').value).toBe('');
    // What each step is for comes with the template, and can be edited.
    expect(screen.getByLabelText('Node 1 role').value).toBe('Investigator');
    expect(screen.getByLabelText('Workflow kind').value).toBe('bugfix');
    expect(lastDirty()).toBe(true);
    for (let index = 1; index <= 7; index++) type(`Node ${index} agent`, A1);
    click('Save workflow');
    await waitFor(() => expect(backend.mutations()).toHaveLength(1));
    expect(backend.mutations()[0].body.nodes[5].repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: 5 });
    expect(backend.mutations()[0].body.nodes.map(node => node.askOwner)).toEqual([true, false, false, false, false, true, false]);
    expect(backend.mutations()[0].body.nodes[0].role).toBe('Investigator');
    expect(backend.mutations()[0].body).toMatchObject({ kind: 'bugfix', description: 'Investigate, agree on a fix, build, review, test and commit.' });
  });

  it('duplicates as a new workflow with agents and unique bounded name', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature(), { ...feature(), id: A2, name: 'Copy of Feature' }] });
    click('Duplicate workflow Feature');
    expect(screen.getByLabelText('Workflow name').value).toBe('Copy of Feature 2');
    expect(screen.getByLabelText('Node 1 agent').value).toBe(A1);
    expect(lastDirty()).toBe(true);
    click('Save workflow');
    await waitFor(() => expect(backend.mutations()).toHaveLength(1));
    expect(backend.mutations()[0]).toMatchObject({ method: 'POST', path: '/workflows', body: { name: 'Copy of Feature 2' } });
  });

  it('uses general editor placeholders', async () => {
    await renderSettings({ agents: [codex()] });
    click('Add workflow');
    expect(screen.getByLabelText('Workflow name').placeholder).toBe('e.g. Bug fix');
    expect(screen.getByLabelText('Node 1 name').placeholder).toBe('e.g. Analyse');
    expect(screen.getByLabelText('Node 1 prompt').placeholder).toBe('What this step should do. {input} is replaced with what you type when starting a run.');
  });

  it('saves a role-based workflow before any agent has been created', async () => {
    await renderSettings();
    click('Add workflow');
    type('Workflow name', 'Team review');
    type('Node 1 name', 'Report');
    type('Node 1 role', 'Reviewer');
    type('Node 1 prompt', 'Report findings');
    click('Save workflow');
    await waitFor(() => expect(backend.state.workflows[0]?.nodes[0]).toMatchObject({ role: 'Reviewer', agentId: null }));
  });

  it('adds a workflow with a repeating node and a single-pass node', async () => {
    await renderSettings({ agents: [codex(), cursor()] });
    click('Add workflow');
    expect(nodeNames()).toEqual(['']);
    expect(screen.getByLabelText('Node 1 repeat').value).toBe('once');
    expect(screen.queryByLabelText('Node 1 maximum passes')).toBeNull();

    type('Workflow name', 'Release');
    fillNode(1, { name: 'Develop', agent: A1, prompt: '/feature-dev {input}', repeat: 'until_complete', max: '20' });
    click('Add node');
    fillNode(2, { name: 'Test', agent: A2, prompt: '/feature-test {input}' });
    click('Save workflow');

    expect(await workflows().findByText('2 nodes: Develop → Test')).toBeTruthy();
    expect(backend.mutations()).toEqual([{
      method: 'POST',
      path: '/workflows',
      body: {
        name: 'Release',
        kind: 'other',
        description: '',
        agentsDecide: false,
        progressFile: null,
        nodes: [
          { name: 'Develop', role: '', agentId: A1, prompt: '/feature-dev {input}', repeat: { mode: 'until_complete', max: 20 }, readOnly: false, approval: false, askOwner: false },
          { name: 'Test', role: '', agentId: A2, prompt: '/feature-test {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
        ],
      },
    }]);
    toast('success', 'Workflow "Release" added');
    expect(screen.queryByLabelText('Workflow name')).toBeNull();
  });

  it('shows each invalid field from the shared validator and sends nothing', async () => {
    await renderSettings({ agents: [codex()] });
    click('Add workflow');
    click('Save workflow');

    for (const label of ['Workflow name', 'Node 1 name', 'Node 1 agent', 'Node 1 prompt']) {
      expect(screen.getByLabelText(label).getAttribute('aria-invalid')).toBe('true');
    }
    expect(screen.getByText('Choose a saved agent or enter a role for team assignment')).toBeTruthy();
    expect(screen.getByText('Use 1–8192 characters without terminal control codes')).toBeTruthy();
    expect(backend.mutations()).toEqual([]);
  });

  it.each(['', '0', '101', '2.5'])('rejects a maximum of "%s" passes', async (max) => {
    await renderSettings({ agents: [codex()] });
    click('Add workflow');
    type('Workflow name', 'Loop');
    fillNode(1, { name: 'Develop', agent: A1, prompt: '/dev', repeat: 'until_complete', max });
    click('Save workflow');

    expect(screen.getByText('Use a whole number from 1 to 100')).toBeTruthy();
    expect(screen.getByLabelText('Node 1 maximum passes').getAttribute('aria-invalid')).toBe('true');
    expect(backend.mutations()).toEqual([]);
  });

  it('moves and removes nodes, keeping at least one', async () => {
    await renderSettings({ agents: [codex()] });
    click('Add workflow');
    expect(screen.getByRole('button', { name: 'Remove node 1' }).disabled).toBe(true);
    click('Add node');
    click('Add node');
    ['A', 'B', 'C'].forEach((name, index) => type(`Node ${index + 1} name`, name));
    expect(screen.getByRole('button', { name: 'Move node 1 up' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Move node 3 down' }).disabled).toBe(true);

    click('Move node 3 up');
    expect(nodeNames()).toEqual(['A', 'C', 'B']);
    click('Move node 1 down');
    expect(nodeNames()).toEqual(['C', 'A', 'B']);
    click('Remove node 2');
    expect(nodeNames()).toEqual(['C', 'B']);
  });

  it('stops adding nodes at 32', async () => {
    await renderSettings({ agents: [codex()] });
    click('Add workflow');
    for (let count = 1; count < 32; count++) click('Add node');
    expect(nodeNames()).toHaveLength(32);
    expect(screen.getByRole('button', { name: 'Add node' }).disabled).toBe(true);
    // 31 role queries over a form that grows to 32 nodes take 4–6 s on a busy machine.
  }, 20000);

  it('edits a workflow, sending its revision and dropping the maximum of a single-pass node', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    expect(screen.getByLabelText('Workflow name').value).toBe('Feature');
    expect(nodeNames()).toEqual(['Develop', 'Test']);
    expect(screen.getByLabelText('Node 1 agent').value).toBe(A1);
    expect(screen.getByLabelText('Node 1 prompt').value).toBe('/feature-dev {input}');
    expect(screen.getByLabelText('Node 1 maximum passes').value).toBe('20');
    expect(screen.getByLabelText('Node 2 repeat').value).toBe('once');

    type('Node 1 repeat', 'once');
    type('Node 2 agent', A1);
    click('Save workflow');

    await waitFor(() => toast('success', 'Workflow "Feature" saved'));
    expect(backend.mutations()).toEqual([{
      method: 'PUT',
      path: `/workflows/${W1}`,
      body: {
        name: 'Feature',
        kind: 'other',
        description: '',
        agentsDecide: false,
        progressFile: null,
        revision: 3,
        nodes: [
          { name: 'Develop', role: '', agentId: A1, prompt: '/feature-dev {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
          { name: 'Test', role: '', agentId: A1, prompt: '/feature-test {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
        ],
      },
    }]);
  });

  it('loads the latest version when the workflow changed elsewhere, then saves with the new revision', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    type('Workflow name', 'Mine');
    backend.state.workflows[0] = { ...feature(), name: 'Theirs', nodes: [feature().nodes[1]], revision: 4 };
    click('Save workflow');

    await waitFor(() => toast('error', 'This workflow was changed elsewhere. The latest version has been loaded.'));
    expect(screen.getByLabelText('Workflow name').value).toBe('Theirs');
    expect(nodeNames()).toEqual(['Test']);

    click('Save workflow');
    await waitFor(() => toast('success', 'Workflow "Theirs" saved'));
    expect(backend.mutations().at(-1).body.revision).toBe(4);
  });

  it('closes the editor when the workflow no longer exists', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    type('Workflow name', 'Mine');
    backend.state.workflows.length = 0;
    click('Save workflow');

    await waitFor(() => toast('error', 'workflows record not found'));
    await waitFor(() => expect(screen.queryByLabelText('Workflow name')).toBeNull());
    expect(workflows().getByText('No workflows yet.')).toBeTruthy();
    expect(lastDirty()).toBe(false);
  });

  it('closes the editor of a workflow that is deleted while being edited', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    type('Workflow name', 'Mine');
    click('Delete workflow Feature');

    await waitFor(() => expect(screen.queryByLabelText('Workflow name')).toBeNull());
    expect(lastDirty()).toBe(false);
  });

  it('starts each opening of the editor from the saved workflow', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    type('Workflow name', 'Abandoned');
    click('Cancel');
    click('Edit workflow Feature');
    expect(screen.getByLabelText('Workflow name').value).toBe('Feature');
  });

  it('clears field errors when nodes are moved or removed, so none sits on the wrong node', async () => {
    await renderSettings({ agents: [codex()] });
    click('Add workflow');
    type('Workflow name', 'Two');
    fillNode(1, { name: 'Good', agent: A1, prompt: '/ok' });
    click('Add node');
    type('Node 2 name', 'Blank prompt');
    type('Node 2 agent', A1);
    click('Save workflow');
    expect(screen.getByLabelText('Node 2 prompt').getAttribute('aria-invalid')).toBe('true');

    click('Move node 2 up');
    expect(screen.queryByText('Use 1–8192 characters without terminal control codes')).toBeNull();
    expect(screen.getByLabelText('Node 2 prompt').getAttribute('aria-invalid')).toBe('false');

    click('Save workflow');
    expect(screen.getByLabelText('Node 1 prompt').getAttribute('aria-invalid')).toBe('true');
    click('Remove node 1');
    expect(screen.queryByText('Use 1–8192 characters without terminal control codes')).toBeNull();
  });

  it('asks before another workflow replaces an unsaved draft', async () => {
    const second = { ...feature(), id: '44444444-4444-4444-8444-444444444444', name: 'Review' };
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature(), second] });
    click('Edit workflow Feature');
    click('Edit workflow Review');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Workflow name').value).toBe('Review');

    type('Workflow name', 'Unsaved');
    window.confirm.mockReturnValueOnce(false);
    click('Edit workflow Feature');
    expect(window.confirm).toHaveBeenCalledWith('Discard the unsaved changes to this workflow?');
    expect(screen.getByLabelText('Workflow name').value).toBe('Unsaved');

    click('Edit workflow Feature');
    expect(screen.getByLabelText('Workflow name').value).toBe('Feature');
  });

  it('renders node field errors returned by the API', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    backend.failNext('PUT', 'workflows', {
      status: 400,
      message: 'Validation failed',
      errors: [{ field: 'nodes[1].agentId', message: 'Agent no longer exists' }],
    });
    click('Edit workflow Feature');
    type('Workflow name', 'Feature 2');
    click('Save workflow');

    expect(await screen.findByText('Agent no longer exists')).toBeTruthy();
    expect(screen.getByLabelText('Node 2 agent').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Node 1 agent').getAttribute('aria-invalid')).toBe('false');
    toast('error', 'Validation failed');
  });

  it('deletes a workflow after confirmation and reports a refusal', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    backend.failNext('DELETE', 'workflows', { status: 500, message: 'An unexpected error occurred' });
    click('Delete workflow Feature');
    expect(window.confirm).toHaveBeenCalledWith('Delete workflow "Feature"?');
    await waitFor(() => toast('error', 'An unexpected error occurred'));
    expect(workflows().getByText('Feature')).toBeTruthy();

    click('Delete workflow Feature');
    await waitFor(() => expect(workflows().queryByText('Feature')).toBeNull());
    toast('success', 'Workflow "Feature" deleted');
  });

  it('reports unsaved changes while the workflow editor differs from what was loaded', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    expect(lastDirty()).toBe(false);
    click('Move node 2 up');
    expect(lastDirty()).toBe(true);
    click('Cancel');
    expect(lastDirty()).toBe(false);
    expect(screen.queryByLabelText('Workflow name')).toBeNull();
  });
});

describe('PipelineSettings workflows — loops and who decides', () => {
  it('edits a progress file, tracks dirty draft, and clears it with null', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    expect(screen.getByLabelText('Progress file').value).toBe('');
    type('Progress file', ' docs/{input} ');
    expect(lastDirty()).toBe(true);
    click('Save workflow');
    await waitFor(() => toast('success', 'Workflow "Feature" saved'));
    expect(backend.mutations().at(-1).body.progressFile).toBe('docs/{input}');
    click('Edit workflow Feature');
    type('Progress file', '');
    click('Save workflow');
    await waitFor(() => expect(backend.mutations().at(-1).body.progressFile).toBeNull());
  });
  it('shows the API field error for progressFile', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    backend.failNext('PUT', 'workflows', { status: 400, message: 'Invalid progress file', errors: [{ field: 'progressFile', message: 'Invalid path' }] });
    click('Save workflow');
    expect(await screen.findByText('Invalid path')).toBeTruthy();
  });
  const looping = () => ({
    ...feature(),
    agentsDecide: true,
    nodes: [
      { name: 'Develop', role: '', agentId: A1, prompt: '/feature-dev {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
      { name: 'Test', role: '', agentId: A2, prompt: '/feature-test {input}', repeat: { mode: 'loop_back', to: 'Develop', max: 20 }, readOnly: false, approval: false, askOwner: false },
      { name: 'Review', role: '', agentId: A1, prompt: '/review', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
    ],
  });
  const options = label => [...screen.getByLabelText(label).options].map(option => option.textContent);
  const decide = () => screen.getByRole('checkbox', { name: 'Let agents decide' });
  const savedBody = () => backend.mutations().at(-1).body;

  it('adds a workflow whose second node loops back to the first, with agents deciding', async () => {
    await renderSettings({ agents: [codex(), cursor()] });
    click('Add workflow');
    expect(decide().checked).toBe(false);
    type('Workflow name', 'Build');
    fillNode(1, { name: 'Develop', agent: A1, prompt: '/feature-dev {input}' });
    click('Add node');
    fillNode(2, { name: 'Test', agent: A2, prompt: '/feature-test {input}', repeat: 'loop_back' });
    expect(options('Node 2 loops back to')).toEqual(['Choose a node', 'Node 1: Develop']);
    fireEvent.change(screen.getByLabelText('Node 2 loops back to'), { target: { value: screen.getByLabelText('Node 2 loops back to').options[1].value } });
    type('Node 2 maximum rounds', '20');
    fireEvent.click(decide());
    click('Save workflow');

    await waitFor(() => toast('success', 'Workflow "Build" added'));
    expect(savedBody()).toEqual({
      name: 'Build',
      kind: 'other',
      description: '',
      agentsDecide: true,
      progressFile: null,
      nodes: [
        { name: 'Develop', role: '', agentId: A1, prompt: '/feature-dev {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
        { name: 'Test', role: '', agentId: A2, prompt: '/feature-test {input}', repeat: { mode: 'loop_back', to: 'Develop', max: 20 }, readOnly: false, approval: false, askOwner: false },
      ],
    });
  });

  it('does not offer a loop on the first node, and offers only earlier nodes to loop back to', async () => {
    await renderSettings({ agents: [codex()], workflows: [looping()] });
    click('Edit workflow Feature');
    expect(options('Node 1 repeat')).toEqual(['Run once', 'Repeat until the agent reports COMPLETE']);
    expect(options('Node 2 repeat')).toHaveLength(3);
    type('Node 3 repeat', 'loop_back');
    expect(options('Node 3 loops back to')).toEqual(['Choose a node', 'Node 1: Develop', 'Node 2: Test']);
  });

  it('opens a saved loop on its node and rounds, and the saved choice of who decides', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [looping()] });
    click('Edit workflow Feature');
    expect(screen.getByLabelText('Node 2 repeat').value).toBe('loop_back');
    const target = screen.getByLabelText('Node 2 loops back to');
    expect(target.options[target.selectedIndex].textContent).toBe('Node 1: Develop');
    expect(screen.getByLabelText('Node 2 maximum rounds').value).toBe('20');
    expect(screen.queryByLabelText('Node 2 maximum passes')).toBeNull();
    expect(decide().checked).toBe(true);
    expect(lastDirty()).toBe(false);
  });

  it('tracks read-only and approval choices and disables approval on a loop closer', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    const readOnly = screen.getByRole('checkbox', { name: 'Node 1 read-only step' });
    expect(screen.getAllByText('Read-only step — The agent is told to change nothing except files in its run notes folder.')).toHaveLength(2);
    const approval = screen.getByRole('checkbox', { name: 'Node 2 wait for my approval' });
    expect(lastDirty()).toBe(false);
    fireEvent.click(readOnly);
    fireEvent.click(approval);
    expect(lastDirty()).toBe(true);
    expect(readOnly.checked).toBe(true);
    expect(approval.checked).toBe(true);
    type('Node 2 repeat', 'loop_back');
    expect(approval.disabled).toBe(true);
    expect(approval.checked).toBe(false);
    expect(screen.getByText('A step that closes a loop cannot wait for approval.')).toBeTruthy();
  });
  it('shows server field errors beside the read-only and approval checkboxes', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    backend.failNext('PUT', 'workflows', {
      status: 400, message: 'Validation failed',
      errors: [
        { field: 'nodes[0].readOnly', message: 'Read-only flag is invalid' },
        { field: 'nodes[1].approval', message: 'Approval flag is invalid' },
      ],
    });
    click('Edit workflow Feature');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Node 1 read-only step' }));
    click('Save workflow');
    expect(await screen.findByText('Read-only flag is invalid')).toBeTruthy();
    expect(screen.getByText('Approval flag is invalid')).toBeTruthy();
  });

  it('keeps a loop on the same node when that node is renamed', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [looping()] });
    click('Edit workflow Feature');
    type('Node 1 name', 'Build');
    click('Save workflow');
    await waitFor(() => toast('success', 'Workflow "Feature" saved'));
    expect(savedBody().nodes[1].repeat).toEqual({ mode: 'loop_back', to: 'Build', max: 20 });
  });

  it('refuses a loop whose node was moved after it, naming the field, and sends nothing', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [looping()] });
    click('Edit workflow Feature');
    click('Move node 1 down');
    expect(nodeNames()).toEqual(['Test', 'Develop', 'Review']);
    click('Save workflow');
    expect(screen.getByText('Choose an earlier node to loop back to')).toBeTruthy();
    expect(screen.getByLabelText('Node 1 loops back to').getAttribute('aria-invalid')).toBe('true');
    expect(backend.mutations()).toEqual([]);
  });

  it('refuses a loop whose node was removed', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [looping()] });
    click('Edit workflow Feature');
    click('Remove node 1');
    click('Save workflow');
    expect(screen.getByLabelText('Node 1 loops back to').value).toBe('');
    expect(screen.getByText('Choose an earlier node to loop back to')).toBeTruthy();
    expect(backend.mutations()).toEqual([]);
  });

  it.each(['', '0', '101', '2.5'])('rejects a maximum of "%s" rounds', async (max) => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [looping()] });
    click('Edit workflow Feature');
    type('Node 2 maximum rounds', max);
    click('Save workflow');
    expect(screen.getByText('Use a whole number from 1 to 100')).toBeTruthy();
    expect(screen.getByLabelText('Node 2 maximum rounds').getAttribute('aria-invalid')).toBe('true');
    expect(backend.mutations()).toEqual([]);
  });

  it('turns a loop back into a single pass, dropping its node and rounds', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [looping()] });
    click('Edit workflow Feature');
    type('Node 2 repeat', 'once');
    expect(screen.queryByLabelText('Node 2 loops back to')).toBeNull();
    click('Save workflow');
    await waitFor(() => toast('success', 'Workflow "Feature" saved'));
    expect(savedBody().nodes[1].repeat).toEqual({ mode: 'once' });
  });

  it('saves a changed choice of who decides and reports it as unsaved until then', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [looping()] });
    click('Edit workflow Feature');
    fireEvent.click(decide());
    expect(lastDirty()).toBe(true);
    click('Save workflow');
    await waitFor(() => toast('success', 'Workflow "Feature" saved'));
    expect(savedBody().agentsDecide).toBe(false);
  });

  it('shows a loop and who decides in the workflow list', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [looping()] });
    expect(workflows().getByText('3 nodes: Develop → Test ↺ Develop → Review · agents decide')).toBeTruthy();
  });

  it('renders an API error on the loop field', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [looping()] });
    click('Edit workflow Feature');
    backend.failNext('PUT', 'workflows', {
      status: 400, message: 'One or more fields failed validation.',
      errors: [{ field: 'nodes[1].repeat.to', message: 'Loops cannot share a node; this one overlaps the loop that ends at Test' }, { field: 'agentsDecide', message: 'Use true or false' }],
    });
    click('Save workflow');
    expect(await screen.findByText('Loops cannot share a node; this one overlaps the loop that ends at Test')).toBeTruthy();
    expect(screen.getByText('Use true or false')).toBeTruthy();
  });
});

describe('PipelineSettings — reuse: saved templates and saved steps', () => {
  const savedTemplate = () => ({
    id: '44444444-4444-4444-8444-444444444444', name: 'My hunt', kind: 'troubleshoot', description: 'Mine', agentsDecide: true, progressFile: null, revision: 1, ...STAMPS,
    nodes: [{ name: 'Look', role: 'Investigator', prompt: 'Look at {input}', repeat: { mode: 'once' }, readOnly: true, approval: false, askOwner: false }],
  });
  const savedStep = () => ({ id: '55555555-5555-4555-8555-555555555555', name: 'Security review', role: 'Reviewer', prompt: 'Review for security problems', repeat: { mode: 'until_complete', max: 2 }, readOnly: true, approval: false, askOwner: false, revision: 1, ...STAMPS });

  it('offers the built-in Troubleshoot and Review only templates', async () => {
    await renderSettings({ agents: [codex()] });
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }));
    expect(screen.getByRole('button', { name: /Review only.*report findings/ })).toBeTruthy();
    click(/Troubleshoot.*Gather evidence/);
    expect(screen.getByLabelText('Workflow kind').value).toBe('troubleshoot');
    expect(nodeNames()[0]).toBe('Clarify');
    expect(screen.getByLabelText('Node 5 loops back to').selectedOptions[0].textContent).toBe('Node 4: Fix');
    expect(screen.getByLabelText('Node 2 wait for my approval').checked).toBe(true);
  });

  it('starts a workflow from a template the owner saved, with no agents chosen yet', async () => {
    await renderSettings({ agents: [codex()], templates: [savedTemplate()] });
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }));
    click(/My hunt.*Mine/);
    expect(screen.getByLabelText('Workflow name').value).toBe('My hunt');
    expect(screen.getByLabelText('Workflow kind').value).toBe('troubleshoot');
    expect(screen.getByLabelText('Workflow description').value).toBe('Mine');
    expect(screen.getByLabelText('Node 1 role').value).toBe('Investigator');
    expect(screen.getByLabelText('Node 1 agent').value).toBe('');
    expect(screen.getByLabelText('Let agents decide').checked).toBe(true);
  });

  it('saves the open workflow as a template without its agents', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    type('Workflow description', 'Build and test');
    click('Save as template');
    await waitFor(() => toast('success', 'Template "Feature" saved'));
    expect(backend.mutations()).toEqual([{ method: 'POST', path: '/templates', body: {
      name: 'Feature', kind: 'other', description: 'Build and test', agentsDecide: false, progressFile: null,
      nodes: [
        { name: 'Develop', role: '', prompt: '/feature-dev {input}', repeat: { mode: 'until_complete', max: 20 }, readOnly: false, approval: false, askOwner: false },
        { name: 'Test', role: '', prompt: '/feature-test {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
      ],
    } }]);
    expect(screen.getByRole('region', { name: 'Workflow editor' })).toBeTruthy();
  });

  it('reports a template that could not be saved and one that is not valid yet', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    backend.failNext('POST', 'templates', { status: 409, message: 'A template with this name already exists' });
    click('Save as template');
    await waitFor(() => toast('error', 'A template with this name already exists'));
    type('Node 1 prompt', '');
    click('Save as template');
    await waitFor(() => toast('error', 'Fix the marked fields before saving this as a template.'));
    expect(backend.mutations()).toHaveLength(1);
  });

  it('deletes a saved template after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderSettings({ agents: [codex()], templates: [savedTemplate()] });
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }));
    click('Delete saved template My hunt');
    await waitFor(() => toast('success', 'Saved template "My hunt" deleted'));
    expect(backend.mutations()).toEqual([{ method: 'DELETE', path: `/templates/${savedTemplate().id}`, body: undefined }]);
  });

  it('saves a step for reuse, and refuses one that loops or has no prompt', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    type('Node 1 role', 'Developer');
    click('Save node 1 as a reusable step');
    await waitFor(() => toast('success', 'Step "Develop" saved'));
    expect(backend.mutations()).toEqual([{ method: 'POST', path: '/step-presets', body: { name: 'Develop', role: 'Developer', prompt: '/feature-dev {input}', repeat: { mode: 'until_complete', max: 20 }, readOnly: false, approval: false, askOwner: false } }]);
    type('Node 2 prompt', '');
    click('Save node 2 as a reusable step');
    await waitFor(() => toast('error', 'This step cannot be saved yet: Use 1–8192 characters without terminal control codes'));
    type('Node 2 repeat', 'loop_back');
    expect(screen.getByRole('button', { name: 'Save node 2 as a reusable step' }).disabled).toBe(true);
    expect(backend.mutations()).toHaveLength(1);
  });

  it('inserts a saved step as a copy at the end of the workflow', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()], stepPresets: [savedStep()] });
    click('Edit workflow Feature');
    expect([...screen.getByLabelText('Insert a saved step').options].map(option => option.textContent)).toEqual(['Insert a saved step…', 'Clarify (built in)', 'Requirements (built in)', 'Security review (Reviewer)']);
    type('Insert a saved step', savedStep().id);
    expect(nodeNames()).toEqual(['Develop', 'Test', 'Security review']);
    expect(screen.getByLabelText('Node 3 role').value).toBe('Reviewer');
    expect(screen.getByLabelText('Node 3 prompt').value).toBe('Review for security problems');
    expect(screen.getByLabelText('Node 3 read-only step').checked).toBe(true);
    expect(screen.getByLabelText('Node 3 maximum passes').value).toBe('2');
    expect(screen.getByLabelText('Node 3 agent').value).toBe('');
    expect(backend.mutations()).toEqual([]);
  });

  it('offers the built-in Feature from requirements template, which opens by asking the owner', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Add workflow' }));
    click(/Feature from requirements.*specification/);
    expect(screen.getByLabelText('Workflow kind').value).toBe('build');
    expect(nodeNames()).toEqual(['Requirements', 'Specify', 'Plan', 'Develop', 'Review', 'Test', 'Commit']);
    expect(screen.getByLabelText('Node 1 always ask me').checked).toBe(true);
    expect(screen.getByLabelText('Node 1 read-only step').checked).toBe(true);
    expect(screen.getByLabelText('Node 2 read-only step').checked).toBe(false);
    expect(backend.mutations()).toEqual([]);
  });

  it('inserts the built-in Requirements step into any workflow', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    type('Insert a saved step', 'requirements');
    expect(nodeNames()).toEqual(['Develop', 'Test', 'Requirements']);
    expect(screen.getByLabelText('Node 3 always ask me').checked).toBe(true);
    expect(screen.getByLabelText('Node 3 read-only step').checked).toBe(true);
    expect(screen.getByLabelText('Node 3 prompt').value).toMatch(/who it is for/);
    expect(backend.mutations()).toEqual([]);
  });

  it('inserts the built-in Clarify step, which always asks the owner, into any workflow', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    type('Insert a saved step', 'clarify');
    expect(nodeNames()).toEqual(['Develop', 'Test', 'Clarify']);
    expect(screen.getByLabelText('Node 3 always ask me').checked).toBe(true);
    expect(screen.getByLabelText('Node 3 read-only step').checked).toBe(true);
    expect(screen.getByLabelText('Node 3 prompt').value).toMatch(/Ask nothing you could find out yourself/);
    expect(backend.mutations()).toEqual([]);
  });

  it('saves whether a step always asks the owner', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [feature()] });
    click('Edit workflow Feature');
    expect(screen.getByLabelText('Node 1 always ask me').checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Node 1 always ask me'));
    expect(lastDirty()).toBe(true);
    click('Save workflow');
    await waitFor(() => expect(backend.mutations()).toHaveLength(1));
    expect(backend.mutations()[0].body.nodes.map(node => node.askOwner)).toEqual([true, false]);
  });

  it('lists saved steps and deletes one after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderSettings({ agents: [codex()], stepPresets: [savedStep()] });
    expect(screen.getByText('Saved steps (1)')).toBeTruthy();
    click('Delete saved step Security review');
    await waitFor(() => toast('success', 'Saved step "Security review" deleted'));
    expect(backend.mutations()).toEqual([{ method: 'DELETE', path: `/step-presets/${savedStep().id}`, body: undefined }]);
  });

  it('shows a workflow’s kind and description in the list', async () => {
    await renderSettings({ agents: [codex(), cursor()], workflows: [{ ...feature(), kind: 'build', description: 'Plan, build, test' }] });
    expect(workflows().getByText('Build')).toBeTruthy();
    expect(workflows().getByText('Plan, build, test')).toBeTruthy();
  });
});

describe('PipelineSettings — the way to the builder', () => {
  it('asks the app to open the workflow builder', async () => {
    const asked = vi.fn();
    window.addEventListener('codedeck:open-workflow-builder', asked);
    try {
      await renderSettings({ agents: [codex()] });
      click('Open the workflow builder');
      expect(asked).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('codedeck:open-workflow-builder', asked);
    }
  });
});

it('creates, edits and deletes a team from workflow settings', async () => {
  await renderSettings({ agents: [codex(), cursor()] });
  click('Add team');
  type('Team name', 'Daily');
  type('Member 1 role', 'Developer');
  type('Member 1 agent', A1);
  click('Save team');
  await screen.findByRole('button', { name: 'Edit Daily' });
  click('Edit Daily');
  type('Member 1 agent', A2);
  click('Save team');
  await waitFor(() => expect(backend.state.teams[0]).toMatchObject({ revision: 2, members: [{ role: 'Developer', agentId: A2 }] }));
  click('Delete Daily');
  await waitFor(() => expect(backend.state.teams).toEqual([]));
});
