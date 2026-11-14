import { afterEach, describe, expect, it, vi } from 'vitest';
import { PipelineApiError } from '../pipelinesApi';
import { loadDefinitions, parseAgent, parsePreflight, parseSettings, parseWorkflow, parseWorktree } from '../pipelineRecords';

const A1 = '11111111-1111-4111-8111-111111111111';
const W1 = '33333333-3333-4333-8333-333333333333';

const agent = (patch = {}) => ({
  id: A1, name: 'codex', launchCommand: 'codex', resetCommand: '/clear', revision: 1,
  createdAt: '2026-11-13T11:00:00.000Z', updatedAt: '2026-11-13T11:00:00.000Z', ...patch,
});
const node = (patch = {}) => ({ name: 'Develop', agentId: A1, prompt: '/dev {input}', repeat: { mode: 'once' }, ...patch });
const STAMPS = { createdAt: '2026-11-13T11:00:00.000Z', updatedAt: '2026-11-13T12:30:00.000Z' };
const workflow = (patch = {}) => ({ id: W1, name: 'Feature', agentsDecide: false, revision: 2, nodes: [node()], ...STAMPS, ...patch });

function rejects(parse, record, field) {
  let failure;
  try { parse(record); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PipelineApiError);
  expect(failure.message).toContain(field);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('parseAgent', () => {
  it('returns every field of a valid agent and nothing else', () => {
    expect(parseAgent({ ...agent(), extra: 'ignored' })).toEqual(agent());
  });

  it.each([
    ['id', { id: 'not-a-uuid' }],
    ['id', { id: undefined }],
    ['name', { name: '' }],
    ['name', { name: 7 }],
    ['launchCommand', { launchCommand: '   ' }],
    ['launchCommand', { launchCommand: null }],
    ['resetCommand', { resetCommand: '' }],
    ['resetCommand', { resetCommand: undefined }],
    ['revision', { revision: 0 }],
    ['revision', { revision: '1' }],
    ['revision', { revision: 1.5 }],
    ['createdAt', { createdAt: undefined }],
    ['createdAt', { createdAt: 'yesterday' }],
    ['updatedAt', { updatedAt: 1794583395754 }],
    ['updatedAt', { updatedAt: '2026-11-13 11:00:00' }],
  ])('rejects an agent with a bad %s', (field, patch) => {
    rejects(parseAgent, agent(patch), field);
  });

  it('rejects a response that is not an object without echoing a command', () => {
    rejects(parseAgent, null, 'agent');
    let failure;
    try { parseAgent(agent({ revision: 0, launchCommand: 'codex --secret-flag' })); } catch (error) { failure = error; }
    expect(failure.message).not.toContain('secret-flag');
    expect(failure.message).toContain(A1);
  });
});

describe('parseWorkflow', () => {
  it('keeps the workflow with both repeat shapes', () => {
    const record = workflow({ nodes: [node({ repeat: { mode: 'until_complete', max: 100 } }), node({ name: 'Test' })] });
    expect(parseWorkflow({ ...record, extra: 'ignored' })).toEqual(record);
  });

  it.each([
    ['id', { id: 'w1' }],
    ['name', { name: ' ' }],
    ['revision', { revision: null }],
    ['createdAt', { createdAt: '' }],
    ['updatedAt', { updatedAt: null }],
    ['nodes', { nodes: [] }],
    ['nodes', { nodes: 'none' }],
    ['nodes[0]', { nodes: [null] }],
    ['nodes[0].name', { nodes: [node({ name: '' })] }],
    ['nodes[0].agentId', { nodes: [node({ agentId: 'codex' })] }],
    ['nodes[0].prompt', { nodes: [node({ prompt: 5 })] }],
    ['nodes[0].repeat', { nodes: [node({ repeat: null })] }],
    ['nodes[0].repeat.mode', { nodes: [node({ repeat: { mode: 'forever' } })] }],
    ['nodes[1].repeat.max', { nodes: [node(), node({ repeat: { mode: 'until_complete', max: 0 } })] }],
    ['nodes[0].repeat.max', { nodes: [node({ repeat: { mode: 'until_complete', max: 101 } })] }],
    ['nodes[0].repeat.max', { nodes: [node({ repeat: { mode: 'until_complete' } })] }],
    ['nodes[0].repeat.max', { nodes: [node({ repeat: { mode: 'once', max: 3 } })] }],
    ['agentsDecide', { agentsDecide: undefined }],
    ['agentsDecide', { agentsDecide: 'true' }],
    ['agentsDecide', { agentsDecide: 1 }],
    ['nodes[1].repeat.to', { nodes: [node(), node({ name: 'Test', repeat: { mode: 'loop_back', max: 5 } })] }],
    ['nodes[1].repeat.to', { nodes: [node(), node({ name: 'Test', repeat: { mode: 'loop_back', to: '  ', max: 5 } })] }],
    ['nodes[1].repeat.to', { nodes: [node(), node({ name: 'Test', repeat: { mode: 'loop_back', to: 7, max: 5 } })] }],
    ['nodes[1].repeat.to', { nodes: [node(), node({ name: 'Test', repeat: { mode: 'loop_back', to: 'Test', max: 5 } })] }],
    ['nodes[1].repeat.to', { nodes: [node(), node({ name: 'Test', repeat: { mode: 'loop_back', to: 'Deploy', max: 5 } })] }],
    ['nodes[0].repeat.to', { nodes: [node({ repeat: { mode: 'once', to: 'Develop' } })] }],
    ['nodes[0].repeat.to', { nodes: [node({ repeat: { mode: 'until_complete', max: 3, to: 'Develop' } })] }],
    ['nodes[1].repeat.max', { nodes: [node(), node({ name: 'Test', repeat: { mode: 'loop_back', to: 'Develop' } })] }],
    ['nodes[1].repeat.max', { nodes: [node(), node({ name: 'Test', repeat: { mode: 'loop_back', to: 'Develop', max: 0 } })] }],
    ['nodes[1].repeat.max', { nodes: [node(), node({ name: 'Test', repeat: { mode: 'loop_back', to: 'Develop', max: 101 } })] }],
  ])('rejects a workflow with a bad %s', (field, patch) => {
    rejects(parseWorkflow, workflow(patch), field);
  });

  it('keeps who decides and a loop back to an earlier node', () => {
    const record = workflow({
      agentsDecide: true,
      nodes: [node(), node({ name: 'Test', repeat: { mode: 'loop_back', to: 'Develop', max: 20 } }), node({ name: 'Review' })],
    });
    expect(parseWorkflow(record)).toEqual(record);
  });
});

describe('parseSettings', () => {
  it('accepts no setup agent or an agent id', () => {
    expect(parseSettings({ setupAgentId: null, revision: 1 })).toEqual({ setupAgentId: null, revision: 1 });
    expect(parseSettings({ setupAgentId: A1, revision: 9 })).toEqual({ setupAgentId: A1, revision: 9 });
  });

  it.each([
    ['setupAgentId', { setupAgentId: undefined, revision: 1 }],
    ['setupAgentId', { setupAgentId: '', revision: 1 }],
    ['revision', { setupAgentId: null, revision: 0 }],
    ['settings', 'nope'],
  ])('rejects settings with a bad %s', (field, record) => {
    rejects(parseSettings, record, field);
  });
});

describe('loadDefinitions', () => {
  const page = data => ({ ok: true, status: 200, json: async () => ({ data, page: { hasNextPage: false } }) });

  function stubBackend({ agents = [agent()], workflows = [workflow()], settings = { setupAgentId: A1, revision: 3 } } = {}) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/agents')) return page(agents);
      if (String(url).includes('/workflows')) return page(workflows);
      return { ok: true, status: 200, json: async () => settings };
    }));
  }

  it('returns validated agents, workflows and settings', async () => {
    stubBackend();
    await expect(loadDefinitions()).resolves.toEqual({
      agents: [parseAgent(agent())],
      workflows: [workflow()],
      settings: { setupAgentId: A1, revision: 3 },
    });
  });

  it('fails as a whole when any record is invalid', async () => {
    stubBackend({ workflows: [workflow({ revision: 0 })] });
    await expect(loadDefinitions()).rejects.toThrow(/revision/);
  });
});

describe('parseWorktree', () => {
  const HEAD = 'a'.repeat(40);
  const worktree = (patch = {}) => ({
    path: '/git/worktrees/demo-feature', name: 'demo-feature', branch: 'feature/x', head: HEAD,
    current: false, dirty: true, selectable: true, reason: null, ...patch,
  });
  const blocked = worktree({ branch: null, dirty: null, selectable: false, reason: { code: 'missing', message: 'The worktree directory is missing.' } });

  it('returns every field of a valid worktree and nothing else', () => {
    expect(parseWorktree({ ...worktree(), extra: 'ignored' })).toEqual(worktree());
    expect(parseWorktree({ ...blocked, reason: { ...blocked.reason, extra: 1 } })).toEqual(blocked);
  });

  it.each(['missing', 'unreadable', 'detached', 'in_use'])('accepts the reason code %s', (code) => {
    const record = worktree({ dirty: null, selectable: false, reason: { code, message: 'Why it cannot be chosen.' } });
    expect(parseWorktree(record)).toEqual(record);
  });

  it.each([
    ['worktree', null],
    ['worktree', []],
    ['path', worktree({ path: 'relative/dir' })],
    ['path', worktree({ path: '/a\nb' })],
    ['path', worktree({ path: 7 })],
    ['name', worktree({ name: '' })],
    ['name', worktree({ name: undefined })],
    ['branch', worktree({ branch: '' })],
    ['branch', worktree({ branch: undefined })],
    ['head', worktree({ head: 'abc' })],
    ['head', worktree({ head: null })],
    ['current', worktree({ current: 'false' })],
    ['dirty', worktree({ dirty: 'no' })],
    ['dirty', worktree({ dirty: undefined })],
    ['selectable', worktree({ selectable: 1 })],
    ['reason', worktree({ reason: undefined })],
    ['reason', worktree({ reason: 'in_use' })],
    ['reason.code', worktree({ selectable: false, reason: { code: 'whatever', message: 'x' } })],
    ['reason.message', worktree({ selectable: false, reason: { code: 'in_use', message: '' } })],
    ['selectable', worktree({ selectable: true, reason: { code: 'in_use', message: 'x' } })],
    ['selectable', worktree({ selectable: false, reason: null })],
  ])('rejects an invalid %s', (field, record) => {
    rejects(parseWorktree, record, field);
  });
});

describe('parsePreflight', () => {
  const HEAD = 'b'.repeat(40);
  const preflight = (patch = {}) => ({ project: 'Demo', eligible: true, reasons: [], branch: 'main', head: HEAD, dirty: false, ...patch });
  const blocked = preflight({
    eligible: false, branch: null, head: null, dirty: null,
    reasons: [{ code: 'not_git_toplevel', message: 'The project path must be the top level of a git working tree.' }],
  });

  it('returns every field of a valid preflight and nothing else', () => {
    expect(parsePreflight({ ...preflight(), extra: 1 })).toEqual(preflight());
    expect(parsePreflight(blocked)).toEqual(blocked);
  });

  it.each([
    ['preflight', null],
    ['project', preflight({ project: '' })],
    ['eligible', preflight({ eligible: 'true' })],
    ['reasons', preflight({ reasons: undefined })],
    ['reasons', preflight({ reasons: {} })],
    ['reasons[0]', preflight({ eligible: false, reasons: ['nope'] })],
    ['reasons[0].code', preflight({ eligible: false, reasons: [{ code: '', message: 'x' }] })],
    ['reasons[0].message', preflight({ eligible: false, reasons: [{ code: 'x', message: 5 }] })],
    ['eligible', preflight({ eligible: true, reasons: [{ code: 'x', message: 'y' }] })],
    ['eligible', preflight({ eligible: false, reasons: [] })],
    ['branch', preflight({ branch: '' })],
    ['branch', preflight({ branch: undefined })],
    ['head', preflight({ head: 'abc' })],
    ['head', preflight({ head: undefined })],
    ['dirty', preflight({ dirty: 'no' })],
    ['dirty', preflight({ dirty: undefined })],
  ])('rejects an invalid %s', (field, record) => {
    rejects(parsePreflight, record, field);
  });
});

