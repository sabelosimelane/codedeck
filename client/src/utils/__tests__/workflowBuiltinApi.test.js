import { afterEach, describe, expect, it, vi } from 'vitest';
import { PipelineApiError, addBuiltinWorkflow, dismissBuiltinWorkflow, listBuiltinWorkflows } from '../pipelinesApi';

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });
afterEach(() => { vi.unstubAllGlobals(); });

const STAMPS = { createdAt: '2026-11-24T13:00:00.000Z', updatedAt: '2026-11-24T13:00:00.000Z' };
const builtinSource = (version = 1) => ({
  kind: 'builtin', id: 'bug-fix', version, latestVersion: version,
  updateAvailable: false, updatedToVersionAt: null, shipped: true,
});
const builtinRow = (patch = {}) => ({
  id: 'bug-fix', name: 'Bug fix', kind: 'bugfix', description: 'Fix things.', version: 1,
  status: 'new', workflowId: null, ...patch,
});
const builtinWorkflow = (patch = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', name: 'Bug fix', kind: 'bugfix', description: 'Fix things.',
  agentsDecide: false, progressFile: null, revision: 1, source: builtinSource(), ...STAMPS,
  nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
  ...patch,
});

describe('listBuiltinWorkflows', () => {
  it('resolves the shipped rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [builtinRow(), builtinRow({ id: 'quick-change', name: 'Quick change', status: 'linked', workflowId: '22222222-2222-4222-8222-222222222222' })], page: { hasNextPage: false } })));
    const rows = await listBuiltinWorkflows();
    expect(rows.map(row => row.id)).toEqual(['bug-fix', 'quick-change']);
  });

  it.each([
    ['bad status', { status: 'old' }],
    ['linked without a workflow', { status: 'linked', workflowId: null }],
    ['new with a workflow', { status: 'new', workflowId: '22222222-2222-4222-8222-222222222222' }],
    ['bad version', { version: 0 }],
    ['bad id', { id: 'Bad_ID' }],
    ['65-char id', { id: 'a'.repeat(65) }],
  ])('rejects a row with %s', async (_label, patch) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [builtinRow(patch)], page: { hasNextPage: false } })));
    await expect(listBuiltinWorkflows()).rejects.toBeInstanceOf(PipelineApiError);
  });
});

describe('addBuiltinWorkflow', () => {
  it('resolves the linked 201 receipt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(builtinWorkflow(), { status: 201 })));
    const created = await addBuiltinWorkflow('bug-fix');
    expect(created.source).toMatchObject({ kind: 'builtin', id: 'bug-fix' });
  });

  it.each([
    ['local source', {
      source: { kind: 'local', id: null, version: null, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null },
    }],
    ['wrong built-in id', { source: { ...builtinSource(1), id: 'quick-change' } }],
    ['shipped with null latestVersion', { source: { ...builtinSource(1), latestVersion: null, updateAvailable: true, shipped: true } }],
    ['unshipped with updateAvailable', { source: { ...builtinSource(1), latestVersion: null, updateAvailable: true, shipped: false } }],
    ['unshipped with latestVersion', { source: { ...builtinSource(1), latestVersion: 2, updateAvailable: false, shipped: false } }],
    ['impossible updatedToVersionAt', { source: { ...builtinSource(1), updatedToVersionAt: '2026-02-30T00:00:00.000Z' } }],
    ['assigned agent', {
      nodes: [{ name: 'Develop', role: 'Developer', agentId: 'a1b2c3d4-1111-4111-8111-111111111111', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
    }],
  ])('rejects a receipt with %s', async (_label, patch) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(builtinWorkflow(patch), { status: 201 })));
    await expect(addBuiltinWorkflow('bug-fix')).rejects.toBeInstanceOf(PipelineApiError);
  });
});

describe('dismissBuiltinWorkflow', () => {
  it('resolves on 204, rejects HTTP 200 JSON, and throws the problem detail on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) })));
    await expect(dismissBuiltinWorkflow('bug-fix')).resolves.toEqual({});
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true }, { ok: true, status: 200 })));
    await expect(dismissBuiltinWorkflow('bug-fix')).rejects.toBeInstanceOf(PipelineApiError);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Built-in workflow not found' }, { ok: false, status: 404 })));
    const failure = await dismissBuiltinWorkflow('nope').catch(error => error);
    expect(failure).toBeInstanceOf(PipelineApiError);
    expect(failure.status).toBe(404);
  });
});
