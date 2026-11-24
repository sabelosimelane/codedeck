import { afterEach, describe, expect, it, vi } from 'vitest';
import { PipelineApiError } from '../pipelinesApi';
import { loadDefinitions, parseTeam, parseAgent, parsePreflight, parseRunPlan, parseSettings, parseStepPreset, parseTemplate, parseWorkflow, parseWorktree } from '../pipelineRecords';

const A1 = '11111111-1111-4111-8111-111111111111';
const W1 = '33333333-3333-4333-8333-333333333333';

const agent = (patch = {}) => ({
  id: A1, name: 'codex', launchCommand: 'codex', resetCommand: '/clear', revision: 1,
  createdAt: '2026-11-13T11:00:00.000Z', updatedAt: '2026-11-13T11:00:00.000Z', ...patch,
});
const node = (patch = {}) => ({ name: 'Develop', role: '', agentId: A1, prompt: '/dev {input}', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false, ...patch });
const STAMPS = { createdAt: '2026-11-13T11:00:00.000Z', updatedAt: '2026-11-13T12:30:00.000Z' };
const workflow = (patch = {}) => ({ id: W1, name: 'Feature', kind: 'other', description: '', agentsDecide: false, progressFile: null, revision: 2, nodes: [node()], ...STAMPS, ...patch });

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
  it('rejects malformed node flags independently', () => {
    expect(parseWorkflow(workflow({ nodes: [node({ readOnly: true, approval: true, askOwner: false })] })).nodes[0]).toMatchObject({ readOnly: true, approval: true, askOwner: false });
    for (const flag of ['readOnly', 'approval']) for (const value of [undefined, null, 'true']) {
      rejects(parseWorkflow, workflow({ nodes: [node({ [flag]: value })] }), `nodes[0].${flag}`);
    }
  });
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
    ['progressFile', { progressFile: undefined }],
    ['progressFile', { progressFile: '' }],
    ['progressFile', { progressFile: 5 }],
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
    expect(parseSettings({ setupAgentId: null, defaultBaseBranch: null, revision: 1 })).toEqual({ setupAgentId: null, defaultBaseBranch: null, revision: 1 });
    expect(parseSettings({ setupAgentId: A1, defaultBaseBranch: null, revision: 9 })).toEqual({ setupAgentId: A1, defaultBaseBranch: null, revision: 9 });
    expect(parseSettings({ setupAgentId: null, defaultBaseBranch: 'develop', revision: 2 }).defaultBaseBranch).toBe('develop');
  });

  it.each([
    ['setupAgentId', { setupAgentId: undefined, defaultBaseBranch: null, revision: 1 }],
    ['setupAgentId', { setupAgentId: '', defaultBaseBranch: null, revision: 1 }],
    ['revision', { setupAgentId: null, defaultBaseBranch: null, revision: 0 }],
    ['defaultBaseBranch', { setupAgentId: null, revision: 1 }],
    ['defaultBaseBranch', { setupAgentId: null, defaultBaseBranch: 'a b', revision: 1 }],
    ['settings', 'nope'],
  ])('rejects settings with a bad %s', (field, record) => {
    rejects(parseSettings, record, field);
  });
});

describe('loadDefinitions', () => {
  const page = data => ({ ok: true, status: 200, json: async () => ({ data, page: { hasNextPage: false } }) });

  function stubBackend({ agents = [agent()], workflows = [workflow()], settings = { setupAgentId: A1, defaultBaseBranch: null, revision: 3 }, templates = [], stepPresets = [] } = {}) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/agents')) return page(agents);
      if (String(url).includes('/workflows')) return page(workflows);
      if (String(url).includes('/templates')) return page(templates);
      if (String(url).includes('/step-presets')) return page(stepPresets);
      return { ok: true, status: 200, json: async () => settings };
    }));
  }

  it('returns validated agents, workflows and settings', async () => {
    stubBackend();
    await expect(loadDefinitions()).resolves.toEqual({
      agents: [parseAgent(agent())],
      workflows: [workflow()],
      settings: { setupAgentId: A1, defaultBaseBranch: null, revision: 3 },
      templates: [],
      stepPresets: [],
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

describe('parseRunPlan', () => {
  const entry = (patch = {}) => ({ repository: 'mobile-app', role: 'todo', todo: 'docs/todos/phone.md', input: 'todos/phone.md', listed: true, present: true, ...patch });
  const plan = (patch = {}) => ({ progressFile: 'docs/todos/tag.md', input: 'todos/tag.md', foundIn: 'backend', problem: null,
    repositories: [{ repository: 'backend', role: 'this', todo: null, input: null, listed: true, present: null }, entry(), { repository: 'frontend', role: 'minor', todo: null, input: null, listed: false, present: null }], ...patch });
  const empty = { progressFile: null, input: 'fix the login', foundIn: null, problem: null, repositories: null };

  it('returns the plan with only the fields it knows', () => {
    expect(parseRunPlan({ ...plan(), extra: 1 })).toEqual(plan());
    expect(parseRunPlan(empty)).toEqual(empty);
    expect(parseRunPlan(plan({ repositories: null, problem: 'backend (major): use this todo' }))).toMatchObject({ repositories: null, problem: 'backend (major): use this todo' });
    expect(parseRunPlan(plan({ repositories: [entry({ input: null, present: false })] })).repositories).toEqual([entry({ input: null, present: false })]);
  });

  it.each([
    ['plan', null], ['plan', []],
  ])('refuses a %s that is not an object (%j)', (_field, value) => {
    expect(() => parseRunPlan(value)).toThrow('Invalid run plan field plan');
  });

  it.each([
    ['progressFile', ''], ['progressFile', 7], ['progressFile', undefined],
    ['input', ''], ['input', null],
    ['foundIn', ''], ['foundIn', 7], ['foundIn', undefined],
    ['problem', ''], ['problem', undefined],
    ['repositories', undefined], ['repositories', 'backend'],
  ])('refuses an invalid %s (%j)', (field, value) => {
    expect(() => parseRunPlan(plan({ [field]: value }))).toThrow(`Invalid run plan field ${field}`);
  });

  it.each([
    ['repository', ''], ['repository', 7],
    ['role', 'major'], ['role', undefined],
    ['todo', ''], ['todo', undefined],
    ['input', ''], ['input', undefined],
    ['listed', 'yes'], ['listed', undefined],
    ['present', 'yes'], ['present', undefined],
  ])('refuses a repository with an invalid %s (%j)', (field, value) => {
    expect(() => parseRunPlan(plan({ repositories: [entry({ [field]: value })] }))).toThrow(`Invalid run plan field repositories[0].${field}`);
  });

  it('refuses a repository whose todo does not go with its role', () => {
    expect(() => parseRunPlan(plan({ repositories: [entry({ role: 'minor' })] }))).toThrow('Invalid run plan field repositories[0].todo');
    expect(() => parseRunPlan(plan({ repositories: [entry({ todo: null })] }))).toThrow('Invalid run plan field repositories[0].todo');
    expect(() => parseRunPlan(plan({ repositories: [null] }))).toThrow('Invalid run plan field repositories[0]');
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


describe('kind, description, roles and what the owner saved', () => {
  const { agentId, ...templateNode } = node({ role: 'Developer' });
  const template = (patch = {}) => ({ ...workflow({ kind: 'build', description: 'Mine', nodes: [templateNode] }), ...patch });
  const preset = (patch = {}) => ({ id: W1, name: 'Review', role: 'Reviewer', prompt: 'Review', repeat: { mode: 'until_complete', max: 3 }, readOnly: true, approval: false, askOwner: false, revision: 1, ...STAMPS, ...patch });

  it('keeps a workflow’s kind, description and step roles', () => {
    const parsed = parseWorkflow(workflow({ kind: 'troubleshoot', description: 'Find the cause', nodes: [node({ role: 'Investigator' })] }));
    expect(parsed).toMatchObject({ kind: 'troubleshoot', description: 'Find the cause' });
    expect(parsed.nodes[0].role).toBe('Investigator');
  });

  it.each([
    [{ kind: 'deploy' }, 'kind'], [{ kind: undefined }, 'kind'], [{ description: null }, 'description'], [{ description: 'x'.repeat(281) }, 'description'],
    [{ nodes: [node({ role: undefined })] }, 'nodes[0].role'], [{ nodes: [node({ role: 'x'.repeat(33) })] }, 'nodes[0].role'], [{ nodes: [node({ role: 12 })] }, 'nodes[0].role'],
  ])('rejects a workflow with %j', (patch, field) => rejects(parseWorkflow, workflow(patch), field));

  it('reads a saved template, which names no agents', () => {
    expect(parseTemplate(template())).toEqual(template());
    rejects(parseTemplate, template({ nodes: [node()] }), 'nodes[0].agentId');
    rejects(parseTemplate, template({ name: '' }), 'name');
    rejects(parseTemplate, null, 'template');
    rejects(parseWorkflow, template(), 'nodes[0].agentId');
  });

  it('reads a saved step and returns exactly its fields', () => {
    expect(parseStepPreset({ ...preset(), surprise: 1 })).toEqual(preset());
    expect(parseStepPreset(preset({ repeat: { mode: 'once', max: 9 } })).repeat).toEqual({ mode: 'once' });
  });

  it.each([
    [{ id: 'x' }, 'id'], [{ name: '' }, 'name'], [{ role: null }, 'role'], [{ prompt: ' ' }, 'prompt'],
    [{ repeat: { mode: 'loop_back', to: 'Develop', max: 3 } }, 'repeat.mode'], [{ repeat: null }, 'repeat.mode'], [{ repeat: { mode: 'until_complete', max: 0 } }, 'repeat.max'],
    [{ readOnly: 'yes' }, 'readOnly'], [{ approval: undefined }, 'approval'], [{ revision: 0 }, 'revision'], [{ createdAt: 'x' }, 'createdAt'], [{ updatedAt: null }, 'updatedAt'],
  ])('rejects a saved step with %j', (patch, field) => rejects(parseStepPreset, preset(patch), field));

  it('loads saved templates and steps with the definitions, and fails as a whole on a bad one', async () => {
    const page = data => ({ ok: true, status: 200, json: async () => ({ data, page: { hasNextPage: false } }) });
    const stub = (templates, presets) => vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/agents')) return page([agent()]);
      if (String(url).includes('/workflows')) return page([workflow()]);
      if (String(url).includes('/templates')) return page(templates);
      if (String(url).includes('/step-presets')) return page(presets);
      return { ok: true, status: 200, json: async () => ({ setupAgentId: A1, defaultBaseBranch: null, revision: 3 }) };
    }));
    stub([template()], [preset()]);
    await expect(loadDefinitions()).resolves.toMatchObject({ templates: [template()], stepPresets: [preset()] });
    stub([template()], [preset({ prompt: '' })]);
    await expect(loadDefinitions()).rejects.toThrow('Invalid saved step from the pipelines API: prompt');
  });
});

describe('a step that always asks the owner', () => {
  const stepFields = { name: 'Develop', role: '', agentId: A1, prompt: '/dev {input}', repeat: { mode: 'once' }, readOnly: false, approval: false };
  it('is read from a workflow node and a saved step, and must be a boolean', () => {
    expect(parseWorkflow(workflow({ nodes: [{ ...stepFields, askOwner: true }] })).nodes[0].askOwner).toBe(true);
    rejects(parseWorkflow, workflow({ nodes: [stepFields] }), 'nodes[0].askOwner');
    rejects(parseWorkflow, workflow({ nodes: [{ ...stepFields, askOwner: 'yes' }] }), 'nodes[0].askOwner');
    const preset = { id: W1, name: 'Clarify', role: '', prompt: 'Ask', repeat: { mode: 'once' }, readOnly: true, approval: false, askOwner: true, revision: 1, ...STAMPS };
    expect(parseStepPreset(preset).askOwner).toBe(true);
    const { askOwner, ...without } = preset;
    rejects(parseStepPreset, without, 'askOwner');
  });
});

describe('parseTeam', () => {
  it('retains a valid team role fallback and accepts legacy members', () => {
    const base = { id: W1, name: 'Daily', revision: 1, ...STAMPS };
    for (const patch of [{}, { fallbackAgentId: 'c410a1b2-3456-4789-8abc-def012345679' }]) {
      const members = [{ role: 'Developer', agentId: A1, ...patch }];
      expect(parseTeam({ ...base, members }).members).toEqual(members);
    }
  });

  it.each([
    ['id', { id: null }], ['name', { name: '' }], ['members', { members: [] }],
    ['role', { members: [{ role: null, agentId: A1 }] }], ['agentId', { members: [{ role: 'Developer', agentId: null }] }],
    ['fallbackAgentId', { members: [{ role: 'Developer', agentId: A1, fallbackAgentId: {} }] }],
    ['fallbackAgentId', { members: [{ role: 'Developer', agentId: A1, fallbackAgentId: null }] }],
    ['fallbackAgentId', { members: [{ role: 'Developer', agentId: A1, fallbackAgentId: A1 }] }],
    ['createdAt', { createdAt: null }], ['updatedAt', { updatedAt: 'invalid' }], ['revision', { revision: null }],
  ])('refuses an invalid %s from the teams API', (field, patch) => {
    rejects(parseTeam, { id: W1, name: 'Daily', members: [{ role: 'Developer', agentId: A1 }], revision: 1, ...STAMPS, ...patch }, field);
  });
});
