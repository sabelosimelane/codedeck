import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import ApprovalReview from '../ApprovalReview.jsx';

const run = (overrides = {}) => ({
  id: 'run-1', workflowName: 'Bug fix',
  approvalRequest: { stepIndex: 2, stepName: 'Analyse', note: { summary: 'Both calls use the whole stored name; fix is a first-word rule.' } },
  ...overrides,
});
const NOTE = '## Cause\n\n- `WakeFacts.java:45` uses the full name\n- **Spec** asks for it';
const mount = (props = {}) => {
  const h = {
    onLoadNotes: vi.fn(async () => ({ notes: [{ status: 'written', content: NOTE }] })),
    onApprove: vi.fn(async () => ({})), onSendBack: vi.fn(async () => ({})), ...props,
  };
  render(<ApprovalReview run={run()} {...h} />);
  return h;
};
afterEach(cleanup);

describe('ApprovalReview', () => {
  it('says what is being asked, leads with the summary and shows the note as a document', async () => {
    const h = mount();
    const panel = within(screen.getByRole('group', { name: 'Analyse approval' }));
    expect(panel.getByText('Analyse is finished. Approve it to continue, or send it back with what to change.')).toBeTruthy();
    expect(panel.getByText('Both calls use the whole stored name; fix is a first-word rule.')).toBeTruthy();
    expect(panel.getByText('Loading the step note…')).toBeTruthy();
    await waitFor(() => expect(panel.getByRole('heading', { name: 'Cause' })).toBeTruthy());
    expect(h.onLoadNotes).toHaveBeenCalledWith('run-1', 0, 2);
    expect(panel.getAllByRole('listitem')).toHaveLength(2);
    expect(panel.getByText('WakeFacts.java:45').tagName).toBe('CODE');
    expect(panel.getByText('Spec').tagName).toBe('STRONG');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('approves in one click', async () => {
    const h = mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Approve and continue' })); });
    expect(h.onApprove).toHaveBeenCalledWith('run-1');
    expect(h.onSendBack).not.toHaveBeenCalled();
  });

  it('asks what to change before sending back, and can be cancelled', async () => {
    const h = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }));
    const box = screen.getByRole('textbox', { name: 'What should change' });
    expect(screen.getByRole('button', { name: 'Send back' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'What should change' }), { target: { value: ' Cover the empty name ' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send back' })); });
    expect(h.onSendBack).toHaveBeenCalledWith('run-1', 'Cover the empty name');
    expect(box).toBeTruthy();
  });

  it('keeps the comment when sending back failed, and blocks both actions while one is in flight', async () => {
    let release;
    const h = mount({ onSendBack: vi.fn(() => new Promise(resolve => { release = resolve; })) });
    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    expect(screen.getByRole('button', { name: 'Approve and continue' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Sending back…' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Sending back…' }));
    await act(async () => { release(null); });
    expect(h.onSendBack).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox').value).toBe('Again');
  });

  it('says when the step left no note or the note could not be loaded', async () => {
    mount({ onLoadNotes: vi.fn(async () => ({ notes: [] })) });
    await waitFor(() => expect(screen.getByText('This step left no note.')).toBeTruthy());
    cleanup();
    mount({ onLoadNotes: vi.fn(async () => null) });
    await waitFor(() => expect(screen.getByText('The step note could not be loaded.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Approve and continue' }).disabled).toBe(false);
  });
});
