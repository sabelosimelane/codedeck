import { describe, expect, it } from 'vitest';
import {
  shouldSyncVisibleTerminal,
  shouldWriteTerminalViewport,
} from '../../utils/terminalVisibility';

describe('shouldSyncVisibleTerminal', () => {
  it('allows sync for visible terminals with real dimensions', () => {
    expect(shouldSyncVisibleTerminal({
      isVisible: true,
      width: 800,
      height: 600,
    })).toBe(true);
  });

  it('blocks sync for hidden terminals', () => {
    expect(shouldSyncVisibleTerminal({
      isVisible: false,
      width: 800,
      height: 600,
    })).toBe(false);
  });

  it('blocks sync for zero-sized terminals', () => {
    expect(shouldSyncVisibleTerminal({
      isVisible: true,
      width: 0,
      height: 600,
    })).toBe(false);
  });
});

describe('shouldWriteTerminalViewport', () => {
  it('allows writes only when the pane is active and the document is visible', () => {
    expect(shouldWriteTerminalViewport({
      isVisible: true,
      documentVisibility: 'visible',
    })).toBe(true);
  });

  it('blocks writes for hidden panes even if the document is visible', () => {
    expect(shouldWriteTerminalViewport({
      isVisible: false,
      documentVisibility: 'visible',
    })).toBe(false);
  });

  it('blocks writes while the document is hidden', () => {
    expect(shouldWriteTerminalViewport({
      isVisible: true,
      documentVisibility: 'hidden',
    })).toBe(false);
  });
});
