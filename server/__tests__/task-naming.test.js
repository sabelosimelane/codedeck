import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskNaming, provisionalTaskTitle } from '../tasks/task-naming.js';
import { setTaskState, OWN_REPOSITORY } from './helpers/task-state.js';

const ID = '7a000000-0000-4000-8000-000000000001';
const SETTINGS = { provider: 'codex', model: 'gpt-test', effort: 'low' };
const NOTE = '# Clarify\n\nThe panic call says the Traveller\'s full name several times; the owner wants the first name only.';
const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function setup({ titleSource = 'input', generate = vi.fn(async () => 'First name only on the call'), readSettings = () => SETTINGS } = {}) {
  const db = new Database(':memory:');
  databases.push(db);
  const taskStore = createTaskStore(db);
  taskStore.create({ ...OWN_REPOSITORY, id: ID, project: 'Demo', title: '/tmp/drops/screenshot.png', worktreePath: '/tmp/worktrees/demo', branch: 'task/demo', baseBranch: 'main', baseCommit: 'a'.repeat(40), titleSource });
  const warn = vi.fn();
  return { taskStore, generate, warn, naming: createTaskNaming({ taskStore, readSettings, generate, warn }) };
}
const written = (extra = {}) => ({ taskId: ID, input: '"/tmp/drops/screenshot.png"', content: NOTE, ...extra });

describe('naming a task from the work of its run', () => {
  it('asks the naming CLI with what was asked and what the step reported, and renames the task', async () => {
    const { naming, generate, taskStore } = setup();
    expect(await naming.noteWritten(written())).toMatchObject({ id: ID, title: 'First name only on the call', titleSource: 'generated' });
    expect(generate).toHaveBeenCalledTimes(1);
    const [settings, context] = generate.mock.calls[0];
    expect(settings).toEqual(SETTINGS);
    expect(context).toBe(`What the owner asked for:\n"/tmp/drops/screenshot.png"\n\nWhat the run reported so far:\n${NOTE}`);
    expect(taskStore.get(ID).title).toBe('First name only on the call');
  });

  it('leaves out an empty request', async () => {
    const { naming, generate } = setup();
    await naming.noteWritten(written({ input: '   ' }));
    expect(generate.mock.calls[0][1]).toBe(`What the run reported so far:\n${NOTE}`);
  });

  it('gives the CLI at most 12000 characters, without control characters', async () => {
    const { naming, generate } = setup();
    await naming.noteWritten(written({ content: `bell\x07 here\n${'x'.repeat(20000)}` }));
    const context = generate.mock.calls[0][1];
    expect(context).toHaveLength(12000);
    expect(context).toContain('bell here\nxxx');
  });

  it.each([['owner'], ['generated']])('does not ask for a task whose title is the %s one', async titleSource => {
    const { naming, generate, taskStore } = setup({ titleSource: 'input' });
    if (titleSource === 'owner') taskStore.rename(ID, { title: 'Mine', revision: 1 });
    else taskStore.applyGeneratedTitle(ID, 'Named before');
    expect(await naming.noteWritten(written())).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('does nothing for a run that has no task', async () => {
    const { naming, generate } = setup();
    expect(await naming.noteWritten(written({ taskId: null }))).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('does nothing for a task that is finished or gone', async () => {
    const { naming, generate, taskStore } = setup();
    expect(await naming.noteWritten(written({ taskId: '7a000000-0000-4000-8000-000000000009' }))).toBeNull();
    setTaskState(taskStore, ID, { state: 'closed' });
    expect(await naming.noteWritten(written())).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('does nothing while session naming is not configured', async () => {
    const { naming, generate, taskStore, warn } = setup({ readSettings: () => null });
    expect(await naming.noteWritten(written())).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(taskStore.get(ID).titleSource).toBe('input');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the title when the CLI finds nothing to name, and tries again at the next note', async () => {
    const generate = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('First name only on the call');
    const { naming, taskStore } = setup({ generate });
    expect(await naming.noteWritten(written())).toBeNull();
    expect(taskStore.get(ID)).toMatchObject({ title: '/tmp/drops/screenshot.png', titleSource: 'input' });
    expect(await naming.noteWritten(written())).toMatchObject({ title: 'First name only on the call' });
  });

  it('reports a CLI failure once per reason, keeps the title, and tries again at the next note', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error('The codex naming CLI failed')).mockRejectedValueOnce(new Error('The codex naming CLI failed')).mockResolvedValueOnce('Named at last');
    const { naming, taskStore, warn } = setup({ generate });
    expect(await naming.noteWritten(written())).toBeNull();
    expect(await naming.noteWritten(written())).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[task-naming] task=${ID} error=The codex naming CLI failed`);
    expect(taskStore.get(ID).titleSource).toBe('input');
    expect(await naming.noteWritten(written())).toMatchObject({ title: 'Named at last' });
  });

  it('reports a generated title the task cannot take', async () => {
    const { naming, taskStore, warn } = setup({ generate: vi.fn(async () => 'two\nlines') });
    expect(await naming.noteWritten(written())).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`[task-naming] task=${ID} error=tasks: title`));
    expect(taskStore.get(ID).titleSource).toBe('input');
  });

  it('keeps a title the owner gave while the CLI was working', async () => {
    let finish;
    const generate = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { naming, taskStore } = setup({ generate });
    const pending = naming.noteWritten(written());
    taskStore.rename(ID, { title: 'Mine', revision: 1 });
    finish('Generated');
    expect(await pending).toBeNull();
    expect(taskStore.get(ID)).toMatchObject({ title: 'Mine', titleSource: 'owner' });
  });

  it('asks once while a request for the same task is under way', async () => {
    let finish;
    const generate = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { naming } = setup({ generate });
    const first = naming.noteWritten(written());
    expect(await naming.noteWritten(written())).toBeNull();
    finish('Named once');
    expect(await first).toMatchObject({ title: 'Named once' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ taskId: 'not-a-task' }, 'task naming: taskId must be a task identity or null'],
    [{ taskId: undefined }, 'task naming: taskId must be a task identity or null'],
    [{ input: null }, 'task naming: input must be text'],
    [{ content: '' }, 'task naming: content must be nonempty text'],
    [{ content: '  \n ' }, 'task naming: content must be nonempty text'],
    [{ content: 12 }, 'task naming: content must be nonempty text'],
  ])('refuses %j', async (extra, message) => {
    const { naming, generate } = setup();
    await expect(naming.noteWritten(written(extra))).rejects.toThrow(message);
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['taskStore', 'readSettings', 'generate', 'warn'])('requires %s', name => {
    const deps = { taskStore: { get() {}, applyGeneratedTitle() {} }, readSettings() {}, generate() {}, warn() {}, [name]: undefined };
    expect(() => createTaskNaming(deps)).toThrow(`task naming: ${name} is required`);
  });
});

describe('what a task is called until it is named', () => {
  it.each([
    ['The call says the full name', 'Bug fix', 'The call says the full name'],
    ['  \n\n  Second line is the first with words \nmore', 'Bug fix', 'Second line is the first with words more'],
    ['Paragraph one.\n\nParagraph two.', 'Bug fix', 'Paragraph one. Paragraph two.'],
    ['First\u00a0\u2009paragraph.\n\nSecond paragraph.', 'Bug fix', 'First paragraph. Second paragraph.'],
    ['"/tmp/drops/screenshot.png"', 'Bug fix', '"/tmp/drops/screenshot.png"'],
    ['x'.repeat(200), 'Bug fix', 'x'.repeat(80)],
    [`${'y'.repeat(79)} z`, 'Bug fix', 'y'.repeat(79)],
    ['tab\there', 'Bug fix', 'tab here'],
    ['', 'Bug fix', 'Bug fix'],
    ['  \n ', 'Feature build', 'Feature build'],
  ])('%j with %s is %j', (input, workflowName, title) => {
    expect(provisionalTaskTitle(input, workflowName)).toBe(title);
  });
  it.each([[null, 'Bug fix', 'input must be text'], ['words', '', 'workflowName must be nonempty text'], ['words', null, 'workflowName must be nonempty text']])('refuses %j, %j', (input, workflowName, message) => {
    expect(() => provisionalTaskTitle(input, workflowName)).toThrow(`task naming: ${message}`);
  });
});
