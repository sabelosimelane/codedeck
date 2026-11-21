import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import SyncConflictDialog from '../SyncConflictDialog.jsx';

describe('SyncConflictDialog', () => {
  it('renders blocked repositories and invokes proceed or abort callbacks', () => {
    const onProceed = vi.fn();
    const onCancel = vi.fn();
    const { getByText } = render(
      <SyncConflictDialog
        conflict={{
          host: 'devbox',
          results: [{
            status: 'blocked',
            code: 'dirty',
            repository: 'codedeck',
            branch: 'main',
            message: 'Working tree has uncommitted changes.',
          }],
        }}
        actionLabel="open a terminal"
        onProceed={onProceed}
        onCancel={onCancel}
      />
    );

    expect(getByText('Could not sync latest changes')).toBeTruthy();
    expect(getByText('codedeck')).toBeTruthy();
    expect(getByText('Uncommitted changes')).toBeTruthy();
    expect(getByText('Working tree has uncommitted changes.')).toBeTruthy();

    fireEvent.click(getByText('Proceed without syncing'));
    expect(onProceed).toHaveBeenCalledTimes(1);

    fireEvent.click(getByText('Abort'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
