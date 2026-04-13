import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import TerminalArea from './components/TerminalArea';
import FileTree from './components/FileTree';
import FileBrowserPanel from './components/FileBrowserPanel';
import PaneDivider from './components/PaneDivider';
import PreviewPage from './components/PreviewPage';
import { ToastProvider, useToast } from './components/ToastContext';
import { openFilePreviewTab } from './utils/fileActions';

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
  const [fileTreeWidth, setFileTreeWidth] = useState(() => {
    const saved = localStorage.getItem('codedeck-filetree-width');
    return saved ? parseInt(saved, 10) : 260;
  });
  const { showToast } = useToast();

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
      
      // Cmd/Ctrl + Shift + B: Toggle files browser
      if (key === 'b' && isCmdOrCtrl && event.shiftKey && !event.altKey) {
        event.preventDefault();
        setShowFileTree(prev => !prev);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Poll session status every 2 seconds for sidebar terminal list
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/sessions');
        if (res.ok) setSessionStatus(await res.json());
      } catch {
        // Silent — polling failure is not user-actionable
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
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
        body: JSON.stringify({ shelved: true, shelvedAt: new Date().toISOString() }),
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

  const unshelveProject = async (name) => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shelved: false, shelvedAt: null }),
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

  const activeProjects = projects.filter(p => !p.shelved);
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
        shelvedProjects={shelvedProjects}
        activeProject={activeProject}
        isCompact={isSidebarCompact}
        onSelect={setActiveProject}
        onAdd={addProject}
        onRemove={removeProject}
        onRename={renameProject}
        onShelve={shelveProject}
        onUnshelve={unshelveProject}
        onToggleCompact={() => setIsSidebarCompact(prev => !prev)}
        onToggleFiles={() => setShowFileTree(prev => !prev)}
        showFileTree={showFileTree}
        sessionStatus={sessionStatus}
        onBrowseFiles={setFileBrowserProject}
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
          <TerminalArea project={activeProject} sessionStatus={sessionStatus} />
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
    </div>
  );
}
