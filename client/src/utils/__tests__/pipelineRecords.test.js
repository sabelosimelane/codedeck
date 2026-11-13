import { afterEach, describe, expect, it, vi } from 'vitest';
import { PipelineApiError } from '../pipelinesApi';
import { loadDefinitions, parseAgent, parseSettings, parseWorkflow } from '../pipelineRecords';

const A1 = '11111111-1111-4111-8111-111111111111';
const W1 = '33333333-3333-4333-8333-333333333333';

const agent = (patch = {}) => ({
  id: A1, name: 'codex', launchCommand: 'codex', resetCommand: '/clear', revision: 1,
  createdAt: '2026-11-13T11:00:00.000Z', updatedAt: '2026-11-13T11:00:00.000Z', ...patch,
});
const node = (patch = {}) => ({ name: 'Develop', agentId: A1, prompt: '/dev {input}', repeat: { mode: 'once' }, ...patch });
const STAMPS = { createdAt: '2026-11-13T11:00:00.000Z', updatedAt: '2026-11-13T12:30:00.000Z' };
const workflow = (patch = {}) => ({ id: W1, name: 'Feature', revision: 2, nodes: [node()], ...STAMPS, ...patch });

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
  ])('rejects a workflow with a bad %s', (field, patch) => {
    rejects(parseWorkflow, workflow(patch), field);
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
