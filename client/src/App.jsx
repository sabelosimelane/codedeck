import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Sidebar from './components/Sidebar';
import TerminalArea from './components/TerminalArea';
import FileTree from './components/FileTree';
import FileBrowserPanel from './components/FileBrowserPanel';
import ProjectSwitcher from './components/ProjectSwitcher';
import ShortcutsOverlay from './components/ShortcutsOverlay';
import SessionSearch from './components/SessionSearch';
import RunWorkflowDialog from './components/pipelines/RunWorkflowDialog';
import PaneDivider from './components/PaneDivider';
import PreviewPage from './components/PreviewPage';
import { ToastProvider, useToast } from './components/ToastContext';
import { useSessionAttention } from './hooks/useSessionAttention';
import { usePipelineRuns } from './hooks/usePipelineRuns';
import { openFilePreviewTab } from './utils/fileActions';
import { useSessionTitles } from './hooks/useSessionTitles';
import { useWaitingSessions } from './hooks/useWaitingSessions';
import { buildRunAdoptionSessions, planTerminalAdoption } from './utils/terminalAdoption';
import {
  DEFAULT_APP_TITLE,
  SYSTEM_RESOURCES_URL,
  createResourceAlertFavicon,
  formatSystemResourceTitle,
  hasSystemResourceAlert,
} from './utils/systemResourceTitle';

const DEFAULT_FAVICON_HREF = '/favicon.svg';
const SYSTEM_RESOURCES_POLL_INTERVAL_MS = 30000;

function updateResourceFavicon(isAlerting) {
  const icon = document.querySelector("link[rel~='icon']") || document.createElement('link');
  icon.rel = 'icon';
  icon.href = isAlerting ? createResourceAlertFavicon() : DEFAULT_FAVICON_HREF;

  if (!icon.parentNode) {
    document.head.appendChild(icon);
  }
}

export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

function AppContent() {
  const previewPath = new URLSearchParams(window.location.search).get('preview');
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const [isSidebarCompact, setIsSidebarCompact] = useState(() => {
    return localStorage.getItem('codedeck-sidebar-compact') === 'true';
  });
  const [showFileTree, setShowFileTree] = useState(false);
  const [sessionStatus, setSessionStatus] = useState([]);
  const { titles: sessionTitles, refresh: refreshSessionTitles, error: namingError } = useSessionTitles();
  const [fileBrowserProject, setFileBrowserProject] = useState(null);
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);
  const [showShortcutsOverlay, setShowShortcutsOverlay] = useState(false);
  const [showSessionSearch, setShowSessionSearch] = useState(false);
  const [showRunWorkflow, setShowRunWorkflow] = useState(false);
  const [resumedSession, setResumedSession] = useState(null);
  const [adoptedSessionIds, setAdoptedSessionIds] = useState(() => new Set());
  const [fileTreeWidth, setFileTreeWidth] = useState(() => {
    const saved = localStorage.getItem('codedeck-filetree-width');
    return saved ? parseInt(saved, 10) : 260;
  });
  const { showToast } = useToast();
  // Finished and muted state is owned by the backend so the phone and every
  // browser tab honour the same rules.
  const { finishedSessionIds, mutedStatusSessionIds, resetFinishedSession, toggleMutedStatusSession } = useSessionAttention(sessionStatus, showToast);
  const { waitingSessionIds, toggleWaiting } = useWaitingSessions(showToast, { sessionStatus, finishedSessionIds });
  const {
    runs: pipelineRuns,
    locallyStartedRunIds,
    startRun,
    stopRun,
    resumeRun,
    continueRun,
    cleanupRun,
  } = usePipelineRuns({ projectName: activeProject?.name || null, showToast });
  const sessionStatusRequestInFlightRef = useRef(false);
  const systemResourcesRequestInFlightRef = useRef(false);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) {
        showToast({ type: 'error', message: 'Failed to load projects' });
        return;
      }
      const data = await res.json();
      setProjects(data);
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  }, [showToast]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  useEffect(() => {
    if (previewPath) return undefined;

    const fetchSystemResources = async () => {
      if (systemResourcesRequestInFlightRef.current) return;
      systemResourcesRequestInFlightRef.current = true;
      try {
        const res = await fetch(SYSTEM_RESOURCES_URL);
        if (res.ok) {
          const resources = await res.json();
          document.title = formatSystemResourceTitle(resources);
          updateResourceFavicon(hasSystemResourceAlert(resources));
        }
      } catch {
        // Silent — the external resource service is optional while CodeDeck runs.
      } finally {
        systemResourcesRequestInFlightRef.current = false;
      }
    };

    document.title = DEFAULT_APP_TITLE;
    fetchSystemResources();
    const id = setInterval(fetchSystemResources, SYSTEM_RESOURCES_POLL_INTERVAL_MS);

    return () => {
      clearInterval(id);
      document.title = DEFAULT_APP_TITLE;
      updateResourceFavicon(false);
    };
  }, [previewPath]);

  useEffect(() => {
    localStorage.setItem('codedeck-sidebar-compact', String(isSidebarCompact));
  }, [isSidebarCompact]);

  useEffect(() => {
    localStorage.setItem('codedeck-filetree-width', String(fileTreeWidth));
  }, [fileTreeWidth]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      const key = event.key.toLowerCase();
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;
      
      // Cmd/Ctrl + B: Toggle project sidebar
      if (key === 'b' && isCmdOrCtrl && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setIsSidebarCompact(prev => !prev);
        return;
      }
      
      // Cmd/Ctrl + Shift + F: Toggle files browser
      if (key === 'f' && isCmdOrCtrl && event.shiftKey && !event.altKey) {
        event.preventDefault();
        setShowFileTree(prev => !prev);
        return;
      }

      // Cmd/Ctrl + Shift + P: Project quick switcher
      if (key === 'p' && isCmdOrCtrl && event.shiftKey && !event.altKey) {
        event.preventDefault();
        setShowProjectSwitcher(prev => !prev);
        return;
      }

      // Cmd/Ctrl + Shift + S: Search agent conversations
      if (key === 's' && isCmdOrCtrl && event.shiftKey && !event.altKey) {
        event.preventDefault();
        setShowSessionSearch(prev => !prev);
        return;
      }

      // Cmd/Ctrl + /: Shortcuts reference overlay
      if (key === '/' && isCmdOrCtrl && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setShowShortcutsOverlay(prev => !prev);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    setAdoptedSessionIds(new Set());
  }, [activeProject?.name]);

  const fetchSessionStatus = useCallback(async () => {
    if (sessionStatusRequestInFlightRef.current) return;
    sessionStatusRequestInFlightRef.current = true;
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) setSessionStatus(await res.json());
    } catch {
      // Silent — background session refresh failure is not user-actionable
    } finally {
      sessionStatusRequestInFlightRef.current = false;
    }
  }, []);

  // Poll session status every 2 seconds for sidebar terminal list
  useEffect(() => {
    fetchSessionStatus();
    const id = setInterval(fetchSessionStatus, 2000);
    return () => clearInterval(id);
  }, [fetchSessionStatus]);

  const addProject = async (name, path, host = 'local') => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path, host }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: err.error || 'Failed to add project' });
        return;
      }
      showToast({ type: 'success', message: `Project "${name}" added` });
      await fetchProjects();
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const shelveProject = async (name) => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shelved: true, shelvedAt: new Date().toISOString(), waiting: false, waitingAt: null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: err.error || 'Failed to shelve project' });
        return;
      }
      if (activeProject?.name === name) setActiveProject(null);
      showToast({ type: 'success', message: 'Project shelved' });
      await fetchProjects();
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const markWaitingProject = async (name) => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waiting: true, waitingAt: new Date().toISOString() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: err.error || 'Failed to mark project waiting' });
        return;
      }
      if (activeProject?.name === name) setActiveProject(null);
      showToast({ type: 'success', message: 'Project moved to Waiting' });
      await fetchProjects();
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const activateWaitingProject = async (projectOrName) => {
    const name = typeof projectOrName === 'string' ? projectOrName : projectOrName?.name;
    if (!name) return;

    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waiting: false, waitingAt: null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: err.error || 'Failed to activate project' });
        return;
      }
      const data = await res.json();
      showToast({ type: 'success', message: 'Project active' });
      await fetchProjects();
      setActiveProject(data);
      fetchSessionStatus();
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const unshelveProject = async (name) => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shelved: false, shelvedAt: null, waiting: false, waitingAt: null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: err.error || 'Failed to restore project' });
        return;
      }
      const data = await res.json();
      showToast({ type: 'success', message: 'Project restored' });
      await fetchProjects();
      setActiveProject(data);
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const renameProject = async (oldName, newName) => {
    const project = projects.find(p => p.name === oldName);
    if (!project) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(oldName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, path: project.path }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: err.error || 'Failed to rename project' });
        return;
      }
      const updated = await res.json();
      if (activeProject?.name === oldName) setActiveProject(updated);
      showToast({ type: 'success', message: `Project renamed to "${newName}"` });
      await fetchProjects();
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const removeProject = async (name) => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) {
        const problem = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: typeof problem.detail === 'string' ? problem.detail : 'Failed to remove project' });
        return;
      }
      if (activeProject?.name === name) setActiveProject(null);
      showToast({ type: 'success', message: `Project "${name}" removed` });
      await fetchProjects();
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const openFile = async (filePath, explicitHost) => {
    try {
      const host = explicitHost || activeProject?.host || 'local';
      const res = await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, host }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast({ type: 'error', message: err.error || 'Failed to open file' });
      }
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const activeProjects = projects.filter(p => !p.shelved && !p.waiting);
  const waitingProjects = projects
    .filter(p => !p.shelved && p.waiting)
    .sort((a, b) => new Date(b.waitingAt) - new Date(a.waitingAt));
  const shelvedProjects = projects
    .filter(p => p.shelved)
    .sort((a, b) => new Date(b.shelvedAt) - new Date(a.shelvedAt));

  const searchParams = new URLSearchParams(window.location.search);
  const currentPreviewPath = searchParams.get('preview');
  const previewHost = searchParams.get('host') || 'local';

  const adoptSessions = useMemo(() => {
    if (!activeProject) return [];
    const aliveSessionIds = new Set(
      sessionStatus.filter((session) => session.alive).map((session) => session.sessionId),
    );
    return planTerminalAdoption({
      existingSessionIds: adoptedSessionIds,
      resumeSessionId: resumedSession?.project === activeProject.name ? resumedSession.sessionId : null,
      runSessions: buildRunAdoptionSessions(pipelineRuns, locallyStartedRunIds, aliveSessionIds),
    });
  }, [
    activeProject,
    adoptedSessionIds,
    resumedSession,
    pipelineRuns,
    locallyStartedRunIds,
    sessionStatus,
  ]);

  if (currentPreviewPath) {
    return <PreviewPage filePath={currentPreviewPath} host={previewHost} onOpenFile={(p) => openFile(p, previewHost)} />;
  }

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <Sidebar
        activeProjects={activeProjects}
        waitingProjects={waitingProjects}
        shelvedProjects={shelvedProjects}
        activeProject={activeProject}
        isCompact={isSidebarCompact}
        onSelect={(project) => {
          setActiveProject(project);
          fetchSessionStatus();
        }}
        onAdd={addProject}
        onRemove={removeProject}
        onRename={renameProject}
        onMarkWaiting={markWaitingProject}
        onActivateWaiting={activateWaitingProject}
        onShelve={shelveProject}
        onUnshelve={unshelveProject}
        onToggleCompact={() => setIsSidebarCompact(prev => !prev)}
        onToggleFiles={() => setShowFileTree(prev => !prev)}
        showFileTree={showFileTree}
        sessionStatus={sessionStatus.map(session => ({ ...session, title: sessionTitles[session.sessionId]?.title ?? null }))}
        finishedSessionIds={finishedSessionIds}
        mutedStatusSessionIds={mutedStatusSessionIds}
        onResetFinishedSession={resetFinishedSession}
        waitingSessionIds={waitingSessionIds}
        onBrowseFiles={setFileBrowserProject}
        onShowShortcuts={() => setShowShortcutsOverlay(true)}
      />
      {showFileTree && activeProject && (
        <>
          <FileTree
            root={activeProject.path}
            host={activeProject.host}
            onOpenFile={openFile}
            onPreviewFile={(path) => openFilePreviewTab(path, activeProject.host)}
            width={fileTreeWidth}
          />
          <PaneDivider
            onDrag={(delta) => setFileTreeWidth(prev => Math.max(180, Math.min(600, prev + delta)))}
            onDoubleClick={() => setFileTreeWidth(260)}
          />
        </>
      )}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {activeProject ? (
          <TerminalArea
            project={activeProject}
            sessionStatus={sessionStatus}
            sessionTitles={sessionTitles}
            onTitlesChanged={refreshSessionTitles}
            namingError={namingError}
            onSessionStatusRefresh={setSessionStatus}
            finishedSessionIds={finishedSessionIds}
            mutedStatusSessionIds={mutedStatusSessionIds}
            onResetFinishedSession={resetFinishedSession}
            onToggleMutedStatusSession={toggleMutedStatusSession}
            waitingSessionIds={waitingSessionIds}
            onToggleWaiting={toggleWaiting}
            onOpenSessionSearch={() => setShowSessionSearch(true)}
            onOpenRunWorkflow={() => setShowRunWorkflow(true)}
            adoptSessions={adoptSessions}
            onSessionsAdopted={(sessionIds) => {
              setAdoptedSessionIds((current) => {
                const next = new Set(current);
                for (const sessionId of sessionIds) next.add(sessionId);
                return next;
              });
              if (resumedSession && sessionIds.includes(resumedSession.sessionId)) {
                setResumedSession((current) => (
                  current?.sessionId === resumedSession.sessionId ? null : current
                ));
              }
            }}
            pipelineRuns={pipelineRuns}
            onStopPipelineRun={stopRun}
            onResumePipelineRun={resumeRun}
            onContinuePipelineRun={continueRun}
            onCleanupPipelineRun={cleanupRun}
          />
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: '13px',
          }}>
            Select a project to get started.
          </div>
        )}
      </div>
      {fileBrowserProject && (
        <FileBrowserPanel
          project={fileBrowserProject}
          onPreviewFile={(path) => openFilePreviewTab(path, fileBrowserProject.host)}
          onClose={() => setFileBrowserProject(null)}
        />
      )}
      {showShortcutsOverlay && (
        <ShortcutsOverlay onClose={() => setShowShortcutsOverlay(false)} />
      )}
      {showSessionSearch && activeProject && (
        <SessionSearch
          project={activeProject}
          onClose={() => setShowSessionSearch(false)}
          onResumed={(session) => {
            setResumedSession({ sessionId: session.sessionId, project: session.project });
            const destination = projects.find(candidate => candidate.name === session.project);
            if (destination && destination.name !== activeProject.name) setActiveProject(destination);
            fetchSessionStatus();
          }}
        />
      )}
      {showRunWorkflow && activeProject && (
        <RunWorkflowDialog
          projectName={activeProject.name}
          onClose={() => setShowRunWorkflow(false)}
          onStart={startRun}
        />
      )}
      {showProjectSwitcher && (
        <ProjectSwitcher
          projects={[...activeProjects, ...waitingProjects]}
          onSelect={(project) => {
            if (project.waiting) {
              activateWaitingProject(project);
              setShowProjectSwitcher(false);
              return;
            }
            setActiveProject(project);
            fetchSessionStatus();
            setShowProjectSwitcher(false);
          }}
          onClose={() => setShowProjectSwitcher(false)}
        />
      )}
    </div>
  );
}
