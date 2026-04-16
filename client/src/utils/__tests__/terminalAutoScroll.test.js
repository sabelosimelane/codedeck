import { describe, expect, it } from 'vitest';
import {
  isTerminalViewportAtBottom,
  shouldPauseAutoScrollOnWheel,
} from '../terminalAutoScroll';

describe('isTerminalViewportAtBottom', () => {
  it('treats the viewport as pinned when viewportY matches baseY', () => {
    expect(isTerminalViewportAtBottom({ viewportY: 24, baseY: 24 })).toBe(true);
  });

  it('treats the viewport as detached when viewportY is above baseY', () => {
    expect(isTerminalViewportAtBottom({ viewportY: 18, baseY: 24 })).toBe(false);
  });
});

describe('shouldPauseAutoScrollOnWheel', () => {
  it('pauses auto-scroll as soon as the user wheels upward with scrollback available', () => {
    expect(shouldPauseAutoScrollOnWheel({
      deltaY: -36,
      buffer: { viewportY: 24, baseY: 24 },
    })).toBe(true);
  });

  it('pauses auto-scroll for any wheel attempt while pinned at the bottom with scrollback available', () => {
    expect(shouldPauseAutoScrollOnWheel({
      deltaY: 36,
      buffer: { viewportY: 24, baseY: 24 },
    })).toBe(true);
  });

  it('keeps auto-scroll active once the viewport is already detached from the bottom', () => {
    expect(shouldPauseAutoScrollOnWheel({
      deltaY: 36,
      buffer: { viewportY: 20, baseY: 24 },
    })).toBe(false);
  });

  it('does not pause auto-scroll when there is no scrollback yet', () => {
    expect(shouldPauseAutoScrollOnWheel({
      deltaY: -36,
      buffer: { viewportY: 0, baseY: 0 },
    })).toBe(false);
  });
});
