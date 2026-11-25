import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTaskTabs } from '../useTaskTabs';

const STORAGE_KEY = 'codedeck-dismissed-task-tabs';
const NO_TASKS = [];

describe('useTaskTabs stored dismissals', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ['unparseable JSON', '{not json'],
    ['a value that is not a list', '{"project":"Alpha"}'],
    ['a stored task the current client no longer accepts', '[{"id":"t1","project":"Alpha"}]'],
  ])('reports %s, discards it and keeps the app running', (_label, stored) => {
    localStorage.setItem(STORAGE_KEY, stored);
    const showToast = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useTaskTabs(NO_TASKS, showToast));

    expect(result.current.tasks).toEqual([]);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('dismissed task tabs') }));
    expect(console.error).toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('[]');
  });

  it('keeps working when the browser refuses to store dismissals', () => {
    const showToast = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });

    const { result } = renderHook(() => useTaskTabs(NO_TASKS, showToast));

    expect(result.current.tasks).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('QuotaExceededError'));
  });
});
