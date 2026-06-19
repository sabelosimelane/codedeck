import React, { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar';
import TerminalArea from './components/TerminalArea';
import FileTree from './components/FileTree';
import FileBrowserPanel from './components/FileBrowserPanel';
import ProjectSwitcher from './components/ProjectSwitcher';
import ShortcutsOverlay from './components/ShortcutsOverlay';
import PaneDivider from './components/PaneDivider';
import PreviewPage from './components/PreviewPage';
import { ToastProvider, useToast } from './components/ToastContext';
import { openFilePreviewTab } from './utils/fileActions';
import { getTerminalStatus } from './utils/terminalActivity';

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
  const [fileBrowserProject, setFileBrowserProject] = useState(null);
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);
  const [showShortcutsOverlay, setShowShortcutsOverlay] = useState(false);
  const [fileTreeWidth, setFileTreeWidth] = useState(() => {
    const saved = localStorage.getItem('codedeck-filetree-width');
    return saved ? parseInt(saved, 10) : 260;
  });
  const [finishedSessionIds, setFinishedSessionIds] = useState(new Set());
  const [mutedStatusSessionIds, setMutedStatusSessionIds] = useState(() => {
    try {
      const stored = localStorage.getItem('codedeck-muted-status-sessions');
      const parsed = stored ? JSON.parse(stored) : [];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });
  const { showToast } = useToast();
  const sessionStatusRequestInFlightRef = useRef(false);
  const prevSessionStatusRef = useRef([]);

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

  // Detect terminals that transition from busy to idle/unknown and mark them as finished.
  // The previous-snapshot read and ref advance happen in the effect body (once per change),
  // NOT inside the state updater — React StrictMode double-invokes updaters to surface
  // impurity, and a ref mutation inside one corrupts the prev/current comparison so the
  // busy→idle transition is never recorded. Keep the updater pure.
  useEffect(() => {
    const prevSessions = prevSessionStatusRef.current;
    prevSessionStatusRef.current = sessionStatus;

    const prevMap = new Map(prevSessions.map(s => [s.sessionId, s]));
    const currentSessionIds = new Set(sessionStatus.map(s => s.sessionId));

    setFinishedSessionIds(prev => {
      const next = new Set(prev);
      let changed = false;

      // Clean up sessions that no longer exist
      for (const sessionId of next) {
        if (!currentSessionIds.has(sessionId)) {
          next.delete(sessionId);
          changed = true;
        }
      }

      for (const session of sessionStatus) {
        const prevSession = prevMap.get(session.sessionId);
        const prevStatus = prevSession ? getTerminalStatus(prevSession) : null;
        const currentStatus = getTerminalStatus(session);

        if (currentStatus === 'busy') {
          if (next.has(session.sessionId)) {
            next.delete(session.sessionId);
            changed = true;
          }
        } else if (prevStatus === 'busy' && (currentStatus === 'idle' || currentStatus === 'unknown')) {
          if (session.alive && !next.has(session.sessionId)) {
            next.add(session.sessionId);
            changed = true;
          }
        }
      }

      return changed ? next : prev;
    });
  }, [sessionStatus]);

  const resetFinishedSession = useCallback((sessionId) => {
    setFinishedSessionIds(prev => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const toggleMutedStatusSession = useCallback((sessionId) => {
    setMutedStatusSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }

      try {
        const values = Array.from(next);
        if (values.length === 0) {
          localStorage.removeItem('codedeck-muted-status-sessions');
        } else {
          localStorage.setItem('codedeck-muted-status-sessions', JSON.stringify(values));
        }
      } catch {
        // Non-critical preference persistence.
      }

      return next;
    });
  }, []);

  const addProject = async (name, path) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path }),
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
        showToast({ type: 'error', message: 'Failed to remove project' });
        return;
      }
      if (activeProject?.name === name) setActiveProject(null);
      showToast({ type: 'success', message: `Project "${name}" removed` });
      await fetchProjects();
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    }
  };

  const openFile = async (filePath) => {
    try {
      const res = await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
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

  if (previewPath) {
    return <PreviewPage filePath={previewPath} onOpenFile={openFile} />;
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
        sessionStatus={sessionStatus}
        finishedSessionIds={finishedSessionIds}
        mutedStatusSessionIds={mutedStatusSessionIds}
        onResetFinishedSession={resetFinishedSession}
        onBrowseFiles={setFileBrowserProject}
        onShowShortcuts={() => setShowShortcutsOverlay(true)}
      />
      {showFileTree && activeProject && (
        <>
          <FileTree
            root={activeProject.path}
            onOpenFile={openFile}
            onPreviewFile={openFilePreviewTab}
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
            onSessionStatusRefresh={setSessionStatus}
            finishedSessionIds={finishedSessionIds}
            mutedStatusSessionIds={mutedStatusSessionIds}
            onResetFinishedSession={resetFinishedSession}
            onToggleMutedStatusSession={toggleMutedStatusSession}
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
          onPreviewFile={openFilePreviewTab}
          onClose={() => setFileBrowserProject(null)}
        />
      )}
      {showShortcutsOverlay && (
        <ShortcutsOverlay onClose={() => setShowShortcutsOverlay(false)} />
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
