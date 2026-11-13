import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../Sidebar', () => ({ default: ({ activeProjects, activeProject, onSelect }) => <div>{activeProjects.map(project => <button key={project.name} onClick={() => onSelect(project)}>{project.name}</button>)}<span data-testid="active-project">{activeProject?.name}</span></div> }));
vi.mock('../TerminalArea', () => ({ default: ({ project, resumedSessionId, onOpenSessionSearch }) => <div><button onClick={onOpenSessionSearch}>Open session search</button><span data-testid="terminal-project">{project.name}</span><span data-testid="resumed-tab">{resumedSessionId}</span></div> }));
vi.mock('../FileTree', () => ({ default: () => null }));
vi.mock('../FileBrowserPanel', () => ({ default: () => null }));
vi.mock('../ProjectSwitcher', () => ({ default: () => null }));
vi.mock('../ShortcutsOverlay', () => ({ default: () => null }));
vi.mock('../PaneDivider', () => ({ default: () => null }));
vi.mock('../PreviewPage', () => ({ default: () => null }));
vi.mock('../ToastContext', () => ({ ToastProvider: ({ children }) => children, useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('../../hooks/useSessionTitles', () => ({ useSessionTitles: () => ({ titles: {}, refresh: vi.fn(), error: null }) }));
vi.mock('../../hooks/useSessionAttention', () => ({ useSessionAttention: () => ({ finishedSessionIds: new Set(), mutedStatusSessionIds: new Set(), resetFinishedSession: vi.fn(), toggleMutedStatusSession: vi.fn() }) }));
vi.mock('../../hooks/useWaitingSessions', () => ({ useWaitingSessions: () => ({ waitingSessionIds: new Set(), toggleWaiting: vi.fn() }) }));

import App from '../../App';

const projects = [{ name: 'Alpha', path: '/tmp/alpha' }, { name: 'Beta', path: '/tmp/beta' }];
const conversation = { cli: 'codex', conversationId: 'b', title: 'Fix beta', firstPrompt: null, project: 'Beta', cwd: '/tmp/beta', updatedAt: Date.now() };

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it('switches project and passes the confirmed session ID to its terminal area', async () => {
  global.fetch = vi.fn(async (url) => {
    if (url === '/api/projects') return { ok: true, json: async () => projects };
    if (url === '/api/sessions') return { ok: true, json: async () => [] };
    if (url.startsWith('/api/agent-sessions?')) return { ok: true, json: async () => ({ data: [conversation], page: { hasNextPage: false }, sources: [] }) };
    if (url === '/api/agent-sessions/resume') return { ok: true, json: async () => ({ sessionId: 'Beta-9', project: 'Beta', cli: 'codex', conversationId: 'b' }) };
    return { ok: true, json: async () => ({}) };
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open session search' }));
  fireEvent.click(await screen.findByRole('button', { name: /Fix beta/ }));
  await waitFor(() => expect(screen.getByTestId('terminal-project').textContent).toBe('Beta'));
  expect(screen.getByTestId('resumed-tab').textContent).toBe('Beta-9');
  expect(screen.queryByRole('dialog', { name: 'Session search' })).toBeNull();
});
