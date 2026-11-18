import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Badge, Button, ConfirmDialog, Dialog, Field, Note, PromptDialog, SegmentedControl, Select, TextArea, TextInput } from '../index.jsx';

afterEach(cleanup);

describe('Dialog', () => {
  it('names itself, shows a subtitle and footer, and closes by button, Escape and a click outside', () => {
    const onClose = vi.fn();
    render(<Dialog title="Run workflow" subtitle="Pick one" closeLabel="Close run workflow" onClose={onClose} footer={<span>foot</span>}><p>body</p></Dialog>);
    const dialog = screen.getByRole('dialog', { name: 'Run workflow' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Pick one')).toBeTruthy();
    expect(screen.getByText('foot')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close run workflow' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(dialog.parentElement);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('cannot be closed while busy', () => {
    const onClose = vi.fn();
    render(<Dialog title="Working" busy onClose={onClose}>x</Dialog>);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog').parentElement);
    expect(screen.getByRole('button', { name: 'Close' }).disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('form controls', () => {
  it('pass the text to onChange and carry their accessible names', () => {
    const changes = [];
    render(<>
      <Field label="Name" hint="Shown in the sidebar" error="Too long" action={<Button variant="link">Edit</Button>}>
        <TextInput label="Name" value="a" invalid onChange={value => changes.push(['input', value])} />
      </Field>
      <TextArea label="Notes" value="" onChange={value => changes.push(['area', value])} />
      <Select label="Kind" value="a" onChange={value => changes.push(['select', value])}><option value="a">A</option><option value="b">B</option></Select>
    </>);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ab' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'b' } });
    expect(changes).toEqual([['input', 'ab'], ['area', 'n'], ['select', 'b']]);
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Too long');
    expect(screen.getByText('Shown in the sidebar')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' }).getAttribute('data-variant')).toBe('link');
  });

  it('offers exclusive choices and skips a disabled one', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Where to work" value="new" onChange={onChange} options={[{ value: 'new', label: 'New task' }, { value: 'task', label: 'Open task', disabled: true, title: 'None open' }, { value: 'main', label: 'Main' }]} />);
    const group = screen.getByRole('radiogroup', { name: 'Where to work' });
    expect(group).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'New task' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Open task' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Open task' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Main' }));
    expect(onChange.mock.calls).toEqual([['main']]);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<SegmentedControl label="x" value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }]} />)).toThrow('at least two options');
    quiet.mockRestore();
  });

  it('renders a button, a note and a badge with their looks', () => {
    render(<><Button variant="primary" size="small">Go</Button><Note tone="warning">Careful</Note><Badge>Build</Badge></>);
    expect(screen.getByRole('button', { name: 'Go' })).toMatchObject({ type: 'button' });
    expect(screen.getByRole('button', { name: 'Go' }).dataset).toMatchObject({ variant: 'primary', size: 'small' });
    expect(screen.getByText('Careful').dataset.tone).toBe('warning');
    expect(screen.getByText('Build').className).toBe('ui-badge');
  });
});

describe('ConfirmDialog', () => {
  it('runs the action once, stays up while it runs, and cancels without running it', async () => {
    let finish;
    const onConfirm = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Merge task" confirmLabel="Merge" onConfirm={onConfirm} onCancel={onCancel}>Merge it?</ConfirmDialog>);
    expect(screen.getByText('Merge it?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(true);
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('PromptDialog', () => {
  it('submits the trimmed text, and not a blank or unchanged one', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<PromptDialog title="Rename task" label="Task title" initialValue="Replies" confirmLabel="Rename" requireChange maxLength={80} onSubmit={onSubmit} onCancel={() => {}} />);
    const input = screen.getByLabelText('Task title');
    expect(input.value).toBe('Replies');
    expect(input.maxLength).toBe(80);
    expect(screen.getByRole('button', { name: 'Rename' }).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Rename' }).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  WhatsApp replies ' } });
    fireEvent.submit(input.closest('form'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('WhatsApp replies'));
  });

  it('accepts the suggested text when a change is not required', async () => {
    const onSubmit = vi.fn(async () => {});
    const onCancel = vi.fn();
    render(<PromptDialog title="Commit changes" label="Message" initialValue="Replies" confirmLabel="Commit" onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Replies'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
