import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

// needs_input is a paused iteration: it keeps listening for the agent's next signal.
const ACTIVE = new Set(['running', 'resetting', 'needs_input']);
const QUIET_MS = 1000;
const SUBMIT_DELAY_MS = 100;
const RESET_TIMEOUT_MS = 15000;
const MAX_OUTPUT = 65536;
// `resetFirst` clears the agent's context before the first pass, for a terminal whose agent
// already worked. `guidance` is one more sentence or two of instruction for every pass.
// A step's guidance names every repository of its task with its path, so it has room for several.
export const GUIDANCE_MAX = 4000;
const START_FIELDS = ['requestId', 'command', 'resetCommand', 'maxIterations', 'resetFirst', 'guidance'];

function validateStart(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Workflow start requires an object.');
  for (const field of Object.keys(request)) {
    if (!START_FIELDS.includes(field)) throw new Error('Workflow start contains an unknown field.');
  }
  const { requestId, command, resetCommand, maxIterations, resetFirst, guidance } = request;
  if (resetFirst !== undefined && typeof resetFirst !== 'boolean') throw new Error('Workflow resetFirst must be true or false.');
  if (guidance !== undefined && (typeof guidance !== 'string' || !guidance.trim() || guidance.length > GUIDANCE_MAX || /[\x00-\x1f\x7f]/.test(guidance))) {
    throw new Error(`Workflow guidance must contain 1–${GUIDANCE_MAX} characters on one line without terminal control codes.`);
  }
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

/** What is typed into the agent for one pass: the step's prompt, the standing instruction, and the step's guidance. */
export function buildPrompt(command, identifier, guidance) {
  // Never include an assembled marker: terminal echo must not match a result.
  return `${command}\n\nCodeDeck workflow instruction: perform one pass of the command above. As your final output, emit exactly one signal, only after all work and tools for this pass have finished. Use CONTINUE if this pass finished and the overall requested task still has work remaining. Use COMPLETE only if the entire requested task is finished. Use NEEDS_INPUT if you need an answer, permission, or encounter a problem that prevents continuation. Before a NEEDS_INPUT signal, state what you need: print the questions marker on a line of its own, then a numbered list with one short question per item, each followed by Recommended: and the answer you recommend; write nothing else between the questions marker and the signal. Do not reset context yourself. Do not print a signal as an example or while explaining this instruction.${guidance === undefined ? '' : ` ${guidance}`}\nIteration identifier: ${identifier}\nCopy the iteration identifier verbatim; do not reconstruct or invent it. Construct the signal by joining these parts without spaces: opening [[CDW: ; the iteration identifier ; a colon ; the chosen uppercase status ; closing ]] . Construct the questions marker the same way, with QUESTIONS in place of the status.`;
}

/** A terminal session owns a loop in backend memory, independently of its browser socket. */
export function createTerminalWorkflow({ write, notify }) {
  if (typeof write !== 'function') throw new Error('Workflow write must be a function.');
  if (typeof notify !== 'function') throw new Error('Workflow notify must be a function.');
  let status = 'stopped';
  let error = null;
  let request = null;
  let identifier = null;
  // Every identifier given out in the pass in progress, and one composed into an answer not yet submitted.
  let passIdentifiers = new Set();
  let pendingIdentifier = null;
  let rawOutput = '';
  let phase = 'waiting';
  let pass = 0;
  let limitReached = false;
  let quietTimer;
  // Checked before every repeat pass (a run's attachment copies); not part of the replayed request.
  let beforePass = null;
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
  // Short enough to copy; the counter prevents reuse within this session.
  function issueIdentifier() {
    const issued = `${randomUUID().slice(0, 8)}-${(issuedIdentifiers.size + 1).toString(36)}`;
    issuedIdentifiers.add(issued);
    return issued;
  }
  function iteration() {
    cancelTimers();
    status = 'running';
    phase = 'waiting';
    pass += 1;
    identifier = issueIdentifier();
    passIdentifiers = new Set([identifier]);
    pendingIdentifier = null;
    rawOutput = '';
    publish();
    pasteAndSubmit(buildPrompt(request.command, identifier, request.guidance));
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
    /** The identifier the agent copies into its signal for the pass in progress, or null. */
    signalIdentifier: () => identifier,
    start(input, options = {}) {
      validateStart(input);
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Workflow start options must be an object.');
      for (const field of Object.keys(options)) {
        if (field !== 'beforePass') throw new Error('Workflow start contains an unknown option.');
      }
      if (options.beforePass !== undefined && typeof options.beforePass !== 'function') throw new Error('Workflow beforePass must be a function.');
      const previous = requests.get(input.requestId);
      if (previous) {
        if (
          previous.command !== input.command
          || previous.resetCommand !== input.resetCommand
          || previous.maxIterations !== input.maxIterations
          || (previous.resetFirst ?? false) !== (input.resetFirst ?? false)
          || previous.guidance !== input.guidance
        ) throw new Error('Workflow requestId was already used with different commands.');
        publish();
        return;
      }
      if (ACTIVE.has(status)) throw new Error('A workflow is already running in this terminal.');
      // Bound retained idempotency keys for this session; never silently evict one.
      if (requests.size >= 1000) throw new Error('Workflow request limit reached. Open a new terminal to start another workflow.');
      request = { ...input };
      beforePass = options.beforePass ?? null;
      requests.set(request.requestId, request);
      error = null;
      limitReached = false;
      pass = 0;
      if (request.resetFirst === true) {
        // The agent in this terminal has context from earlier work: clear it, then start pass 1.
        cancelTimers();
        status = 'resetting';
        identifier = null;
        publish();
        reset();
      } else {
        iteration();
      }
    },
    stop() { finish('stopped'); },
    /**
     * What to type for the agent as the answer to its request: the answer, and a new identifier
     * for the rest of the pass. The terminal can send the answered request again at any time (a
     * browser pane attaching or resizing redraws the screen); under the old identifier it is
     * recognised as old, and only a request under the new one is the agent asking again.
     */
    answerText(answer) {
      if (typeof answer !== 'string' || !answer.trim()) throw new Error('Workflow answer must be a non-empty string.');
      if (status !== 'needs_input') throw new Error('The agent is not waiting for an answer.');
      pendingIdentifier ??= issueIdentifier();
      return `${answer}\n\nCodeDeck: from here on in this pass, use the iteration identifier ${pendingIdentifier} in your signal and your questions marker, in place of the earlier one.`;
    },
    input(data) {
      if (typeof data !== 'string') throw new Error('Workflow input must be a string.');
      if (status !== 'needs_input' || !isAnswer(data)) return;
      if (pendingIdentifier !== null) {
        identifier = pendingIdentifier;
        passIdentifiers.add(identifier);
        pendingIdentifier = null;
      }
      status = 'running';
      rawOutput = '';
      publish();
    },
    output(data) {
      if (typeof data !== 'string') throw new Error('Workflow output must be a string.');
      if (!ACTIVE.has(status) || !data) return;
      if (phase === 'checking') return;
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
        // A request for input counts only under the current identifier: under an earlier one of
        // this pass it is the answered request, redrawn. The end of the pass counts under any of them.
        .find(candidate => (candidate[2] === 'NEEDS_INPUT' ? candidate[1] === identifier : passIdentifiers.has(candidate[1])) || !issuedIdentifiers.has(candidate[1]));
      if (!match) return;
      if (!issuedIdentifiers.has(match[1])) {
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
        publish();
        if (beforePass === null) {
          phase = 'before_reset';
          scheduleQuiet(reset);
          return;
        }
        // Nothing reaches the agent until the check passes; a Stop or new start meanwhile wins.
        phase = 'checking';
        const checking = request;
        const current = () => request === checking && status === 'resetting' && phase === 'checking';
        Promise.resolve().then(() => beforePass()).then(() => {
          if (!current()) return;
          phase = 'before_reset';
          scheduleQuiet(reset);
        }, (err) => {
          if (!current()) return;
          finish('error', String(err?.message || err || 'The check before the next pass failed.').slice(0, 2000));
        });
      }
    },
  };
}
