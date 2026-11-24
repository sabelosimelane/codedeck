import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('lucide-react', () => {
  const Icon = () => null;
  return { ArrowDown: Icon, ArrowUp: Icon, BookmarkPlus: Icon, Copy: Icon, Download: Icon, Pencil: Icon, Plus: Icon, Trash2: Icon, Upload: Icon, X: Icon };
});

import WorkflowList from '../WorkflowList';
import WorkflowEditor from '../WorkflowEditor';

const STAMPS = { createdAt: '2026-11-24T13:00:00.000Z', updatedAt: '2026-11-24T13:00:00.000Z' };
const localSource = () => ({ kind: 'local', id: null, version: null, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null });
const importedSource = (id, version) => ({ kind: 'imported', id, version, latestVersion: null, updateAvailable: false, updatedToVersionAt: null, shipped: null });

const workflow = (patch = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', name: 'Bug fix', kind: 'bugfix', description: 'Fix things.',
  agentsDecide: false, progressFile: null, revision: 1, source: localSource(),
  nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
  ...STAMPS, ...patch,
});

function pkg(name = 'Bug fix') {
  return {
    format: 'codedeck.workflow', formatVersion: 1,
    source: { id: '123e4567-e89b-42d3-a456-426614174000', version: 2 },
    exportedAt: '2026-11-24T13:05:52.000Z',
    workflow: {
      name, description: 'Fix things.', kind: 'bugfix', agentsDecide: false, progressFile: null,
      nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }],
    },
  };
}

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); toast.mockClear(); });

function renderList(props = {}) {
  const onChanged = vi.fn(async () => {});
  const onDirtyChange = vi.fn();
  render(<WorkflowList workflows={props.workflows ?? []} agents={[]} templates={[]} stepPresets={[]} variant="form" onChanged={onChanged} onDirtyChange={onDirtyChange} />);
  return { onChanged };
}

function chooseFile(input, content) {
  const file = new File([JSON.stringify(content)], 'bug-fix.codedeck-workflow.json', { type: 'application/json' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('workflow import', () => {
  it('imports a new file and toasts success', async () => {
    const { onChanged } = renderList();
    global.fetch = vi.fn(async (url) => {
      const target = String(url);
      if (target.endsWith('/workflow-imports/previews')) {
        return jsonResponse({ target: { mode: 'new' }, workflow: pkg().workflow, changes: [], missingRoles: ['Developer'] });
      }
      if (target.endsWith('/workflow-imports')) {
        return jsonResponse({ ...workflow({ name: 'Bug fix', source: importedSource('123e4567-e89b-42d3-a456-426614174000', 2), nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }] }), revision: 1 }, { status: 201 });
      }
      throw new Error(`unexpected request ${target}`);
    });

    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    chooseFile(screen.getByLabelText(/package file/i), pkg());
    await waitFor(() => expect(screen.getByText(/no team gives these roles/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    const [, options] = global.fetch.mock.calls.at(-1);
    expect(JSON.parse(options.body)).toEqual({ package: pkg(), target: { mode: 'new' } });
  });

  it('offers a copy with another name on a clash', async () => {
    const { onChanged } = renderList({ workflows: [workflow()] });
    global.fetch = vi.fn(async (url) => {
      const target = String(url);
      if (target.endsWith('/workflow-imports/previews')) {
        return jsonResponse({ target: { mode: 'name-clash', workflowId: workflow().id, revision: 1, suggestedName: 'Bug fix (imported)' }, workflow: pkg().workflow, changes: [], missingRoles: [] });
      }
      if (target.endsWith('/workflow-imports')) {
        return jsonResponse({ ...workflow({ name: 'Bug fix (imported)', source: importedSource('123e4567-e89b-42d3-a456-426614174000', 2), nodes: [{ name: 'Develop', role: 'Developer', prompt: 'Do it', repeat: { mode: 'once' }, readOnly: false, approval: false, askOwner: false }] }), revision: 1 }, { status: 201 });
      }
      throw new Error(`unexpected request ${target}`);
    });

    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    chooseFile(screen.getByLabelText(/package file/i), pkg());
    await waitFor(() => expect(screen.getByDisplayValue('Bug fix (imported)')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /import as a copy/i }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('disables the copy apply and marks the field invalid while the typed name clashes', async () => {
    renderList({ workflows: [workflow()] });
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/workflow-imports/previews')) {
        return jsonResponse({ target: { mode: 'name-clash', workflowId: workflow().id, revision: 1, suggestedName: 'Bug fix (imported)' }, workflow: pkg().workflow, changes: [], missingRoles: [] });
      }
      throw new Error(`unexpected request ${url}`);
    });
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    chooseFile(screen.getByLabelText(/package file/i), pkg());
    const copyName = await waitFor(() => screen.getByDisplayValue('Bug fix (imported)'));
    fireEvent.change(copyName, { target: { value: 'Bug fix' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /import as a copy/i }).disabled).toBe(true));
    expect(screen.getByLabelText(/copy name/i).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/already taken/i);
  });

  it('shows the package export timestamp in new and name-clash previews', async () => {
    renderList();
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/workflow-imports/previews')) {
        return jsonResponse({ target: { mode: 'new' }, workflow: pkg().workflow, changes: [], missingRoles: [] });
      }
      throw new Error(`unexpected request ${url}`);
    });
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    chooseFile(screen.getByLabelText(/package file/i), pkg());
    await waitFor(() => expect(screen.getByText(/24 Nov 2026/i)).toBeTruthy());
    cleanup();

    renderList({ workflows: [workflow()] });
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/workflow-imports/previews')) {
        return jsonResponse({ target: { mode: 'name-clash', workflowId: workflow().id, revision: 1, suggestedName: 'Bug fix (imported)' }, workflow: pkg().workflow, changes: [], missingRoles: [] });
      }
      throw new Error(`unexpected request ${url}`);
    });
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    chooseFile(screen.getByLabelText(/package file/i), pkg());
    await waitFor(() => expect(screen.getByText(/24 Nov 2026/i)).toBeTruthy());
  });

  it('toasts failure when the preview or the import is refused', async () => {
    renderList();
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/workflow-imports/previews')) {
        return jsonResponse({ message: 'This file is version 1; Bug fix already took version 2 from it.' }, { ok: false, status: 409 });
      }
      throw new Error(`unexpected request ${url}`);
    });
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    chooseFile(screen.getByLabelText(/package file/i), pkg());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));

    toast.mockClear();
    global.fetch = vi.fn(async (url) => {
      const target = String(url);
      if (target.endsWith('/workflow-imports/previews')) {
        return jsonResponse({ target: { mode: 'new' }, workflow: pkg().workflow, changes: [], missingRoles: [] });
      }
      return jsonResponse({ message: 'A workflow with this name already exists' }, { ok: false, status: 409 });
    });
    chooseFile(screen.getByLabelText(/package file/i), pkg());
    await waitFor(() => expect(screen.getByRole('button', { name: /^import$/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'A workflow with this name already exists' })));
  });

  it('marks an imported workflow with its version', () => {
    renderList({ workflows: [workflow({ source: importedSource('123e4567-e89b-42d3-a456-426614174000', 2) })] });
    expect(screen.getByText(/imported, version 2/i)).toBeTruthy();
  });

  it('says already up to date and does not apply when the same file is re-imported', async () => {
    renderList({ workflows: [workflow({ source: importedSource('123e4567-e89b-42d3-a456-426614174000', 2) })] });
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/workflow-imports/previews')) {
        return jsonResponse({
          target: { mode: 'up-to-date', workflowId: workflow().id },
          workflow: pkg().workflow,
          changes: [],
          missingRoles: [],
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    chooseFile(screen.getByLabelText(/package file/i), pkg());
    await waitFor(() => expect(screen.getByText(/already up to date/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^import$/i })).toBeNull();
    expect(global.fetch.mock.calls.some(([url]) => String(url).endsWith('/workflow-imports') && !String(url).endsWith('/previews'))).toBe(false);
  });

  it('explains that an update is not offered yet and does not apply', async () => {
    renderList({ workflows: [workflow({ source: importedSource('123e4567-e89b-42d3-a456-426614174000', 2) })] });
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/workflow-imports/previews')) {
        return jsonResponse({
          target: { mode: 'update', workflowId: workflow().id, revision: 1, fromVersion: 2 },
          workflow: pkg().workflow,
          changes: [],
          missingRoles: [],
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    fireEvent.click(screen.getByRole('button', { name: /import/i }));
    chooseFile(screen.getByLabelText(/package file/i), { ...pkg(), source: { id: '123e4567-e89b-42d3-a456-426614174000', version: 3 } });
    await waitFor(() => expect(screen.getByText(/not offered in this release/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^import$/i })).toBeNull();
    expect(global.fetch.mock.calls.some(([url]) => String(url).endsWith('/workflow-imports') && !String(url).endsWith('/previews'))).toBe(false);
  });
});

describe('workflow export', () => {
  function renderEditor(patch = {}) {
    const onSaved = vi.fn(async () => {});
    render(<WorkflowEditor workflow={workflow(patch)} agents={[]} stepPresets={[]} variant="form" onSaved={onSaved} onChanged={vi.fn()} onCancel={vi.fn()} onDirtyChange={vi.fn()} onLibraryChanged={vi.fn()} />);
    return { onSaved };
  }

  it('exports a saved workflow with every step role and toasts success', async () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
    const { onSaved } = renderEditor();
    void onSaved;
    global.fetch = vi.fn(async () => jsonResponse(pkg()));
    const clicked = [];
    const appendChild = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation(node => { clicked.push(node); return appendChild(node); });
    fireEvent.click(screen.getByRole('button', { name: /export/i }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining(`/api/pipelines/workflows/${workflow().id}/export`), expect.anything()));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/exported/i) })));
  });

  it('disables export with its reason on unsaved edits', async () => {
    renderEditor();
    const button = screen.getByRole('button', { name: /export/i });
    expect(button.disabled).toBe(false);
    // Editing the name dirties the draft: export waits for a save.
    fireEvent.change(screen.getByLabelText(/workflow name/i), { target: { value: 'Bug fix 2' } });
    const dirty = screen.getByRole('button', { name: /export/i });
    expect(dirty.disabled).toBe(true);
    expect(dirty.title).toMatch(/save before exporting/i);
  });

  it('toasts failure when the export is refused', async () => {
    renderEditor();
    global.fetch = vi.fn(async () => jsonResponse({ message: 'Give every step a role before exporting: Test.' }, { ok: false, status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: /export/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Give every step a role before exporting: Test.' })));
  });

  it('saves a workflow without its source', async () => {
    const { onSaved } = renderEditor();
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes(`/workflows/${workflow().id}`) && !String(url).endsWith('/export')) {
        return jsonResponse({ ...workflow(), revision: 2 });
      }
      throw new Error(`unexpected request ${url}`);
    });
    fireEvent.click(screen.getByRole('button', { name: /save workflow/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [, options] = global.fetch.mock.calls.at(-1);
    expect(JSON.parse(options.body)).not.toHaveProperty('source');
  });
});
