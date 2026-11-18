/**
 * The workflow builder is one screen owned by the app, opened from places that sit far
 * apart in the tree (Settings, the Run dialog). They ask for it with a window event so the
 * request does not have to be threaded through every component in between.
 */
const EVENT = 'codedeck:open-workflow-builder';

export function openWorkflowBuilder() {
  window.dispatchEvent(new Event(EVENT));
}

/** Calls `handler` whenever the builder is asked for. Returns the function that stops listening. */
export function onOpenWorkflowBuilder(handler) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
