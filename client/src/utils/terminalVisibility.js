export function shouldSyncVisibleTerminal({ isVisible, width, height }) {
  return Boolean(isVisible && width > 0 && height > 0);
}
