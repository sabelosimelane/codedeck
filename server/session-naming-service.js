import { NamingError, requireField, validateTitle } from './session-naming-validation.js';

// Observe submission boundaries only. Keystroke content is never retained.
export function observesSubmission(state, data) {
  requireField(typeof data === 'string', 'input', 'Terminal input must be text');
  const text = (state.tail || '') + data;
  state.tail = '';
  let submitted = false;
  const submit = () => { if (state.characters > 0) submitted = true; state.characters = 0; };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\x1b') {
      const rest = text.slice(i);
      const match = rest.match(/^\x1b\[[0-9;:]*[A-Za-z~]/);
      if (match) {
        if (match[0] === '\x1b[200~') state.pasting = true;
        else if (match[0] === '\x1b[201~') state.pasting = false;
        else if (!state.pasting && /^\x1b\[13(?:;1)?u$/.test(match[0])) submit();
        i += match[0].length - 1;
      } else if (/^\x1b(?:\[[0-9;:]*)?$/.test(rest)) { state.tail = rest.slice(0, 32); break; }
    } else if (!state.pasting && /[\r\n]/.test(text[i])) submit();
    else if (text[i] === '\x03' || text[i] === '\x15') state.characters = 0;
    else if (text[i] === '\x7f' || text[i] === '\b') state.characters = Math.max(0, (state.characters || 0) - 1);
    else if (!/[\x00-\x20\x7f]/.test(text[i])) state.characters = (state.characters || 0) + 1;
  }
  return submitted;
}

export function boundContext(text) {
  requireField(typeof text === 'string', 'snapshotText', 'A terminal snapshot is required');
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(-12000);
}

export function createNamingService({ store, generate, capture }) {
  const inputs = new Map();
  const queue = [];
  const pending = new Set();
  const deleted = new Set();
  const retryTimers = new Map();
  const cancelRetry = id => { clearTimeout(retryTimers.get(id)); retryTimers.delete(id); };
  let running = 0;
  let stopped = false;

  async function run(job) {
    let record = store.get(job.id);
    if (!record || record.revision !== job.revision || stopped) return;
    record = store.update(job.id, { state: 'generating', error: null }, job.revision);
    try {
      const text = boundContext(job.context ?? await capture(job.id));
      if (job.context == null && inputs.has(job.id)) inputs.get(job.id).submitted = false;
      if (!text.trim()) throw new NamingError('No terminal context available', 409);
      if (JSON.stringify(store.settings()) !== JSON.stringify(job.settings)) throw new NamingError('Naming settings changed', 409);
      const title = await generate(job.settings, text);
      if (title !== null) validateTitle(title);
      store.update(job.id, { state: title === null ? 'waiting' : 'named', title, source: title === null ? null : 'generated', error: null }, record.revision);
    } catch (error) {
      const reason = error instanceof NamingError ? error.message : 'Could not generate a title. Check the Conduit connection and selection.';
      const deadline = job.deadline ?? Date.now() + 60000;
      const canRetry = !stopped && Date.now() + 10000 <= deadline && JSON.stringify(store.settings()) === JSON.stringify(job.settings);
      const updated = store.update(job.id, { state: canRetry ? 'queued' : 'failed', error: reason }, record.revision);
      if (updated && canRetry) {
        const timer = setTimeout(() => {
          retryTimers.delete(job.id);
          const current = store.get(job.id);
          if (stopped || !current || current.revision !== updated.revision) return;
          if (Date.now() > deadline || queue.length >= 100) {
            store.update(job.id, { state: 'failed', error: reason }, current.revision); return;
          }
          queue.push({ ...job, context: null, deadline, revision: current.revision });
          drain();
        }, 10000);
        timer.unref?.(); retryTimers.set(job.id, timer);
      }
    }
  }
  function drain() {
    while (!stopped && running < 2 && queue.length) {
      const job = queue.shift(); running++;
      const task = run(job).catch(() => { console.error('[session-naming] job persistence failed'); }).finally(() => {
        running--; pending.delete(task); drain();
      });
      pending.add(task);
    }
  }
  function enqueue(id, context) {
    const settings = store.settings();
    if (!settings) throw new NamingError('Configure session naming first', 409);
    const record = store.ensure(id);
    if (['queued', 'generating'].includes(record.state)) return record;
    if (queue.length >= 100) throw new NamingError('Naming queue is full; retry shortly', 503);
    const queued = store.update(id, { state: 'queued', error: null });
    queue.push({ id, context, settings, revision: queued.revision });
    queueMicrotask(drain);
    return queued;
  }
  return {
    input(id, data) {
      if (stopped || deleted.has(id) || !store.settings()) return;
      const record = store.get(id);
      if (record && !['waiting', 'queued', 'generating', 'failed'].includes(record.state)) return;
      let input = inputs.get(id);
      if (!input) { input = {}; inputs.set(id, input); }
      if (observesSubmission(input, data)) input.submitted = true;
    },
    observe(id, { executionStatus, snapshotText }) {
      if (stopped || deleted.has(id) || !inputs.get(id)?.submitted || executionStatus !== 'running' || typeof snapshotText !== 'string' || !snapshotText.trim()) return;
      const record = store.get(id);
      if (record && !['waiting', 'failed'].includes(record.state)) return;
      inputs.get(id).submitted = false;
      try { enqueue(id, boundContext(snapshotText)); } catch (error) {
        store.ensure(id); store.update(id, { state: 'failed', error: 'Naming could not be queued. Check settings and retry.' });
        console.warn('[session-naming] could not queue naming job');
      }
    },
    rename(id, title) { validateTitle(title); cancelRetry(id); store.ensure(id); inputs.delete(id); return store.update(id, { title, state: 'manual', source: 'manual', error: null }); },
    retry(id) {
      const record = store.get(id);
      if (!record) throw new NamingError('Session title not found', 404);
      if (['queued', 'generating'].includes(record.state)) return record;
      if (record.state !== 'failed') throw new NamingError('Only failed naming requests can be retried', 409);
      return enqueue(id, null);
    },
    remove(id) { cancelRetry(id); deleted.add(id); inputs.delete(id); store.remove(id); },
    async waitForIdle() { await Promise.resolve(); while (pending.size || queue.length) { drain(); await Promise.all([...pending]); } },
    stop() { stopped = true; for (const id of retryTimers.keys()) cancelRetry(id); queue.length = 0; inputs.clear(); },
  };
}
