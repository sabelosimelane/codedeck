import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { TASK_TITLE_MAX, TaskRepositories, TaskTitleInput } from '../NewTaskFields.jsx';

const repo = (name, overrides = {}) => ({ name, path: `/group/${name}`, own: false, branch: 'main', head: 'a'.repeat(40), dirty: false, usable: true, reason: null, ...overrides });
const REPOSITORIES = [repo('backend', { own: true }), repo('mobile-app', { branch: 'develop' }), repo('tools', { branch: null }),
  repo('frontend', { branch: null, head: null, dirty: null, usable: false, reason: { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' } })];
const box = name => screen.getByRole('checkbox', { name });

afterEach(cleanup);

describe('TaskTitleInput', () => {
  it('asks for a title of at most 80 characters and passes on what is typed', () => {
    const onChange = vi.fn();
    render(<TaskTitleInput value="" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Task title' });
    expect(TASK_TITLE_MAX).toBe(80);
    expect(input.maxLength).toBe(80);
    expect(input.placeholder).toBe('For example: WhatsApp replies');
    fireEvent.change(input, { target: { value: 'Replies' } });
    expect(onChange).toHaveBeenCalledWith('Replies');
  });

  it('says what happens to a title that may be left empty', () => {
    render(<TaskTitleInput value="" onChange={vi.fn()} optional />);
    expect(screen.getByRole('textbox', { name: 'Task title' }).placeholder).toBe('Named from the work once the run starts, or type a title');
  });
});

describe('TaskRepositories', () => {
  it('lists every repository with where its copy would start from, ticked as told', () => {
    render(<TaskRepositories repositories={REPOSITORIES} ticked={new Set(['backend'])} onToggle={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Repositories' })).toBeTruthy();
    expect(screen.getByText('The task gets its own copy of each one ticked. The others stay readable and can be added to the task later.')).toBeTruthy();
    expect(box('backend').checked).toBe(true);
    expect(box('mobile-app').checked).toBe(false);
    expect(screen.getByText('from main')).toBeTruthy();
    expect(screen.getByText('from develop')).toBeTruthy();
    expect(screen.getByText('from its current commit')).toBeTruthy();
    expect(screen.queryByText('Tick at least one repository.')).toBeNull();
  });

  it('shows a repository Git cannot use with why, and does not let it be ticked', () => {
    render(<TaskRepositories repositories={REPOSITORIES} ticked={new Set(['frontend'])} onToggle={vi.fn()} />);
    expect(box('frontend').disabled).toBe(true);
    expect(box('frontend').checked).toBe(false);
    expect(screen.getByText('This folder is not the top level of a Git working tree.')).toBeTruthy();
  });

  it('reports the repository ticked or unticked', () => {
    const onToggle = vi.fn();
    render(<TaskRepositories repositories={REPOSITORIES} ticked={new Set(['backend'])} onToggle={onToggle} />);
    fireEvent.click(box('mobile-app'));
    fireEvent.click(box('backend'));
    expect(onToggle.mock.calls).toEqual([['mobile-app'], ['backend']]);
  });

  it('says so when nothing is ticked', () => {
    render(<TaskRepositories repositories={REPOSITORIES} ticked={new Set()} onToggle={vi.fn()} />);
    expect(screen.getByText('Tick at least one repository.')).toBeTruthy();
  });

  it('keeps the repository a run starts in ticked, and says that is why', () => {
    const onToggle = vi.fn();
    render(<TaskRepositories repositories={REPOSITORIES} ticked={new Set()} onToggle={onToggle} startsIn="mobile-app" />);
    expect(box('mobile-app').checked).toBe(true);
    expect(box('mobile-app').disabled).toBe(true);
    expect(screen.getByText('the run starts here')).toBeTruthy();
    expect(box('backend').checked).toBe(false);
    expect(box('backend').disabled).toBe(false);
    expect(screen.queryByText('Tick at least one repository.')).toBeNull();
  });

  it('lets nothing be changed while it is disabled', () => {
    render(<TaskRepositories repositories={REPOSITORIES} ticked={new Set(['backend'])} onToggle={vi.fn()} disabled />);
    expect(box('backend').disabled).toBe(true);
    expect(box('mobile-app').disabled).toBe(true);
  });

  it.each([
    ['repositories', { repositories: null }, 'repositories must be an array'],
    ['ticked', { ticked: ['backend'] }, 'ticked must be a Set'],
    ['onToggle', { onToggle: null }, 'onToggle must be a function'],
    ['startsIn', { startsIn: 'website' }, 'startsIn must be one of the repositories: website'],
  ])('refuses an invalid %s', (_name, patch, message) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<TaskRepositories repositories={REPOSITORIES} ticked={new Set()} onToggle={vi.fn()} {...patch} />)).toThrow(message);
    } finally {
      error.mockRestore();
    }
  });
});
