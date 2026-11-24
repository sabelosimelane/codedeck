import { afterEach, describe, expect, it, vi } from 'vitest';
import { PipelineApiError, exportWorkflow, importWorkflow, previewImport } from '../pipelinesApi';

const W1 = '33333333-3333-4333-8333-333333333333';

function pkg() {
  return {
    format: 'codedeck.workflow',
    formatVersion: 1,
    source: { id: W1, version: 2 },
    exportedAt: '2026-11-24T13:05:52.000Z',
    workflow: {
      name: 'Bug fix', description: '', kind: 'bugfix', agentsDecide: false, progressFile: null,
      nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
    },
  };
}

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

afterEach(() => { vi.unstubAllGlobals(); });

describe('exportWorkflow', () => {
  it('downloads the package of a workflow', async () => {
    global.fetch = vi.fn(async () => jsonResponse(pkg()));
    await expect(exportWorkflow(W1)).resolves.toEqual(pkg());
    const [url, options] = global.fetch.mock.calls.at(-1);
    expect(url).toBe(`/api/pipelines/workflows/${W1}/export`);
    expect(options?.method ?? 'GET').toBe('GET');
  });

  it('rejects a response that is not a package', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ format: 'nope' }));
    await expect(exportWorkflow(W1)).rejects.toBeInstanceOf(PipelineApiError);
  });
});

describe('previewImport', () => {
  it('posts the package and returns the preview', async () => {
    const preview = { target: { mode: 'new' }, workflow: pkg().workflow, changes: [], missingRoles: ['Developer'] };
    global.fetch = vi.fn(async () => jsonResponse(preview));
    await expect(previewImport(pkg())).resolves.toEqual(preview);
    const [url, options] = global.fetch.mock.calls.at(-1);
    expect(url).toBe('/api/pipelines/workflow-imports/previews');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ package: pkg() });
  });

  it('rejects a preview with a bad target, changes or missing roles', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ target: { mode: 'new' }, workflow: pkg().workflow, changes: [], missingRoles: 'Developer' }));
    await expect(previewImport(pkg())).rejects.toBeInstanceOf(PipelineApiError);

    global.fetch = vi.fn(async () => jsonResponse({
      target: { mode: 'name-clash', workflowId: W1, revision: 1 },
      workflow: pkg().workflow, changes: [], missingRoles: [],
    }));
    await expect(previewImport(pkg())).rejects.toBeInstanceOf(PipelineApiError);

    global.fetch = vi.fn(async () => jsonResponse({
      target: { mode: 'update', workflowId: W1, revision: 1 },
      workflow: pkg().workflow, changes: [], missingRoles: [],
    }));
    await expect(previewImport(pkg())).rejects.toBeInstanceOf(PipelineApiError);
  });

  it('accepts name-clash and update targets with their required fields', async () => {
    const clash = {
      target: { mode: 'name-clash', workflowId: W1, revision: 1, suggestedName: 'Bug fix (imported)' },
      workflow: pkg().workflow, changes: [], missingRoles: [],
    };
    global.fetch = vi.fn(async () => jsonResponse(clash));
    await expect(previewImport(pkg())).resolves.toEqual(clash);

    const update = {
      target: { mode: 'update', workflowId: W1, revision: 2, fromVersion: 2 },
      workflow: pkg().workflow, changes: [], missingRoles: [],
    };
    global.fetch = vi.fn(async () => jsonResponse(update));
    await expect(previewImport(pkg())).resolves.toEqual(update);
  });

  it('carries the refusal message of the backend', async () => {
    global.fetch = vi.fn(async () => jsonResponse(
      { message: 'This file is version 1; Bug fix already took version 2 from it.' },
      { ok: false, status: 409 },
    ));
    const failure = await previewImport(pkg()).catch(error => error);
    expect(failure).toBeInstanceOf(PipelineApiError);
    expect(failure.status).toBe(409);
    expect(failure.message).toMatch(/already took version/);
  });

  it('rejects a preview whose workflow fails definition-field validation', async () => {
    const bad = {
      target: { mode: 'new' }, changes: [], missingRoles: [],
      workflow: { ...pkg().workflow, nodes: [{ name: 'Develop', prompt: 'Do it', repeat: { mode: 'once' } }] },
    };
    global.fetch = vi.fn(async () => jsonResponse(bad));
    await expect(previewImport(pkg())).rejects.toBeInstanceOf(PipelineApiError);
  });

  it('rejects a preview whose target workflowId is not a workflow UUID', async () => {
    const bad = {
      target: { mode: 'name-clash', workflowId: 'not-a-uuid', revision: 1, suggestedName: 'Bug fix (imported)' },
      workflow: pkg().workflow, changes: [], missingRoles: [],
    };
    global.fetch = vi.fn(async () => jsonResponse(bad));
    await expect(previewImport(pkg())).rejects.toBeInstanceOf(PipelineApiError);
  });

  it('rejects a staged-mode preview carrying changes (comparison arrives in Phase 3)', async () => {
    const clashTarget = { mode: 'name-clash', workflowId: W1, revision: 1, suggestedName: 'Bug fix (imported)' };
    const bodies = [
      { target: clashTarget, workflow: pkg().workflow, changes: [{}], missingRoles: [] },
      { target: { mode: 'update', workflowId: W1, revision: 2, fromVersion: 2 }, workflow: pkg().workflow, changes: [{}], missingRoles: [] },
      { target: { mode: 'up-to-date', workflowId: W1 }, workflow: pkg().workflow, changes: [{}], missingRoles: [] },
    ];
    for (const body of bodies) {
      global.fetch = vi.fn(async () => jsonResponse(body));
      await expect(previewImport(pkg())).rejects.toBeInstanceOf(PipelineApiError);
    }
  });

  it('rejects a new-workflow preview with changes or blank missing roles', async () => {
    const base = () => ({ target: { mode: 'new' }, workflow: pkg().workflow, changes: [], missingRoles: [] });
    const cases = [
      { ...base(), changes: [null], missingRoles: [''] },
      { ...base(), changes: [{ id: 'step:Develop.added' }] },
      { ...base(), missingRoles: [''] },
      { ...base(), missingRoles: ['   '] },
    ];
    for (const body of cases) {
      global.fetch = vi.fn(async () => jsonResponse(body));
      await expect(previewImport(pkg())).rejects.toBeInstanceOf(PipelineApiError);
    }
  });
});

describe('importWorkflow', () => {
  it('posts the package with its target and returns the created workflow', async () => {
    const created = {
      id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Bug fix', kind: 'bugfix', description: '', agentsDecide: false,
      progressFile: null, revision: 1, nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
      source: { kind: 'imported', id: W1, version: 2, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null },
      createdAt: '2026-11-24T13:05:52.000Z', updatedAt: '2026-11-24T13:05:52.000Z',
    };
    global.fetch = vi.fn(async () => jsonResponse(created, { status: 201 }));
    await expect(importWorkflow(pkg(), { mode: 'new' })).resolves.toMatchObject({ id: created.id, name: 'Bug fix' });
    const [url, options] = global.fetch.mock.calls.at(-1);
    expect(url).toBe('/api/pipelines/workflow-imports');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ package: pkg(), target: { mode: 'new' } });
  });

  it('rejects a response without an id, source or nodes', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ id: 'x' }, { status: 201 }));
    await expect(importWorkflow(pkg(), { mode: 'new' })).rejects.toBeInstanceOf(PipelineApiError);
  });

  it('rejects a receipt missing persisted fields the write validator lets callers omit', async () => {
    const receipt = () => ({
      id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Bug fix', kind: 'bugfix', description: '', agentsDecide: false,
      progressFile: null, revision: 1,
      nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
      source: { kind: 'imported', id: W1, version: 2, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null },
      createdAt: '2026-11-24T13:05:52.000Z', updatedAt: '2026-11-24T13:05:52.000Z',
    });
    const without = (mutate) => { const body = receipt(); mutate(body); return body; };
    const cases = [
      without(body => { delete body.description; }),
      without(body => { delete body.kind; }),
      without(body => { delete body.progressFile; }),
      without(body => { delete body.nodes[0].readOnly; }),
      without(body => { delete body.nodes[0].approval; }),
      without(body => { delete body.nodes[0].askOwner; }),
      without(body => { body.nodes[0].agentId = null; }),
    ];
    for (const body of cases) {
      global.fetch = vi.fn(async () => jsonResponse(body, { status: 201 }));
      await expect(importWorkflow(pkg(), { mode: 'new' })).rejects.toBeInstanceOf(PipelineApiError);
    }
  });

  it('rejects a receipt with an impossible calendar date in any timestamp field', async () => {
    const receipt = () => ({
      id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Bug fix', kind: 'bugfix', description: '', agentsDecide: false,
      progressFile: null, revision: 1,
      nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
      source: { kind: 'imported', id: W1, version: 2, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null },
      createdAt: '2026-11-24T13:05:52.000Z', updatedAt: '2026-11-24T13:05:52.000Z',
    });
    const impossible = '2026-02-30T13:05:52.000Z';
    const cases = [
      { ...receipt(), createdAt: impossible },
      { ...receipt(), updatedAt: impossible },
      { ...receipt(), source: { ...receipt().source, updatedToVersionAt: impossible } },
    ];
    for (const body of cases) {
      global.fetch = vi.fn(async () => jsonResponse(body, { status: 201 }));
      await expect(importWorkflow(pkg(), { mode: 'new' })).rejects.toBeInstanceOf(PipelineApiError);
    }
  });

  it('accepts a receipt carrying a real source update timestamp', async () => {
    const body = {
      id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Bug fix', kind: 'bugfix', description: '', agentsDecide: false,
      progressFile: null, revision: 1,
      nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
      source: { kind: 'imported', id: W1, version: 2, latestVersion: null, updateAvailable: false, updatedToVersionAt: '2026-02-28T13:05:52.000Z', shipped: null },
      createdAt: '2026-11-24T13:05:52.000Z', updatedAt: '2026-11-24T13:05:52.000Z',
    };
    global.fetch = vi.fn(async () => jsonResponse(body, { status: 201 }));
    await expect(importWorkflow(pkg(), { mode: 'new' })).resolves.toMatchObject({ id: body.id });
  });

  it('rejects a new-import receipt that is not linked to the package source', async () => {
    const linked = () => ({
      id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Bug fix', kind: 'bugfix', description: '', agentsDecide: false,
      progressFile: null, revision: 1,
      nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
      source: { kind: 'imported', id: W1, version: 2, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null },
      createdAt: '2026-11-24T13:05:52.000Z', updatedAt: '2026-11-24T13:05:52.000Z',
    });
    const cases = [
      { ...linked(), source: { kind: 'local', id: null, version: null, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null } },
      { ...linked(), source: { ...linked().source, id: 'bbbbbbbb-2222-4222-8222-222222222222' } },
      { ...linked(), source: { ...linked().source, version: 3 } },
    ];
    for (const body of cases) {
      global.fetch = vi.fn(async () => jsonResponse(body, { status: 201 }));
      await expect(importWorkflow(pkg(), { mode: 'new' })).rejects.toBeInstanceOf(PipelineApiError);
    }
    // Without the sent package's source, linkage cannot be verified — reject even
    // a well-shaped imported receipt (the soft gate would have accepted it).
    global.fetch = vi.fn(async () => jsonResponse(linked(), { status: 201 }));
    const { source: _source, ...withoutSource } = pkg();
    await expect(importWorkflow(withoutSource, { mode: 'new' })).rejects.toBeInstanceOf(PipelineApiError);
  });

  it('rejects a new-import receipt whose step already has an agent', async () => {
    const receipt = {
      id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Bug fix', kind: 'bugfix', description: '', agentsDecide: false,
      progressFile: null, revision: 1,
      nodes: [{ name: 'Develop', role: 'Developer', agentId: W1, prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
      source: { kind: 'imported', id: W1, version: 2, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null },
      createdAt: '2026-11-24T13:05:52.000Z', updatedAt: '2026-11-24T13:05:52.000Z',
    };
    global.fetch = vi.fn(async () => jsonResponse(receipt, { status: 201 }));
    await expect(importWorkflow(pkg(), { mode: 'new' })).rejects.toBeInstanceOf(PipelineApiError);
  });

  it('rejects a malformed import receipt for each bad part', async () => {
    const receipt = () => ({
      id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Bug fix', kind: 'bugfix', description: '', agentsDecide: false,
      progressFile: null, revision: 1,
      nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
      source: { kind: 'imported', id: W1, version: 2, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null },
      createdAt: '2026-11-24T13:05:52.000Z', updatedAt: '2026-11-24T13:05:52.000Z',
    });
    const cases = [
      { ...receipt(), id: 'bad' },
      { ...receipt(), source: { kind: 'unexpected' } },
      { ...receipt(), source: { kind: 'imported', id: 'bad', version: 2 } },
      // §4.4 view is incomplete: kind/id/version alone are not enough
      { ...receipt(), source: { kind: 'imported', id: W1, version: 2 } },
      { ...receipt(), source: { kind: 'imported', id: W1, version: 2, latestVersion: 3, updateAvailable: false, updatedToVersionAt: null, shipped: null } },
      { ...receipt(), source: { ...receipt().source, version: 2 ** 31 } },
      { ...receipt(), createdAt: 'not-a-time' },
      { ...receipt(), nodes: [null] },
      { ...receipt(), nodes: [{ name: 'Develop', prompt: 'Do it' }] },
    ];
    for (const body of cases) {
      global.fetch = vi.fn(async () => jsonResponse(body, { status: 201 }));
      await expect(importWorkflow(pkg(), { mode: 'new' })).rejects.toBeInstanceOf(PipelineApiError);
    }
  });
});
