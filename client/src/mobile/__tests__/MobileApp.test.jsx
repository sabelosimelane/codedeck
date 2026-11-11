import React from 'react';
import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
import { render,screen,fireEvent,waitFor,cleanup,within,act } from '@testing-library/react';
const mocks=vi.hoisted(()=>({send:vi.fn(()=>true),composer:vi.fn(()=>true),restore:vi.fn(async()=>'prompt'),enable:vi.fn(async()=>({permission:'denied',token:null})),pushConfigured:false,native:null}));
vi.mock('../../components/Terminal',()=>({default:React.forwardRef((props,ref)=>{React.useImperativeHandle(ref,()=>({sendInput:mocks.send,sendComposer:mocks.composer,focus:()=>{}}));return <div>Terminal {props.sessionId}</div>})}));
vi.mock('../native',()=>({isPushConfigured:()=>mocks.pushConfigured,restoreNotifications:mocks.restore,watchNative:async handlers=>{mocks.native=handlers;return ()=>{}},enableNotifications:mocks.enable,hideKeyboard:async()=>{},showKeyboard:async()=>{}}));
import MobileApp from '../MobileApp';
import { setThemeMode } from '../../theme';
const MIN=60_000,HOUR=60*MIN;
function reply(body){return Promise.resolve({ok:true,json:async()=>body});}
const page=data=>({data,page:{currentPage:0,size:20,totalElements:data.length,totalPages:1,hasNextPage:false}});
const CAPS={instanceId:'instance',protocolVersion:2,notificationsReady:false,capabilities:['session-start','project-state','session-state']};
const proj=(id,name,state='active',stateChangedAt=null)=>({id,name,state,stateChangedAt});
const session=(id,projectId,title,status,live=true,extra={})=>({id,incarnationId:`inc-${id}`,projectId,title,status,live,cwd:'/tmp',host:'local',runtimeType:'tmux',finished:false,muted:false,waiting:false,needsInput:false,lastActivityAt:Date.now()-MIN,...extra});
// A small backend: lists projects and sessions, and applies state changes the way the server does.
function serve(projects,sessions,{onState}={}){
 let rows=sessions;
 global.fetch=vi.fn((url,options={})=>{
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
beforeEach(()=>{localStorage.clear();setThemeMode('dark');mocks.pushConfigured=false;mocks.send.mockReturnValue(true);mocks.composer.mockReturnValue(true);mocks.restore.mockClear();mocks.enable.mockClear();
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
