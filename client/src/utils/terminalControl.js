const identity = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
function geometry(value) {
 if (!value || !Number.isInteger(value.cols) || value.cols < 2 || value.cols > 500 || !Number.isInteger(value.rows) || value.rows < 1 || value.rows > 300) throw new Error('Invalid terminal dimensions.');
}
function validateState(value) {
 geometry(value);
 if (!(value.controllerId === null || identity(value.controllerId)) || !Number.isSafeInteger(value.controlRevision) || value.controlRevision < 0) throw new Error('Invalid terminal control state.');
}
/** Commands live only within one socket generation. Nothing survives disconnect. */
export function createTerminalControl({dimensions,onState,onError}) {
 if ([dimensions,onState,onError].some(v=>typeof v!=='function')) throw new Error('Terminal control requires callbacks.');
 let ws=null, attachmentId=null, state=null, hydrated=false, pending=[], claimId=null, wantsClaim=false;
 const connected=()=>ws?.readyState===1 && attachmentId!==null;
 const controller=()=>connected() && state?.controllerId===attachmentId;
 function reset(){attachmentId=null;state=null;hydrated=false;pending=[];claimId=null;wantsClaim=false;}
 function send(value){try{ws.send(JSON.stringify(value));return true;}catch{pending=[];claimId=null;onError('Terminal send failed. Input was discarded; reconnect before retrying.');ws.close();return false;}}
 function claim(){
  if(!connected()) return false;
  wantsClaim=true;
  if(!hydrated || claimId) return false;
  if(controller()){wantsClaim=false;return true;}
  const size=dimensions(); geometry(size); claimId=crypto.randomUUID();
  send({type:'claim_control',requestId:claimId,...size});return false;
 }
 return {
  connect(socket){if(!socket || typeof socket.send!=='function') throw new Error('Terminal socket required.'); reset();ws=socket;},
  disconnect(){reset();ws=null;},
  session(value){validateState(value);if(!identity(value.attachmentId)) throw new Error('Invalid terminal attachment identity.');attachmentId=value.attachmentId;state=value;onState({...state,isController:controller()});},
  ready(){hydrated=true;if(wantsClaim)claim();},
  claim,
  input(data,onSent=()=>{}){
   if(typeof onSent!=='function')throw new Error('Input delivery callback required.');
   if(typeof data!=='string'||data.length===0||data.length>65536) throw new Error('Terminal input must contain 1–65536 characters.');
   if(!connected()){onError('Disconnected input was discarded.');return false;}
   if(controller() && hydrated){const sent=send({type:'input',data,controlRevision:state.controlRevision});if(sent)onSent();return sent;}
   if(pending.reduce((sum,x)=>sum+x.data.length,0)+data.length>65536){onError('Pending input is full; wait for control.');return false;}
   pending.push({data,onSent});claim();return false;
  },
  state(value){
   validateState(value);if(!state || value.controlRevision<state.controlRevision)return;
   state=value;onState({...state,isController:controller()});
   if(value.requestId===claimId){claimId=null;wantsClaim=false;const batch=pending;pending=[];
    if(controller())for(const {data,onSent} of batch){if(!send({type:'input',data,controlRevision:state.controlRevision}))break;onSent();}
    else onError('Control changed before input was sent. Input was discarded.');
   }else if(!controller() && pending.length && !claimId){pending=[];onError('Terminal input was discarded after control changed.');}
  },
  reject(message){pending=[];claimId=null;wantsClaim=false;onError(message);},
  resize(cols,rows){geometry({cols,rows});if(controller()&&hydrated)send({type:'resize',cols,rows,controlRevision:state.controlRevision});},
  isController:controller,
  revision:()=>controller()?state.controlRevision:null,
 };
}
