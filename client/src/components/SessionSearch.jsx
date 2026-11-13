import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useToast } from './ToastContext';
import './session-search.css';

const CLI_NAMES = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', agy: 'Antigravity' };
const PAGE_SIZE = 25;

function relativeTime(timestamp) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60000) return 'just now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h ago`;
  return `${Math.floor(elapsed / 86400000)}d ago`;
}

export default function SessionSearch({ project, onClose, onResumed }) {
  const [scope, setScope] = useState('project');
  const [cli, setCli] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0); // API pages are zero-based
  const [hasNextPage, setHasNextPage] = useState(false);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [highlight, setHighlight] = useState(0);
  const [resuming, setResuming] = useState(null);
  const requestId = useRef(0);
  const pendingResume = useRef(false);
  const inputRef = useRef(null);
  const { showToast } = useToast();

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const currentId = ++requestId.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE), sort: '-updatedAt' });
    if (scope === 'project') params.set('project', project.name);
    if (cli) params.set('cli', cli);
    if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());

    (async () => {
      try {
        const res = await fetch(`/api/agent-sessions?${params}`, { method: 'GET' }).catch(() => { throw new Error('Server unreachable'); });
        if (!res.ok) {
          const problem = await res.json();
          throw new Error(problem.message || 'Failed to load conversations');
        }
        const data = await res.json();
        if (requestId.current !== currentId) return;
        setRows(previous => page === 0 ? data.data : [...previous, ...data.data]);
        setHasNextPage(data.page.hasNextPage);
        setSources(data.sources);
      } catch (cause) {
        if (requestId.current !== currentId) return;
        setError(cause.message);
      } finally {
        if (requestId.current === currentId) setLoading(false);
      }
    })();
    return () => { requestId.current++; };
  }, [project.name, scope, cli, debouncedQuery, page]);

  const resetSearch = () => {
    requestId.current++;
    setRows([]);
    setPage(0);
    setHighlight(0);
    setHasNextPage(false);
  };

  const resume = async (row) => {
    if (pendingResume.current) return;
    pendingResume.current = true;
    setResuming(`${row.cli}:${row.conversationId}`);
    try {
      const res = await fetch('/api/agent-sessions/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cli: row.cli, conversationId: row.conversationId, project: row.project }),
      }).catch(() => { throw new Error('Server unreachable'); });
      if (!res.ok) {
        const problem = await res.json();
        throw new Error(problem.message || 'Failed to resume conversation');
      }
      const data = await res.json();
      onResumed(data);
      showToast({ type: 'success', message: `Resumed ${CLI_NAMES[row.cli]} conversation` });
      onClose();
    } catch (cause) {
      showToast({ type: 'error', message: cause.message });
    } finally {
      pendingResume.current = false;
      setResuming(null);
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight(i => Math.min(i + 1, rows.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight(i => Math.max(0, i - 1)); }
    else if (event.key === 'Enter' && rows[highlight]) { event.preventDefault(); resume(rows[highlight]); }
  };

  const unavailable = sources.filter(source => !source.available).map(source => CLI_NAMES[source.cli]);

  return (
    <div className="session-search-overlay" data-testid="session-search-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={handleKeyDown}>
      <div className="session-search-modal" role="dialog" aria-modal="true" aria-label="Session search">
        <div className="session-search-heading"><span>Session search</span><button type="button" aria-label="Close session search" onClick={onClose}><X size={16} /></button></div>
        <div className="session-search-input-wrap"><Search size={16} /><input ref={inputRef} aria-label="Search conversations" placeholder="Search conversations…" value={query} onChange={event => { requestId.current++; resetSearch(); setQuery(event.target.value); }} /></div>
        <div className="session-search-controls">
          <div className="session-search-scope" aria-label="Project scope">
            <button type="button" aria-pressed={scope === 'project'} onClick={() => { resetSearch(); setScope('project'); }}>This project</button>
            <button type="button" aria-pressed={scope === 'all'} onClick={() => { resetSearch(); setScope('all'); }}>All projects</button>
          </div>
          <select aria-label="CLI" value={cli} onChange={event => { resetSearch(); setCli(event.target.value); }}>
            <option value="">All CLIs</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="agy">Antigravity</option>
          </select>
        </div>
        <div className="session-search-list" role="listbox" aria-label="Conversations">
          {rows.map((row, index) => {
            const firstPrompt = !row.title;
            const label = row.title || row.firstPrompt;
            const rowKey = `${row.cli}:${row.conversationId}`;
            return <button type="button" aria-current={index === highlight} disabled={Boolean(resuming)} className="session-search-row" key={rowKey} onMouseEnter={() => setHighlight(index)} onClick={() => resume(row)} aria-label={`${label}, ${CLI_NAMES[row.cli]}`}>
              <span className={`session-search-label ${firstPrompt ? 'first-prompt' : ''}`} title={label}>{firstPrompt ? `“${label}”` : label}</span>
              <span className="session-search-meta"><span>{CLI_NAMES[row.cli]}</span>{scope === 'all' && <span>{row.project}</span>}<time dateTime={new Date(row.updatedAt).toISOString()}>{relativeTime(row.updatedAt)}</time></span>
              {resuming === rowKey && <span className="session-search-progress">Resuming…</span>}
            </button>;
          })}
          {loading && <div className="session-search-state" role="status">Loading conversations…</div>}
          {error && <div className="session-search-state" role="alert">{error}</div>}
          {!loading && !error && rows.length === 0 && <div className="session-search-state">No conversations found</div>}
        </div>
        {unavailable.length > 0 && <div className="session-search-note">{unavailable.join(' and ')} have no history on this machine.</div>}
        {!loading && !error && hasNextPage && <button type="button" className="session-search-more" onClick={() => setPage(value => value + 1)}>Load more</button>}
      </div>
    </div>
  );
}
