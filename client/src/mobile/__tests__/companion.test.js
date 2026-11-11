import { describe,it,expect,vi } from 'vitest';
import { normalizeInstanceUrl, draftKey, validateCapabilities, validatePage, validateEvent, validateSession, validateSessionState, createCompanionApi } from '../companion';
describe('companion private boundaries',()=>{
 it.each(['http://host','https://user:pass@host','https://host/path','',null])('rejects unsafe address %j',url=>expect(()=>normalizeInstanceUrl(url)).toThrow());
 it('accepts HTTPS origin',()=>expect(normalizeInstanceUrl('https://host.tail.ts.net/')).toBe('https://host.tail.ts.net'));
 it('scopes drafts to instance and incarnation',()=>expect(draftKey('one','old')).not.toBe(draftKey('one','new')));
 it('rejects incompatible capabilities and missing fields',()=>{expect(()=>validateCapabilities({protocolVersion:1})).toThrow(); expect(()=>validateCapabilities({instanceId:'a',protocolVersion:2,notificationsReady:true,capabilities:['session-start','project-state','session-state']})).not.toThrow();});
 it('validates pagination and every session field',()=>{expect(()=>validatePage({data:[{}],page:{hasNextPage:false}},'sessions')).toThrow();});
 it('surfaces HTTP errors without accepting malformed data',async()=>{
  const request=vi.fn().mockResolvedValue({ok:false,status:403,json:async()=>({message:'Not authorized'})});
  await expect(createCompanionApi('https://host',request).get('/capabilities')).rejects.toThrow('Not authorized');
 });
});
it('accepts no-content device deletion',async()=>{const request=vi.fn().mockResolvedValue({ok:true,status:204,json:vi.fn(()=>{throw new Error('empty')})});expect(await createCompanionApi('https://host',request).remove('/devices/id')).toBeNull();});

it('accepts test event routing and millisecond timestamps',()=>expect(validateEvent({id:'event',instanceId:'instance',sessionId:null,incarnationId:null,kind:'test',status:'active',createdAt:123})).toBeTruthy());
it('accepts explicit nullable session cwd',()=>expect(validatePage({data:[{id:'s',incarnationId:'i',projectId:'p',title:'s',status:'idle',live:true,cwd:null,host:'local',runtimeType:'tmux',finished:false,muted:false,waiting:false,needsInput:false,lastActivityAt:null}],page:{currentPage:0,size:20,totalElements:1,totalPages:1,hasNextPage:false}},'sessions')).toBeTruthy());

const pageOf=data=>({data,page:{currentPage:0,size:20,totalElements:data.length,totalPages:1,hasNextPage:false}});
const project=extra=>({id:'p',name:'Project',state:'active',stateChangedAt:null,...extra});
const session={id:'p-2',incarnationId:'8d7f3a7e-8a54-4d5b-9d5e-7f4b6a0c2e11',projectId:'p',title:'p-2',status:'idle',live:true,cwd:'/work/p',host:'local',runtimeType:'tmux',finished:false,muted:false,waiting:false,needsInput:false,lastActivityAt:1794330000000};
describe('session start contract',()=>{
 it.each([[undefined],[[]],[['project-state']],[['session-start']],['session-start'],[['session-start','project-state']]])('requires an instance that can start sessions and report project state (%j)',capabilities=>{
  expect(()=>validateCapabilities({instanceId:'a',protocolVersion:2,notificationsReady:true,capabilities})).toThrow('This instance requires a compatible CodeDeck update.');
 });
 it('accepts every project state with its timestamp',()=>{
  expect(validatePage(pageOf([project(),project({id:'w',state:'waiting',stateChangedAt:'2026-11-02T08:00:00.000Z'}),project({id:'s',state:'shelved',stateChangedAt:null})]),'projects').data).toHaveLength(3);
 });
 it.each([[{state:undefined}],[{state:'archived'}],[{state:''}],[{stateChangedAt:undefined}],[{stateChangedAt:'yesterday'}],[{stateChangedAt:123}]])('rejects project field %j',extra=>{
  expect(()=>validatePage(pageOf([project(extra)]),'projects')).toThrow();
 });
 it('validates a started session field by field',()=>{
  expect(validateSession(session)).toBe(session);
  for(const field of Object.keys(session))expect(()=>validateSession({...session,[field]:undefined})).toThrow();
  expect(()=>validateSession(null)).toThrow();
  expect(()=>validateSession({...session,live:'yes'})).toThrow();
 });
});

describe('session attention contract',()=>{
 it.each([['finished','yes'],['muted',0],['waiting',null],['needsInput','false'],['lastActivityAt',-1],['lastActivityAt',1.5],['lastActivityAt','1794330000000']])('rejects a session whose %s is %j',(field,value)=>{
  expect(()=>validateSession({...session,[field]:value})).toThrow();
 });
 it('accepts an unknown activity time',()=>expect(validateSession({...session,lastActivityAt:null}).lastActivityAt).toBeNull());
 const state={sessionId:'p-2',finished:false,muted:true,waiting:false,lastActivityAt:null};
 it('validates a state change response field by field',()=>{
  expect(validateSessionState(state,'p-2')).toBe(state);
  for(const field of Object.keys(state))expect(()=>validateSessionState({...state,[field]:undefined},'p-2')).toThrow();
  expect(()=>validateSessionState(null,'p-2')).toThrow();
  expect(()=>validateSessionState({...state,lastActivityAt:-5},'p-2')).toThrow();
 });
 it('rejects a state response for a different session',()=>expect(()=>validateSessionState(state,'p-3')).toThrow(/session/));
});
