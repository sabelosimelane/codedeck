/**
 * What the backend does when it is told to stop (SIGTERM from `node --watch` after a change to
 * its files, from `./server.sh stop`, or Ctrl-C): it lets the work that must not be cut in half
 * finish, then exits. Node's watcher starts the next process only once this one is gone, so a
 * merge that changes the backend's own files is finished and recorded by the process that began it.
 */
export function createShutdown({ pending, timeoutMs, exit, log, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  for (const [name, value] of Object.entries({ pending, exit, log, setTimer, clearTimer })) {
    if (typeof value !== 'function') throw new TypeError(`shutdown: ${name} must be a function`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('shutdown: timeoutMs must be a positive integer');

  let stopping = false;
  return function shutdown(signal) {
    if (typeof signal !== 'string' || !signal) throw new TypeError('shutdown: signal must be named');
    if (stopping) return;
    stopping = true;
    log(`[shutdown] ${signal}: finishing work in progress before exiting`);
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      exit(code);
    };
    const timer = setTimer(() => {
      if (done) return;
      log(`[shutdown] work in progress did not finish within ${timeoutMs} ms; exiting with it unfinished`);
      finish(1);
    }, timeoutMs);
    Promise.resolve().then(pending).then(
      () => finish(0),
      (error) => {
        log(`[shutdown] could not wait for work in progress: ${error?.message || error}`);
        finish(1);
      },
    );
  };
}
