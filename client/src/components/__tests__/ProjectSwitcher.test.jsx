import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import ProjectSwitcher from '../ProjectSwitcher';

vi.mock('lucide-react', () => ({
  Search: () => null,
}));

describe('ProjectSwitcher', () => {
  it('includes waiting projects and marks their state', () => {
    const onSelect = vi.fn();

    render(
      <ProjectSwitcher
        projects={[
          { name: 'Alpha', path: '/tmp/alpha' },
          { name: 'Beta', path: '/tmp/beta', waiting: true },
        ]}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();

    fireEvent.click(screen.getByText('Beta'));
    expect(onSelect).toHaveBeenCalledWith({ name: 'Beta', path: '/tmp/beta', waiting: true });
  });
});
