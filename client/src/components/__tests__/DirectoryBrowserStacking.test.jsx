import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import DirectoryBrowser from '../DirectoryBrowser.jsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// The folder picker is opened from shared ui dialogs (Repositories, Locations), so it must stack above them.
describe('DirectoryBrowser stacking', () => {
  it('opens above the shared dialog overlay it is launched from', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ui/ui.css'), 'utf8');
    const dialogLayer = Number(/\.ui-overlay\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1]);
    expect(dialogLayer).toBeGreaterThan(0);
    render(<DirectoryBrowser initialPath="/tmp" onSelect={() => {}} onCancel={() => {}} />);
    const overlay = screen.getByText('Browse Filesystem').closest('div[style*="position: fixed"]');
    expect(Number(overlay.style.zIndex)).toBeGreaterThan(dialogLayer);
  });
});
