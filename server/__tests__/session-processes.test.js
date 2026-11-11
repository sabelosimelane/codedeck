import { describe, expect, it } from 'vitest';
import { collectSessionProcessIds, parsePaneProcesses, parseProcessSnapshot } from '../session-processes.js';

describe('session process collection', () => {
  it('includes pane pids, tty peers, and transitive descendants including detached tty-less children', () => {
    expect(collectSessionProcessIds({
      panes: [{ pid: 20, tty: '/dev/ttys012' }, { pid: 30, tty: '/dev/pts/3' }],
      processes: [
        { pid: 21, ppid: 1, tty: 'ttys012' },
        { pid: 22, ppid: 20, tty: '??' },
        { pid: 23, ppid: 22, tty: '?' },
        { pid: 31, ppid: 1, tty: 'pts/3' },
        { pid: 40, ppid: 1, tty: 'other' },
      ],
      excludePids: [20, 40],
    })).toEqual([21, 22, 23, 30, 31]);
  });

  it.each([
    { panes: [{ pid: 1, tty: '/dev/pts/1' }], processes: [], excludePids: [] },
    { panes: [{ pid: 2, tty: '' }], processes: [], excludePids: [] },
    { panes: [], processes: [{ pid: 3, ppid: '1', tty: '?' }], excludePids: [] },
    { panes: [], processes: [{ pid: 3, ppid: 1, tty: null }], excludePids: [] },
    { panes: [], processes: [], excludePids: [-1] },
  ])('rejects malformed input per field: %j', input => {
    expect(() => collectSessionProcessIds(input)).toThrow();
  });

  it('parses pane and ps rows with strict field checks', () => {
    expect(parsePaneProcesses('20\t/dev/pts/3\n')).toEqual([{ pid: 20, tty: '/dev/pts/3' }]);
    expect(parseProcessSnapshot(' 21  20  pts/3\n 22 1 ??\n')).toEqual([
      { pid: 21, ppid: 20, tty: 'pts/3' }, { pid: 22, ppid: 1, tty: '??' },
    ]);
    expect(() => parsePaneProcesses('bad\t/dev/pts/3\n')).toThrow(/pid/);
    expect(() => parseProcessSnapshot('21 20\n')).toThrow(/tty/);
  });

  it('accepts system ps rows while never returning pid zero or one', () => {
    const processes = parseProcessSnapshot('1 0 pts/3\n0 0 pts/3\n21 1 pts/3\n');
    expect(collectSessionProcessIds({ panes: [{ pid: 20, tty: '/dev/pts/3' }], processes, excludePids: [1] })).toEqual([20, 21]);
  });
});
