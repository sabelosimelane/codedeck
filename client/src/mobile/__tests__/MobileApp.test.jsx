import React from 'react';
import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
import { render,screen,fireEvent,waitFor,cleanup,within,act } from '@testing-library/react';
const mocks=vi.hoisted(()=>({send:vi.fn(()=>true),composer:vi.fn(()=>true),restore:vi.fn(async()=>'prompt'),enable:vi.fn(async()=>({permission:'denied',token:null})),pushConfigured:false,native:null}));
vi.mock('../../components/Terminal',()=>({default:React.forwardRef((props,ref)=>{React.useImperativeHandle(ref,()=>({sendInput:mocks.send,sendComposer:mocks.composer,focus:()=>{}}));return <div>Terminal {props.sessionId}</div>})}));
vi.mock('../native',()=>({isPushConfigured:()=>mocks.pushConfigured,restoreNotifications:mocks.restore,watchNative:async handlers=>{mocks.native=handlers;return ()=>{}},enableNotifications:mocks.enable,hideKeyboard:async()=>{},showKeyboard:async()=>{}}));
import MobileApp from '../MobileApp';
import { setThemeMode } from '../../theme';
import { run,askingRun,approvalRun,completeRun,task,RUN_ID,TASK_ID,WORKTREE_ID,landing,committedLanding } from './runFixtures';
const MIN=60_000,HOUR=60*MIN;
function reply(body){return Promise.resolve({ok:true,json:async()=>body});}
const page=data=>({data,page:{currentPage:0,size:20,totalElements:data.length,totalPages:1,hasNextPage:false}});
const CAPS={instanceId:'instance',protocolVersion:2,notificationsReady:false,capabilities:['session-start','project-state','session-state']};
const proj=(id,name,state='active',stateChangedAt=null)=>({id,name,state,stateChangedAt});
const session=(id,projectId,title,status,live=true,extra={})=>({id,incarnationId:`inc-${id}`,projectId,title,status,live,cwd:'/tmp',host:'local',runtimeType:'tmux',finished:false,muted:false,waiting:false,needsInput:false,lastActivityAt:Date.now()-MIN,...extra});
// A small backend: lists projects and sessions, and applies state changes the way the server does.
// Runs and tasks come from the endpoints the desktop uses. `onRun` answers an owner action on a run.
let work={runs:[],tasks:[],notes:[],onRun:null,landings:[],onLand:null};
function workReply(url,options){
 if(url.includes('/worktrees'))return options.method==='POST'?Promise.resolve(work.onLand(url,options)):reply(page(work.landings));
 if(url.includes('/api/tasks'))return reply(page(work.tasks));
 if(!url.includes('/api/pipelines/runs'))return undefined;
 if(url.includes('/notes'))return reply(page(work.notes));
 if(options.method==='POST'){const result=work.onRun(url,options);if(result.ok)result.json().then(next=>{work.runs=work.runs.map(item=>item.id===next.id?next:item);});return Promise.resolve(result);}
 return reply(page(work.runs));
}
function serve(projects,sessions,{onState}={}){
 let rows=sessions;
 global.fetch=vi.fn((url,options={})=>{
  const worked=workReply(url,options);if(worked)return worked;
  if(options.method==='PUT'&&url.endsWith('/state')){
   const id=decodeURIComponent(url.split('/sessions/')[1].replace('/state',''));const patch=JSON.parse(options.body);
   if(onState){const refused=onState(id,patch);if(refused)return Promise.resolve(refused);}
   rows=rows.map(row=>row.id===id?{...row,...(patch.waiting!==undefined?{waiting:patch.waiting}:{}),...(patch.muted!==undefined?{muted:patch.muted}:{}),...(patch.acknowledged?{finished:false}:{})}:row);
   const row=rows.find(item=>item.id===id);
   return reply({sessionId:id,finished:row.finished,muted:row.muted,waiting:row.waiting,lastActivityAt:row.lastActivityAt});
  }
  if(url.endsWith('/capabilities'))return reply(CAPS);
  if(url.includes('/projects'))return reply(page(projects));
  return reply(page(rows));
 });
}
const group=name=>within(screen.getByRole('group',{name}));
const calls=method=>global.fetch.mock.calls.filter(([,options])=>options?.method===method);
const rowTitles=()=>within(screen.getByRole('list',{name:'Sessions'})).getAllByRole('listitem').map(item=>item.querySelector('.m-row-title').textContent);
async function connected(){localStorage.setItem('codedeck-mobile-instance','https://host');render(<MobileApp/>);}
afterEach(()=>{cleanup();vi.useRealTimers();});
beforeEach(()=>{work={runs:[],tasks:[],notes:[],onRun:null,landings:[],onLand:null};localStorage.clear();setThemeMode('dark');mocks.pushConfigured=false;mocks.send.mockReturnValue(true);mocks.composer.mockReturnValue(true);mocks.restore.mockClear();mocks.enable.mockClear();
 serve([proj('p','Project')],[session('s','p','Agent','idle',true,{incarnationId:'inc'})]);
});
describe('mobile companion',()=>{
 it('connects privately, opens an existing terminal, sends special keys and explicit multiline drafts',async()=>{
  render(<MobileApp/>);fireEvent.change(screen.getByLabelText('Instance HTTPS address'),{target:{value:'https://host.tail.ts.net'}});fireEvent.click(screen.getByText('Connect'));
  fireEvent.click(await screen.findByText('Agent'));expect(screen.getByText('Terminal s')).toBeTruthy();
  fireEvent.click(screen.getByText('Esc'));expect(mocks.send).toHaveBeenCalledWith('\x1b',undefined);
  fireEvent.click(screen.getByRole('button',{name:'Compose'}));fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'one\ntwo'}});
  expect(localStorage.getItem('codedeck-draft:instance:inc')).toBe('one\ntwo');expect(mocks.send).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Send prompt'}));expect(mocks.composer).toHaveBeenLastCalledWith('one\ntwo',expect.any(Function));
 });
 it('keeps an unsent draft when terminal input is rejected',async()=>{
  mocks.composer.mockReturnValue(false);render(<MobileApp/>);fireEvent.change(screen.getByLabelText('Instance HTTPS address'),{target:{value:'https://host'}});fireEvent.click(screen.getByText('Connect'));
  fireEvent.click(await screen.findByText('Agent'));fireEvent.click(screen.getByRole('button',{name:'Compose'}));fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'keep'}});fireEvent.click(screen.getByRole('button',{name:'Send prompt'}));
  expect(screen.getByLabelText('Prompt').value).toBe('keep');
 });
 it('restores only opted-in notifications and preserves explicit unregister on restart',async()=>{
  localStorage.setItem('codedeck-mobile-notifications:instance','true');
  await connected();await screen.findByText('Agent');expect(mocks.restore).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole('button',{name:'Settings'}));
  const alerts=screen.getByRole('switch',{name:'Session alerts'});expect(alerts.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(alerts);
  await waitFor(()=>expect(localStorage.getItem('codedeck-mobile-notifications:instance')).toBe('false'));
  expect(screen.getByRole('switch',{name:'Session alerts'}).getAttribute('aria-checked')).toBe('false');
  global.fetch.mockClear();await mocks.native.onToken('rotated-after-unregister');expect(global.fetch).not.toHaveBeenCalled();
 });
 it('turns session alerts on through the native permission flow and rolls back when denied',async()=>{
  mocks.pushConfigured=true;await connected();await screen.findByText('Agent');fireEvent.click(screen.getByRole('button',{name:'Settings'}));
  const alerts=screen.getByRole('switch',{name:'Session alerts'});expect(alerts.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(alerts);
  await waitFor(()=>expect(mocks.enable).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(screen.getByRole('switch',{name:'Session alerts'}).getAttribute('aria-checked')).toBe('false'));
  expect(localStorage.getItem('codedeck-mobile-notifications:instance')).toBe('false');
  expect(screen.getByText('denied')).toBeTruthy();
 });
 it('cannot turn alerts on when this build has no push configuration',async()=>{
  await connected();await screen.findByText('Agent');fireEvent.click(screen.getByRole('button',{name:'Settings'}));
  expect(screen.getByRole('switch',{name:'Session alerts'}).disabled).toBe(true);
  expect(screen.getByText('Missing')).toBeTruthy();
 });
 it('refuses an instance that cannot share session state',async()=>{
  global.fetch=vi.fn(()=>reply({...CAPS,capabilities:['session-start','project-state']}));
  await connected();
  expect((await screen.findByRole('alert')).textContent).toContain('This instance requires a compatible CodeDeck update.');
 });
});

describe('appearance',()=>{
 it('switches between System, Dark and Light from settings and persists the choice',async()=>{
  render(<MobileApp/>);
  const appearance=group('Appearance');
  expect(appearance.getByRole('button',{name:'Dark'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(appearance.getByRole('button',{name:'Light'}));
  expect(document.documentElement.dataset.theme).toBe('light');expect(localStorage.getItem('codedeck-theme')).toBe('light');
  expect(group('Appearance').getByRole('button',{name:'Light'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(group('Appearance').getByRole('button',{name:'System'}));
  expect(localStorage.getItem('codedeck-theme')).toBe('system');
 });
 it('flips between dark and light from the terminal header',async()=>{
  await connected();fireEvent.click(await screen.findByText('Agent'));
  fireEvent.click(screen.getByRole('button',{name:'Switch to light mode'}));
  expect(document.documentElement.dataset.theme).toBe('light');
  fireEvent.click(screen.getByRole('button',{name:'Switch to dark mode'}));
  expect(document.documentElement.dataset.theme).toBe('dark');
 });
});

describe('now view',()=>{
 const busy=()=>[
  session('old','p','Old notes','idle',true,{lastActivityAt:Date.now()-40*HOUR}),
  session('run','q','Build Android','running',true,{lastActivityAt:Date.now()-20*MIN}),
  session('fin','p','Fix tests','idle',true,{finished:true,lastActivityAt:Date.now()-2*MIN}),
  session('park','p','Long refactor','running',true,{waiting:true,lastActivityAt:Date.now()-5*MIN}),
  session('idle','p','Waiting agent','idle',true,{lastActivityAt:Date.now()-30*MIN}),
 ];
 const two=[proj('p','Project'),proj('q','Other project')];
 it('answers what is happening now and lists work in flight by last activity',async()=>{
  serve(two,busy());await connected();
  expect(await screen.findByRole('heading',{level:1,name:'1 running'})).toBeTruthy();
  expect(screen.getByText('1 needs you')).toBeTruthy();
  expect(rowTitles()).toEqual(['Fix tests','Build Android','Waiting agent']);
  const list=within(screen.getByRole('list',{name:'Sessions'}));
  expect(list.getByText('Finished')).toBeTruthy();expect(list.getByText('Running')).toBeTruthy();
  expect(list.getByText('Other project')).toBeTruthy();
 });
 it('keeps quiet sessions one tap away and shows them under Earlier',async()=>{
  serve(two,busy());await connected();await screen.findByText('Fix tests');
  expect(screen.queryByText('Old notes')).toBeNull();expect(screen.queryByText('Long refactor')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'2 quiet sessions'}));
  const earlier=within(screen.getByRole('region',{name:'Earlier'}));
  expect(earlier.getByText('Old notes')).toBeTruthy();
  expect(within(earlier.getByText('Long refactor').closest('li')).getByRole('img',{name:'Waiting'})).toBeTruthy();
  expect(screen.getByRole('button',{name:/Showing all sessions/}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:/Showing all sessions/}));
  expect(screen.queryByText('Old notes')).toBeNull();
 });
 it('says all is quiet and shows the most recent sessions when nothing is in flight',async()=>{
  serve(two,[session('a','p','Yesterday work','idle',true,{lastActivityAt:Date.now()-30*HOUR}),session('b','p','Older work','idle',true,{lastActivityAt:Date.now()-60*HOUR})]);await connected();
  expect(await screen.findByRole('heading',{level:1,name:'All quiet'})).toBeTruthy();
  expect(screen.getByText('Last activity yesterday')).toBeTruthy();
  expect(within(screen.getByRole('region',{name:'Most recent'})).getByText('Yesterday work')).toBeTruthy();
  expect(rowTitles()).toEqual(['Yesterday work','Older work']);
 });
 it('tells you to open a terminal when there are no sessions at all',async()=>{
  serve(two,[]);await connected();
  expect(await screen.findByRole('heading',{level:1,name:'All quiet'})).toBeTruthy();
  expect(screen.getByText('Open a terminal on your desktop, or start one with +.')).toBeTruthy();
 });
 it('searches every session, including quiet ones, by title or project',async()=>{
  serve(two,busy());await connected();await screen.findByText('Fix tests');
  fireEvent.change(screen.getByRole('searchbox',{name:'Search sessions and projects'}),{target:{value:'old'}});
  expect(rowTitles()).toEqual(['Old notes']);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'other proj'}});
  expect(rowTitles()).toEqual(['Build Android']);
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'zzz'}});
  expect(screen.getByText('No sessions match “zzz”')).toBeTruthy();
 });
 it('only shows the connection state when something is wrong',async()=>{
  serve(two,busy());await connected();await screen.findByText('Fix tests');
  expect(screen.queryByText(/Connected/)).toBeNull();
 });
 it('refreshes by itself while the list is on screen',async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});
  serve(two,busy());await connected();await screen.findByText('Fix tests');
  const listed=()=>global.fetch.mock.calls.filter(([url])=>url.includes('/sessions?')).length;
  const before=listed();
  await act(()=>vi.advanceTimersByTimeAsync(5200));
  expect(listed()).toBeGreaterThan(before);
  fireEvent.click(screen.getByText('Fix tests'));const inTerminal=listed();
  await act(()=>vi.advanceTimersByTimeAsync(5200));
  expect(listed()).toBe(inTerminal);
 });
});

describe('session actions',()=>{
 const rows=()=>[session('fin','p','Fix tests','idle',true,{finished:true}),session('run','p','Build Android','running')];
 const openActions=async title=>{fireEvent.contextMenu(await screen.findByText(title));return within(screen.getByRole('dialog',{name:title}));};
 it('parks a session from a long press, so it leaves the active list on every device',async()=>{
  serve([proj('p','Project')],rows());await connected();
  const sheet=await openActions('Build Android');
  fireEvent.click(sheet.getByRole('button',{name:/Mark as waiting/}));
  await waitFor(()=>expect(screen.queryByText('Build Android')).toBeNull());
  expect(calls('PUT').map(([url,options])=>[url,JSON.parse(options.body)])).toEqual([['https://host/api/mobile/v1/sessions/run/state',{waiting:true}]]);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Marked as waiting')).toBeTruthy();
  expect(screen.getByRole('heading',{level:1,name:'1 needs you'})).toBeTruthy();
 });
 it('offers to stop waiting for a parked session',async()=>{
  serve([proj('p','Project')],[session('park','p','Long refactor','running',true,{waiting:true}),session('a','p','Agent','idle')]);await connected();await screen.findByText('Agent');
  fireEvent.click(screen.getByRole('button',{name:'1 quiet session'}));
  const sheet=await openActions('Long refactor');
  fireEvent.click(sheet.getByRole('button',{name:/Stop waiting/}));
  await waitFor(()=>expect(JSON.parse(calls('PUT')[0][1].body)).toEqual({waiting:false}));
  expect(await screen.findByRole('heading',{level:1,name:'1 running'})).toBeTruthy();
 });
 it('mutes status colours while keeping the real state in words',async()=>{
  serve([proj('p','Project')],rows());await connected();
  const sheet=await openActions('Build Android');
  fireEvent.click(sheet.getByRole('button',{name:/Mute status colours/}));
  const row=(await screen.findByRole('img',{name:'Status muted'})).closest('li');
  expect(within(row).getByText('Running')).toBeTruthy();
  expect(JSON.parse(calls('PUT')[0][1].body)).toEqual({muted:true});
  expect(screen.getByRole('heading',{level:1,name:'1 needs you'})).toBeTruthy();
 });
 it('marks finished work as reviewed without opening it',async()=>{
  serve([proj('p','Project')],rows());await connected();
  const sheet=await openActions('Fix tests');
  fireEvent.click(sheet.getByRole('button',{name:'Mark as reviewed'}));
  await waitFor(()=>expect(screen.queryByText('Finished')).toBeNull());
  expect(JSON.parse(calls('PUT')[0][1].body)).toEqual({acknowledged:true});
  expect(screen.queryByText('Terminal fin')).toBeNull();
 });
 it('does not offer review for a session that has not finished',async()=>{
  serve([proj('p','Project')],rows());await connected();
  expect((await openActions('Build Android')).queryByRole('button',{name:'Mark as reviewed'})).toBeNull();
 });
 it('acknowledges finished work when its terminal is opened',async()=>{
  serve([proj('p','Project')],rows());await connected();
  fireEvent.click(await screen.findByText('Fix tests'));
  expect(screen.getByText('Terminal fin')).toBeTruthy();
  await waitFor(()=>expect(calls('PUT').map(([url,options])=>[url,JSON.parse(options.body)])).toEqual([['https://host/api/mobile/v1/sessions/fin/state',{acknowledged:true}]]));
  fireEvent.click(screen.getByRole('button',{name:'Back to sessions'}));
  await waitFor(()=>expect(screen.queryByText('Finished')).toBeNull());
 });
 it('does not touch the backend when opening a session that has nothing to acknowledge',async()=>{
  serve([proj('p','Project')],rows());await connected();
  fireEvent.click(await screen.findByText('Build Android'));
  expect(screen.getByText('Terminal run')).toBeTruthy();expect(calls('PUT')).toHaveLength(0);
 });
 it('keeps the sheet open and explains when a change is refused',async()=>{
  serve([proj('p','Project')],rows(),{onState:()=>({ok:false,status:409,json:async()=>({message:'Session status has not been observed yet. Try again in a few seconds.'})})});await connected();
  const sheet=await openActions('Build Android');
  fireEvent.click(sheet.getByRole('button',{name:/Mute status colours/}));
  expect((await screen.findByRole('alert')).textContent).toContain('Session status has not been observed yet');
  expect(screen.getByRole('dialog',{name:'Build Android'})).toBeTruthy();expect(screen.queryByRole('img',{name:'Status muted'})).toBeNull();
 });
 it('opens the same actions from the terminal header and closes with back',async()=>{
  serve([proj('p','Project')],rows());await connected();
  fireEvent.click(await screen.findByText('Build Android'));
  fireEvent.click(screen.getByRole('button',{name:'Session options'}));
  expect(screen.getByRole('dialog',{name:'Build Android'})).toBeTruthy();
  await mocks.native.onBack();await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByText('Terminal run')).toBeTruthy();
 });
});

describe('new session',()=>{
 const started={...session('Shelf-1','Shelf','Shelf-1','idle'),incarnationId:'8d7f3a7e-8a54-4d5b-9d5e-7f4b6a0c2e11',cwd:'/work/shelf'};
 function serveWithStart(onStart){
  let projects=[proj('p','Project'),proj('Parked','Parked','waiting','2026-11-02T08:00:00.000Z'),proj('Shelf','Shelf','shelved','2026-11-01T10:00:00.000Z')];
  let sessions=[session('s','p','Agent','idle')];
  global.fetch=vi.fn((url,options={})=>{
   const worked=workReply(url,options);if(worked)return worked;
   if(options.method==='POST'&&url.endsWith('/sessions')){return onStart(url).then(result=>{if(result.ok){projects=projects.map(row=>row.id==='Shelf'?proj('Shelf','Shelf'):row);sessions=[...sessions,started];}return result;});}
   if(url.endsWith('/capabilities'))return reply(CAPS);
   if(url.includes('/projects'))return reply(page(projects));
   return reply(page(sessions));
  });
 }
 const created=()=>Promise.resolve({ok:true,status:201,json:async()=>started});
 async function openSheet(){await connected();await screen.findByText('Agent');fireEvent.click(screen.getByRole('button',{name:'New session'}));return within(screen.getByRole('dialog',{name:'New session'}));}
 it('lists every project for a new session, including waiting and shelved ones without sessions',async()=>{
  serveWithStart(created);const sheet=await openSheet();
  expect(sheet.getAllByRole('region').map(region=>region.getAttribute('aria-label'))).toEqual(['Active','Waiting','Shelved']);
  expect(within(sheet.getByRole('region',{name:'Shelved'})).getByRole('button',{name:/Shelf.*Restore & start/})).toBeTruthy();
  fireEvent.change(sheet.getByRole('searchbox',{name:'Search all projects'}),{target:{value:'shel'}});
  expect(sheet.queryByRole('button',{name:/^Project/})).toBeNull();expect(sheet.getByRole('button',{name:/Shelf/})).toBeTruthy();
  fireEvent.change(sheet.getByRole('searchbox',{name:'Search all projects'}),{target:{value:'zzz'}});
  expect(sheet.getByText('No projects match “zzz”')).toBeTruthy();
 });
 it('starts a session in a shelved project, restores it and opens the new terminal',async()=>{
  serveWithStart(created);const sheet=await openSheet();
  fireEvent.click(sheet.getByRole('button',{name:/Shelf/}));
  expect(await screen.findByText('Terminal Shelf-1')).toBeTruthy();
  expect(calls('POST').map(([url])=>url)).toEqual(['https://host/api/mobile/v1/projects/Shelf/sessions']);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Back to sessions'}));
  expect(await screen.findByText('Shelf-1')).toBeTruthy();
 });
 it('keeps the sheet open and shows why when a session cannot start',async()=>{
  serveWithStart(()=>Promise.resolve({ok:false,status:503,json:async()=>({message:'Host media-server is unreachable'})}));const sheet=await openSheet();
  fireEvent.click(sheet.getByRole('button',{name:/Shelf/}));
  expect((await screen.findByRole('alert')).textContent).toContain('Host media-server is unreachable');
  expect(screen.getByRole('dialog',{name:'New session'})).toBeTruthy();expect(screen.queryByText('Terminal Shelf-1')).toBeNull();
 });
 it('starts only one session when a project is tapped twice',async()=>{
  let finish;serveWithStart(()=>new Promise(resolve=>{finish=()=>resolve({ok:true,status:201,json:async()=>started});}));const sheet=await openSheet();
  fireEvent.click(sheet.getByRole('button',{name:/Shelf/}));fireEvent.click(sheet.getByRole('button',{name:/Shelf/}));
  expect(calls('POST')).toHaveLength(1);expect(sheet.getByText('Starting…')).toBeTruthy();
  finish();expect(await screen.findByText('Terminal Shelf-1')).toBeTruthy();
 });
 it('closes from its close button and from the device back button',async()=>{
  serveWithStart(created);await openSheet();
  fireEvent.click(screen.getByRole('button',{name:'Close'}));expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'New session'}));expect(screen.getByRole('dialog')).toBeTruthy();
  await mocks.native.onBack();await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByText('Agent')).toBeTruthy();
 });
});

describe('workflow runs on the phone',()=>{
 const okRun=record=>({ok:true,status:200,json:async()=>record});
 const runSessions=()=>[session('p-1','p','p-1','idle'),session('p-2','p','p-2','running'),session('p-9','p','Scratch','idle')];
 const taskList=()=>within(screen.getByRole('list',{name:'Tasks'}));
 async function withRun(record){work.runs=[record];work.tasks=[task()];serve([proj('p','p')],runSessions());await connected();await screen.findByRole('list',{name:'Tasks'});}
 async function openTask(){fireEvent.click(taskList().getByRole('button',{name:/First name only on the call/}));await screen.findByRole('list',{name:'Steps'});}

 it('lists a run as its task, with its state and step, and keeps its terminals out of the session list',async()=>{
  await withRun(run());
  const row=taskList().getByRole('button',{name:/First name only on the call/});
  expect(row.textContent).toContain('Running');expect(row.textContent).toContain('Step 2 of 3 · Fix');expect(row.textContent).toContain('Bug fix · p');
  expect(rowTitles()).toEqual(['Scratch']);
  expect(screen.getByRole('heading',{level:1}).textContent).toBe('1 running');
  expect(screen.getByRole('heading',{level:2,name:'Sessions'})).toBeTruthy();
 });
 it('shows no task list when no run is open',async()=>{
  serve([proj('p','p')],runSessions());await connected();await screen.findByText('Scratch');
  expect(screen.queryByRole('list',{name:'Tasks'})).toBeNull();expect(screen.queryByRole('heading',{level:2,name:'Sessions'})).toBeNull();
  expect(global.fetch.mock.calls.some(([url])=>url==='https://host/api/pipelines/runs?open=true&page=0&size=100')).toBe(true);
  expect(global.fetch.mock.calls.some(([url])=>url==='https://host/api/tasks?open=true&page=0&size=100')).toBe(true);
 });
 it('opens the task, then a step terminal, and comes back the same way',async()=>{
  await withRun(run());await openTask();
  expect(screen.getByRole('heading',{level:1,name:'First name only on the call'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Open terminal of Fix'}));
  expect(await screen.findByText('Terminal p-2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Back to sessions'}));
  expect(await screen.findByRole('list',{name:'Steps'})).toBeTruthy();
  await mocks.native.onBack();
  expect(await screen.findByRole('list',{name:'Tasks'})).toBeTruthy();
 });
 it('answers the questions of a run and shows the run moving on',async()=>{
  work.onRun=vi.fn(()=>okRun(run()));
  await withRun(askingRun());
  expect(screen.getByRole('heading',{level:1}).textContent).toBe('1 needs you');expect(taskList().getByText('Needs your input')).toBeTruthy();
  await openTask();
  fireEvent.change(screen.getByLabelText('Your answer to question 2'),{target:{value:'Yes'}});
  fireEvent.click(screen.getByRole('button',{name:'Send answers'}));
  expect(await screen.findByText('Answer sent to Bug fix')).toBeTruthy();
  const [url,options]=work.onRun.mock.calls[0];
  expect(url).toBe(`https://host/api/pipelines/runs/${RUN_ID}/answer`);
  expect(JSON.parse(options.body)).toEqual({answer:'1. As you recommend: The first name only\n2. Yes'});
  await waitFor(()=>expect(screen.queryByRole('group',{name:'Question 1'})).toBeNull());
  expect(screen.getByText('Running',{selector:'.m-state'})).toBeTruthy();
 });
 it('says why an answer was refused and keeps the questions',async()=>{
  work.onRun=vi.fn(()=>({ok:false,status:409,json:async()=>({message:'The run is not waiting for an answer'})}));
  await withRun(askingRun());await openTask();
  fireEvent.change(screen.getByLabelText('Your answer to question 2'),{target:{value:'Yes'}});
  fireEvent.click(screen.getByRole('button',{name:'Send answers'}));
  expect(await screen.findByText('The run is not waiting for an answer')).toBeTruthy();
  expect(screen.getByRole('group',{name:'Question 1'})).toBeTruthy();
  expect(screen.getByLabelText('Your answer to question 2').value).toBe('Yes');
 });
 it('approves a step that waits for approval',async()=>{
  work.onRun=vi.fn(()=>okRun(run()));work.notes=[{id:7,stepIndex:1,stepName:'Fix',status:'written',summary:'Done',attempt:1,pass:1,createdAt:'2026-11-10T17:50:00.000Z',content:'The greeting reads the first name.'}];
  await withRun(approvalRun());await openTask();
  expect(await screen.findByText('The greeting reads the first name.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Approve and continue'}));
  expect(await screen.findByText('Bug fix approved')).toBeTruthy();
  expect(work.onRun.mock.calls[0][0]).toBe(`https://host/api/pipelines/runs/${RUN_ID}/approve`);
 });
 it('sends a step back with what to change',async()=>{
  work.onRun=vi.fn(()=>okRun(run()));
  await withRun(approvalRun());await openTask();
  fireEvent.click(screen.getByRole('button',{name:'Send back…'}));
  fireEvent.change(screen.getByLabelText('What should change'),{target:{value:'Keep the surname.'}});
  fireEvent.click(screen.getByRole('button',{name:'Send back'}));
  expect(await screen.findByText('Bug fix sent back')).toBeTruthy();
  expect(JSON.parse(work.onRun.mock.calls[0][1].body)).toEqual({comment:'Keep the surname.'});
 });
 it('resumes an interrupted run',async()=>{
  work.onRun=vi.fn(()=>okRun(run()));
  const interrupted=run({status:'interrupted',actions:{...run().actions,stop:false,resume:true},steps:[run().steps[0],{...run().steps[1],status:'interrupted'},run().steps[2]]});
  await withRun(interrupted);await openTask();
  fireEvent.click(screen.getByRole('button',{name:'Resume'}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'Confirm'})).getByRole('button',{name:'Resume'}));
  expect(await screen.findByText('Bug fix resumed')).toBeTruthy();
  expect(work.onRun.mock.calls[0][0]).toBe(`https://host/api/pipelines/runs/${RUN_ID}/resume`);
 });
 it('closes a finished run, says how many terminals went with it, and goes back to the list',async()=>{
  const finished=completeRun({updatedAt:new Date().toISOString(),finishedAt:new Date().toISOString()});
  work.onRun=vi.fn(()=>okRun({...finished,worktree:{...finished.worktree,state:'released'},terminalsClosed:['p-1','p-2'],terminalsNotClosed:['p-3']}));
  await withRun(finished);await openTask();
  fireEvent.click(within(screen.getByRole('toolbar',{name:'Run controls'})).getByRole('button',{name:'Close run'}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'Confirm'})).getByRole('button',{name:'Close run'}));
  expect(await screen.findByText('Bug fix run closed; its work is left in place. 2 terminals closed.')).toBeTruthy();
  expect(screen.getByText('1 terminal could not be closed: p-3. Close it from its tab.')).toBeTruthy();
  expect(work.onRun.mock.calls[0][0]).toBe(`https://host/api/pipelines/runs/${RUN_ID}/cleanup`);
  await waitFor(()=>expect(screen.queryByRole('list',{name:'Steps'})).toBeNull());
 });
 it('stops a working run once the owner confirms',async()=>{
  work.onRun=vi.fn(()=>okRun(run({status:'stopped',stopReason:'user',finishedAt:run().createdAt,actions:{...run().actions,stop:false,resume:true}})));
  await withRun(run());await openTask();
  fireEvent.click(within(screen.getByRole('toolbar',{name:'Run controls'})).getByRole('button',{name:'Stop'}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'Confirm'})).getByRole('button',{name:'Stop'}));
  expect(await screen.findByText('Bug fix stopped')).toBeTruthy();
  expect(work.onRun.mock.calls[0][0]).toBe(`https://host/api/pipelines/runs/${RUN_ID}/stop`);
 });
 it('commits a finished task from its screen, then reads Git again',async()=>{
  const finished=completeRun({updatedAt:new Date().toISOString()});
  work.landings=[landing()];work.onLand=vi.fn(()=>{work.landings=[committedLanding()];return okRun(committedLanding());});
  await withRun(finished);await openTask();
  fireEvent.click(await within(screen.getByRole('region',{name:'In Git'})).findByRole('button',{name:'Commit changes'}));
  fireEvent.change(screen.getByLabelText('Commit message'),{target:{value:'Use the first name'}});
  fireEvent.click(within(screen.getByRole('dialog',{name:'Commit changes'})).getByRole('button',{name:'Commit'}));
  expect(await screen.findByText('Changes committed in p')).toBeTruthy();
  const [url,options]=work.onLand.mock.calls[0];
  expect(url).toBe(`https://host/api/tasks/${TASK_ID}/worktrees/${WORKTREE_ID}/commit`);
  expect(JSON.parse(options.body)).toEqual({message:'Use the first name'});
  expect(await screen.findByText('3 commits ready for main')).toBeTruthy();
 });
 it('says why a merge was refused, with the conflicting files',async()=>{
  work.landings=[committedLanding()];work.onLand=vi.fn(()=>({ok:false,status:409,json:async()=>({message:'The merge conflicts and was aborted.',conflicts:['src/call.js']})}));
  await withRun(completeRun({updatedAt:new Date().toISOString()}));await openTask();
  fireEvent.click(await within(screen.getByRole('region',{name:'In Git'})).findByRole('button',{name:'Merge into main'}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'Confirm'})).getByRole('button',{name:'Merge'}));
  expect(await screen.findByText('The merge conflicts and was aborted. Conflicts: src/call.js')).toBeTruthy();
 });
 it('stops a run from a long press on its row, once the owner confirms',async()=>{
  work.onRun=vi.fn(()=>okRun(run({status:'stopped',stopReason:'user',finishedAt:run().createdAt,actions:{...run().actions,stop:false,resume:true}})));
  await withRun(run());
  fireEvent.contextMenu(taskList().getByRole('button',{name:/First name only on the call/}));
  const sheet=within(screen.getByRole('dialog',{name:'First name only on the call'}));
  expect(sheet.getByRole('button',{name:'Open task'})).toBeTruthy();
  fireEvent.click(sheet.getByRole('button',{name:'Stop'}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'Confirm'})).getByRole('button',{name:'Stop'}));
  expect(await screen.findByText('Bug fix stopped')).toBeTruthy();
  expect(work.onRun.mock.calls[0][0]).toBe(`https://host/api/pipelines/runs/${RUN_ID}/stop`);
  expect(screen.queryByRole('dialog',{name:'First name only on the call'})).toBeNull();
 });
 it('approves a step from a long press, with what the step concluded in view',async()=>{
  work.onRun=vi.fn(()=>okRun(run()));
  await withRun(approvalRun());
  fireEvent.contextMenu(taskList().getByRole('button',{name:/First name only on the call/}));
  const sheet=within(screen.getByRole('dialog',{name:'First name only on the call'}));
  fireEvent.click(sheet.getByRole('button',{name:'Approve Fix'}));
  const asked=within(screen.getByRole('dialog',{name:'Confirm'}));
  expect(asked.getByText('Approve Fix and continue Bug fix? Fix concluded: The call now uses the first name')).toBeTruthy();
  fireEvent.click(asked.getByRole('button',{name:'Approve'}));
  expect(await screen.findByText('Bug fix approved')).toBeTruthy();
 });
 it('opens the task from its actions, and a tap still opens it',async()=>{
  await withRun(askingRun());
  fireEvent.contextMenu(taskList().getByRole('button',{name:/First name only on the call/}));
  fireEvent.click(within(screen.getByRole('dialog',{name:'First name only on the call'})).getByRole('button',{name:'Open task'}));
  expect(await screen.findByRole('list',{name:'Steps'})).toBeTruthy();
 });
 it('returns to the list when the run it shows is closed',async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});
  await withRun(run());await openTask();
  work.runs=[];
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(await screen.findByText('That run is no longer open')).toBeTruthy();
  expect(screen.queryByRole('list',{name:'Steps'})).toBeNull();expect(rowTitles()).toContain('Scratch');
 });
 it('counts quiet tasks beside quiet sessions',async()=>{
  const old=new Date(Date.now()-9*HOUR).toISOString();
  work.runs=[completeRun({updatedAt:old,finishedAt:old})];work.tasks=[task()];
  serve([proj('p','p')],[session('p-9','p','Scratch','running')]);await connected();await screen.findByText('Scratch');
  expect(screen.queryByRole('list',{name:'Tasks'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'1 quiet task'}));
  expect(taskList().getByText('Complete')).toBeTruthy();
 });
 it('reports runs that cannot be read instead of showing a partial list',async()=>{
  work.runs=[{...run(),status:'paused'}];serve([proj('p','p')],runSessions());await connected();
  expect((await screen.findByRole('alert')).textContent).toContain(`Invalid run ${RUN_ID} field status`);
 });
});
