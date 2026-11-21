import React, { useEffect, useMemo, useState } from 'react';
import { Server, RefreshCw, Trash2, Plus, GitBranch, FolderOpen, Star, Download } from 'lucide-react';
import { Button, Dialog, Field, IconButton, Note, Select, TextInput } from './ui/index.jsx';
import DirectoryBrowser from './DirectoryBrowser.jsx';
import { useToast } from './ToastContext';

const REACHABILITY_COLOR = {
  reachable: 'var(--accent)',
  unreachable: 'var(--danger)',
  failing: 'var(--warning)',
  unknown: 'var(--text-muted)',
};

async function readError(res) {
  try {
    const body = await res.json();
    return body?.message || body?.error || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

function basenameOf(p) {
  return String(p || '').replace(/\/+$/, '').split('/').pop() || '';
}

function boundRepoNamesForLocation(loc, workspaceMode) {
  const names = new Set((loc?.repositories ?? []).map(r => r.name.toLowerCase()));
  if (workspaceMode !== 'folder' && loc?.path) {
    names.add(basenameOf(loc.path).toLowerCase());
  }
  return names;
}

/**
 * Manage cross-host locations, auto-detected multi-repo remotes, 1-click clone,
 * manual sync, and auto-sync toggle for a project.
 */
export default function ProjectLocationsDialog({ project, onUpdated, onClose }) {
  const { showToast } = useToast();
  const [currentProject, setCurrentProject] = useState(project);
  const [hosts, setHosts] = useState([]);
  const [gitUrl, setGitUrl] = useState(project?.gitUrl || '');
  const [autoSync, setAutoSync] = useState(project?.autoSync !== false);
  const [savingSettings, setSavingSettings] = useState(false);

  const [selectedHost, setSelectedHost] = useState('');
  const [mode, setMode] = useState('clone'); // 'clone' | 'bind'
  const [targetPath, setTargetPath] = useState('');
  const [selectedCloneRepos, setSelectedCloneRepos] = useState(() => new Set(
    (project?.repoManifest ?? []).filter(r => r.gitUrl).map(r => r.name)
  ));
  const [browsing, setBrowsing] = useState(false);
  const [busyHost, setBusyHost] = useState(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setCurrentProject(project);
    if (project?.gitUrl) setGitUrl(project.gitUrl);
    setAutoSync(project?.autoSync !== false);
  }, [project]);

  const repoManifest = useMemo(
    () => (Array.isArray(currentProject?.repoManifest) ? currentProject.repoManifest : []),
    [currentProject?.repoManifest],
  );
  const isMultiRepo = repoManifest.length > 1;

  useEffect(() => {
    setSelectedCloneRepos(new Set(repoManifest.filter(r => r.gitUrl).map(r => r.name)));
  }, [repoManifest]);

  const locations = Array.isArray(currentProject?.locations) && currentProject.locations.length > 0
    ? currentProject.locations
    : [{ host: currentProject?.host || 'local', path: currentProject?.path || '', repositories: currentProject?.repositories || [] }];
  const boundHosts = new Set(locations.map(l => l.host.toLowerCase()));

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/hosts');
        if (!res.ok || !alive) return;
        const list = await res.json();
        if (!alive) return;
        setHosts(list);
        const firstUnbound = list.find(h => !boundHosts.has(h.name.toLowerCase()));
        setSelectedHost(prev => (prev && !boundHosts.has(prev.toLowerCase()) ? prev : (firstUnbound?.name || '')));
      } catch {
        if (alive) showToast({ type: 'error', message: 'Failed to load hosts' });
      }
    })();

    // Lazily discover origin remotes for existing projects so users never have to hand-type URLs.
    (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(project.name)}/discover-remotes`, { method: 'POST' });
        if (!res.ok || !alive) return;
        const discovered = await res.json();
        if (!alive || !discovered?.name) return;
        setCurrentProject(discovered);
        if (discovered.gitUrl) setGitUrl(prev => prev || discovered.gitUrl);
        onUpdated?.(discovered);
      } catch {
        // Non-blocking best-effort discovery.
      }
    })();

    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const unboundHosts = hosts.filter(h => !boundHosts.has(h.name.toLowerCase()));
  const selectedHostObj = hosts.find(h => h.name === selectedHost);

  const toggleCloneRepo = (repoName) => {
    setSelectedCloneRepos(prev => {
      const next = new Set(prev);
      if (next.has(repoName)) next.delete(repoName);
      else next.add(repoName);
      return next;
    });
  };

  const applyUpdated = (updated) => {
    setCurrentProject(updated);
    onUpdated?.(updated);
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const payload = isMultiRepo
        ? { autoSync }
        : { gitUrl: gitUrl.trim() || null, autoSync };
      const res = await fetch(`/api/projects/${encodeURIComponent(currentProject.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        showToast({ type: 'error', message: await readError(res) });
        return;
      }
      const updated = await res.json();
      applyUpdated(updated);
      showToast({ type: 'success', message: `Saved sync settings for ${currentProject.name}` });
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSetDefault = async (hostName) => {
    setBusyHost(hostName);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(currentProject.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultHost: hostName }),
      });
      if (!res.ok) {
        showToast({ type: 'error', message: await readError(res) });
        return;
      }
      const updated = await res.json();
      applyUpdated(updated);
      showToast({ type: 'success', message: `Default host set to ${hostName}` });
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    } finally {
      setBusyHost(null);
    }
  };

  const handleSyncHost = async (hostName) => {
    setBusyHost(hostName);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(currentProject.name)}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: hostName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const blocked = body?.results?.find(r => r.status === 'blocked');
        const reason = blocked ? `${blocked.repository}: ${blocked.message}` : (body?.message || body?.error || 'Sync failed');
        showToast({ type: 'error', message: `${hostName}: ${reason}` });
        return;
      }
      showToast({
        type: 'success',
        message: body.updated
          ? `Synced ${currentProject.name} on ${hostName} (pulled ${body.commitsPulled} commit${body.commitsPulled === 1 ? '' : 's'})`
          : `${currentProject.name} on ${hostName} is already up to date`,
      });
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    } finally {
      setBusyHost(null);
    }
  };

  const handleCloneMissing = async (hostName) => {
    setBusyHost(hostName);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(currentProject.name)}/locations/${encodeURIComponent(hostName)}/clone-missing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        showToast({ type: 'error', message: await readError(res) });
        return;
      }
      const updated = await res.json();
      applyUpdated(updated);
      const count = updated?.cloneSummary?.cloned?.length ?? 0;
      showToast({
        type: 'success',
        message: count > 0
          ? `Cloned ${count} missing ${count === 1 ? 'repository' : 'repositories'} onto ${hostName}`
          : `All cloneable repositories are already on ${hostName}`,
      });
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    } finally {
      setBusyHost(null);
    }
  };

  const handleRemoveLocation = async (hostName) => {
    setBusyHost(hostName);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(currentProject.name)}/locations/${encodeURIComponent(hostName)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        showToast({ type: 'error', message: await readError(res) });
        return;
      }
      const updated = await res.json();
      applyUpdated(updated);
      showToast({ type: 'success', message: `Removed ${hostName} from ${currentProject.name}` });
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    } finally {
      setBusyHost(null);
    }
  };

  const handleAddLocation = async () => {
    if (!selectedHost) return;
    setAdding(true);
    try {
      const endpoint = mode === 'clone'
        ? `/api/projects/${encodeURIComponent(currentProject.name)}/locations/clone`
        : `/api/projects/${encodeURIComponent(currentProject.name)}/locations`;
      let payload;
      if (mode === 'clone') {
        if (isMultiRepo) {
          payload = {
            host: selectedHost,
            repositories: repoManifest.filter(r => selectedCloneRepos.has(r.name)).map(r => r.name),
            ...(targetPath.trim() ? { targetPath: targetPath.trim() } : {}),
          };
        } else {
          payload = {
            host: selectedHost,
            ...(gitUrl.trim() ? { gitUrl: gitUrl.trim() } : {}),
            ...(targetPath.trim() ? { targetPath: targetPath.trim() } : {}),
          };
        }
      } else {
        payload = { host: selectedHost, path: targetPath.trim() };
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        showToast({ type: 'error', message: await readError(res) });
        return;
      }
      const updated = await res.json();
      applyUpdated(updated);
      setTargetPath('');
      const clonedCount = updated?.cloneSummary?.cloned?.length;
      showToast({
        type: 'success',
        message: mode === 'clone'
          ? (clonedCount
            ? `Cloned ${clonedCount} ${clonedCount === 1 ? 'repository' : 'repositories'} onto ${selectedHost}`
            : `Cloned ${currentProject.name} onto ${selectedHost}`)
          : `Bound ${selectedHost} location to ${currentProject.name}`,
      });
    } catch {
      showToast({ type: 'error', message: 'Server unreachable' });
    } finally {
      setAdding(false);
    }
  };

  const selectedCloneCount = repoManifest.filter(r => r.gitUrl && selectedCloneRepos.has(r.name)).length;
  const cloneDisabled = isMultiRepo ? selectedCloneCount === 0 : !gitUrl.trim();

  return (
    <>
    <Dialog
      title={`Hosts & sync — ${currentProject.name}`}
      subtitle="Work on this project from any host and keep checkouts synced with git pull --ff-only."
      onClose={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Sync Settings */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
          {isMultiRepo ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-muted)' }}>
                Project repositories ({repoManifest.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {repoManifest.map(repo => (
                  <div
                    key={repo.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '6px 8px',
                      borderRadius: 'var(--radius)',
                      border: '1px solid var(--border)',
                      background: 'var(--bg-elevated)',
                      fontSize: 12,
                    }}
                  >
                    <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{repo.name}</span>
                    <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {repo.gitUrl || 'no remote'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Field label="Git repository URL" hint="Used to auto-clone this project onto hosts that do not have a checkout yet.">
              <TextInput
                value={gitUrl}
                onChange={setGitUrl}
                placeholder="git@github.com:org/repo.git or https://..."
                spellCheck={false}
              />
            </Field>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoSync}
              onChange={e => setAutoSync(e.target.checked)}
            />
            <span>Auto-sync with <code>git pull --ff-only</code> before opening new Main terminals, tasks, or workflows</span>
          </label>
          <div>
            <Button variant="primary" onClick={handleSaveSettings} disabled={savingSettings}>
              {savingSettings ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        </div>

        {/* Bound Locations */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-muted)' }}>
            Bound hosts ({locations.length})
          </div>
          {locations.map(loc => {
            const isDefault = (currentProject.defaultHost || currentProject.host || 'local').toLowerCase() === loc.host.toLowerCase();
            const isBusy = busyHost === loc.host;
            const boundNames = isMultiRepo ? boundRepoNamesForLocation(loc, currentProject.workspaceMode) : null;
            const missingCloneable = isMultiRepo
              ? repoManifest.filter(r => r.gitUrl && !boundNames.has(r.name.toLowerCase()))
              : [];
            return (
              <div
                key={loc.host}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 'var(--radius)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-elevated)',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Server size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{loc.host}</span>
                    {isDefault && (
                      <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--accent-soft, rgba(99,102,241,0.15))', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                        default
                      </span>
                    )}
                    {isMultiRepo && (
                      <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {boundNames.size}/{repoManifest.length} repos
                      </span>
                    )}
                    {loc.reachability && (
                      <span style={{ fontSize: 10, color: REACHABILITY_COLOR[loc.reachability] || 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        ● {loc.reachability}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                    {loc.path}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {missingCloneable.length > 0 && (
                    <Button
                      size="small"
                      onClick={() => handleCloneMissing(loc.host)}
                      disabled={isBusy}
                      title={`Clone ${missingCloneable.map(r => r.name).join(', ')} onto ${loc.host}`}
                    >
                      <Download size={11} /> Clone missing ({missingCloneable.length})
                    </Button>
                  )}
                  <IconButton
                    aria-label={`Sync ${loc.host}`}
                    title={`git pull --ff-only on ${loc.host}`}
                    onClick={() => handleSyncHost(loc.host)}
                    disabled={isBusy}
                  >
                    <RefreshCw size={12} />
                  </IconButton>
                  {!isDefault && (
                    <IconButton
                      aria-label={`Set ${loc.host} as default`}
                      title="Set as default host"
                      onClick={() => handleSetDefault(loc.host)}
                      disabled={isBusy}
                    >
                      <Star size={12} />
                    </IconButton>
                  )}
                  {locations.length > 1 && (
                    <IconButton
                      tone="danger"
                      aria-label={`Remove ${loc.host}`}
                      title="Remove host binding"
                      onClick={() => handleRemoveLocation(loc.host)}
                      disabled={isBusy}
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Add another host */}
        {unboundHosts.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-muted)' }}>
              Add host location
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={selectedHost} onChange={setSelectedHost} aria-label="Target host">
                {unboundHosts.map(h => (
                  <option key={h.name} value={h.name}>{h.name}</option>
                ))}
              </Select>
              <Button variant={mode === 'clone' ? 'primary' : 'default'} onClick={() => setMode('clone')}>
                <GitBranch size={12} /> {isMultiRepo ? 'Clone repos' : 'Clone repo'}
              </Button>
              <Button variant={mode === 'bind' ? 'primary' : 'default'} onClick={() => setMode('bind')}>
                <FolderOpen size={12} /> Bind folder
              </Button>
            </div>
            {mode === 'clone' && isMultiRepo && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {repoManifest.map(repo => {
                  const hasRemote = Boolean(repo.gitUrl);
                  return (
                    <label
                      key={repo.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12,
                        color: hasRemote ? 'var(--text-primary)' : 'var(--text-muted)',
                        cursor: hasRemote ? 'pointer' : 'not-allowed',
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Clone ${repo.name}`}
                        checked={hasRemote && selectedCloneRepos.has(repo.name)}
                        disabled={!hasRemote}
                        onChange={() => toggleCloneRepo(repo.name)}
                      />
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{repo.name}</span>
                      {!hasRemote && <span style={{ fontSize: 11 }}>(no remote — skipped)</span>}
                    </label>
                  );
                })}
              </div>
            )}
            <Field
              label={mode === 'clone' ? 'Destination path (optional if host has default workspace folder)' : 'Existing checkout path on host'}
              hint={mode === 'clone'
                ? (selectedHostObj?.defaultRoot
                  ? (isMultiRepo
                    ? `Leave blank to clone into ${selectedHostObj.defaultRoot}/${currentProject.name}/<repo>`
                    : `Leave blank to clone into ${selectedHostObj.defaultRoot}/<repo>`)
                  : undefined)
                : (isMultiRepo ? 'Matching sibling or child repositories on this host will be linked automatically.' : undefined)}
            >
              <div style={{ display: 'flex', gap: 6 }}>
                <TextInput
                  value={targetPath}
                  onChange={setTargetPath}
                  placeholder={mode === 'clone'
                    ? (selectedHostObj?.defaultRoot ? `${selectedHostObj.defaultRoot}/${currentProject.name}` : '/path/to/clone')
                    : '/path/to/existing/checkout'}
                  spellCheck={false}
                />
                {mode === 'bind' && (
                  <Button onClick={() => setBrowsing(true)}>Browse…</Button>
                )}
              </div>
            </Field>
            <div>
              <Button
                variant="primary"
                onClick={handleAddLocation}
                disabled={adding || (mode === 'bind' && !targetPath.trim()) || (mode === 'clone' && cloneDisabled)}
              >
                <Plus size={12} /> {adding
                  ? (mode === 'clone' ? 'Cloning…' : 'Binding…')
                  : (mode === 'clone'
                    ? (isMultiRepo
                      ? `Clone ${selectedCloneCount} ${selectedCloneCount === 1 ? 'repo' : 'repos'} onto ${selectedHost}`
                      : `Clone onto ${selectedHost}`)
                    : `Bind on ${selectedHost}`)}
              </Button>
            </div>
          </div>
        ) : (
          <Note>All configured hosts are already bound to this project. Add more hosts in Settings → Hosts.</Note>
        )}
      </div>
    </Dialog>

    {browsing && selectedHost && (
      <DirectoryBrowser
        initialHost={selectedHost}
        initialPath={selectedHostObj?.defaultRoot || ''}
        onSelect={(chosenPath, chosenHost) => {
          setTargetPath(chosenPath);
          if (chosenHost && !boundHosts.has(chosenHost.toLowerCase())) {
            setSelectedHost(chosenHost);
          }
          setBrowsing(false);
        }}
        onCancel={() => setBrowsing(false)}
      />
    )}
    </>
  );
}
