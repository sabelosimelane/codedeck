export const MAX_SELECTION_OUTPUT_BYTES = 4 * 1024 * 1024;

// Own the copy gesture, not xterm's selection coordinates. xterm still handles
// character widths, wrapped lines, reverse drags, and scrollback selection.
export function createTerminalSelection({ term, element, isActive, onChange, onResume, showToast }) {
  if (!term || typeof term.focus !== 'function') throw new TypeError('term must be a terminal');
  if (!(element instanceof HTMLElement)) throw new TypeError('element must be an HTMLElement');
  for (const [name, callback] of Object.entries({ isActive, onChange, onResume, showToast })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  }
  const doc = element.ownerDocument;
  let state = 'idle';
  let outputBytes = 0;
  let disposed = false;
  let gesture = 0;
  let swallowClick = false;
  let preparing = false;
  let replaying = false;
  let pendingMove = null;
  let pendingUp = null;

  function setState(next) {
    state = next;
    onChange(next);
  }
  function release(message) {
    if (state === 'idle' || disposed) return;
    gesture++;
    preparing = false;
    pendingMove = pendingUp = null;
    setState('idle');
    outputBytes = 0;
    term.clearSelection();
    if (message) showToast({ type: 'warning', message });
    onResume();
  }
  function replayMouse(type, source, target) {
    replaying = true;
    try {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
        clientX: source.clientX, clientY: source.clientY,
        // Option is latched for the complete gesture, even if released early.
        altKey: true, detail: 1,
      }));
    } finally {
      replaying = false;
    }
  }
  function mouseDown(event) {
    if (replaying || event.button !== 0) return;
    if (event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const currentGesture = ++gesture;
      if (state === 'idle') outputBytes = 0;
      setState('dragging');
      preparing = true;
      pendingMove = pendingUp = null;
      term.clearSelection();
      term.focus();
      // xterm parses writes asynchronously. Drain the already submitted writes
      // before installing its native selection listeners; new output is held.
      term.write('', () => {
        if (disposed || gesture !== currentGesture || state !== 'dragging') return;
        preparing = false;
        replayMouse('mousedown', event, term.element);
        if (pendingMove) replayMouse('mousemove', pendingMove, doc);
        if (pendingUp) replayMouse('mouseup', pendingUp, doc);
        pendingMove = pendingUp = null;
      });
      return;
    }
    if (state !== 'idle') {
      event.preventDefault();
      event.stopImmediatePropagation();
      swallowClick = true;
      release();
    }
  }
  function click(event) {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function mouseMove(event) {
    // Hover reporting is user input to xterm and would clear its selection.
    if (replaying) return;
    if (preparing) {
      pendingMove = event;
      event.stopImmediatePropagation();
    } else if (state === 'selected' && element.contains(event.target)) {
      event.stopImmediatePropagation();
    }
  }
  function mouseUp(event) {
    if (preparing && !replaying) {
      pendingUp = event;
      event.stopImmediatePropagation();
      return;
    }
    if (state !== 'dragging') return;
    const currentGesture = gesture;
    // xterm's document listener finalizes the selection in this same event.
    queueMicrotask(() => {
      if (disposed || currentGesture !== gesture || state !== 'dragging') return;
      if (term.hasSelection()) setState('selected');
      else release();
    });
  }
  function ownsTarget(target) {
    if (element.contains(target)) return true;
    return !(target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]'));
  }
  async function copy() {
    const text = term.getSelection();
    if (typeof text !== 'string') throw new TypeError('terminal selection must be a string');
    if (!text) return;
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      if (!disposed) showToast({ type: 'success', message: 'Copied selection' });
    } catch (error) {
      if (!disposed) showToast({ type: 'error', message: 'Copy failed — allow clipboard access and press Cmd+C again' });
      console.warn('Terminal clipboard write failed', error.name);
    }
  }
  function keyDown(event) {
    if (state === 'idle' || !isActive() || !ownsTarget(event.target)) return;
    if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) void copy();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      release();
    } else if (!['Meta', 'Alt', 'Shift', 'Control', 'CapsLock'].includes(event.key)) {
      release();
    }
  }
  function copyEvent(event) {
    if (state === 'idle' || !isActive() || !ownsTarget(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void copy();
  }
  const listeners = [
    [element, 'mousedown', mouseDown], [element, 'click', click],
    [doc, 'mousemove', mouseMove], [doc, 'mouseup', mouseUp],
    [doc, 'keydown', keyDown], [doc, 'copy', copyEvent],
  ];
  for (const [target, type, handler] of listeners) target.addEventListener(type, handler, true);
  return {
    isHolding: () => state !== 'idle',
    release,
    noteOutput(data) {
      if (typeof data !== 'string') throw new TypeError('terminal output must be a string');
      if (state === 'idle') return;
      outputBytes += new TextEncoder().encode(data).byteLength;
      if (outputBytes > MAX_SELECTION_OUTPUT_BYTES) release('Selection ended because incoming output exceeded 4 MiB. Select the text again to copy.');
    },
    dispose() {
      disposed = true;
      for (const [target, type, handler] of listeners) target.removeEventListener(type, handler, true);
    },
  };
}
