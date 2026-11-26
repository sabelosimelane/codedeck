import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import ShortcutsOverlay from './ShortcutsOverlay.jsx';

afterEach(cleanup);

describe('ShortcutsOverlay', () => {
  it('lists the project assistant toggle with Shift+L', () => {
    render(<ShortcutsOverlay onClose={() => {}} />);
    const row = screen.getByText('Toggle project assistant').closest('.shortcuts-row');
    expect(row).not.toBeNull();
    const keys = [...row.querySelectorAll('kbd')].map(kbd => kbd.textContent);
    expect(keys.slice(1)).toEqual(['⇧', 'L']);
    expect(['⌘', 'Ctrl']).toContain(keys[0]);
  });
});
