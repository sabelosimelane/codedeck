import { handleAssistantConnection } from './acp-bridge.js';
import { isLocalProject } from './project.js';

export function routeUpgrade(req, socket, head, { authorizeUpgrade, terminal, assistant }) {
  if (authorizeUpgrade(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch (error) { console.error('[assistant] invalid upgrade URL', error); socket.destroy(); return; }
  const server = pathname === '/ws/assistant' ? assistant : pathname === '/ws/terminal' ? terminal : null;
  if (!server) { socket.destroy(); return; }
  server.handleUpgrade(req, socket, head, ws => server.emit('connection', ws, req));
}

export function createAssistantSocketHandler({ findProject, store, proposalStore, compose, sessionTokens, assistantUrl, settings, agentStore, bridge = handleAssistantConnection }) {
  if (typeof findProject !== 'function' || !store || typeof bridge !== 'function') throw new TypeError('Invalid assistant socket dependencies');
  const live = new Map();
  const handler = (ws, req) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch (error) { console.error('[assistant] invalid assistant URL', error); ws.close(4400, 'Invalid URL'); return; }
    const projectName = url.searchParams.get('project');
    if (!projectName) { ws.close(4400, 'Project is required'); return; }
    const project = findProject(projectName);
    if (!project) { ws.close(4404, 'Project not found'); return; }
    if (!isLocalProject(project)) { ws.close(4409, 'Only local projects are supported'); return; }
    if (typeof project.path !== 'string' || !project.path) { ws.close(4404, 'Project path is missing'); return; }
    const failStart = error => { console.error('[assistant] bridge start failed', error); if (live.get(projectName)?.ws === ws) live.delete(projectName); if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'spawn_error', message: error.message })); ws.close(1011, 'Assistant could not start'); };
    let conversation;
    try { conversation = store.current(projectName); } catch (error) { failStart(error); return; }
    const previous = live.get(projectName);
    // A panel still open elsewhere is told it was replaced; one that reloaded is already gone.
    const tellReplaced = () => {
      if (previous.ws === ws || previous.ws.readyState !== 1) return;
      try {
        const notice = store.append(previous.conversationId, { role: 'notice', content: 'The assistant was opened elsewhere.' });
        previous.ws.send(JSON.stringify({ type: 'message', message: notice }));
      } catch (error) { console.error('[assistant] takeover notice failed', error); previous.ws.send(JSON.stringify({ type: 'error', message: error.message })); }
    };
    // The same conversation with the same settings keeps its agent, and a running turn with it.
    if (previous?.bridge && previous.conversationId === conversation.id && previous.bridge.sameSettings()) {
      tellReplaced();
      previous.ws = ws;
      try { previous.bridge.attach(ws); } catch (error) { failStart(error); }
      return;
    }
    if (previous) {
      tellReplaced();
      live.delete(projectName);
      previous.bridge?.close();
      previous.ws.close();
    }
    const entry = { ws, bridge: null, conversationId: conversation.id }; live.set(projectName, entry);
    // The entry lasts as long as its agent, not its socket: a panel that comes back takes it over.
    const onClosed = () => { if (live.get(projectName) === entry) live.delete(projectName); };
    try {
      entry.bridge = bridge(ws, { project: projectName, cwd: project.path, conversation, store, proposalStore, compose, sessionTokens, assistantUrl, settings, agentStore, onClosed });
      if (!entry.bridge) onClosed();
    } catch (error) { failStart(error); }
  };
  handler.pushProposal = (projectName, proposal) => { live.get(projectName)?.bridge?.pushProposal?.(proposal); };
  handler.pushSituation = (projectName, flags) => { live.get(projectName)?.bridge?.pushSituation?.(flags); };
  return handler;
}
