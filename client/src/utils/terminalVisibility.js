export function shouldSyncVisibleTerminal({ isVisible, width, height }) {
  return Boolean(isVisible && width > 0 && height > 0);
}

export function shouldWriteTerminalViewport({ isVisible, documentVisibility }) {
  return Boolean(isVisible && documentVisibility === 'visible');
}
