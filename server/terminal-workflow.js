import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

// needs_input is a paused iteration: it keeps listening for the agent's next signal.
const ACTIVE = new Set(['running', 'resetting', 'needs_input']);
const QUIET_MS = 1000;
const SUBMIT_DELAY_MS = 100;
const RESET_TIMEOUT_MS = 15000;
const MAX_OUTPUT = 65536;

function validateStart(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Workflow start requires an object.');
  for (const field of Object.keys(request)) {
    if (!['requestId', 'command', 'resetCommand', 'maxIterations'].includes(field)) throw new Error('Workflow start contains an unknown field.');
  }
  const { requestId, command, resetCommand, maxIterations } = request;
  if (typeof requestId !== 'string' || !/^[\w-]{1,128}$/.test(requestId)) throw new Error('Workflow requestId must contain 1–128 letters, digits, underscores or hyphens.');
  if (typeof command !== 'string' || !command.trim() || command.length > 16384 || /[\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new Error('Workflow command must contain 1–16384 characters without terminal control codes.');
  if (typeof resetCommand !== 'string' || !resetCommand.trim() || resetCommand.length > 256 || /[\x00-\x1f\x7f]/.test(resetCommand)) throw new Error('Workflow resetCommand must contain 1–256 characters on one line without terminal control codes.');
  if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100)) {
    throw new Error('Workflow maxIterations must be an integer from 1 to 100.');
  }
}

// Focus reports, mouse events and cursor keys are not an answer; Enter or text is.
function isAnswer(data) {
  return /[^\x00-\x1f\x7f]|\r/.test(data.replace(/\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O.|.)/gs, ''));
}

function buildPrompt(command, identifier) {
  // Never include an assembled marker: terminal echo must not match a result.
  return `${command}\n\nCodeDeck workflow instruction: perform one pass of the command above. As your final output, emit exactly one signal, only after all work and tools for this pass have finished. Use CONTINUE if this pass finished and the overall requested task still has work remaining. Use COMPLETE only if the entire requested task is finished. Use NEEDS_INPUT if you need an answer, permission, or encounter a problem that prevents continuation. Do not reset context yourself. Do not print a signal as an example or while explaining this instruction.\nIteration identifier: ${identifier}\nCopy the iteration identifier verbatim; do not reconstruct or invent it. Construct the signal by joining these parts without spaces: opening [[CDW: ; the iteration identifier ; a colon ; the chosen uppercase status ; closing ]] .`;
}

/** A terminal session owns a loop in backend memory, independently of its browser socket. */
export function createTerminalWorkflow({ write, notify }) {
  if (typeof write !== 'function') throw new Error('Workflow write must be a function.');
  if (typeof notify !== 'function') throw new Error('Workflow notify must be a function.');
  let status = 'stopped';
  let error = null;
  let request = null;
  let identifier = null;
  let rawOutput = '';
  let phase = 'waiting';
  let pass = 0;
  let limitReached = false;
  let quietTimer;
  let resetTimer;
  let enterTimer;
  const requests = new Map();
  const issuedIdentifiers = new Set();

  const snapshot = () => ({
    status,
    active: ACTIVE.has(status),
    error,
    requestId: request?.requestId ?? null,
    iteration: pass,
    limitReached,
  });
  const publish = () => notify(snapshot());
  function cancelTimers() {
    clearTimeout(quietTimer);
    clearTimeout(resetTimer);
    clearTimeout(enterTimer);
  }
  function finish(nextStatus, message = null, { reachedLimit = false } = {}) {
    cancelTimers();
    status = nextStatus;
    error = message;
    limitReached = reachedLimit;
    identifier = null;
    rawOutput = '';
    phase = 'waiting';
    publish();
  }
  function submit(text) {
    try {
      write(text);
      return true;
    } catch {
      finish('error', 'Terminal submission failed. Check the terminal before starting again.');
      return false;
    }
  }
  function pasteAndSubmit(text) {
    if (submit(`\x1b[200~${text}\x1b[201~`)) {
      enterTimer = setTimeout(() => submit('\r'), SUBMIT_DELAY_MS);
    }
  }
  function iteration() {
    cancelTimers();
    status = 'running';
    phase = 'waiting';
    pass += 1;
    // Short enough to copy; the counter prevents reuse within this session.
    identifier = `${randomUUID().slice(0, 8)}-${(issuedIdentifiers.size + 1).toString(36)}`;
    issuedIdentifiers.add(identifier);
    rawOutput = '';
    publish();
    pasteAndSubmit(buildPrompt(request.command, identifier));
  }
  function reset() {
    phase = 'reset_output';
    rawOutput = '';
    resetTimer = setTimeout(() => finish('error', 'Reset did not settle within 15 seconds. Check the terminal before starting again.'), RESET_TIMEOUT_MS);
    // Boundaries prevent paste heuristics; a separate Enter lets TUIs process
    // the paste before handling submission.
    pasteAndSubmit(request.resetCommand);
  }
  function scheduleQuiet(action) {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(action, QUIET_MS);
  }

  return {
    snapshot,
    start(input) {
      validateStart(input);
      const previous = requests.get(input.requestId);
      if (previous) {
        if (
          previous.command !== input.command
          || previous.resetCommand !== input.resetCommand
          || previous.maxIterations !== input.maxIterations
        ) throw new Error('Workflow requestId was already used with different commands.');
        publish();
        return;
      }
      if (ACTIVE.has(status)) throw new Error('A workflow is already running in this terminal.');
      // Bound retained idempotency keys for this session; never silently evict one.
      if (requests.size >= 1000) throw new Error('Workflow request limit reached. Open a new terminal to start another workflow.');
      request = { ...input };
      requests.set(request.requestId, request);
      error = null;
      limitReached = false;
      pass = 0;
      iteration();
    },
    stop() { finish('stopped'); },
    input(data) {
      if (typeof data !== 'string') throw new Error('Workflow input must be a string.');
      if (status !== 'needs_input' || !isAnswer(data)) return;
      status = 'running';
      rawOutput = '';
      publish();
    },
    output(data) {
      if (typeof data !== 'string') throw new Error('Workflow output must be a string.');
      if (!ACTIVE.has(status) || !data) return;
      if (phase === 'before_reset') {
        scheduleQuiet(reset);
        return;
      }
      if (phase === 'reset_output') {
        scheduleQuiet(iteration);
        return;
      }
      // Retain raw chunks until stripping so split escape sequences are handled.
      rawOutput = (rawOutput + data).slice(-MAX_OUTPUT);
      const text = stripVTControlCharacters(rawOutput).replace(/\s/g, '');
      // Known older signals can be redrawn by the terminal. An unknown ID is
      // an invalid result, not a reason to wait forever or accept a near match.
      const match = [...text.matchAll(/\[\[CDW:([\w-]+):(CONTINUE|COMPLETE|NEEDS_INPUT)\]\]/g)]
        .filter(candidate => !(status === 'needs_input' && candidate[1] === identifier && candidate[2] === 'NEEDS_INPUT'))
        .find(candidate => candidate[1] === identifier || !issuedIdentifiers.has(candidate[1]));
      if (!match) return;
      if (match[1] !== identifier) {
        finish('error', 'Workflow signal identifier does not match the current iteration. The agent may have copied it incorrectly. Check the terminal, then start the workflow again.');
        return;
      }
      clearTimeout(enterTimer);
      rawOutput = '';
      if (match[2] === 'COMPLETE') finish('complete');
      else if (match[2] === 'NEEDS_INPUT') {
        // Keep the identifier: after the user answers, the agent finishes this pass.
        status = 'needs_input';
        publish();
      } else if (request.maxIterations !== undefined && pass >= request.maxIterations) {
        finish('stopped', null, { reachedLimit: true });
      } else {
        identifier = null;
        status = 'resetting';
        phase = 'before_reset';
        publish();
        scheduleQuiet(reset);
      }
    },
  };
}
