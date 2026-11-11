import React, { useEffect, useRef, useState } from 'react';
import Terminal from '../components/Terminal';
import { ToastProvider, useToast } from '../components/ToastContext';
import { createCompanionApi, normalizeInstanceUrl, validateCapabilities, validatePage, validateEvent, validateSession, validateSessionState, draftKey } from './companion';
import { buildNowView } from './nowView';
import { watchNative, enableNotifications, hideKeyboard, showKeyboard, isPushConfigured, restoreNotifications } from './native';
import { getThemeMode, setThemeMode, getResolvedTheme, THEME_CHANGE_EVENT } from '../theme';
import './mobile.css';
const SETTINGS='codedeck-mobile-instance';
const INSTALLATION='codedeck-mobile-installation';
const INTENT='codedeck-mobile-navigation';
function installationId(){let id=localStorage.getItem(INSTALLATION);if(!id){id=crypto.randomUUID();localStorage.setItem(INSTALLATION,id);}if(!/^[\da-f-]{36}$/i.test(id))throw new Error('Invalid installation identity.');return id;}
const keys=[['Esc','\x1b'],['Tab','\t'],['↑','\x1b[A'],['↓','\x1b[B'],['←','\x1b[D'],['→','\x1b[C'],['Enter','\r']];
const APPEARANCE=[['system','System'],['dark','Dark'],['light','Light']];
const hostLabel=host=>host==='local'?'This host':host;

function Icon({d,size=18,width=2,children}){return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">{d&&<path d={d}/>}{children}</svg>;}
const BackIcon=()=><Icon d="M15 6l-6 6 6 6" width={2.2}/>;
const SunIcon=()=><Icon d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"><circle cx="12" cy="12" r="4"/></Icon>;
const MoonIcon=()=><Icon d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>;
const SettingsIcon=()=><Icon d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2"><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/></Icon>;
const SearchIcon=()=><Icon d="M21 21l-4.3-4.3" size={20}><circle cx="11" cy="11" r="7"/></Icon>;
const SendIcon=()=><Icon d="M12 19V5M6 11l6-6 6 6" size={20} width={2.4}/>;
const CtrlIcon=()=><Icon d="M6 14l6-6 6 6" size={16} width={2.2}/>;
const KeyboardIcon=()=><Icon d="M7 10h0M11 10h0M15 10h0M8 14h8"><rect x="3" y="6" width="18" height="12" rx="2"/></Icon>;
const ComposeIcon=()=><Icon d="M4 20h4L19 9l-4-4L4 16z" size={16}/>;
const PlusIcon=({size=24})=><Icon d="M12 5v14M5 12h14" size={size} width={2.4}/>;
const CloseIcon=()=><Icon d="M6 6l12 12M18 6L6 18" width={2.2}/>;
const FilterIcon=()=><Icon d="M4 7h16M7 12h10M10 17h4" size={16} width={2.2}/>;
const MoreIcon=()=><Icon><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></Icon>;
const CheckIcon=()=><Icon d="M5 12l5 5L20 7" size={22} width={2.2}/>;
const TerminalIcon=()=><Icon d="M5 8l4 4-4 4M12 16h7" size={22}/>;
const HOURGLASS="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4";
const EYE_OFF="M3 3l18 18M10.6 5.1A10 10 0 0 1 22 12a17 17 0 0 1-3 3.6M6.5 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.6-1.2";
const Glyph=({d,label,size=14})=><svg role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:'true'} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d}/></svg>;
const REFRESH_MS=5000;
const LONG_PRESS_MS=500;

/** One session in the Now list. A tap opens it; a long press (or context menu) offers its actions. */
function SessionRow({row,index,onOpen,onActions}){
 const timer=useRef(null),pressed=useRef(false),origin=useRef(null);
 const cancel=()=>{if(timer.current){clearTimeout(timer.current);timer.current=null;}};
 useEffect(()=>cancel,[]);
 const actions=()=>{pressed.current=true;onActions(row);};
 return <li className="m-rise" style={{'--i':index}}>
  <button className={`m-row m-press is-age-${row.age}`}
   onPointerDown={event=>{pressed.current=false;origin.current={x:event.clientX,y:event.clientY};cancel();timer.current=setTimeout(actions,LONG_PRESS_MS);}}
   onPointerMove={event=>{if(origin.current&&(Math.abs(event.clientX-origin.current.x)>10||Math.abs(event.clientY-origin.current.y)>10))cancel();}}
   onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel}
   onContextMenu={event=>{event.preventDefault();cancel();if(!pressed.current)actions();}}
   onClick={()=>{if(pressed.current){pressed.current=false;return;}onOpen(row.session);}}>
   <span className={`m-dot is-${row.tone}`}/>
   <span className="m-row-body">
    <span className="m-row-title">{row.title}</span>
    <span className="m-row-meta">{row.note&&<><span className={`m-state is-${row.tone}`}>{row.note}</span><span aria-hidden="true"> · </span></>}<span>{row.projectName}</span></span>
   </span>
   {row.muted&&<span className="m-row-flag"><Glyph d={EYE_OFF} label="Status muted"/></span>}
   {row.parked&&<span className="m-row-flag"><Glyph d={HOURGLASS} label="Waiting"/></span>}
   <span className="m-row-when m-mono">{row.when}</span>
  </button>
 </li>;
}

/** What you can do to a session without opening it. Every change is shared with the desktop. */
function SessionActionsSheet({row,busy,showOpen,onOpen,onApply,onClose}){
 const {session}=row;
 return <div className="m-sheet-layer">
  <div className="m-backdrop" aria-hidden="true" onClick={onClose}/>
  <div className="m-sheet m-sheet-auto" role="dialog" aria-modal="true" aria-labelledby="m-session-actions">
   <span className="m-grabber" aria-hidden="true"/>
   <div className="m-actions-head">
    <h2 id="m-session-actions">{row.title}</h2>
    <p><span className={`m-dot is-${row.tone}`}/>{row.note&&<span className={`m-state is-${row.tone}`}>{row.note}</span>}<span>{row.note?' · ':''}{row.projectName}</span></p>
   </div>
   <div className="m-actions">
    {showOpen&&<button className="m-action m-press" disabled={busy} onClick={()=>onOpen(session)}><span className="m-action-icon is-accent"><TerminalIcon/></span><span className="m-action-text">Open terminal</span></button>}
    {session.finished&&<button className="m-action m-press" disabled={busy} onClick={()=>onApply(session,{acknowledged:true},'Marked as reviewed')}><span className="m-action-icon is-needs"><CheckIcon/></span><span className="m-action-text">Mark as reviewed</span></button>}
    <button className="m-action m-press" disabled={busy} aria-pressed={session.waiting} onClick={()=>onApply(session,{waiting:!session.waiting},session.waiting?'No longer waiting':'Marked as waiting')}>
     <span className="m-action-icon"><Glyph d={HOURGLASS} size={22}/></span>
     <span className="m-action-text">{session.waiting?'Stop waiting':'Mark as waiting'}<small>Quiet until the agent finishes, then it returns</small></span>
    </button>
    <button className="m-action m-press" disabled={busy} aria-pressed={session.muted} onClick={()=>onApply(session,{muted:!session.muted},session.muted?'Status colours shown':'Status colours muted')}>
     <span className="m-action-icon"><Glyph d={EYE_OFF} size={22}/></span>
     <span className="m-action-text">{session.muted?'Show status colours':'Mute status colours'}<small>Colours off; the real state is unchanged</small></span>
    </button>
   </div>
   <p className="m-actions-foot">Changes apply on the desktop too.</p>
  </div>
 </div>;
}
const PROJECT_GROUPS=[['active','Active'],['waiting','Waiting'],['shelved','Shelved']];
const plural=(count,word)=>`${count} ${word}${count===1?'':'s'}`;
function initials(name){const letters=name.replace(/[^\p{L}\p{N} ]/gu,' ').trim().split(/\s+/).slice(0,2).map(word=>word[0]).join('');return (letters||'?').toUpperCase();}
function since(iso,now=Date.now()){
 const days=Math.floor((now-Date.parse(iso))/86400000);
 if(days<1)return 'today';if(days===1)return 'yesterday';if(days<14)return `${days} days ago`;if(days<60)return `${Math.floor(days/7)} weeks ago`;return `${Math.floor(days/30)} months ago`;
}

/** Search every project — active, waiting and shelved — and start a new terminal in one. */
function NewSessionSheet({projects,sessions,starting,onStart,onClose}){
 const [query,setQuery]=useState('');
 const needle=query.trim().toLocaleLowerCase();
 const counts=new Map();for(const session of sessions)counts.set(session.projectId,(counts.get(session.projectId)||0)+1);
 const meta=project=>{
  const count=counts.get(project.id)||0;
  if(project.state==='shelved')return project.stateChangedAt?`Shelved ${since(project.stateChangedAt)}`:'Shelved';
  if(project.state==='waiting')return `Waiting · ${count?plural(count,'session'):'no sessions'}`;
  return count?plural(count,'session'):'No open sessions';
 };
 // Shelved projects follow the desktop shelf: most recently shelved first.
 const order=(a,b)=>a.state==='shelved'?(Date.parse(b.stateChangedAt||0)-Date.parse(a.stateChangedAt||0))||a.name.localeCompare(b.name):a.name.localeCompare(b.name);
 const groups=PROJECT_GROUPS.map(([key,label])=>({key,label,projects:projects.filter(project=>project.state===key&&(!needle||project.name.toLocaleLowerCase().includes(needle))).sort(order)})).filter(group=>group.projects.length);
 return <div className="m-sheet-layer">
  <div className="m-backdrop" aria-hidden="true" onClick={onClose}/>
  <div className="m-sheet" role="dialog" aria-modal="true" aria-labelledby="m-new-session">
   <span className="m-grabber" aria-hidden="true"/>
   <div className="m-sheet-head">
    <div><h2 id="m-new-session">New session</h2><p>Start a terminal in any project.</p></div>
    <button className="m-icon m-round m-press" onClick={onClose} aria-label="Close"><CloseIcon/></button>
   </div>
   <label className="m-search m-sheet-search"><SearchIcon/><input type="search" aria-label="Search all projects" placeholder="Search all projects" value={query} onChange={event=>setQuery(event.target.value)}/></label>
   <div className="m-sheet-list">
    {groups.map((group,groupIndex)=><section key={group.key} className="m-sheet-group m-rise" style={{'--i':groupIndex}} aria-label={group.label}>
     <h3>{group.label}<span className="m-mono">{group.projects.length}</span></h3>
     {group.projects.map(project=><button key={project.id} className={`m-project-row m-press is-${project.state}`} disabled={starting!==null} onClick={()=>onStart(project)}>
      <span className="m-tile m-mono" aria-hidden="true">{initials(project.name)}</span>
      <span className="m-project-body"><span className="m-project-name">{project.name}</span><span className="m-project-meta">{meta(project)}</span></span>
      {starting===project.id?<span className="m-starting">Starting…</span>:project.state==='shelved'?<span className="m-restore">Restore &amp; start</span>:<span className="m-plus" aria-hidden="true"><PlusIcon size={18}/></span>}
     </button>)}
    </section>)}
    {!groups.length&&<p className="m-sheet-empty">No projects match “{query.trim()}”</p>}
   </div>
  </div>
 </div>;
}

export default function MobileApp(){return <ToastProvider><Companion/></ToastProvider>;}
function Companion(){
 const [address,setAddress]=useState(()=>localStorage.getItem(SETTINGS)||'');
 const [instance,setInstance]=useState(null),[screen,setScreen]=useState('settings'),[status,setStatus]=useState('Not connected'),[error,setError]=useState('');
 const [projects,setProjects]=useState([]),[sessions,setSessions]=useState([]),[selected,setSelected]=useState(null);
 const [permission,setPermission]=useState('prompt'),[composer,setComposer]=useState(false),[draft,setDraft]=useState(''),[ctrl,setCtrl]=useState(false);
 const [search,setSearch]=useState(''),[scope,setScope]=useState('active'),[now,setNow]=useState(()=>Date.now());
 const [actionsFor,setActionsFor]=useState(null),[stateBusy,setStateBusy]=useState(false);
 const refreshing=useRef(false),stateBusyRef=useRef(false),refresh=useRef(null);
 const [alerts,setAlerts]=useState(false);
 const [sheetOpen,setSheetOpen]=useState(false),[starting,setStarting]=useState(null);
 const startingRef=useRef(null);
 const { showToast }=useToast();
 const [themeMode,setThemeModeState]=useState(getThemeMode),[resolvedTheme,setResolvedTheme]=useState(getResolvedTheme);
 const notificationEnabled=useRef(false),notificationInstance=useRef(null);
 const draftRef=useRef(draft);draftRef.current=draft;
 const terminal=useRef(null),api=useRef(null),keyboard=useRef(false),current=useRef({});
 const fail=err=>{setError(typeof err==='string'?err:err.message);};
 async function loadSessions(){
  refreshing.current=true;
  try {
   const all=[];let nextPage=0,more=true;
   while(more){
    const result=validatePage(await api.current.get(`/sessions?page=${nextPage}&size=100`),'sessions');
    all.push(...result.data);more=result.page.hasNextPage;nextPage+=1;
   }
   setSessions(all);setNow(Date.now());return all;
  }finally{refreshing.current=false;}
 }
 // Waiting, muted and reviewed are shared state: the list only changes once the backend confirms.
 async function applyState(session,patch,message){
  if(stateBusyRef.current)return;
  stateBusyRef.current=true;setStateBusy(true);setError('');
  try{
   const state=validateSessionState(await api.current.put(`/sessions/${encodeURIComponent(session.id)}/state`,patch),session.id);
   const merge=row=>row.id===session.id?{...row,finished:state.finished,muted:state.muted,waiting:state.waiting}:row;
   setSessions(rows=>rows.map(merge));setSelected(current=>current&&merge(current));
   setActionsFor(null);
   if(message)showToast({type:'success',message});
  }catch(err){fail(err);showToast({type:'error',message:`Could not update ${session.title}`});}
  finally{stateBusyRef.current=false;setStateBusy(false);}
 }
 async function loadProjects(){
  const all=[];let nextPage=0,more=true;
  while(more){const result=validatePage(await api.current.get(`/projects?page=${nextPage}&size=100`),'projects');all.push(...result.data);more=result.page.hasNextPage;nextPage+=1;}
  setProjects(all);return all;
 }
 async function startSession(project){
  // A ref, not state: two taps in the same frame must not both start a session.
  if(startingRef.current)return;
  startingRef.current=project.id;setStarting(project.id);setError('');
  try{
   const session=validateSession(await api.current.post(`/projects/${encodeURIComponent(project.id)}/sessions`));
   await Promise.all([loadProjects(),loadSessions()]);
   setSheetOpen(false);openSession(session);
   showToast({type:'success',message:project.state==='shelved'?`Restored ${project.name} and started ${session.title}`:`Started ${session.title}`});
  }catch(err){fail(err);showToast({type:'error',message:`Could not start a session in ${project.name}`});}
  finally{startingRef.current=null;setStarting(null);}
 }
 function openSession(session,identity=instance){
  if(selected?.incarnationId===session.incarnationId)terminal.current?.claimControl?.();
  setSelected(session);setDraft(localStorage.getItem(draftKey(identity.instanceId,session.incarnationId))||'');setComposer(false);setActionsFor(null);setScreen('terminal');
  // Opening finished work is looking at it — the same acknowledgement as clicking its pane on the desktop.
  if(session.finished)applyState(session,{acknowledged:true},null);
 }
 async function route(intent,identity=instance){
  if(!identity||!api.current)return;
  if(intent.instanceId!==identity.instanceId)throw new Error('This notification belongs to another instance.');
  const event=validateEvent(await api.current.get(`/events/${encodeURIComponent(intent.eventId)}`));
  if(event.instanceId!==identity.instanceId||event.id!==intent.eventId)throw new Error('Notification identity did not match.');
  if(event.kind==='test'){localStorage.removeItem(INTENT);setStatus('Test notification received');return;}
  if(event.status!=='active'){localStorage.removeItem(INTENT);throw new Error(event.status==='ended'?'This session has ended.':'This notification is no longer current.');}
  const result=validatePage(await api.current.get(`/sessions?id=${encodeURIComponent(event.sessionId)}&size=20`),'sessions');
  const session=result.data.find(row=>row.id===event.sessionId&&row.incarnationId===event.incarnationId);
  if(!session){localStorage.removeItem(INTENT);throw new Error('The original session has ended.');}
  openSession(session,identity);localStorage.removeItem(INTENT);
 }
 async function connect(){
  setError('');setStatus('Connecting…');
  try{
   const origin=normalizeInstanceUrl(address);api.current=createCompanionApi(origin);
   const capabilities=validateCapabilities(await api.current.get('/capabilities'));setInstance(capabilities);setAddress(origin);localStorage.setItem(SETTINGS,origin);
   await loadProjects();
   await loadSessions();setStatus('Connected');setScreen('sessions');
   notificationInstance.current=capabilities.instanceId;
   const stored=localStorage.getItem(`codedeck-mobile-notifications:${capabilities.instanceId}`);
   if(stored!==null&&stored!=='true'&&stored!=='false')throw new Error('Invalid stored notification preference.');
   notificationEnabled.current=stored==='true';setAlerts(notificationEnabled.current);
   restoreNotifications(notificationEnabled.current).then(value=>{setPermission(value);if(value==='denied')return register(null,value);}).catch(fail);
   const intent=localStorage.getItem(INTENT);if(intent)await route(JSON.parse(intent),capabilities);
  }catch(err){setStatus('Connection problem');fail(err);}
 }
 function notificationPreference(enabled){
  if(!notificationInstance.current)throw new Error('Connect before changing notifications.');
  notificationEnabled.current=enabled;setAlerts(enabled);
  localStorage.setItem(`codedeck-mobile-notifications:${notificationInstance.current}`,String(enabled));
 }
 async function unregister(){notificationPreference(false);await api.current.remove(`/devices/${installationId()}`);setPermission('prompt');}
 async function register(token,granted='granted'){
  if(granted==='granted'&&!notificationEnabled.current)return;
  if(!api.current)throw new Error('Connect before registering notifications.');
  await api.current.put(`/devices/${installationId()}`,{token,notificationsEnabled:granted==='granted',permission:granted});setPermission(granted);
 }
 async function notifications(){try{notificationPreference(true);const result=await enableNotifications();setPermission(result.permission);if(result.permission!=='granted'){notificationPreference(false);await register(null,result.permission);}}catch(err){fail(err);}}
 function toggleAlerts(){if(alerts)unregister().catch(fail);else notifications();}
 async function back(){
  if(keyboard.current){await hideKeyboard();return;}
  if(actionsFor){setActionsFor(null);return;}
  if(sheetOpen){setSheetOpen(false);return;}
  if(screen==='terminal'){setScreen('sessions');setSelected(null);}
  else if(screen==='settings'){if(instance)setScreen('sessions');}
  else setScreen('settings');
 }
 function chooseTheme(mode){setThemeMode(mode);setThemeModeState(mode);setResolvedTheme(getResolvedTheme());}
 current.current={route,register,back,fail};
 useEffect(()=>{
  let dispose=null,cancelled=false;
  watchNative({onRoute:intent=>{localStorage.setItem(INTENT,JSON.stringify(intent));current.current.route(intent).catch(current.current.fail);},onToken:token=>current.current.register(token).catch(current.current.fail),onBack:()=>current.current.back().catch(current.current.fail),onKeyboard:visible=>{keyboard.current=visible;},onError:message=>current.current.fail(message)}).then(fn=>{if(cancelled)fn();else dispose=fn;}).catch(fail);
  return ()=>{cancelled=true;dispose?.();};
 },[]);
 useEffect(()=>{if(localStorage.getItem(SETTINGS))connect();},[]);
 useEffect(()=>{
  const viewport=window.visualViewport;
  const resize=()=>document.documentElement.style.setProperty('--mobile-height',`${viewport?.height||window.innerHeight}px`);
  resize();viewport?.addEventListener('resize',resize);return ()=>viewport?.removeEventListener('resize',resize);
 },[]);
 useEffect(()=>{
  // "System" follows the OS; keep the header toggle and status-bar colour in step with it.
  const sync=event=>setResolvedTheme(event.detail==='light'?'light':'dark');
  window.addEventListener(THEME_CHANGE_EVENT,sync);return ()=>window.removeEventListener(THEME_CHANGE_EVENT,sync);
 },[]);
 useEffect(()=>{
  const meta=document.querySelector('meta[name="theme-color"]');
  if(meta)meta.setAttribute('content',getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()||meta.getAttribute('content'));
 },[resolvedTheme]);
 function send(data,onSent){if(ctrl&&data.length===1){data=String.fromCharCode(data.toUpperCase().charCodeAt(0)-64);setCtrl(false);}return terminal.current?.sendInput(data,onSent)===true;}
 function updateDraft(value){setDraft(value);localStorage.setItem(draftKey(instance.instanceId,selected.incarnationId),value);}
 refresh.current=()=>Promise.all([loadProjects(),loadSessions()]);
 useEffect(()=>{
  // The list keeps itself current while it is on screen; nothing to tap.
  if(screen!=='sessions'||!instance)return undefined;
  const tick=()=>{if(document.visibilityState!=='visible'||refreshing.current)return;refresh.current().catch(err=>current.current.fail(err));};
  const timer=setInterval(tick,REFRESH_MS);document.addEventListener('visibilitychange',tick);
  return ()=>{clearInterval(timer);document.removeEventListener('visibilitychange',tick);};
 },[screen,instance]);
 const connected=status==='Connected'||(instance&&status!=='Connection problem'&&status!=='Connecting…');
 const toggleThemeLabel=resolvedTheme==='dark'?'Switch to light mode':'Switch to dark mode';
 const errorBanner=error&&<div role="alert" className="m-error"><span>{error}</span><button className="m-press" onClick={()=>setError('')}>Dismiss</button></div>;
 const everyRow=buildNowView({sessions,projects,now,scope:'all',query:''}).groups.flatMap(group=>group.rows);
 const actionsRow=actionsFor&&everyRow.find(row=>row.key===actionsFor);
 const actionsSheet=actionsRow&&<SessionActionsSheet row={actionsRow} busy={stateBusy} showOpen={screen!=='terminal'} onOpen={openSession} onApply={applyState} onClose={()=>setActionsFor(null)}/>;

 if(screen==='terminal'&&selected){
  // A session started seconds ago may not be in the list yet; it is still described by what the start returned.
  const selectedRow=everyRow.find(row=>row.key===selected.incarnationId)??buildNowView({sessions:[selected],projects,now,scope:'all',query:''}).groups[0].rows[0];
  return <main className="mobile-app m-terminal-screen">
  <header className="m-bar">
   <button className="m-icon m-press" onClick={()=>back().catch(fail)} aria-label="Back to sessions"><BackIcon/></button>
   <div className="m-term-title m-rise">
    <h1>{selected.title}</h1>
    <p className="m-mono"><span className={`m-dot is-${selectedRow.tone}`}/><span className={`m-state is-${selectedRow.tone}`}>{selectedRow.note||'Idle'}</span> · {selectedRow.projectName} · {hostLabel(selected.host)}</p>
   </div>
   <button className="m-icon m-press" onClick={()=>setActionsFor(selected.incarnationId)} aria-label="Session options" aria-haspopup="dialog"><MoreIcon/></button>
   <button className="m-icon m-press" onClick={()=>chooseTheme(resolvedTheme==='dark'?'light':'dark')} aria-label={toggleThemeLabel}>{resolvedTheme==='dark'?<SunIcon/>:<MoonIcon/>}</button>
  </header>
  {errorBanner}
  <div className="mobile-terminal m-rise m-d1"><Terminal key={selected.incarnationId} ref={terminal} sessionId={selected.id} incarnationId={selected.incarnationId} cwd={selected.cwd} host={selected.host} runtimeType={selected.runtimeType} instanceUrl={address} isVisible isActivePane claimOnOpen mobile/></div>
  {composer&&<div className="m-composer m-rise"><textarea aria-label="Prompt" rows={2} value={draft} onChange={e=>updateDraft(e.target.value)} placeholder="Write a prompt. Send when ready."/><button className="m-send m-press" aria-label="Send prompt" disabled={!draft} onClick={()=>{const submitted=draft;const delivered=()=>{if(draftRef.current===submitted)updateDraft('');};try{if(terminal.current?.sendComposer(draft,delivered))delivered();}catch(err){fail(err);}}}><SendIcon/></button></div>}
  {ctrl&&<div className="m-keys m-rise">{'ACDRUZ'.split('').map(key=><button key={key} className="m-key m-press" onClick={()=>send(key)}>Ctrl+{key}</button>)}</div>}
  <div className="m-keys">{keys.map(([label,data])=><button key={label} className="m-key m-press" onClick={()=>send(data)}>{label}</button>)}</div>
  <div className="m-toggles">
   <button className="m-toggle m-press" aria-pressed={ctrl} onClick={()=>setCtrl(!ctrl)}><CtrlIcon/>Ctrl</button>
   <button className="m-toggle m-press" onClick={()=>{terminal.current?.focus();(keyboard.current?hideKeyboard():showKeyboard()).catch(fail);}}><KeyboardIcon/>Keyboard</button>
   <button className="m-toggle m-press" aria-pressed={composer} onClick={()=>setComposer(!composer)}><ComposeIcon/>Compose</button>
  </div>
  {actionsSheet}
 </main>;
 }

 if(screen==='sessions'){
  const view=buildNowView({sessions,projects,now,scope,query:search});
  const showingAll=scope==='all';
  let position=0;
  return <main className="mobile-app">
  <header className="m-bar">
   <button className="m-scope m-press" aria-pressed={showingAll} aria-label={showingAll?'Showing all sessions. Show active only':'Showing active sessions. Show all'} onClick={()=>setScope(showingAll?'active':'all')}><FilterIcon/>{showingAll?'All':'Active'}</button>
   <span className="m-bar-status m-mono">{status!=='Connected'&&status}</span>
   <button className="m-icon m-round m-press" onClick={()=>setScreen('settings')} aria-label="Settings"><SettingsIcon/></button>
  </header>
  {errorBanner}
  <section className="mobile-sessions" aria-label="Session picker">
   <div className="m-now m-rise"><h1 className={`is-${view.headlineTone}`}>{view.headline}</h1><p className={`is-${view.sublineTone}`}>{view.subline}</p></div>
   <div className="m-results" aria-live="polite">
    {view.groups.map((group,groupIndex)=><section key={group.label} className="m-now-group" aria-label={group.label}>
     {group.showLabel&&<h2 className="m-mono">{group.label}</h2>}
     <ul aria-label={groupIndex===0?'Sessions':`${group.label} sessions`}>{group.rows.map(row=><SessionRow key={row.key} row={row} index={position++} onOpen={openSession} onActions={target=>setActionsFor(target.key)}/>)}</ul>
    </section>)}
    {view.searching&&!view.groups.length&&<p className="m-now-empty">No sessions match “{search.trim()}”</p>}
    {!view.searching&&!sessions.length&&<p className="m-now-empty">Open a terminal on your desktop, or start one with +.</p>}
    {view.quietCount>0&&!showingAll&&<button className="m-more m-press" onClick={()=>setScope('all')}><span>{plural(view.quietCount,'quiet session')}</span><Icon d="M6 9l6 6 6-6" size={14} width={2.2}/></button>}
   </div>
   <div className="m-dock m-rise m-d3">
    <label className="m-search"><SearchIcon/><input type="search" aria-label="Search sessions and projects" placeholder="Search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    <button className="m-fab m-press" aria-label="New session" aria-haspopup="dialog" onClick={()=>setSheetOpen(true)}><PlusIcon/></button>
   </div>
  </section>
  {sheetOpen&&<NewSessionSheet projects={projects} sessions={sessions} starting={starting} onStart={startSession} onClose={()=>setSheetOpen(false)}/>}
  {actionsSheet}
 </main>;
 }

 const pushReady=isPushConfigured();
 return <main className="mobile-app">
  <header className="m-bar">
   {instance&&<button className="m-icon m-round m-press" onClick={()=>back().catch(fail)} aria-label="Back to sessions"><BackIcon/></button>}
   <span className="m-brand m-mono m-end"><span className={`m-dot ${connected?'is-running':''}`}/>CodeDeck · {status}</span>
  </header>
  {errorBanner}
  <section className="mobile-settings">
   <div className="m-heading m-rise"><h1>Settings</h1>{!instance&&<p>Your workspace, wherever you are.</p>}</div>
   <section className="m-panel m-rise m-d1" aria-labelledby="m-connection">
    <h2 id="m-connection">Connection</h2>
    <label className="m-field">Instance HTTPS address<input aria-label="Instance HTTPS address" className="m-mono" type="url" value={address} onChange={e=>setAddress(e.target.value)} placeholder="https://host.tailnet.ts.net" autoCapitalize="none" autoCorrect="off"/></label>
    <p className="m-help">Connect through Tailscale to the CodeDeck instance running on your host.</p>
    <button className="m-primary m-press" onClick={connect}>Connect</button>
   </section>
   <section className="m-panel m-rise m-d2" aria-labelledby="m-appearance">
    <h2 id="m-appearance">Appearance</h2>
    <div className="m-tabs m-tabs-3" role="group" aria-label="Appearance">{APPEARANCE.map(([mode,label])=><button key={mode} className="m-press" aria-pressed={themeMode===mode} onClick={()=>chooseTheme(mode)}>{label}</button>)}</div>
   </section>
   <section className="m-panel m-rise m-d3" aria-labelledby="m-notifications">
    <h2 id="m-notifications">Notifications</h2>
    <div className="m-switch-row">
     <span><span id="m-alerts-label" className="m-switch-title">Session alerts</span><span className="m-help">When a session finishes or needs your input</span></span>
     <button className="m-switch" role="switch" aria-checked={alerts} aria-labelledby="m-alerts-label" disabled={!instance||(!alerts&&!pushReady)} onClick={toggleAlerts}><span/></button>
    </div>
    <dl className="m-facts m-mono">
     <div><dt>Push configuration</dt><dd>{pushReady?'Ready':'Missing'}</dd></div>
     <div><dt>Permission</dt><dd>{permission}</dd></div>
     <div><dt>Delivery</dt><dd>{instance?.notificationsReady?'Available':'Not configured'}</dd></div>
    </dl>
    <button className="m-pill m-press" disabled={!instance?.notificationsReady||permission!=='granted'} onClick={()=>api.current.post(`/devices/${installationId()}/test-notification`).then(()=>setStatus('Test queued')).catch(fail)}>Test notification</button>
   </section>
  </section>
 </main>;
}
