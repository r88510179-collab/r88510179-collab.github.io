// Pool Alerts on the Admin pages (Weekly Admin and Organizer Corrections). It changes nothing about publishing:
//  * After the page reports a publication or an official correction VERIFIED BY READ-BACK, it asks the alert service to
//    notify subscribers now, signed with the publisher's own Neon Auth session token. If that call cannot be made, the
//    alert service's hourly check sends the alert anyway, and the panel says so.
//  * For the signed-in publisher, a small panel: sender status, Notify now, Pause/Resume, Retry failed deliveries and a
//    test alert to this device.
import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';
import {apiFor} from '../push-client.mjs?v=2';
import {isVerifiedSuccess,describeStatus} from './pool-alerts-admin-core.js?v=1';
// Admin never runs on a Vercel preview: from there it would change the live pool (synthetic staging publications: nfl-pool/push/release.mjs staging-publish).
if(/^https:\/\/nfl-pool-personal-[a-z0-9-]{1,60}-r88510179-collabs-projects\.vercel\.app$/.test(globalThis.location?.origin??'')){document.body.textContent='Admin is switched off on preview deployments: from here it would change the live pool. Use Admin at picks.smokkeventures.com.';throw new Error('Admin is disabled on preview deployments');}

const NEON_AUTH_URL='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const NEON_DATA_URL='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
function deviceRecord(){
  return new Promise(resolve=>{
    try{
      const r=indexedDB.open('pool-alerts',1);
      r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv');if(!db.objectStoreNames.contains('alerts'))db.createObjectStore('alerts',{keyPath:'id'})};
      r.onsuccess=()=>{const db=r.result,g=db.transaction('kv').objectStore('kv').get('device');g.onsuccess=()=>{db.close();resolve(g.result||null)};g.onerror=()=>{db.close();resolve(null)}};
      r.onerror=()=>resolve(null);
    }catch{resolve(null)}
  });
}

export function bootPoolAlertsAdmin(doc=document,win=window){
  const api=apiFor(win.location.origin),message=doc.getElementById('message'),main=doc.querySelector('main');
  if(!message||!main)return;
  const neon=createClient({auth:{url:NEON_AUTH_URL},dataApi:{url:NEON_DATA_URL}});
  async function publisherToken(){
    try{const {data}=await neon.auth.getSession();const t=data?.session?.token;if(typeof t==='string'&&t.split('.').length===3)return t}catch{}
    try{const r=await win.fetch(NEON_AUTH_URL+'/token',{credentials:'include',headers:{Accept:'application/json'}});if(r.ok){const j=await r.json();if(typeof j?.token==='string'&&j.token.split('.').length===3)return j.token}}catch{}
    return null;
  }
  const panel=doc.createElement('section');panel.className='admin-card';panel.setAttribute('aria-label','Pool Alerts maintenance');
  panel.innerHTML='<div class="section-head"><div><h2>Pool Alerts</h2><p>Phone notifications for official picks. Subscribers are notified automatically after each verified publication or correction.</p></div></div>';
  const status=doc.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.className='muted';
  const details=doc.createElement('ul');details.className='muted';
  const row=doc.createElement('div');row.className='row-actions';
  const button=(label,cls='ghost')=>{const b=doc.createElement('button');b.type='button';b.className=cls;b.textContent=label;b.style.minHeight='44px';row.append(b);return b};
  const notify=button('Notify subscribers now','primary'),refresh=button('Refresh status'),pause=button('Pause sending'),resume=button('Resume sending'),retry=button('Retry failed deliveries'),test=button('Test alert to this device');
  panel.append(status,details,row);
  main.append(panel);
  const say=t=>{status.textContent=t};
  if(!api){say('Pool Alerts is not configured for this site.');row.hidden=true;return}

  async function owner(path,{method='POST',body={}}={}){
    const token=await publisherToken();
    if(!token)throw Object.assign(Error('sign in'),{signIn:true});
    const r=await win.fetch(api+path,{method,credentials:'omit',headers:{Authorization:'Bearer '+token,...(method==='POST'?{'Content-Type':'application/json'}:{})},
      body:method==='POST'?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});
    let data=null;try{data=await r.json()}catch{}
    if(!r.ok)throw Object.assign(Error('status '+r.status),{status:r.status,data});
    return data;
  }
  async function showStatus(){
    try{const s=await owner('/v1/owner/status',{method:'GET'});details.replaceChildren(...describeStatus(s).map(t=>{const li=doc.createElement('li');li.textContent=t;return li}));say('')}
    catch(e){details.replaceChildren();say(e.signIn?'Sign in above to manage Pool Alerts.':e.status===401?'This account is not allowed to manage Pool Alerts.':'The alert service could not be reached. Alerts still go out from its hourly check once it is back.')}
  }
  async function dispatch(reason){
    say(reason+' Notifying subscribers…');
    try{
      const r=await owner('/v1/dispatch');
      say(r.paused?'Sending is paused, so no alert was sent. Resume sending to deliver it (alerts older than 24 hours are skipped).'
        :'Subscribers notified: '+r.sent+' delivered'+(r.retrying?', '+r.retrying+' will retry automatically':'')+(r.failed?', '+r.failed+' failed':'')+'.');
    }catch(e){
      say(e.signIn?'Sign in to notify subscribers now; otherwise the hourly check sends the alert.':'Could not reach the alert service now. Its hourly check will send the alert; you can also tap Notify subscribers now.');
    }
    showStatus();
  }
  const guard=fn=>async()=>{for(const b of row.querySelectorAll('button'))b.disabled=true;try{await fn()}finally{for(const b of row.querySelectorAll('button'))b.disabled=false}};
  notify.addEventListener('click',guard(()=>dispatch('')));
  refresh.addEventListener('click',guard(showStatus));
  pause.addEventListener('click',guard(async()=>{try{await owner('/v1/owner/pause',{body:{note:'paused from Admin'}});say('Sending paused. Publications are still recorded; nothing is sent until you resume.')}catch{say('Could not pause sending.')}showStatus()}));
  resume.addEventListener('click',guard(async()=>{try{await owner('/v1/owner/resume',{body:{note:'resumed from Admin'}});say('Sending resumed.')}catch{say('Could not resume sending.')}showStatus()}));
  retry.addEventListener('click',guard(async()=>{try{const r=await owner('/v1/owner/retry-failed');say(r.reset.deliveries?'Retried '+r.reset.deliveries+' failed deliveries.':'No failed delivery is eligible for a retry.')}catch{say('Could not retry failed deliveries.')}showStatus()}));
  test.addEventListener('click',guard(async()=>{
    const device=await deviceRecord();
    if(!device?.id||device.api!==api){say('This device has no alerts. Turn alerts on from the Pool Center Home page first, then test here.');return}
    try{const r=await owner('/v1/owner/test',{body:{subscriptionId:device.id}});say(r.delivered?'Test alert delivered to this device\'s push service. It should appear within a few seconds.':'The push service refused the test alert (status '+r.status+').')}
    catch(e){say(e.status===409?'Sending is switched off for this deployment.':e.status===404?'The alert service does not know this device any more. Turn alerts off and on again on the Home page.':'Could not send the test alert.')}
  }));

  // Automatic dispatch: once per verified success message.
  let last='';
  new win.MutationObserver(()=>{
    const text=message.textContent||'';
    if(message.hidden||text===last||!isVerifiedSuccess(message.className,text))return;
    last=text;
    void dispatch('Publication verified.');
  }).observe(message,{attributes:true,attributeFilter:['class','hidden'],childList:true,characterData:true,subtree:true});
  showStatus();
}

if(typeof document!=='undefined')bootPoolAlertsAdmin();
