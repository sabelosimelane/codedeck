import { describe, it, expect, vi } from 'vitest';
import { handleWsConnection } from '../ws-handler.js';
function fixture() {
  const output = []; const exits = [];
  const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: fn => output.push(fn), onExit: fn => exits.push(fn) };
  const runtime = { type:'tmux', spawn:vi.fn(() => pty), isAvailable:()=>true, isSessionRecoverable:()=>false, resizeSession:vi.fn(), captureSessionSnapshot:vi.fn(() => ({data:'history',lineCount:1,windowLines:10000,historyGuaranteed:true})) };
  const sessions = new Map();
  const connect = (query='protocol=2',options={},sessionId='demo') => {
    const listeners = {};
    const ws = {readyState:1,bufferedAmount:0,send:vi.fn(),close:vi.fn(),on:(event,fn)=>{listeners[event]=fn;}, emit:(event,data)=>listeners[event]?.(data)};
    handleWsConnection(ws,{url:`/ws/terminal?sessionId=${encodeURIComponent(sessionId)}&cwd=/tmp&cols=80&rows=24&${query}`},sessions,runtime,new Set(),new Set(),options);
    ws.messages=()=>ws.send.mock.calls.map(([data])=>JSON.parse(data));
    ws.message=data=>ws.emit('message',JSON.stringify(data));
    ws.claim=(id='claim')=>ws.message({type:'claim_control',requestId:id,cols:80,rows:24});
    return ws;
  };
  return {connect,pty,runtime,sessions,output:data=>output.forEach(fn=>fn(data)),exit:()=>exits.forEach(fn=>fn({exitCode:0})),listeners:output};
}
describe('terminal protocol v2',()=>{
 it('reports desktop activity only from normal attachments and rejects extra fields',()=>{
   const f=fixture(); const onDesktopActivity=vi.fn();
   const desktop=f.connect('protocol=2',{onDesktopActivity});
   desktop.message({type:'user_activity'});
   expect(onDesktopActivity).toHaveBeenCalledTimes(1);
   desktop.message({type:'user_activity',unexpected:true});
   expect(desktop.messages().at(-1).type).toBe('protocol_error');
   expect(onDesktopActivity).toHaveBeenCalledTimes(1);
   const companion=f.connect('protocol=2&companion=1&incarnation=incarnation-1',{onDesktopActivity,getSessionIncarnation:()=> 'incarnation-1'});
   expect(companion.close).not.toHaveBeenCalled();
   expect(f.sessions.get('demo').attachments.has(companion)).toBe(true);
   companion.message({type:'user_activity'});
   expect(companion.messages().at(-1).type).not.toBe('protocol_error');
   expect(onDesktopActivity).toHaveBeenCalledTimes(1);
 });
 it('rejects an invalid desktop activity callback at connection setup',()=>{
   const f=fixture();
   expect(()=>f.connect('protocol=2',{onDesktopActivity:true})).toThrow(/onDesktopActivity/);
 });
 it.each(['sentinel Local-1', 'Customer Platform - Local-12', 'Projet été-1', `${'x'.repeat(254)}-1`])('attaches existing project-derived session identity %s',sessionId=>{
   const f=fixture();const ws=f.connect('protocol=2',{},sessionId);
   expect(ws.messages().some(message=>message.type==='protocol_error')).toBe(false);
   expect(f.runtime.spawn).toHaveBeenCalledWith(expect.objectContaining({sessionId}));
 });
 it.each([' ', 'bad\u0000id', 'bad\nid', 'bad\u007fid', 'x'.repeat(257)])('rejects invalid session identity %j',sessionId=>{
   const f=fixture();const ws=f.connect('protocol=2',{},sessionId);
   expect(ws.messages().at(-1).type).toBe('protocol_error');
   expect(f.runtime.spawn).not.toHaveBeenCalled();
 });
 it('broadcasts one PTY stream to both clients without takeover or resize on attach',()=>{
   const f=fixture(); const a=f.connect(); a.claim(); f.pty.resize.mockClear(); const b=f.connect();
   f.output('hello\r\n');
   for(const ws of [a,b]) expect(ws.messages()).toContainEqual({type:'output',seq:1,data:'hello\r\n'});
   expect(a.close).not.toHaveBeenCalled(); expect(f.listeners).toHaveLength(1); expect(f.pty.resize).not.toHaveBeenCalled();
 });
 it('starts as observer and fences inputs across ordered claims',()=>{
   const f=fixture(); const a=f.connect(); const b=f.connect();
   a.message({type:'input',data:'no',controlRevision:0}); expect(f.pty.write).not.toHaveBeenCalled();
   a.claim('a'); const one=a.messages().findLast(m=>m.type==='control_state');
   a.message({type:'input',data:'yes',controlRevision:one.controlRevision});
   b.claim('b'); const two=b.messages().findLast(m=>m.type==='control_state');
   expect(two.controlRevision).toBe(one.controlRevision+1);
   a.message({type:'input',data:'stale',controlRevision:one.controlRevision});
   b.message({type:'input',data:'phone',controlRevision:two.controlRevision});
   expect(f.pty.write.mock.calls).toEqual([['yes'],['phone']]);
   expect(a.messages().at(-1).type).toBe('control_error');
   expect(f.sessions.get('demo').controlConflicts).toBe(2);
 });
 it('does not change ownership on replay, heartbeat or another attach',()=>{
   const f=fixture(); const a=f.connect(); a.claim(); const before=f.sessions.get('demo').controlRevision;
   const b=f.connect(); b.message({type:'resume',lastSeenSeq:0});
   expect(f.sessions.get('demo').controlRevision).toBe(before);
 });
 it('detaches tmux only after the last attachment disconnects',()=>{
   const f=fixture();const a=f.connect();const b=f.connect();
   a.emit('close');expect(f.pty.kill).not.toHaveBeenCalled();
   b.emit('close');expect(f.pty.kill).toHaveBeenCalledTimes(1);
 });
 it('rejects unsupported clients and malformed messages without raw PTY writes',()=>{
   const f=fixture();const old=f.connect('protocol=1');expect(old.messages()[0].type).toBe('protocol_error');expect(f.runtime.spawn).not.toHaveBeenCalled();
   const a=f.connect();a.claim();a.emit('message','invalid');expect(f.pty.write).not.toHaveBeenCalled();expect(a.messages().at(-1).type).toBe('protocol_error');
 });
 it.each([{type:'input',data:null,controlRevision:1},{type:'resize',cols:0,rows:24,controlRevision:1},{type:'claim_control',requestId:null,cols:80,rows:24}])('rejects invalid fields %j',message=>{
   const f=fixture();const a=f.connect();a.claim();f.pty.resize.mockClear();a.message(message);expect(a.messages().at(-1).type).toBe('protocol_error');expect(f.pty.write).not.toHaveBeenCalled();expect(f.pty.resize).not.toHaveBeenCalled();
 });
 it('closes a slow attachment while another receives output',()=>{
   const f=fixture();const a=f.connect();const b=f.connect();a.bufferedAmount=2*1024*1024;f.output('output');
   expect(a.close).toHaveBeenCalledWith(4008,'slow_client_reconnect');expect(b.messages().at(-1)).toEqual({type:'output',seq:1,data:'output'});
 });
 it('publishes new canonical dimensions before resize-generated output',()=>{
   const f=fixture();const a=f.connect();const b=f.connect();
   f.pty.resize.mockImplementation(()=>f.output('redraw'));
   a.claim();const messages=b.messages();
   expect(messages.findIndex(m=>m.type==='control_state')).toBeLessThan(messages.findIndex(m=>m.type==='output'));
 });
 it('waits for bootstrap output release before declaring attachment ready',async()=>{
   const f=fixture();f.runtime.isSessionRecoverable=()=>true;const a=f.connect();
   expect(a.messages().some(m=>m.type==='attachment_ready')).toBe(false);
   await new Promise(resolve=>setTimeout(resolve,1));
   expect(a.messages().at(-1)).toEqual({type:'attachment_ready'});
 });
 it.each(['protocol=2&cols=', 'protocol=2&rows=-1', 'protocol=2&sessionId=', 'protocol=2&cwd=', 'protocol=2&companion=invalid', 'protocol=2&unknown=1'])('rejects invalid attachment query %s',query=>{
   const f=fixture();const a=f.connect(query);expect(a.messages().at(-1).type).toBe('protocol_error');expect(f.runtime.spawn).not.toHaveBeenCalled();
 });
 it('isolates synchronous snapshot failure from other attachments',()=>{
   const f=fixture();const a=f.connect();const b=f.connect();
   f.runtime.captureSessionSnapshot.mockImplementation(()=>{throw new Error('capture failed');});
   a.message({type:'rehydrate'});f.output('still live');
   expect(a.close).toHaveBeenCalledWith(4008,'snapshot_failed_reconnect');
   expect(b.messages().at(-1)).toMatchObject({type:'output',data:'still live'});
   expect(f.sessions.get('demo').attachments.size).toBe(1);
 });
 it('does not acknowledge control when runtime resize fails',()=>{
   const f=fixture();const a=f.connect();f.runtime.resizeSession.mockImplementation(()=>{throw new Error('resize failed');});a.claim();
   expect(a.messages().some(m=>m.type==='control_state')).toBe(false);
   expect(a.messages().at(-1).type).toBe('control_error');
 });
 it('retires a definitive exit and rejects a stale incarnation without respawning',()=>{
   const f=fixture();const onSessionEnded=vi.fn();const getSessionIncarnation=vi.fn(()=> 'incarnation-1');
   const a=f.connect('protocol=2',{onSessionEnded,getSessionIncarnation});
   expect(a.messages().find(m=>m.type==='session').incarnationId).toBe('incarnation-1');
   f.exit();expect(onSessionEnded).toHaveBeenCalledWith('demo');
   const b=f.connect('protocol=2&incarnation=incarnation-1',{getSessionIncarnation});
   expect(b.close).toHaveBeenCalledWith(4002,'session_ended');expect(f.runtime.spawn).toHaveBeenCalledTimes(1);
   expect(getSessionIncarnation).toHaveBeenLastCalledWith('demo',{create:false});
 });
 it('never creates a durable session from a notification incarnation when tmux reports missing',()=>{
   const f=fixture();const a=f.connect('protocol=2&companion=1&incarnation=incarnation-1',{getSessionIncarnation:()=> 'incarnation-1'});
   expect(a.close).toHaveBeenCalledWith(4002,'session_ended');expect(f.runtime.spawn).not.toHaveBeenCalled();
 });
 it('uses durable tmux identity and rejects a recreated session with the same display ID',()=>{
   const f=fixture();f.runtime.isSessionRecoverable=()=>true;
   f.runtime.getSessionIncarnation=vi.fn(()=> 'new-incarnation');
   const adoptSessionIncarnation=vi.fn();
   const a=f.connect('protocol=2&incarnation=old-incarnation',{getSessionIncarnation:()=> 'old-incarnation',adoptSessionIncarnation});
   expect(a.close).toHaveBeenCalledWith(4002,'session_incarnation_changed');
   expect(f.runtime.spawn).not.toHaveBeenCalled();
   expect(adoptSessionIncarnation).toHaveBeenCalledWith('demo','new-incarnation');
 });
 it('reads a new tmux incarnation after spawn and before the handshake',()=>{
   const f=fixture();f.runtime.getSessionIncarnation=vi.fn(()=> 'new-incarnation');const adoptSessionIncarnation=vi.fn();
   const a=f.connect('protocol=2',{getSessionIncarnation:()=> 'registry-incarnation',adoptSessionIncarnation});
   expect(a.messages().find(m=>m.type==='session').incarnationId).toBe('new-incarnation');
   expect(adoptSessionIncarnation).toHaveBeenCalledWith('demo','new-incarnation');
 });
 it('fails a local identity probe visibly without crashing or affecting another viewer',()=>{
   const f=fixture();const a=f.connect();f.runtime.getSessionIncarnation=()=>{throw new Error('identity unavailable');};
   let b;expect(()=>{b=f.connect();}).not.toThrow();
   expect(b.messages().at(-1)).toMatchObject({type:'spawn_error',reason:'attachment_failed'});
   expect(b.close).toHaveBeenCalled();f.output('live');expect(a.messages().at(-1)).toMatchObject({type:'output',data:'live'});
 });
 it('validates session incarnations before attaching',()=>{
   const f=fixture();const a=f.connect('protocol=2&incarnation=expired');
   expect(a.close).toHaveBeenCalledWith(4002,'session_incarnation_changed');expect(f.runtime.spawn).not.toHaveBeenCalled();
 });
 it('keeps existing client output live while another snapshot is captured',()=>{
   const f=fixture();const a=f.connect();f.runtime.captureSessionSnapshot.mockImplementation(()=>{f.output('during snapshot\r\n');return {data:'history',lineCount:1,windowLines:10000,historyGuaranteed:true};});
   const b=f.connect();expect(a.messages().filter(m=>m.type==='output')).toHaveLength(1);expect(b.messages().filter(m=>m.type==='output')).toHaveLength(1);
 });
});
