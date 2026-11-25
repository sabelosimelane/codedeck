import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../../ToastContext', () => ({ useToast: () => ({ showToast }) }));

import WorkflowsScreen from '../WorkflowsScreen';
import { onOpenWorkflowBuilder, openWorkflowBuilder } from '../../../../utils/workflowBuilder';

const TIMEOUTS = { agentReadySeconds: 120, resetSettleSeconds: 15, finalSignalIdleSeconds: 24, lostPromptSeconds: 30, stallWarningMinutes: 15 };

const A1 = '11111111-1111-4111-8111-111111111111';
const W1 = '33333333-3333-4333-8333-333333333333';
const STAMPS = { createdAt: '2026-11-13T11:00:00.000Z', updatedAt: '2026-11-13T11:00:00.000Z' };
const agent = { id: A1, name: 'codex-high', launchCommand: 'command codex', resetCommand: '/clear', revision: 1, ...STAMPS };
const roles = ['Planner', 'Developer', 'Tester'].map((name, index) => ({ id: `44444444-4444-4444-8444-44444444444${index}`, name, description: '', revision: 1, ...STAMPS }));
const localSource = { kind: 'local', id: null, version: null, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null };
const feature = () => ({
  id: W1, name: 'Feature', kind: 'build', description: 'Plan, build, test', agentsDecide: false, progressFile: null, revision: 3, source: { ...localSource }, ...STAMPS,
  nodes: [
    { name: 'Plan', role: 'Planner', prompt: 'Plan {input}', repeat: { mode: 'once' }, readOnly: true, approval: true, askOwner: false },
    { name: 'Develop', role: 'Developer', prompt: 'Build it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false },
    { name: 'Test', role: 'Tester', prompt: 'Test it', repeat: { mode: 'loop_back', to: 'Develop', max: 5 }, readOnly: false, approval: false, askOwner: false },
  ],
});

let requests;
function stubBackend({ workflows = [feature()], preview = { prompt: 'Plan docs/x.md\n\nCodeDeck workflow instruction: …', skillRewrite: false }, fail = null } = {}) {
  requests = [];
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const page = data => json({ data, page: { hasNextPage: false } });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const path = new URL(url, 'http://codedeck.test').pathname.replace('/api/pipelines', '');
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    requests.push({ method: options.method ?? 'GET', path, body });
    if (fail === path) return json({ message: 'Pipelines request failed' }, 500);
    if (path === '/agents') return page([agent]);
    if (path === '/roles') return page(roles);
    if (path === '/workflows' && !options.method) return page(workflows);
    if (path === '/templates' || path === '/step-presets') return page([]);
    if (path === '/settings') return json({ setupAgentId: A1, setupEffort: null, defaultBaseBranch: null, timeouts: TIMEOUTS, revision: 1 });
    if (path === '/prompt-previews') return typeof preview === 'function' ? preview(body) : json(preview);
    if (path === `/workflows/${W1}` && options.method === 'PUT') return json({ ...feature(), ...body, revision: body.revision + 1 });
    throw new Error(`unexpected request ${options.method ?? 'GET'} ${path}`);
  }));
}

async function open(options) {
  stubBackend(options);
  const onClose = vi.fn();
  render(<WorkflowsScreen onClose={onClose} />);
  await screen.findByRole('button', { name: 'Edit workflow Feature' });
  return { onClose };
}
const rail = () => within(screen.getByRole('navigation', { name: 'Steps of this workflow' }));
const steps = () => rail().getAllByRole('button').filter(button => /^Step \d+:/.test(button.getAttribute('aria-label'))).map(button => button.getAttribute('aria-label'));
const previews = () => requests.filter(request => request.path === '/prompt-previews');

beforeEach(() => { showToast.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('WorkflowsScreen', () => {
  it('lists workflows with their kind and opens one as steps beside the open step', async () => {
    await open();
    expect(screen.getByRole('dialog', { name: 'Workflow builder' })).toBeTruthy();
    expect(screen.getByText('Plan, build, test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit workflow Feature' }));
    expect(steps()).toEqual(['Step 1: Plan', 'Step 2: Develop', 'Step 3: Test']);
    expect(rail().getByRole('button', { name: 'Step 1: Plan' }).getAttribute('aria-current')).toBe('step');
    expect(rail().getByText('Tester · ↺ Develop')).toBeTruthy();
    expect(rail().getByText('Planner · approval')).toBeTruthy();
    // Only the open step's fields are on screen, with a large prompt editor.
    expect(screen.getAllByLabelText(/^Node \d+ name$/).map(input => input.value)).toEqual(['Plan']);
    expect(screen.getByLabelText('Node 1 prompt').rows).toBe(14);
    fireEvent.click(rail().getByRole('button', { name: 'Step 3: Test' }));
    expect(screen.getAllByLabelText(/^Node \d+ name$/).map(input => input.value)).toEqual(['Test']);
    expect(screen.getByLabelText('Node 3 loops back to').selectedOptions[0].textContent).toBe('Node 2: Develop');
  });

  it('shows what the open step’s agent is sent, asked of the backend without agents', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit workflow Feature' }));
    await waitFor(() => expect(screen.getByText(/CodeDeck workflow instruction/)).toBeTruthy(), { timeout: 3000 });
    const first = previews().at(-1).body;
    expect(first).toMatchObject({ nodeIndex: 0, input: '' });
    expect(first.workflow.nodes.every(node => !('agentId' in node))).toBe(true);
    expect(first.workflow.nodes[0]).toMatchObject({ name: 'Plan', prompt: 'Plan {input}', readOnly: true });

    fireEvent.change(screen.getByLabelText('Example input'), { target: { value: 'docs/x.md' } });
    fireEvent.click(rail().getByRole('button', { name: 'Step 2: Develop' }));
    await waitFor(() => expect(previews().at(-1).body).toMatchObject({ nodeIndex: 1, input: 'docs/x.md' }), { timeout: 3000 });
    expect(screen.getByText(/are filled in when a run starts/)).toBeTruthy();
  });

  it('says why there is no preview yet instead of showing a stale one', async () => {
    await open({ preview: () => ({ ok: false, status: 400, json: async () => ({ message: 'One or more fields failed validation.', errors: [{ field: 'workflow.nodes[0].prompt', message: 'Use 1–8192 characters without terminal control codes' }] }) }) });
    fireEvent.click(screen.getByRole('button', { name: 'Edit workflow Feature' }));
    await waitFor(() => expect(screen.getByText('No preview yet — nodes[0].prompt: Use 1–8192 characters without terminal control codes')).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByText(/are filled in when a run starts/)).toBeNull();
  });

  it('mentions the Codex spelling only when the step starts with a skill', async () => {
    await open({ preview: { prompt: '/feature-spec x', skillRewrite: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit workflow Feature' }));
    await waitFor(() => expect(screen.getByText(/written \$skill when Codex runs the step/)).toBeTruthy(), { timeout: 3000 });
  });

  it('reorders steps by drag, keeps the loop on the step it named, and saves the new order', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit workflow Feature' }));
    const plan = rail().getByRole('button', { name: 'Step 1: Plan' });
    const develop = rail().getByRole('button', { name: 'Step 2: Develop' });
    fireEvent.dragStart(develop);
    fireEvent.dragOver(plan);
    fireEvent.drop(plan);
    expect(steps()).toEqual(['Step 1: Develop', 'Step 2: Plan', 'Step 3: Test']);
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(requests.some(request => request.method === 'PUT')).toBe(true));
    const saved = requests.find(request => request.method === 'PUT').body;
    expect(saved.nodes.map(node => node.name)).toEqual(['Develop', 'Plan', 'Test']);
    expect(saved.nodes[2].repeat).toEqual({ mode: 'loop_back', to: 'Develop', max: 5 });
    expect(saved.revision).toBe(3);
  });

  it('adds a step and opens it, and dropping a step on itself changes nothing', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit workflow Feature' }));
    const plan = rail().getByRole('button', { name: 'Step 1: Plan' });
    fireEvent.dragStart(plan);
    fireEvent.drop(plan);
    expect(steps()).toEqual(['Step 1: Plan', 'Step 2: Develop', 'Step 3: Test']);
    fireEvent.click(rail().getByRole('button', { name: 'Add step' }));
    expect(steps()).toEqual(['Step 1: Plan', 'Step 2: Develop', 'Step 3: Test', 'Step 4: no name yet']);
    expect(rail().getByRole('button', { name: 'Step 4: no name yet' }).getAttribute('aria-current')).toBe('step');
    expect(screen.getByLabelText('Node 4 name').value).toBe('');
  });

  it('marks the step that has an invalid field when saving is refused locally', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit workflow Feature' }));
    fireEvent.click(rail().getByRole('button', { name: 'Step 2: Develop' }));
    fireEvent.change(screen.getByLabelText('Node 2 prompt'), { target: { value: '' } });
    fireEvent.click(rail().getByRole('button', { name: 'Step 1: Plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    expect(rail().getByLabelText('This step has an invalid field')).toBeTruthy();
    expect(requests.some(request => request.method === 'PUT')).toBe(false);
  });

  it('asks before closing over unsaved changes, by button or Escape, and closes at once when clean', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { onClose } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Edit workflow Feature' }));
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Feature 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close the workflow builder' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
    cleanup();
    const clean = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Close the workflow builder' }));
    expect(clean.onClose).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('reports a load failure with the API message and loads again on Retry', async () => {
    stubBackend({ fail: '/workflows' });
    render(<WorkflowsScreen onClose={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Pipelines request failed');
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Pipelines request failed' });
    stubBackend();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Edit workflow Feature' })).toBeTruthy();
  });
});

describe('asking for the workflow builder', () => {
  it('calls every listener until it stops listening', () => {
    const handler = vi.fn();
    const stop = onOpenWorkflowBuilder(handler);
    act(() => openWorkflowBuilder());
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
    act(() => openWorkflowBuilder());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(() => onOpenWorkflowBuilder(null)).toThrow('handler must be a function');
  });
});

it('preserves an unsaved workflow while inspecting the improvement dashboard',async()=>{
  await open();
  fireEvent.click(screen.getByRole('button',{name:'Edit workflow Feature'}));
  fireEvent.change(screen.getByLabelText('Workflow name'),{target:{value:'Unsaved workflow'}});
  fireEvent.click(screen.getByRole('button',{name:'Improvements',exact:true}));
  expect(screen.queryByRole('region',{name:'Workflows'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Workflow builder',exact:true}));
  expect(screen.getByLabelText('Workflow name').value).toBe('Unsaved workflow');
});

it('shows disabled in the builder step rail when a step is unchecked', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Edit workflow Feature' }));
  fireEvent.click(screen.getByLabelText('Node 1 enabled'));
  expect(rail().getByText('Planner · approval · disabled')).toBeTruthy();
});
