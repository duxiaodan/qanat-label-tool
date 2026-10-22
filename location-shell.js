import {LOCATIONS,locationId} from './locations.js';
const selector=document.querySelector('#location-select'),status=document.querySelector('#location-status'),host=document.querySelector('#location-host');
const sessions=new Map();let auth=null,current=null,busy=false;
for(const [id,l] of Object.entries(LOCATIONS)){const o=document.createElement('option');o.value=id;o.textContent=l.name;selector.append(o);}
window.labelLocations={
 getSession:()=>auth,
 authenticated(id,bundle){if(!sessions.has(id))throw new Error('Unknown location session');auth=bundle;},
 ready(id){const s=sessions.get(id);if(s){s.ready=true;s.resolve();}},
 failed(id,message){const s=sessions.get(id);if(s)s.reject(new Error(message));},
};
function frame(id){
 if(sessions.has(id))return sessions.get(id);
 const el=document.createElement('iframe');el.className='location-panel loading';el.title=`${LOCATIONS[id].name} labeling`;el.src=`viewer.html?location=${id}${new URLSearchParams(location.search).get('gtreview')==='1'?'&gtreview=1':''}`;
 let resolve,reject;const loaded=new Promise((a,b)=>{resolve=a;reject=b;});
 const s={el,loaded,resolve,reject,ready:false};sessions.set(id,s);host.append(el);return s;
}
async function select(id){
 if(busy||id===current){selector.value=current||id;return;}
 busy=true;selector.disabled=true;const old=current;
 const prior=old?sessions.get(old):null;
 try{
  if(prior && !await prior.el.contentWindow.labelLocationSession.canLeave()){selector.value=old;return;}
  // Freeze the prior viewer after its save/discard guard, until the target commits.
  if(prior)prior.el.inert=true;
  status.textContent=`Loading ${LOCATIONS[id].name}…`;
  const next=frame(id);
  // Before initial login, show the selected gate. Subsequent switches commit only after full load.
  if(!auth&&!old){next.el.classList.remove('loading');current=id;selector.value=id;status.textContent='Unlock to label';}
  if (!auth && !old) await next.loaded;
  else { let timer; try { await Promise.race([next.loaded,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Location load timed out; current work is retained.')),120000);})]); } finally { clearTimeout(timer); } }
  for(const [key,s] of sessions)s.el.classList.toggle('loading',key!==id);
  current=id;selector.value=id;
  const url=new URL(location.href);url.searchParams.set('location',id);history.replaceState(null,'',url);
  document.title=`Qanat label tool · ${LOCATIONS[id].name} · TEST`;
  status.textContent=`${LOCATIONS[id].name} · ${LOCATIONS[id].crs} · TEST`;
  next.el.contentWindow.focus();
 }catch(e){
  status.textContent=e.message;selector.value=old||id;
  const failed=sessions.get(id);if(failed&&!failed.ready&&id!==old){failed.el.remove();sessions.delete(id);}
  current=old;
 }finally{if(prior)prior.el.inert=false;busy=false;selector.disabled=!auth;}
}
selector.addEventListener('change',()=>void select(selector.value));
window.addEventListener('beforeunload',e=>{if([...sessions.values()].some(s=>s.el.contentWindow.labelLocationSession?.hasUnsaved())){e.preventDefault();e.returnValue='';}});
let initial;try{initial=locationId(location.search);}catch(e){status.textContent=e.message;initial='erbil';}
void select(initial);
