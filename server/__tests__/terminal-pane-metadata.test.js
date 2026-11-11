import { describe, expect, it } from 'vitest';
import { parseTerminalPaneMetadata } from '../terminal-runtime.js';

const good = '0\tnode\t0\t1794348000\t/work/demo';
describe('tmux pane metadata preconditions', () => {
  it.each([
    ['pane_index', 'x\tnode\t0\t1794348000\t/work/demo'],
    ['pane_current_command', '0\t\t0\t1794348000\t/work/demo'],
    ['pane_dead', '0\tnode\tx\t1794348000\t/work/demo'],
    ['window_activity', '0\tnode\t0\tx\t/work/demo'],
    ['pane_current_path', '0\tnode\t0\t1794348000\t'],
  ])('rejects invalid %s', (field, raw) => {
    expect(() => parseTerminalPaneMetadata(raw)).toThrow(field);
  });
  it('returns ordered panes and rejects duplicate indices', () => {
    expect(parseTerminalPaneMetadata(`1\tnode\t0\t1794348000\t/work/demo\n${good}`)).toMatchObject([{ paneIndex: 0 }, { paneIndex: 1 }]);
    expect(() => parseTerminalPaneMetadata(`${good}\n${good}`)).toThrow('pane_index');
  });
});
