import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import ProjectLocationsDialog from '../ProjectLocationsDialog.jsx';

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('../ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProjectLocationsDialog', () => {
  it('opens DirectoryBrowser on the selected host and closes it cleanly on Cancel and Close', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).startsWith('/api/hosts')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { name: 'local', builtIn: true, reachability: 'reachable' },
            { name: 'devbox', sshTarget: 'devbox', defaultRoot: '/home/dev', builtIn: false, reachability: 'reachable' },
          ],
        };
      }
      if (String(url).startsWith('/api/browse')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ current: '/home/dev', parent: '/home', entries: [] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }));

    const project = {
      name: 'codedeck',
      path: '/local/codedeck',
      defaultHost: 'local',
      autoSync: true,
      locations: [{ host: 'local', path: '/local/codedeck', repositories: [] }],
    };

    const view = render(
      <ProjectLocationsDialog project={project} onUpdated={vi.fn()} onClose={vi.fn()} />
    );

    await waitFor(() => expect(view.getByText('Bind folder')).toBeTruthy());
    fireEvent.click(view.getByText('Bind folder'));
    fireEvent.click(view.getByText('Browse…'));

    await waitFor(() => expect(view.getByText('Browse Filesystem')).toBeTruthy());
    // Cancel button closes DirectoryBrowser while keeping ProjectLocationsDialog open
    fireEvent.click(view.getByTitle('Cancel folder selection'));
    expect(view.queryByText('Browse Filesystem')).toBeNull();
    expect(view.getByText('Hosts & sync — codedeck')).toBeTruthy();

    // Re-open and test top-right Close (×) button
    fireEvent.click(view.getByText('Browse…'));
    await waitFor(() => expect(view.getByText('Browse Filesystem')).toBeTruthy());
    fireEvent.click(view.getByTitle('Cancel'));
    expect(view.queryByText('Browse Filesystem')).toBeNull();
    expect(view.getByText('Hosts & sync — codedeck')).toBeTruthy();

    // Verify DirectoryBrowser pre-selected devbox when browsing
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/browse') && String(url).includes('host=devbox'))).toBe(true);
  });

  it('updates Git repository URL, Destination path, and Target host when typed or changed', async () => {
    const onUpdated = vi.fn();
    const fetchMock = vi.fn(async (url, opts) => {
      if (String(url).startsWith('/api/hosts')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { name: 'local', builtIn: true, reachability: 'reachable' },
            { name: 'devbox', sshTarget: 'devbox', defaultRoot: '/home/dev', builtIn: false, reachability: 'reachable' },
            { name: 'buildbox', sshTarget: 'buildbox', defaultRoot: '/srv/work', builtIn: false, reachability: 'reachable' },
          ],
        };
      }
      if (String(url).startsWith('/api/projects/codedeck/locations/clone') && opts?.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            name: 'codedeck',
            path: '/local/codedeck',
            defaultHost: 'local',
            gitUrl: 'git@github.com:org/codedeck.git',
            autoSync: true,
            locations: [
              { host: 'local', path: '/local/codedeck', repositories: [] },
              { host: 'buildbox', path: '/srv/work/custom-codedeck', repositories: [] },
            ],
          }),
        };
      }
      if (String(url) === '/api/projects/codedeck' && opts?.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'codedeck',
            path: '/local/codedeck',
            defaultHost: 'local',
            gitUrl: 'git@github.com:org/codedeck.git',
            autoSync: true,
            locations: [{ host: 'local', path: '/local/codedeck', repositories: [] }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const project = {
      name: 'codedeck',
      path: '/local/codedeck',
      defaultHost: 'local',
      autoSync: true,
      locations: [{ host: 'local', path: '/local/codedeck', repositories: [] }],
    };

    const view = render(
      <ProjectLocationsDialog project={project} onUpdated={onUpdated} onClose={vi.fn()} />
    );

    await waitFor(() => expect(view.getByLabelText('Target host')).toBeTruthy());

    const urlInput = view.getByPlaceholderText('git@github.com:org/repo.git or https://...');
    fireEvent.change(urlInput, { target: { value: 'git@github.com:org/codedeck.git' } });
    expect(urlInput.value).toBe('git@github.com:org/codedeck.git');

    const hostSelect = view.getByLabelText('Target host');
    fireEvent.change(hostSelect, { target: { value: 'buildbox' } });
    expect(hostSelect.value).toBe('buildbox');

    const destInput = view.getByPlaceholderText('/srv/work/codedeck');
    fireEvent.change(destInput, { target: { value: '/srv/work/custom-codedeck' } });
    expect(destInput.value).toBe('/srv/work/custom-codedeck');

    fireEvent.click(view.getByText('Save settings'));
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([u, o]) => u === '/api/projects/codedeck' && o?.method === 'PUT');
      expect(putCall).toBeTruthy();
      expect(JSON.parse(putCall[1].body)).toEqual({ gitUrl: 'git@github.com:org/codedeck.git', autoSync: true });
    });

    fireEvent.click(view.getByText('Clone onto buildbox'));
    await waitFor(() => {
      const cloneCall = fetchMock.mock.calls.find(([u, o]) => u === '/api/projects/codedeck/locations/clone' && o?.method === 'POST');
      expect(cloneCall).toBeTruthy();
      expect(JSON.parse(cloneCall[1].body)).toEqual({
        host: 'buildbox',
        gitUrl: 'git@github.com:org/codedeck.git',
        targetPath: '/srv/work/custom-codedeck',
      });
    });
  });

  it('auto-discovers multi-repo remotes, lets user uncheck repos before cloning, and supports Clone missing on partial hosts', async () => {
    const onUpdated = vi.fn();
    const discoveredProject = {
      name: 'mlondolozi',
      path: '/local/mlondolozi/backend',
      defaultHost: 'local',
      gitUrl: 'git@github.com:org/backend.git',
      autoSync: true,
      workspaceMode: 'repo',
      repoManifest: [
        { name: 'backend', gitUrl: 'git@github.com:org/backend.git', primary: true },
        { name: 'frontend', gitUrl: 'git@github.com:org/frontend.git', primary: false },
        { name: 'local-only', gitUrl: null, primary: false },
      ],
      locations: [
        {
          host: 'local',
          path: '/local/mlondolozi/backend',
          repositories: [
            { name: 'frontend', path: '/local/mlondolozi/frontend' },
            { name: 'local-only', path: '/local/mlondolozi/local-only' },
          ],
        },
        {
          host: 'staging',
          path: '/srv/mlondolozi/backend',
          repositories: [],
        },
      ],
    };

    const fetchMock = vi.fn(async (url, opts) => {
      if (String(url).startsWith('/api/hosts')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { name: 'local', builtIn: true, reachability: 'reachable' },
            { name: 'staging', sshTarget: 'staging', defaultRoot: '/srv', builtIn: false, reachability: 'reachable' },
            { name: 'media-server', sshTarget: 'media-server', defaultRoot: '/home/dev', builtIn: false, reachability: 'reachable' },
          ],
        };
      }
      if (String(url) === '/api/projects/mlondolozi/discover-remotes' && opts?.method === 'POST') {
        return { ok: true, status: 200, json: async () => discoveredProject };
      }
      if (String(url) === '/api/projects/mlondolozi/locations/staging/clone-missing' && opts?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...discoveredProject,
            cloneSummary: { cloned: ['frontend'], skipped: [{ name: 'local-only', reason: 'no_remote' }] },
          }),
        };
      }
      if (String(url) === '/api/projects/mlondolozi/locations/clone' && opts?.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            ...discoveredProject,
            cloneSummary: { cloned: ['backend'], skipped: [] },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const initialProject = {
      name: 'mlondolozi',
      path: '/local/mlondolozi/backend',
      defaultHost: 'local',
      autoSync: true,
      locations: discoveredProject.locations,
    };

    const view = render(
      <ProjectLocationsDialog project={initialProject} onUpdated={onUpdated} onClose={vi.fn()} />
    );

    // Discovers remotes automatically and shows multi-repo manifest
    await waitFor(() => expect(view.getByText(/Project repositories \(3\)/i)).toBeTruthy());
    expect(view.getByText('git@github.com:org/frontend.git')).toBeTruthy();

    // Partial host `staging` shows Clone missing button
    const cloneMissingBtn = view.getByRole('button', { name: /Clone missing/i });
    fireEvent.click(cloneMissingBtn);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/projects/mlondolozi/locations/staging/clone-missing',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // Uncheck `frontend` in clone selection and clone onto `media-server`
    const frontendCheckbox = view.getByLabelText('Clone frontend');
    expect(frontendCheckbox.checked).toBe(true);
    fireEvent.click(frontendCheckbox);
    expect(frontendCheckbox.checked).toBe(false);

    fireEvent.click(view.getByText(/Clone 1 repo onto media-server/i));
    await waitFor(() => {
      const cloneCall = fetchMock.mock.calls.find(([u, o]) => u === '/api/projects/mlondolozi/locations/clone' && o?.method === 'POST');
      expect(cloneCall).toBeTruthy();
      expect(JSON.parse(cloneCall[1].body)).toEqual({
        host: 'media-server',
        repositories: ['backend'],
      });
    });
  });
});
