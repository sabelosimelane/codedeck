import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

// needs_input is a paused iteration: it keeps listening for the agent's next signal.
const ACTIVE = new Set(['running', 'resetting', 'needs_input']);
const QUIET_MS = 1000;
const SUBMIT_DELAY_MS = 100;
const RESET_TIMEOUT_MS = 15000;
const MAX_OUTPUT = 65536;
const MAX_BAD_IDENTIFIER_RETRIES = 1;
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

// Focus reports, mouse events, cursor keys and terminal query replies are not an answer.
// Keep parser state across websocket chunks because OSC replies often contain printable bytes.
function answerText(data, state) {
  let visible = '';
  for (let i = 0; i < data.length; i += 1) {
    const char = data[i];
    if (state.mode === 'normal') {
      if (char === '\x1b') state.mode = 'escape';
      else visible += char;
    } else if (state.mode === 'escape') {
      if (char === '[') state.mode = 'csi';
      else if (char === ']') state.mode = 'osc';
      else if (char === 'P' || char === '^' || char === '_') state.mode = 'string';
      else if (char === 'O') state.mode = 'ss3';
      else state.mode = 'normal';
    } else if (state.mode === 'csi') {
      if (char >= '@' && char <= '~') state.mode = 'normal';
    } else if (state.mode === 'ss3') {
      state.mode = 'normal';
    } else if (state.mode === 'osc') {
      if (char === '\x07') state.mode = 'normal';
      else if (char === '\x1b') state.mode = 'osc_escape';
    } else if (state.mode === 'osc_escape') {
      state.mode = char === '\\' ? 'normal' : char === '\x1b' ? 'osc_escape' : 'osc';
    } else if (state.mode === 'string') {
      if (char === '\x1b') state.mode = 'string_escape';
    } else if (state.mode === 'string_escape') {
      state.mode = char === '\\' ? 'normal' : char === '\x1b' ? 'string_escape' : 'string';
    }
  }
  return visible;
}

/** What is typed into the agent for one pass: the step's prompt, the standing instruction, and the step's guidance. */
export function buildPrompt(command, identifier, guidance) {
  // Never include an assembled marker: terminal echo must not match a result.
  return `${command}\n\nCodeDeck workflow instruction: perform one pass of the command above. As your final output, emit exactly one signal, only after all work and tools for this pass have finished. Use CONTINUE if this pass finished and the overall requested task still has work remaining. Use COMPLETE only if the entire requested task is finished. Use NEEDS_INPUT if you need an answer, permission, or encounter a problem that prevents continuation. Before a NEEDS_INPUT signal, state what you need: print the questions marker on a line of its own, then a numbered list with one short question per item, each followed by Recommended: and the answer you recommend; write nothing else between the questions marker and the signal. Do not reset context yourself. Do not print a signal as an example or while explaining this instruction.${guidance === undefined ? '' : ` ${guidance}`}\nIteration identifier: ${identifier}\nCopy the iteration identifier verbatim; do not reconstruct or invent it. Construct the signal by joining these parts without spaces: opening [[CDW: ; the iteration identifier ; a colon ; the chosen uppercase status ; closing ]] . Construct the questions marker the same way, with QUESTIONS in place of the status.`;
}

/** Reminder typed into the agent when it mistypes the iteration identifier in its final signal. */
function buildBadIdentifierPrompt(identifier) {
  // Never include an assembled marker: terminal echo must not match a result.
  return `CodeDeck: the signal identifier you emitted did not match the current iteration. Do not redo any work — emit your final signal again using the exact iteration identifier ${identifier}. Construct the signal by joining these parts without spaces: opening [[CDW: ; ${identifier} ; a colon ; your chosen uppercase status (CONTINUE, COMPLETE, or NEEDS_INPUT) ; closing ]] .`;
}

/**
 * Find the last signal in captured terminal screen text that belongs to the active pass.
 * Signals from earlier passes or other runs in the same terminal are ignored.
 */
export function findPassSignal(screenText, { status, phase, identifier, passIdentifiers } = {}) {
  if (typeof screenText !== 'string' || !screenText) return null;
  if (!ACTIVE.has(status) || phase !== 'waiting') return null;
  const known = passIdentifiers instanceof Set ? passIdentifiers : new Set(Array.isArray(passIdentifiers) ? passIdentifiers : []);
  const text = stripVTControlCharacters(screenText).replace(/\s/g, '');
  const matches = [...text.matchAll(/\[\[CDW:([\w-]+):(CONTINUE|COMPLETE|NEEDS_INPUT)\]\]/g)]
    .filter(candidate => !(status === 'needs_input' && candidate[1] === identifier && candidate[2] === 'NEEDS_INPUT'))
    .filter(candidate => (candidate[2] === 'NEEDS_INPUT' ? candidate[1] === identifier : known.has(candidate[1])));
  const last = matches.at(-1);
  return last ? { id: last[1], signal: last[2] } : null;
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
  let badIdentifierRetries = 0;
  let workObserved = false;
  let askedForInput = false;
  let acceptedSignal = null;
  let handoffDeadline = null;
  let handoffTimer;
  let audit = null;
  function armHandoffDeadline() {
    clearTimeout(handoffTimer);
    handoffTimer = setTimeout(() => finish('error', 'Handoff timed out after the agent finished. Check its final disposition before resuming.'), Math.max(0, handoffDeadline - Date.now()));
  }
  function requestDisposition() {
    workObserved = true;
    badIdentifierRetries = 1;
    rawOutput = '';
    clearTimeout(enterTimer);
    handoffDeadline = Date.now() + 24000;
    armHandoffDeadline();
    audit?.('disposition_requested', 'Idle or invalid final signal; requested disposition only');
    publish();
    pasteAndSubmit(buildBadIdentifierPrompt(identifier));
  }
  let limitReached = false;
  let quietTimer;
  // Checked before every repeat pass (a run's attachment copies); not part of the replayed request.
  let beforePass = null;
  let resetTimer;
  let enterTimer;
  const inputParser = { mode: 'normal' };
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
    clearTimeout(handoffTimer);
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
  function pasteAndSubmit(text, onSubmitted) {
    if (submit(`\x1b[200~${text}\x1b[201~`)) {
      enterTimer = setTimeout(() => { if (submit('\r')) onSubmitted?.(); }, SUBMIT_DELAY_MS);
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
    workObserved = false;
    askedForInput = false;
    acceptedSignal = null;
    handoffDeadline = null;
    badIdentifierRetries = 0;
    identifier = issueIdentifier();
    passIdentifiers = new Set([identifier]);
    pendingIdentifier = null;
    rawOutput = '';
    publish();
    pasteAndSubmit(buildPrompt(request.command, identifier, request.guidance), () => audit?.('prompt_submitted', 'Controller submitted terminal input'));
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

  function exportState() {
    if (!ACTIVE.has(status) || !request) return null;
    return {
      request: { ...request },
      status,
      phase,
      pass,
      identifier,
      passIdentifiers: [...passIdentifiers],
      issuedIdentifiers: [...issuedIdentifiers],
      workObserved,
      askedForInput,
      handoffDeadline,
      ...(acceptedSignal && { acceptedSignal }),
    };
  }
  function startBeforePassReset() {
    if (beforePass === null) {
      phase = 'before_reset';
      publish();
      scheduleQuiet(reset);
      return;
    }
    // Nothing reaches the agent until the check passes; a Stop or new start meanwhile wins.
    phase = 'checking';
    publish();
    const checking = request;
    const current = () => request === checking && status === 'resetting' && phase === 'checking';
    Promise.resolve().then(() => beforePass()).then(() => {
      if (!current()) return;
      phase = 'before_reset';
      publish();
      scheduleQuiet(reset);
    }, (err) => {
      if (!current()) return;
      finish('error', String(err?.message || err || 'The check before the next pass failed.').slice(0, 2000));
    });
  }

  return {
    snapshot,
    setAudit(observer) {
      if (observer !== null && typeof observer !== 'function') throw new Error('Workflow audit observer must be a function or null.');
      audit = observer;
    },
    /** Serializable state of the active pass for backend-restart recovery, or null when inactive. */
    exportState,
    /** The identifier the agent copies into its signal for the pass in progress, or null. */
    signalIdentifier: () => identifier,
    /**
     * Hydrate an in-flight pass after a backend restart without re-sending the prompt or
     * resetting the agent.
     */
    reattach(savedState, options = {}) {
      if (!savedState || typeof savedState !== 'object' || Array.isArray(savedState)) {
        throw new Error('Workflow reattach requires a state object.');
      }
      validateStart(savedState.request);
      if (!ACTIVE.has(savedState.status)) throw new Error('Workflow reattach status must be active.');
      if (!['waiting', 'before_reset', 'reset_output', 'checking'].includes(savedState.phase)) {
        throw new Error('Workflow reattach phase is invalid.');
      }
      if (!Number.isInteger(savedState.pass) || savedState.pass < 0) {
        throw new Error('Workflow reattach pass must be a nonnegative integer.');
      }
      if (savedState.identifier !== null && (typeof savedState.identifier !== 'string' || !/^[\w-]+$/.test(savedState.identifier))) {
        throw new Error('Workflow reattach identifier is invalid.');
      }
      if (!Array.isArray(savedState.passIdentifiers) || !savedState.passIdentifiers.every(id => typeof id === 'string' && /^[\w-]+$/.test(id))) {
        throw new Error('Workflow reattach passIdentifiers must be an array of identifiers.');
      }
      if (!Array.isArray(savedState.issuedIdentifiers) || !savedState.issuedIdentifiers.every(id => typeof id === 'string' && /^[\w-]+$/.test(id))) {
        throw new Error('Workflow reattach issuedIdentifiers must be an array of identifiers.');
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Workflow reattach options must be an object.');
      for (const field of Object.keys(options)) {
        if (field !== 'beforePass') throw new Error('Workflow reattach contains an unknown option.');
      }
      if (options.beforePass !== undefined && typeof options.beforePass !== 'function') throw new Error('Workflow beforePass must be a function.');
      if (ACTIVE.has(status)) throw new Error('A workflow is already running in this terminal.');

      cancelTimers();
      request = { ...savedState.request };
      beforePass = options.beforePass ?? null;
      requests.set(request.requestId, request);
      error = null;
      limitReached = false;
      status = savedState.status;
      phase = savedState.phase;
      pass = savedState.pass;
      badIdentifierRetries = 0;
      askedForInput = savedState.askedForInput ?? (savedState.status === 'needs_input' || savedState.passIdentifiers.length > 1);
      if (typeof askedForInput !== 'boolean') throw new Error('Workflow askedForInput must be boolean.');
      workObserved = savedState.workObserved ?? false;
      handoffDeadline = savedState.handoffDeadline ?? null;
      if (typeof workObserved !== 'boolean') throw new Error('Workflow workObserved must be boolean.');
      if (handoffDeadline !== null) {
        if (!Number.isSafeInteger(handoffDeadline) || handoffDeadline < 0 || !workObserved) throw new Error('Workflow handoffDeadline is invalid.');
        badIdentifierRetries = 1;
        armHandoffDeadline();
      }
      identifier = savedState.identifier;
      passIdentifiers = new Set(savedState.passIdentifiers);
      issuedIdentifiers.clear();
      for (const id of savedState.issuedIdentifiers) issuedIdentifiers.add(id);
      acceptedSignal = savedState.acceptedSignal ?? null;
      if (acceptedSignal !== null && (!passIdentifiers.has(acceptedSignal.id)
        || !['CONTINUE','COMPLETE','NEEDS_INPUT'].includes(acceptedSignal.signal)
        || phase !== 'waiting')) throw new Error('Invalid persisted accepted disposition');
      pendingIdentifier = null;
      rawOutput = '';

      if (status === 'resetting') {
        if (phase === 'reset_output') {
          resetTimer = setTimeout(() => finish('error', 'Reset did not settle within 15 seconds. Check the terminal before starting again.'), RESET_TIMEOUT_MS);
          scheduleQuiet(iteration);
        } else {
          startBeforePassReset();
        }
      }
    },
    /**
     * Inspect captured terminal scrollback on startup recovery for a signal belonging to this
     * pass. Signals from earlier passes or other runs in the same terminal are ignored.
     * @returns {boolean} true if a matching signal was found and processed
     */
    replayScreen(screenText) {
      if (typeof screenText !== 'string') throw new Error('Workflow replayScreen must be a string.');
      const match = acceptedSignal ?? findPassSignal(screenText, { status, phase, identifier, passIdentifiers });
      if (!match) return false;
      rawOutput = '';
      this.output(`[[CDW:${match.id}:${match.signal}]]`);
      return true;
    },
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
        phase = 'reset_output';
        identifier = null;
        publish();
        reset();
      } else {
        iteration();
      }
    },
    stop() { finish('stopped'); },
    /**
     * Pastes and submits the prompt of the pass in progress again, under the same identifier.
     * For a prompt the agent's CLI did not take (it was cleared, or was still starting): the
     * caller decides from the screen that the agent never began the pass.
     */
    observeTurn(turn, screen) {
      if (!['working', 'idle'].includes(turn) || typeof screen !== 'string') throw new Error('Workflow turn observation requires a working or idle turn and screen text.');
      if (status !== 'running' || phase !== 'waiting') return false;
      if (turn === 'working' && !workObserved) {
        workObserved = true;
        audit?.('work_observed', null);
        publish();
      } else if (turn === 'idle' && handoffDeadline === null) {
        // A fast turn may finish between polls. A near-ID can request a correction,
        // but can never authorize a state transition.
        if (!workObserved) {
          const candidates = screen.matchAll(/\[\[CDW[;:]([\w-]+)[;:](?:CONTINUE|COMPLETE|NEEDS_INPUT)\]\]/g);
          const belongs = [...candidates].some(([, id]) => id.length === identifier.length
            && (id === identifier || !issuedIdentifiers.has(id))
            && [...id].filter((letter, i) => letter !== identifier[i]).length <= 1);
          // A new Muse footer below this pass's echoed prompt is evidence even
          // when both the working sample and the final signal were missed.
          const prompt = 'Iteration identifier: ' + identifier;
          const promptAt = screen.lastIndexOf(prompt);
          const finished = promptAt >= 0 && /^\s*◆ Worked for [^\n·]+ · [^\n·]+ · \d{1,2}\/[a-z]{3}\s*$/im.test(screen.slice(promptAt + prompt.length));
          if (!belongs && !finished) return askedForInput;
        }
        requestDisposition();
      }
      return workObserved || askedForInput;
    },
    resubmit() {
      if (workObserved || askedForInput) throw new Error('Cannot resend a prompt after work was observed.');
      if (status !== 'running' || identifier === null) {
        throw new Error('The prompt can be sent again only while a pass is running.');
      }
      clearTimeout(enterTimer);
      pasteAndSubmit(buildPrompt(request.command, identifier, request.guidance), () => audit?.('prompt_submitted', 'Controller submitted terminal input'));
    },
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
      if (status !== 'needs_input') return;
      const text = answerText(data, inputParser);
      if (!/[^\x00-\x1f\x7f]|\r/.test(text)) return;
      if (pendingIdentifier !== null) {
        identifier = pendingIdentifier;
        passIdentifiers.add(identifier);
        pendingIdentifier = null;
      }
      status = 'running';
      workObserved = false;
      badIdentifierRetries = 0;
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
        if (status === 'running' && identifier !== null && badIdentifierRetries < MAX_BAD_IDENTIFIER_RETRIES) {
          requestDisposition();
          return;
        }
        finish('error', 'Workflow signal identifier does not match the current iteration. The agent may have copied it incorrectly. Check the terminal, then start the workflow again.');
        return;
      }
      clearTimeout(enterTimer);
      rawOutput = '';
      if (!acceptedSignal) {
        acceptedSignal = { id: match[1], signal: match[2] };
        audit?.('signal_accepted', match[2]);
      }
      acceptedSignal = null;
      clearTimeout(handoffTimer);
      handoffDeadline = null;
      if (match[2] === 'COMPLETE') finish('complete');
      else if (match[2] === 'NEEDS_INPUT') {
        // Keep the identifier: after the user answers, the agent finishes this pass.
        askedForInput = true;
        status = 'needs_input';
        publish();
      } else if (request.maxIterations !== undefined && pass >= request.maxIterations) {
        finish('stopped', null, { reachedLimit: true });
      } else {
        identifier = null;
        status = 'resetting';
        startBeforePassReset();
      }
    },
  };
}
