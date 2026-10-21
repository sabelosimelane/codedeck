import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalSelection, MAX_SELECTION_OUTPUT_BYTES } from './terminalSelection';

const disposables = [];
function setup(overrides = {}) {
  const element = document.createElement('div');
  const textarea = document.createElement('textarea');
  element.append(textarea);
  document.body.append(element);
  let text = '';
  const term = {
    element,
    write: vi.fn((_data, callback) => callback()), focus: vi.fn(), clearSelection: vi.fn(() => { text = ''; }),
    hasSelection: () => text.length > 0, getSelection: () => text,
  };
  const onChange = vi.fn();
  const onResume = vi.fn();
  const showToast = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const controller = createTerminalSelection({ term, element, isActive: () => true, onChange, onResume, showToast, ...overrides });
  disposables.push(() => { controller.dispose(); element.remove(); });
  const start = () => element.dispatchEvent(new MouseEvent('mousedown', { button: 0, altKey: true, bubbles: true, cancelable: true }));
  const finish = async (value = 'docs/todos/security-deposit-ledger-frontend.md') => {
    text = value;
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await Promise.resolve();
  };
  const key = (value, extra = {}, target = textarea) => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
  };
  return { element, textarea, term, controller, start, finish, key, onChange, onResume, showToast, writeText };
}
afterEach(() => { disposables.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); });

describe('explicit terminal selection', () => {
  it('holds at Option-down, retains selection after Option is released, and copies only on Cmd+C', async () => {
    const s = setup(); s.start();
    expect(s.controller.isHolding()).toBe(true);
    await s.finish();
    expect(s.writeText).not.toHaveBeenCalled();
    expect(s.onChange).toHaveBeenLastCalledWith('selected');
    expect(s.key('c', { metaKey: true }).defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(s.writeText).toHaveBeenCalledExactlyOnceWith('docs/todos/security-deposit-ledger-frontend.md');
    expect(s.controller.isHolding()).toBe(true);
    expect(s.showToast).toHaveBeenCalledWith({ type: 'success', message: 'Copied selection' });
  });
  it('consumes Escape and the first ordinary click, then allows normal clicks', async () => {
    const s = setup(); s.start(); await s.finish();
    expect(s.key('Escape').defaultPrevented).toBe(true);
    expect(s.onResume).toHaveBeenCalledOnce();
    s.start(); await s.finish();
    const agentClick = vi.fn(); s.element.addEventListener('mousedown', agentClick);
    s.element.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(agentClick).not.toHaveBeenCalled();
    expect(s.controller.isHolding()).toBe(false);
    s.element.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(agentClick).toHaveBeenCalledOnce();
  });
  it('starts a fresh selection instead of extending the old anchor', async () => {
    const s = setup(); s.start(); await s.finish('old'); s.start(); await s.finish('new');
    s.key('c', { metaKey: true });
    expect(s.writeText).toHaveBeenCalledExactlyOnceWith('new');
    expect(s.onResume).not.toHaveBeenCalled();
  });
  it('waits for already queued xterm writes before starting the native drag', async () => {
    const s = setup(); let drained;
    s.term.write.mockImplementation((_data, callback) => { drained = callback; });
    const nativeDown = vi.fn(); s.element.addEventListener('mousedown', nativeDown);
    s.start();
    expect(nativeDown).not.toHaveBeenCalled();
    expect(drained).toBeTypeOf('function');
    drained();
    expect(nativeDown).toHaveBeenCalledOnce();
    await s.finish();
    expect(s.controller.isHolding()).toBe(true);
  });
  it('starts the drag on the stable terminal element when a queued redraw replaces the clicked cell', () => {
    const s = setup(); let drained;
    s.term.write.mockImplementation((_data, callback) => { drained = callback; });
    const cell = document.createElement('span'); s.element.append(cell);
    const nativeDown = vi.fn(); s.element.addEventListener('mousedown', nativeDown);
    cell.dispatchEvent(new MouseEvent('mousedown', { button: 0, altKey: true, bubbles: true }));
    cell.remove(); drained();
    expect(nativeDown).toHaveBeenCalledOnce();
  });
  it('finishes a short drag even when mouseup arrives before the write barrier', async () => {
    const s = setup(); let drained;
    s.term.write.mockImplementation((_data, callback) => { drained = callback; });
    s.start(); await s.finish();
    expect(s.onChange).toHaveBeenLastCalledWith('dragging');
    drained(); await Promise.resolve();
    expect(s.onChange).toHaveBeenLastCalledWith('selected');
  });
  it('does not forward hover mouse events while selected', async () => {
    const s = setup(); s.start(); await s.finish();
    const agentMove = vi.fn(); s.element.addEventListener('mousemove', agentMove);
    s.element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(agentMove).not.toHaveBeenCalled();
  });
  it('resumes on typing, preserves the key, and does not resume for modifier keys', async () => {
    const s = setup(); s.start(); await s.finish();
    s.key('Meta'); expect(s.onResume).not.toHaveBeenCalled();
    expect(s.key('x').defaultPrevented).toBe(false);
    expect(s.controller.isHolding()).toBe(false);
    expect(s.onResume).toHaveBeenCalledOnce();
  });
  it('releases an empty drag without copying or moving the cursor', async () => {
    const s = setup(); s.start(); await s.finish('');
    expect(s.controller.isHolding()).toBe(false);
    expect(s.writeText).not.toHaveBeenCalled();
  });
  it('does not steal copy from another input or inactive pane', async () => {
    const s = setup(); s.start(); await s.finish();
    const input = document.createElement('input'); document.body.append(input);
    expect(s.key('c', { metaKey: true }, input).defaultPrevented).toBe(false);
    input.remove();
    expect(s.writeText).not.toHaveBeenCalled();
    const inactive = setup({ isActive: () => false }); inactive.start(); await inactive.finish();
    inactive.key('c', { metaKey: true });
    expect(inactive.writeText).not.toHaveBeenCalled();
  });
  it.each(['denied', 'unavailable'])('reports clipboard %s without clearing selection or pretending success', async (failure) => {
    const s = setup(); s.start(); await s.finish();
    if (failure === 'denied') s.writeText.mockRejectedValue(new Error('denied'));
    else Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    s.key('c', { metaKey: true }); await Promise.resolve(); await Promise.resolve();
    expect(s.showToast).toHaveBeenCalledWith({ type: 'error', message: expect.stringContaining('Copy failed') });
    expect(s.controller.isHolding()).toBe(true);
  });
  it('ends selection visibly at the bounded output limit and resumes without dropping the incoming chunk', async () => {
    const s = setup(); s.start(); await s.finish();
    s.controller.noteOutput('x'.repeat(MAX_SELECTION_OUTPUT_BYTES));
    expect(s.controller.isHolding()).toBe(true);
    s.controller.noteOutput('x');
    expect(s.controller.isHolding()).toBe(false);
    expect(s.onResume).toHaveBeenCalledOnce();
    expect(s.showToast).toHaveBeenCalledWith({ type: 'warning', message: expect.stringContaining('output') });
  });
  it('cleans up global listeners and pending mouseup work', async () => {
    const s = setup(); s.start(); s.controller.dispose(); await s.finish();
    s.key('c', { metaKey: true });
    expect(s.writeText).not.toHaveBeenCalled();
    expect(s.onResume).not.toHaveBeenCalled();
  });
  it.each(['term', 'element', 'isActive', 'onChange', 'onResume', 'showToast'])('rejects invalid %s at construction', (field) => {
    expect(() => setup({ [field]: null })).toThrow(field);
  });
  it('rejects invalid output data without including its contents', () => {
    const s = setup(); expect(() => s.controller.noteOutput(null)).toThrow('output');
  });
});
