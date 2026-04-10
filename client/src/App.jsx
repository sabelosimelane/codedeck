import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import TerminalArea from './components/TerminalArea';
import FileTree from './components/FileTree';

export default function App() {
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const [showFileTree, setShowFileTree] = useState(false);

  const fetchProjects = useCallback(async () => {
    const res = await fetch('/api/projects');
    const data = await res.json();
    setProjects(data);
  }, []);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  const addProject = async (name, path) => {
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path }),
    });
    await fetchProjects();
  };

  const editProject = async (oldName, newName, newPath) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(oldName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, path: newPath }),
    });
    if (res.ok) {
      const updated = await res.json();
      if (activeProject?.name === oldName) setActiveProject(updated);
      await fetchProjects();
    }
  };

  const removeProject = async (name) => {
    await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (activeProject?.name === name) setActiveProject(null);
    await fetchProjects();
  };

  const openFile = async (filePath) => {
    await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    });
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <Sidebar
        projects={projects}
        activeProject={activeProject}
        onSelect={setActiveProject}
        onAdd={addProject}
        onRemove={removeProject}
        onEdit={editProject}
        onToggleFiles={() => setShowFileTree(prev => !prev)}
        showFileTree={showFileTree}
      />
      {showFileTree && activeProject && (
        <FileTree root={activeProject.path} onOpenFile={openFile} />
      )}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {activeProject ? (
          <TerminalArea project={activeProject} />
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
    </div>
  );
}
