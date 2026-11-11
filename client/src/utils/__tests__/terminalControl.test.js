import { describe, it, expect, vi } from 'vitest';
import { createTerminalControl } from '../terminalControl';
function setup() {
 const sent=[]; const ws={readyState:1,send: v=>sent.push(JSON.parse(v))};
 const c=createTerminalControl({dimensions:()=>({cols:80,rows:24}),onState:vi.fn(),onError:vi.fn()});
 c.connect(ws); c.session({attachmentId:'a',controllerId:null,controlRevision:0,cols:120,rows:30});
 return {c,ws,sent};
}
describe('terminal control fencing',()=>{
 it('does not claim on attachment or background recovery',()=>{ const {c,sent}=setup(); c.ready(); expect(sent).toEqual([]); });
 it('claims only after hydration and sends the first intentional input exactly once after acknowledgement',()=>{
  const {c,sent}=setup(); c.input('x'); expect(sent).toEqual([]); c.ready(); expect(sent[0].type).toBe('claim_control');
  const ack={controllerId:'a',controlRevision:1,cols:80,rows:24,requestId:sent[0].requestId}; c.state(ack); c.state(ack);
  expect(sent.filter(x=>x.type==='input')).toEqual([{type:'input',data:'x',controlRevision:1}]);
 });
 it('drops pending input on disconnect and never resends uncertain input',()=>{
  const {c,sent,ws}=setup(); c.ready(); c.input('danger'); const id=sent[0].requestId; c.disconnect();
  c.connect(ws); c.session({attachmentId:'b',controllerId:null,controlRevision:2,cols:80,rows:24}); c.ready();
  c.state({controllerId:'a',controlRevision:1,cols:80,rows:24,requestId:id}); expect(sent.filter(x=>x.type==='input')).toEqual([]);
 });
 it('fences resize and relinquishes control without disconnecting',()=>{
  const {c,sent}=setup(); c.ready(); c.resize(90,40); expect(sent).toEqual([]); c.claim();
  c.state({controllerId:'a',controlRevision:1,cols:80,rows:24,requestId:sent[0].requestId}); c.resize(90,40);
  expect(sent.at(-1)).toEqual({type:'resize',cols:90,rows:40,controlRevision:1});
  c.state({controllerId:'b',controlRevision:2,cols:30,rows:60,requestId:'other'}); expect(c.isController()).toBe(false);
 });
 it.each([null,{}, {attachmentId:'a',controllerId:null,controlRevision:-1,cols:80,rows:24}])('rejects invalid handshakes %j',value=>{const {c}=setup();expect(()=>c.session(value)).toThrow();});
});

it('reports queued input as unsent until the live socket send succeeds',()=>{const {c,sent}=setup();c.ready();const delivered=vi.fn();expect(c.input('draft',delivered)).toBe(false);expect(delivered).not.toHaveBeenCalled();c.state({controllerId:'a',controlRevision:1,cols:80,rows:24,requestId:sent[0].requestId});expect(delivered).toHaveBeenCalledTimes(1);});
