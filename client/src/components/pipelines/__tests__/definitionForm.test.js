import { describe, expect, it, vi } from 'vitest';
import { PipelineApiError } from '../../../utils/pipelinesApi';
import { diagnoseSaveFailure, errorsByField, failureMessage } from '../definitionForm';

const refused = status => new PipelineApiError('refused', { status });

describe('failureMessage', () => {
  it('uses the API message, and names an unreachable server or a failure with no message', () => {
    expect(failureMessage(new PipelineApiError('Cannot delete the current setup agent', { status: 409 }))).toBe('Cannot delete the current setup agent');
    expect(failureMessage(new TypeError('Failed to fetch'))).toBe('Server unreachable');
    expect(failureMessage(new Error(''))).toBe('Pipelines request failed');
  });
});

describe('errorsByField', () => {
  it('keys messages by field and keeps every message for a field', () => {
    expect(errorsByField([
      { field: 'name', message: 'Too long' },
      { field: 'nodes[0].prompt', message: 'Required' },
      { field: 'name', message: 'Already used' },
    ])).toEqual({ name: 'Too long. Already used', 'nodes[0].prompt': 'Required' });
    expect(errorsByField([])).toEqual({});
  });
});

describe('diagnoseSaveFailure', () => {
  it('treats a 404 as gone without reading the item back', async () => {
    const fetchLatest = vi.fn();
    await expect(diagnoseSaveFailure(refused(404), 1, fetchLatest)).resolves.toEqual({ kind: 'gone' });
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it.each([400, 500, 0])('treats status %s as a plain rejection without reading the item back', async (status) => {
    const fetchLatest = vi.fn();
    await expect(diagnoseSaveFailure(refused(status), 1, fetchLatest)).resolves.toEqual({ kind: 'rejected' });
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it('tells a stale revision from another conflict by reading the item back', async () => {
    const latest = { id: 'x', revision: 2 };
    await expect(diagnoseSaveFailure(refused(409), 1, async () => latest)).resolves.toEqual({ kind: 'stale', latest });
    await expect(diagnoseSaveFailure(refused(409), 2, async () => latest)).resolves.toEqual({ kind: 'rejected' });
  });

  it('reports gone when the item vanished, and a rejection when it cannot be read back', async () => {
    await expect(diagnoseSaveFailure(refused(409), 1, async () => { throw refused(404); })).resolves.toEqual({ kind: 'gone' });
    await expect(diagnoseSaveFailure(refused(409), 1, async () => { throw new TypeError('Failed to fetch'); })).resolves.toEqual({ kind: 'rejected' });
  });
});
