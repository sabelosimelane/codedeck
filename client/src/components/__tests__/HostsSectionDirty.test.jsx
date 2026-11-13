import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import HostsSection from '../HostsSection';

const hosts = [
  { name: 'local', builtIn: true, reachability: 'reachable' },
  { name: 'devbox', sshTarget: 'me@devbox', builtIn: false, reachability: 'unknown' },
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('HostsSection unsaved changes', () => {
  it('reports a half-typed new host and an edited host as unsaved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => hosts })));
    const onDirtyChange = vi.fn();
    const lastDirty = () => onDirtyChange.mock.calls.at(-1)[0];
    render(<HostsSection onDirtyChange={onDirtyChange} />);
    await screen.findByText('devbox');
    expect(lastDirty()).toBe(false);

    const newName = screen.getByPlaceholderText('name (e.g. devbox)');
    fireEvent.change(newName, { target: { value: 'box2' } });
    expect(lastDirty()).toBe(true);
    fireEvent.change(newName, { target: { value: '  ' } });
    expect(lastDirty()).toBe(false);

    const newTarget = screen.getByPlaceholderText('ssh target (~/.ssh/config alias or user@host)');
    fireEvent.change(newTarget, { target: { value: 'me@box2' } });
    expect(lastDirty()).toBe(true);
    fireEvent.change(newTarget, { target: { value: '' } });
    expect(lastDirty()).toBe(false);

    fireEvent.click(screen.getByTitle('Rename / edit'));
    expect(lastDirty()).toBe(false);
    fireEvent.change(screen.getByPlaceholderText('ssh target (alias or user@host)'), { target: { value: 'me@other' } });
    expect(lastDirty()).toBe(true);
    fireEvent.click(screen.getByTitle('Cancel'));
    expect(lastDirty()).toBe(false);

    fireEvent.click(screen.getByTitle('Rename / edit'));
    fireEvent.change(screen.getByPlaceholderText('host name'), { target: { value: 'renamed' } });
    expect(lastDirty()).toBe(true);
  });

  it('renders without a dirty listener', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => hosts })));
    render(<HostsSection />);
    expect(await screen.findByText('devbox')).toBeTruthy();
  });
});
