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

export function createAssistantSocketHandler({ findProject, store, proposalStore, compose, sessionTokens, assistantUrl, bridge = handleAssistantConnection }) {
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
    const previous = live.get(projectName);
    if (previous) {
      if (previous.ws.readyState === 1) {
        try {
          const notice = store.append(previous.conversationId, { role: 'notice', content: 'The assistant was opened elsewhere.' });
          previous.ws.send(JSON.stringify({ type: 'message', message: notice }));
        } catch (error) { console.error('[assistant] takeover notice failed', error); previous.ws.send(JSON.stringify({ type: 'error', message: error.message })); }
      }
      previous.bridge?.close();
      previous.ws.close();
    }
    const entry = { ws, bridge: null }; live.set(projectName, entry);
    ws.on('close', () => { if (live.get(projectName) === entry) live.delete(projectName); });
    try { const conversation = store.current(projectName); entry.conversationId = conversation.id; entry.bridge = bridge(ws, { project: projectName, cwd: project.path, conversation, store, proposalStore, compose, sessionTokens, assistantUrl }); }
    catch (error) { console.error('[assistant] bridge start failed', error); live.delete(projectName); if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'spawn_error', message: error.message })); ws.close(1011, 'Assistant could not start'); }
  };
  handler.pushProposal = (projectName, proposal) => { live.get(projectName)?.bridge?.pushProposal?.(proposal); };
  handler.pushSituation = (projectName, flags) => { live.get(projectName)?.bridge?.pushSituation?.(flags); };
  return handler;
}
