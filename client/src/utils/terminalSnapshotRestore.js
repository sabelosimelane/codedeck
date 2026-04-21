function buildCursorStyleSequence(terminalState) {
  const shape = terminalState?.cursorShape;
  const blinking = terminalState?.cursorBlinking !== false;

  if (shape === 'block') return blinking ? '\x1b[1 q' : '\x1b[2 q';
  if (shape === 'underline') return blinking ? '\x1b[3 q' : '\x1b[4 q';
  if (shape === 'bar') return blinking ? '\x1b[5 q' : '\x1b[6 q';
  return '';
}

function buildMouseModeSequence(terminalState) {
  if (!terminalState) return '';

  const mode = terminalState.mouseMode;
  if (mode === 'all') return '\x1b[?1003h';
  if (mode === 'button') return '\x1b[?1002h';
  if (mode === 'standard') return '\x1b[?1000h';
  return '';
}

function buildMouseEncodingSequence(terminalState) {
  if (!terminalState) return '';

  const encoding = terminalState.mouseEncoding;
  if (encoding === 'sgr') return '\x1b[?1006h';
  if (encoding === 'utf8') return '\x1b[?1005h';
  return '';
}

function buildCursorPositionSequence(terminalState) {
  const cursorX = terminalState?.cursorX;
  const cursorY = terminalState?.cursorY;
  if (!Number.isInteger(cursorX) || !Number.isInteger(cursorY)) return '';
  return `\x1b[${cursorY + 1};${cursorX + 1}H`;
}

export function buildTerminalSnapshotReplay(snapshot = {}) {
  const terminalState = snapshot.terminalState;
  const snapshotData = snapshot.data ?? '';

  if (!terminalState) return snapshotData;

  const prefix = [];
  const suffix = [];

  if (terminalState.screenMode === 'alternate') {
    prefix.push('\x1b[?1049h');
  }
  if (terminalState.applicationCursorKeys) {
    prefix.push('\x1b[?1h');
  }
  if (terminalState.keypadMode) {
    prefix.push('\x1b=');
  }
  if (terminalState.insertMode) {
    prefix.push('\x1b[4h');
  }
  if (terminalState.originMode) {
    prefix.push('\x1b[?6h');
  }
  if (terminalState.autoWrap === false) {
    prefix.push('\x1b[?7l');
  }
  if (terminalState.bracketedPaste) {
    prefix.push('\x1b[?2004h');
  }
  if (terminalState.cursorVisible === false) {
    prefix.push('\x1b[?25l');
  }

  const mouseModeSequence = buildMouseModeSequence(terminalState);
  if (mouseModeSequence) {
    prefix.push(mouseModeSequence);
  }

  const mouseEncodingSequence = buildMouseEncodingSequence(terminalState);
  if (mouseEncodingSequence) {
    prefix.push(mouseEncodingSequence);
  }

  const cursorStyleSequence = buildCursorStyleSequence(terminalState);
  if (cursorStyleSequence) {
    prefix.push(cursorStyleSequence);
  }

  const cursorPositionSequence = buildCursorPositionSequence(terminalState);
  if (cursorPositionSequence) {
    suffix.push(cursorPositionSequence);
  }

  return `${prefix.join('')}${snapshotData}${suffix.join('')}`;
}
