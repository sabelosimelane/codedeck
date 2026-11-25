import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import QuestionsPanel from '../QuestionsPanel.jsx';

const QUESTIONS = '1. Which port?\nRecommended: 8080, as the README says.\n2. Keep the old route? Recommended: Yes.\n3. Who reviews?';
const run = (overrides = {}) => ({
  id: 'run-1', workflowName: 'Bug fix', status: 'needs_input', inputRequest: { questions: QUESTIONS, truncated: false },
  actions: { answer: true }, ...overrides,
});
const mount = (props = {}) => {
  const onAnswer = vi.fn(async () => ({}));
  render(<QuestionsPanel run={run()} onAnswer={onAnswer} {...props} />);
  return { onAnswer };
};
const card = number => within(screen.getByRole('group', { name: `Question ${number}` }));
afterEach(cleanup);

describe('QuestionsPanel', () => {
  it('shows each option as a radio, preselects the recommended one, and sends another selected option', async () => {
    const optionsRun = run({ inputRequest: { questions: '1. Which database?\na) Shared\nb) Dedicated\nc) Embedded\nRecommended: a) Reuses what we have.', truncated: false } });
    const { onAnswer } = mount({ run: optionsRun });
    expect(card(1).getAllByRole('radio')).toHaveLength(4);
    expect(card(1).getByRole('radio', { name: /a\) Shared/ }).checked).toBe(true);
    expect(card(1).getByText('Reuses what we have.')).toBeTruthy();
    expect(card(1).queryByRole('radio', { name: /Go with the recommendation/ })).toBeNull();
    fireEvent.click(card(1).getByRole('radio', { name: /b\) Dedicated/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send answers' })); });
    expect(onAnswer).toHaveBeenCalledWith('run-1', '1. (b) Dedicated');
  });

  it('requires a selection when options have no matching recommended letter', () => {
    mount({ run: run({ inputRequest: { questions: '1. Which database?\na) Shared\nb) Dedicated\nRecommended: Decide based on cost.', truncated: false } }) });
    expect(card(1).getAllByRole('radio')).toHaveLength(3);
    expect(card(1).getAllByRole('radio').every(radio => !radio.checked)).toBe(true);
    expect(card(1).getByText('Recommended: Decide based on cost.')).toBeTruthy();
    expect(screen.getByText('1 of 1 still needs your answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send answers' }).disabled).toBe(true);
  });
  it('keeps an uppercase prose opening visible and does not preselect option a', () => {
    mount({ run: run({ inputRequest: { questions: '1. Which database?\na) Shared\nb) Dedicated\nRecommended: A fresh index is safest.', truncated: false } }) });
    expect(card(1).getAllByRole('radio').every(radio => !radio.checked)).toBe(true);
    expect(card(1).getByText('Recommended: A fresh index is safest.')).toBeTruthy();
  });

  it('shows each question on its own, with the recommendation already chosen', () => {
    mount();
    expect(within(screen.getByRole('group', { name: 'Bug fix needs your input' })).getAllByRole('group')).toHaveLength(3);
    expect(card(1).getByText('Which port?')).toBeTruthy();
    expect(card(1).getByRole('radio', { name: /Go with the recommendation/ }).checked).toBe(true);
    expect(card(1).getByText('8080, as the README says.')).toBeTruthy();
    expect(card(1).queryByRole('textbox')).toBeNull();
    // No recommendation: only a box to answer in.
    expect(card(3).queryByRole('radio')).toBeNull();
    expect(card(3).getByRole('textbox', { name: 'Your answer to question 3' })).toBeTruthy();
    expect(screen.getByText('1 of 3 still needs your answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send answers' }).disabled).toBe(true);
  });

  it('sends one numbered answer once every question is answered', async () => {
    const { onAnswer } = mount();
    fireEvent.click(card(2).getByRole('radio', { name: 'My own answer' }));
    fireEvent.change(card(2).getByRole('textbox', { name: 'Your answer to question 2' }), { target: { value: 'No, remove it' } });
    fireEvent.change(card(3).getByRole('textbox'), { target: { value: 'Thabo' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Anything else for the agent' }), { target: { value: 'Small commits please' } });
    expect(screen.queryByText(/still needs your answer/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send answers' })); });
    expect(onAnswer).toHaveBeenCalledWith('run-1', '1. As you recommend: 8080, as the README says.\n2. No, remove it\n3. Thabo\n\nAlso: Small commits please');
  });

  it('accepts every recommendation in one click when all questions have one', async () => {
    const { onAnswer } = mount({ run: run({ inputRequest: { questions: '1. Which port?\nRecommended: 8080.\n2. Keep it? Recommended: Yes.', truncated: false } }) });
    expect(screen.getByRole('button', { name: 'Send answers' }).disabled).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send answers' })); });
    expect(onAnswer).toHaveBeenCalledWith('run-1', 'Proceed with your recommendations.');
  });

  it('keeps what was typed when the answer was not delivered, and blocks a second send meanwhile', async () => {
    let release;
    const onAnswer = vi.fn(() => new Promise(resolve => { release = resolve; }));
    mount({ onAnswer });
    fireEvent.change(card(3).getByRole('textbox'), { target: { value: 'Thabo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(screen.getByRole('button', { name: 'Sending…' }).disabled).toBe(true);
    await act(async () => { release(null); });
    expect(card(3).getByRole('textbox').value).toBe('Thabo');
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('restores edited answers after the waiting panel redraws for the same request', () => {
    const view = render(<QuestionsPanel run={run({ id: 'redraw-run' })} onAnswer={vi.fn()} />);
    fireEvent.click(card(2).getByRole('radio', { name: 'My own answer' }));
    fireEvent.change(card(2).getByRole('textbox', { name: 'Your answer to question 2' }), { target: { value: 'Keep the route' } });
    view.unmount();
    render(<QuestionsPanel run={run({ id: 'redraw-run' })} onAnswer={vi.fn()} />);
    expect(card(2).getByRole('textbox', { name: 'Your answer to question 2' }).value).toBe('Keep the route');
  });

  it('shows a request that is not a numbered list as written, with one box to answer', async () => {
    const { onAnswer } = mount({ run: run({ inputRequest: { questions: 'I need the staging address.', truncated: true } }) });
    expect(screen.getByText('I need the staging address.')).toBeTruthy();
    expect(screen.getByText("The list was cut here. Read the rest in the agent's terminal.")).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'staging.example.test' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send answer' })); });
    expect(onAnswer).toHaveBeenCalledWith('run-1', 'staging.example.test');
  });

  it('says where to answer when the agent listed nothing or shows a dialog', () => {
    mount({ run: run({ inputRequest: { questions: null, truncated: false } }) });
    expect(screen.getByText('The agent did not say what it needs. Read its terminal, then answer here or there.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toBeTruthy();
    cleanup();
    mount({ run: run({ inputRequest: null, actions: { answer: false } }) });
    expect(screen.getByText('The agent is showing a dialog in its terminal. Answer it there.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
