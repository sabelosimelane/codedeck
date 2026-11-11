function text(value,name){if(typeof value!=='string'||!value.trim())throw new Error(`Invalid ${name}.`);return value;}
export function normalizeInstanceUrl(value){
 text(value,'instance address'); const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Use the instance HTTPS origin without a path or credentials.');
 return url.origin;
}
export function draftKey(instanceId,incarnationId){return `codedeck-draft:${text(instanceId,'instance identity')}:${text(incarnationId,'session incarnation')}`;}
const REQUIRED_CAPABILITIES=['session-start','project-state','session-state'];
export const PROJECT_STATES=['active','waiting','shelved'];
export function validateCapabilities(value){
 if(!value||value.protocolVersion!==2||typeof value.notificationsReady!=='boolean'||!Array.isArray(value.capabilities)||!REQUIRED_CAPABILITIES.every(name=>value.capabilities.includes(name)))throw new Error('This instance requires a compatible CodeDeck update.');
 text(value.instanceId,'instance identity');return value;
}
function validateProject(row){
 text(row.name,'project name');
 if(!PROJECT_STATES.includes(row.state))throw new Error('Invalid project state.');
 if(row.stateChangedAt!==null&&(typeof row.stateChangedAt!=='string'||Number.isNaN(Date.parse(row.stateChangedAt))))throw new Error('Invalid project state time.');
}
export function validateSession(row){
 if(!row)throw new Error('Invalid session.');
 for(const field of ['id','incarnationId','projectId','title','status','host','runtimeType'])text(row[field],`session ${field}`);
 if(row.cwd!==null)text(row.cwd,'session cwd');
 if(typeof row.live!=='boolean')throw new Error('Invalid session liveness.');
 for(const field of ['finished','muted','waiting','needsInput'])if(typeof row[field]!=='boolean')throw new Error(`Invalid session ${field} flag.`);
 activityTime(row.lastActivityAt);
 return row;
}
function activityTime(value){if(value!==null&&(!Number.isSafeInteger(value)||value<0))throw new Error('Invalid session activity time.');}
export function validateSessionState(value,sessionId){
 if(!value)throw new Error('Invalid session state.');
 if(text(value.sessionId,'session state identity')!==sessionId)throw new Error('Session state belongs to another session.');
 for(const field of ['finished','muted','waiting'])if(typeof value[field]!=='boolean')throw new Error(`Invalid session state ${field} flag.`);
 activityTime(value.lastActivityAt);
 return value;
}
export function validatePage(value,kind){
 if(!value||!Array.isArray(value.data)||!value.page)throw new Error('Invalid discovery response.');
 for(const key of ['currentPage','size','totalElements','totalPages'])if(!Number.isSafeInteger(value.page[key])||value.page[key]<0)throw new Error(`Invalid page ${key}.`);
 if(value.page.size<1||value.page.size>100||typeof value.page.hasNextPage!=='boolean')throw new Error('Invalid page boundary.');
 for(const row of value.data){
  if(!row)throw new Error('Invalid discovery row.');
  text(row.id,`${kind} identity`);
  if(kind==='projects')validateProject(row);
  else validateSession(row);
 }return value;
}
export function validateEvent(event){
 if(!event)throw new Error('Invalid notification event.');
 for(const field of ['id','instanceId','kind'])text(event[field],`event ${field}`);
 for(const field of ['sessionId','incarnationId']){
  if(event.kind==='test'){if(event[field]!==null)throw new Error(`Test event ${field} must be null.`);}
  else text(event[field],`event ${field}`);
 }
 if(!['active','ended','obsolete'].includes(event.status)||!Number.isSafeInteger(event.createdAt)||event.createdAt<0)throw new Error('Invalid notification event state.');return event;
}
export function createCompanionApi(address,request=fetch){
 const origin=normalizeInstanceUrl(address);
 async function call(path,options={}){
  const response=await request(`${origin}/api/mobile/v1${path}`,{...options,headers:{'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});
  if(response.ok&&response.status===204)return null;
  const body=await response.json();if(!response.ok)throw new Error(typeof body.message==='string'?body.message:`Connection failed (${response.status}).`);return body;
 }
 return {get:path=>call(path),put:(path,body)=>call(path,{method:'PUT',body:JSON.stringify(body)}),post:path=>call(path,{method:'POST',body:'{}'}),remove:path=>call(path,{method:'DELETE'})};
}
