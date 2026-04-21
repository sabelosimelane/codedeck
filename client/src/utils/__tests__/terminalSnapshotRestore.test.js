import { describe, expect, it } from 'vitest';
import { buildTerminalSnapshotReplay } from '../terminalSnapshotRestore';

describe('buildTerminalSnapshotReplay', () => {
  it('returns plain snapshot data when no terminal state metadata is present', () => {
    expect(buildTerminalSnapshotReplay({ data: 'plain text\n' })).toBe('plain text\n');
  });

  it('rebuilds alternate-screen modeful terminal state before replaying snapshot text', () => {
    const replay = buildTerminalSnapshotReplay({
      data: '\x1b[32m~\x1b[39m\n',
      terminalState: {
        screenMode: 'alternate',
        paneMode: null,
        cursorX: 4,
        cursorY: 2,
        cursorVisible: false,
        cursorShape: 'bar',
        cursorBlinking: false,
        cursorVeryVisible: false,
        insertMode: false,
        originMode: false,
        autoWrap: true,
        keypadMode: false,
        applicationCursorKeys: true,
        mouseMode: 'all',
        mouseEncoding: 'sgr',
        bracketedPaste: true,
      },
    });

    expect(replay).toContain('\x1b[?1049h');
    expect(replay).toContain('\x1b[?1h');
    expect(replay).toContain('\x1b[?2004h');
    expect(replay).toContain('\x1b[?1003h');
    expect(replay).toContain('\x1b[?1006h');
    expect(replay).toContain('\x1b[?25l');
    expect(replay).toContain('\x1b[6 q');
    expect(replay).toContain('\x1b[32m~\x1b[39m\n');
    expect(replay.endsWith('\x1b[3;5H')).toBe(true);
  });
});
