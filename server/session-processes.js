function pid(value, field, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 2)) {
    throw new Error(`${field} must be a safe integer ${allowZero ? 'at least 0' : 'greater than 1'}`);
  }
  return value;
}

function tty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

const normalizeTty = value => value.startsWith('/dev/') ? value.slice(5) : value;

export function collectSessionProcessIds({ panes, processes, excludePids }) {
  if (!Array.isArray(panes)) throw new Error('panes must be an array');
  if (!Array.isArray(processes)) throw new Error('processes must be an array');
  if (!Array.isArray(excludePids)) throw new Error('excludePids must be an array');
  const excluded = new Set(excludePids.map((value, index) => pid(value, `excludePids[${index}]`, { allowZero: true })));
  const paneRows = panes.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`panes[${index}] must be an object`);
    return { pid: pid(row.pid, `panes[${index}].pid`), tty: normalizeTty(tty(row.tty, `panes[${index}].tty`)) };
  });
  const processRows = processes.map((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`processes[${index}] must be an object`);
    return {
      pid: pid(row.pid, `processes[${index}].pid`, { allowZero: true }),
      ppid: pid(row.ppid, `processes[${index}].ppid`, { allowZero: true }),
      tty: normalizeTty(tty(row.tty, `processes[${index}].tty`)),
    };
  });
  const paneTtys = new Set(paneRows.map(row => row.tty));
  const selected = new Set(paneRows.map(row => row.pid));
  for (const row of processRows) {
    if (row.tty !== '?' && row.tty !== '??' && paneTtys.has(row.tty)) selected.add(row.pid);
  }
  let changed;
  do {
    changed = false;
    for (const row of processRows) {
      if (selected.has(row.ppid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  } while (changed);
  return [...selected].filter(value => value > 1 && !excluded.has(value)).sort((a, b) => a - b);
}

function numberToken(raw, field, allowZero = false) {
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`${field} must be a decimal integer`);
  return pid(Number(raw), field, { allowZero });
}

export function parsePaneProcesses(raw) {
  if (typeof raw !== 'string') throw new Error('tmux pane output must be text');
  if (!raw.trim()) return [];
  return raw.trimEnd().split('\n').map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== 2) throw new Error(`tmux pane row ${index} must contain pid and tty`);
    return { pid: numberToken(fields[0], `pane[${index}].pid`), tty: tty(fields[1], `pane[${index}].tty`) };
  });
}

export function parseProcessSnapshot(raw) {
  if (typeof raw !== 'string') throw new Error('ps output must be text');
  if (!raw.trim()) return [];
  return raw.trim().split('\n').map((line, index) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3) throw new Error(`ps row ${index} must contain pid, ppid, and tty`);
    return {
      pid: numberToken(fields[0], `ps[${index}].pid`, true),
      ppid: numberToken(fields[1], `ps[${index}].ppid`, true),
      tty: tty(fields[2], `ps[${index}].tty`),
    };
  });
}
