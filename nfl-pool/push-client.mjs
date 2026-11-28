// Pool Alerts phone notifications (Home card). Opt-in Web Push for this device: no account, no name, no e-mail. The
// device's private management credentials and the log of alerts it received stay in this browser (IndexedDB, shared
// with the service worker); the sender stores only the push address, a hash of the credential and the preference.
//
// Each Pool Center site has exactly one alert service; a site without one never contacts any.
export const PRODUCTION_ALERT_API='https://br-late-hat-b55ygmj4-poolalerts.compute.c-7.us-east-2.aws.neon.tech';
export const ALERT_APIS=Object.freeze({
  'https://r88510179-collab.github.io':PRODUCTION_ALERT_API,
  'https://picks.smokkeventures.com':PRODUCTION_ALERT_API
});
// Vercel preview deployments of this site (owner-only, behind Vercel Authentication) use the isolated staging sender,
// so a preview can never enroll a device into production alerts. The staging sender accepts only the origins it lists.
export const STAGING_ALERT_API='https://br-rough-smoke-bccichyp-poolalerts.compute.c-16.us-east-1.aws.neon.tech';
const PREVIEW_ORIGIN=/^https:\/\/nfl-pool-personal-[a-z0-9-]{1,60}-r88510179-collabs-projects\.vercel\.app$/;
export const apiFor=origin=>Object.prototype.hasOwnProperty.call(ALERT_APIS,origin)?ALERT_APIS[origin]
  :(typeof origin==='string'&&PREVIEW_ORIGIN.test(origin)?STAGING_ALERT_API:null);
const CHECK_INTERVAL_MS=24*3600*1000;
const ICON='/nfl-pool/assets/pool-alerts-icon-192.png',BADGE='/nfl-pool/assets/pool-alerts-badge-96.png';

// A device's short code (the first 8 base32 characters of SHA-256 of its id, as XXXX-XXXX), the same one the alert
// service computes (push/core.mjs deviceCodeFromDigest), so the owner can tell which phone is which in a device check.
const BASE32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export async function deviceCode(id,subtle=globalThis.crypto?.subtle){
  if(typeof id!=='string'||!id||!subtle)return null;
  const bytes=new Uint8Array(await subtle.digest('SHA-256',new TextEncoder().encode(id)));
  let bits=0,value=0,out='';
  for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5&&out.length<8){out+=BASE32[(value>>>(bits-5))&31];bits-=5}if(out.length>=8)break}
  return out.slice(0,4)+'-'+out.slice(4,8);
}

export function decodeVapid(key){
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]+$/.test(key))throw Error('Invalid public key');
  const raw=atob(key.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(key.length/4)*4,'='));
  const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(bytes.length!==65||bytes[0]!==4)throw Error('Invalid public key');
  return bytes;
}
const sameBytes=(a,b)=>{if(!a||!b)return false;const x=new Uint8Array(a),y=new Uint8Array(b);return x.length===y.length&&x.every((v,i)=>v===y[i])};

// ------------------------------------------------------------------------------------------------------------------
// This browser's alert store (IndexedDB 'pool-alerts': 'kv' holds the device record, 'alerts' what arrived).
// ------------------------------------------------------------------------------------------------------------------
export function createDeviceStore(idb=globalThis.indexedDB){
  const open=()=>new Promise((resolve,reject)=>{
    const r=idb.open('pool-alerts',1);
    r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv');if(!db.objectStoreNames.contains('alerts'))db.createObjectStore('alerts',{keyPath:'id'})};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  const run=(name,mode,fn)=>open().then(db=>new Promise((resolve,reject)=>{
    const t=db.transaction(name,mode),r=fn(t.objectStore(name));
    t.oncomplete=()=>{db.close();resolve(r?.result)};t.onerror=t.onabort=()=>{db.close();reject(t.error)};
  }));
  return{
    getDevice:()=>run('kv','readonly',s=>s.get('device')),
    setDevice:value=>run('kv','readwrite',s=>s.put(value,'device')),
    deleteDevice:()=>run('kv','readwrite',s=>s.delete('device')),
    listAlerts:()=>run('alerts','readonly',s=>s.getAll()).then(list=>(list||[]).sort((a,b)=>b.receivedAt-a.receivedAt)),
    markOpened:async({season,week,revision})=>{
      const list=await run('alerts','readonly',s=>s.getAll())||[];
      const hit=list.filter(a=>a.season===season&&a.week===week&&a.revision<=revision&&!a.openedAt);
      if(hit.length)await run('alerts','readwrite',s=>{for(const a of hit)s.put({...a,openedAt:Date.now()})});
      return hit.length;
    }
  };
}

// ------------------------------------------------------------------------------------------------------------------
// What this browser can do.
// ------------------------------------------------------------------------------------------------------------------
export function platformOf(win){
  const nav=win.navigator||{},ua=nav.userAgent||'';
  if(/iP(hone|od|ad)/.test(ua)||(/Macintosh/.test(ua)&&nav.maxTouchPoints>1))return 'ios';
  return /Android/.test(ua)?'android':'desktop';
}
export function isStandalone(win){try{return win.matchMedia?.('(display-mode: standalone)')?.matches===true||win.navigator?.standalone===true}catch{return false}}
export function support(win){
  const platform=platformOf(win),standalone=isStandalone(win);
  if(!win.isSecureContext)return{ok:false,reason:'insecure',platform,standalone};
  if(!win.navigator||!('serviceWorker' in win.navigator))return{ok:false,reason:platform==='ios'&&!standalone?'ios-install':'no-service-worker',platform,standalone};
  if(!('PushManager' in win)||!('Notification' in win))return{ok:false,reason:platform==='ios'&&!standalone?'ios-install':'no-push',platform,standalone};
  return{ok:true,platform,standalone};
}

const UNBLOCK={
  ios:'On iPhone or iPad: open Settings, then Notifications, then Pool Center, and turn on Allow Notifications. Then come back here.',
  android:'On Android: in Chrome tap ⋮, then Settings, Site settings, Notifications, choose this site and Allow. For the installed app, press and hold the Pool Center icon, tap App info, then Notifications.',
  desktop:'On a computer: click the icon at the left of the address bar, set Notifications to Allow, and reload.'
};
export const MESSAGES=Object.freeze({
  checking:'Checking this device…',
  unconfigured:'Phone alerts are not switched on for this site yet.',
  'ios-install':'On iPhone or iPad, alerts work from the Home Screen app: tap Share, then Add to Home Screen, then open Pool Center from your Home Screen and turn alerts on there.',
  'no-push':'This browser cannot receive alerts. Use Chrome or Edge on Android or a computer, Safari on a Mac, or the Home Screen app on iPhone (iOS 16.4 or later).',
  'no-service-worker':'This browser cannot receive alerts. Update it, or use Chrome on Android or the Home Screen app on iPhone.',
  insecure:'Alerts need a secure (https) connection.',
  unavailable:'The alert service cannot be reached right now. Try again in a little while.',
  off:'Get a notification on this device when official picks are posted, even when Pool Center is closed. No account needed.',
  on:'Alerts are on for this device.',
  denied:'Notifications are blocked for Pool Center on this device.'
});

// ------------------------------------------------------------------------------------------------------------------
// The device panel.
// ------------------------------------------------------------------------------------------------------------------
function el(doc,tag,props={},children=[]){
  const node=doc.createElement(tag);
  for(const [k,v] of Object.entries(props)){if(k==='dataset')Object.assign(node.dataset,v);else if(k in node)node[k]=v;else node.setAttribute(k,v)}
  node.append(...children);
  return node;
}
function helpSection(doc,platform){
  const block=(heading,steps,note)=>[el(doc,'h4',{textContent:heading}),el(doc,'ol',{},steps.map(s=>el(doc,'li',{textContent:s}))),...(note?[el(doc,'p',{textContent:note})]:[])];
  const blocked=text=>'If you blocked notifications: '+text.replace(/^On (iPhone or iPad|Android|a computer): /,'');
  const android=block('Android (Chrome)',['Open Pool Center in Chrome.','Tap Turn on alerts, then Allow.','Optional: tap ⋮ then Install app (or Add to Home screen) for a Pool Center icon.'],blocked(UNBLOCK.android));
  const ios=block('iPhone or iPad (iOS 16.4 or later)',['Open Pool Center in Safari.','Tap Share, then Add to Home Screen, then Add.','Open Pool Center from the new Home Screen icon (alerts do not work in a Safari tab).','Tap Turn on alerts, then Allow.'],blocked(UNBLOCK.ios));
  const desktop=block('Computer (Chrome, Edge, Firefox or Safari)',['Tap Turn on alerts, then Allow.','Alerts arrive while the browser is running, even with Pool Center closed.'],blocked(UNBLOCK.desktop));
  const order=platform==='ios'?[ios,android,desktop]:platform==='android'?[android,ios,desktop]:[desktop,android,ios];
  const install=el(doc,'button',{type:'button',className:'dash-tool',textContent:'Install Pool Center',hidden:true});
  install.setAttribute('data-install-app','');
  return el(doc,'details',{className:'pa-section pa-details pa-help',dataset:{paHelp:''}},[
    el(doc,'summary',{textContent:'How to get alerts on your phone'}),...order.flat(),
    el(doc,'p',{textContent:'Alerts say only which week\'s official picks were posted or corrected: no names, picks or standings appear on your lock screen. Pool Center keeps no account for alerts; turning them off deletes this device\'s alert record.'}),
    install
  ]);
}

export async function bootPush(doc=globalThis.document,win=globalThis,{api=apiFor(win.location?.origin),store,fetcher,now=()=>Date.now(),readyTimeoutMs=10000}={}){
  const card=doc.querySelector('[aria-label="Pool Alerts"]');
  if(!card)return null;
  let body=card.querySelector('.pa-body');
  if(!body){body=el(doc,'div',{className:'pa-body'});card.append(body)}
  const can=support(win);
  const status=el(doc,'p',{className:'pa-status',role:'status','aria-live':'polite',textContent:MESSAGES.checking});
  const explain=el(doc,'p',{className:'pa-muted'});
  const toggle=el(doc,'button',{type:'button',className:'dash-tool pa-primary',textContent:'Turn on alerts',hidden:true});
  const test=el(doc,'button',{type:'button',className:'dash-tool',textContent:'Send a test alert',hidden:true});
  const correctionsBox=el(doc,'input',{type:'checkbox',checked:true});
  const corrections=el(doc,'label',{className:'pa-check',hidden:true},[correctionsBox,doc.createTextNode('Also alert me when official picks are corrected')]);
  const invite=el(doc,'input',{type:'text',className:'pa-input',autocomplete:'off',placeholder:'Invitation code',hidden:true,'aria-label':'Invitation code',maxLength:128});
  const checkCode=el(doc,'p',{className:'pa-muted'});
  const checkButton=el(doc,'button',{type:'button',className:'dash-tool',textContent:'Ask for a device check'});
  const checkSection=el(doc,'details',{className:'pa-section pa-details',hidden:true,dataset:{paDeviceCheck:''}},[
    el(doc,'summary',{textContent:'Device check'}),
    el(doc,'p',{className:'pa-muted',textContent:'Lets the pool owner send test alerts to this device for the next 24 hours, to confirm alerts reach it even with Pool Center closed. Nothing else is shared.'}),
    checkCode,el(doc,'div',{className:'pa-row'},[checkButton])]);
  const log=el(doc,'ul',{className:'pa-list'});
  const logSection=el(doc,'details',{className:'pa-section pa-details',hidden:true,dataset:{paDeviceLog:''}},[el(doc,'summary',{textContent:'Alerts on this device'}),log]);
  const panel=el(doc,'section',{className:'pa-section',dataset:{paDevice:''},'aria-label':'Phone alerts'},[
    el(doc,'h3',{textContent:'Phone alerts'}),status,explain,corrections,invite,el(doc,'div',{className:'pa-row'},[toggle,test])]);
  body.append(panel,checkSection,logSection,helpSection(doc,can.platform));
  const say=(text,tone='')=>{status.textContent=text;status.className='pa-status'+(tone?' pa-'+tone:'')};
  const state={phase:'checking',device:null,subscription:null,publicKey:null,api};
  const fromHash=(()=>{try{return new URLSearchParams((win.location?.hash||'').slice(1)).get('alerts-invite')}catch{return null}})();
  if(fromHash)invite.value=fromHash.slice(0,128);

  function render(){
    const on=state.phase==='on',busy=state.phase==='busy';
    toggle.hidden=!['on','off','denied'].includes(state.phase)&&!busy;
    toggle.textContent=on?'Turn off alerts':'Turn on alerts';
    toggle.disabled=busy;
    toggle.className='dash-tool'+(on?'':' pa-primary');
    test.hidden=!on;test.disabled=busy;
    checkSection.hidden=!on;checkButton.disabled=busy;
    if(on&&state.device?.id)void deviceCode(state.device.id,win.crypto?.subtle).then(code=>{if(code&&state.device)checkCode.textContent='This device\'s code: '+code}).catch(()=>{});
    corrections.hidden=!['on','off'].includes(state.phase)&&!busy;
    correctionsBox.disabled=busy;
    if(on)correctionsBox.checked=state.device?.corrections!==false;
    explain.textContent=on?(correctionsBox.checked?'You will be notified when official picks are posted and when they are corrected.':'You will be notified when official picks are posted.')
      :state.phase==='off'?'Works on Android, on iPhone and iPad from the Home Screen app, and on computers. Turn alerts off here at any time.':'';
  }
  async function refreshLog(){
    if(!store)return;
    let alerts=[];try{alerts=(await store.listAlerts()).slice(0,10)}catch{}
    logSection.hidden=!alerts.length;
    log.replaceChildren(...alerts.map(a=>{
      const label=a.kind==='test'?'Test alert':'Week '+a.week+' · revision '+a.revision+(a.kind==='correction'?' · correction':'');
      const when=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(a.receivedAt));
      const name=a.kind==='test'?el(doc,'span',{textContent:label}):el(doc,'a',{href:'./?view=picks&season='+a.season+'&week='+a.week,textContent:label});
      if(!a.openedAt&&a.kind!=='test')name.append(el(doc,'span',{className:'pa-tag',textContent:'Unread'}));
      return el(doc,'li',{},[name,el(doc,'small',{textContent:'Received '+when})]);
    }));
  }
  doc.addEventListener('poolalerts:seen',async event=>{try{if(store&&await store.markOpened(event.detail))refreshLog()}catch{}});

  const call=async(path,payload)=>{
    const response=await (fetcher||win.fetch.bind(win))(api+path,{method:payload?'POST':'GET',credentials:'omit',cache:'no-store',redirect:'error',
      headers:payload?{'Content-Type':'application/json'}:{},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(15000)});
    let data=null;try{data=await response.json()}catch{}
    return{status:response.status,ok:response.ok,data};
  };
  async function saveDevice(record){state.device=record;try{await store?.setDevice(record)}catch{}}
  async function forgetDevice(){state.device=null;try{await store?.deleteDevice()}catch{}}

  // Enroll (or re-enroll) this browser's push subscription. Returns true when the device is on.
  async function enroll(sub,{silent=false}={}){
    const result=await call('/v1/subscribe',{subscription:sub.toJSON(),corrections:correctionsBox.checked,platform:can.platform,...(invite.value.trim()?{inviteCode:invite.value.trim()}:{})});
    if(result.ok&&result.data?.id&&result.data?.token){
      await saveDevice({api,id:result.data.id,token:result.data.token,endpoint:sub.endpoint,corrections:result.data.corrections!==false,enrolledAt:now(),checkedAt:now()});
      invite.hidden=true;
      return true;
    }
    const error=result.data?.error;
    if(!silent){
      if(error==='invite-required'){invite.hidden=false;say('This pool needs an invitation code for alerts. Enter the code from the pool owner, then tap Turn on alerts again.','warn');invite.focus?.()}
      else if(error==='enrollment-closed')say('New alert sign-ups are closed right now.','warn');
      else if(result.status===429||result.status===503)say('Alert sign-ups are busy right now. Try again later.','warn');
      else say('Alerts could not be turned on. Check your connection and try again.','bad');
    }
    return false;
  }

  if(!api){state.phase='unavailable';say(MESSAGES.unconfigured);render();return state}
  if(!can.ok){state.phase='unsupported';say(MESSAGES[can.reason]);render();return state}
  const reg=await Promise.race([win.navigator.serviceWorker.ready,new Promise(resolve=>win.setTimeout(()=>resolve(null),readyTimeoutMs))]);
  if(!reg){state.phase='unsupported';say('Reload Pool Center to finish setting up alerts on this device.');render();return state}
  try{state.device=await store?.getDevice()||null}catch{state.device=null}
  if(state.device&&state.device.api!==api)state.device=null;
  try{state.subscription=await reg.pushManager.getSubscription()}catch{state.subscription=null}
  refreshLog();
  try{
    const config=await call('/v1/config');
    if(config.ok&&typeof config.data?.publicKey==='string'){decodeVapid(config.data.publicKey);state.publicKey=config.data.publicKey}
  }catch{}

  async function settle(){
    const permission=win.Notification.permission,sub=state.subscription,device=state.device;
    // A subscription made with another key (the service rotated its key) cannot receive this service's alerts.
    if(sub&&state.publicKey&&sub.options?.applicationServerKey&&!sameBytes(sub.options.applicationServerKey,decodeVapid(state.publicKey).buffer)){
      try{await sub.unsubscribe()}catch{}
      state.subscription=null;
      if(device){try{await call('/v1/unsubscribe',{id:device.id,token:device.token})}catch{};await forgetDevice()}
      return settle();
    }
    if(permission==='denied'){
      state.phase='denied';say(MESSAGES.denied+' '+UNBLOCK[can.platform],'warn');
      if(sub&&device){try{await call('/v1/unsubscribe',{id:device.id,token:device.token})}catch{};try{await sub.unsubscribe()}catch{};state.subscription=null;await forgetDevice()}
      return;
    }
    if(!state.publicKey&&!(sub&&device)){state.phase='unavailable';say(MESSAGES.unavailable,'warn');return}
    if(sub&&device&&device.endpoint===sub.endpoint){
      state.phase='on';say(MESSAGES.on,'good');
      if(now()-(device.checkedAt||0)>CHECK_INTERVAL_MS){
        try{
          const check=await call('/v1/check',{id:device.id,token:device.token,endpoint:sub.endpoint});
          if(check.ok&&check.data?.state==='active')await saveDevice({...device,checkedAt:now(),corrections:check.data.corrections!==false});
          else if(check.ok&&check.data?.state==='endpoint-changed'){
            const r=await call('/v1/preferences',{id:device.id,token:device.token,subscription:sub.toJSON()});
            if(r.ok)await saveDevice({...device,endpoint:sub.endpoint,checkedAt:now()});
          }else if(check.ok&&permission==='granted'){
            // The alert service no longer knows this device (expired, or restored from an older backup): enroll again.
            if(!await enroll(sub,{silent:true})){state.phase='off';say(MESSAGES.off)}
          }
        }catch{}
      }
      return;
    }
    if(sub&&device&&device.endpoint!==sub.endpoint&&permission==='granted'){
      const r=await call('/v1/preferences',{id:device.id,token:device.token,subscription:sub.toJSON()}).catch(()=>null);
      if(r?.ok){await saveDevice({...device,endpoint:sub.endpoint,checkedAt:now()});state.phase='on';say(MESSAGES.on,'good');return}
    }
    if(sub&&!device&&permission==='granted'&&state.publicKey){
      // This browser is subscribed but lost its credentials (site data cleared): the same endpoint and keys re-enroll.
      if(await enroll(sub,{silent:true})){state.phase='on';say(MESSAGES.on,'good');return}
    }
    if(!sub&&device){try{await call('/v1/unsubscribe',{id:device.id,token:device.token})}catch{};await forgetDevice()}
    state.phase='off';say(MESSAGES.off);
  }
  await settle().catch(()=>{state.phase='off';say(MESSAGES.off)});
  render();

  toggle.addEventListener('click',async()=>{
    if(state.phase==='busy')return;
    const wasOn=state.phase==='on';
    state.phase='busy';render();
    try{
      if(wasOn){
        const device=state.device,sub=state.subscription;
        let removed=false;
        try{removed=device?(await call('/v1/unsubscribe',{id:device.id,token:device.token})).ok:true}catch{}
        try{await sub?.unsubscribe()}catch{}
        state.subscription=null;await forgetDevice();
        state.phase='off';say(removed?'Alerts are off for this device.':'Alerts are off for this device. (The alert service was unreachable; it will stop on its own.)','good');
        return;
      }
      // Ask permission first, directly from the tap (iOS requires the user gesture).
      const permission=win.Notification.permission==='granted'?'granted':await win.Notification.requestPermission();
      if(permission!=='granted'){
        state.phase=permission==='denied'?'denied':'off';
        say(permission==='denied'?MESSAGES.denied+' '+UNBLOCK[can.platform]:'Notifications were not allowed. Tap Turn on alerts to try again.','warn');
        return;
      }
      if(!state.publicKey){state.phase='off';say(MESSAGES.unavailable,'warn');return}
      let sub=state.subscription,created=false;
      if(!sub){sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeVapid(state.publicKey)});created=true}
      let enrolled=await enroll(sub);
      if(!enrolled&&created){try{await sub.unsubscribe()}catch{};sub=null}
      state.subscription=enrolled?sub:sub&&!created?sub:null;
      state.phase=enrolled?'on':'off';
      if(enrolled)say(MESSAGES.on,'good');
      if(enrolled&&checkLink){checkSection.open=true;render();void requestCheck()}
    }catch(error){
      state.phase=state.device&&state.subscription?'on':'off';
      say(error?.name==='NotAllowedError'?MESSAGES.denied+' '+UNBLOCK[can.platform]:'Alerts could not be changed. Check your connection and try again.','bad');
    }finally{render()}
  });

  correctionsBox.addEventListener('change',async()=>{
    if(state.phase!=='on'||!state.device)return render();
    const wanted=correctionsBox.checked,device=state.device;
    state.phase='busy';render();
    try{
      const r=await call('/v1/preferences',{id:device.id,token:device.token,corrections:wanted});
      if(!r.ok)throw Error('preferences');
      await saveDevice({...device,corrections:wanted});
      say(wanted?'Correction alerts are on.':'Correction alerts are off. You will still be told when official picks are posted.','good');
    }catch{correctionsBox.checked=!wanted;say('That change could not be saved. Try again.','bad')}
    finally{state.phase='on';render()}
  });

  // The device asks to be listed for the owner's device checks (24 hours). Also asked once, automatically, when Pool
  // Center was opened from a check link (…#alerts-check) and alerts are on.
  async function requestCheck(){
    const device=state.device;
    if(state.phase!=='on'||!device)return false;
    checkButton.disabled=true;
    try{
      const r=await call('/v1/check-request',{id:device.id,token:device.token,platform:can.platform});
      const code=r.data?.code||await deviceCode(device.id,win.crypto?.subtle);
      if(r.ok){say('Device check requested for '+code+'. Close Pool Center now; the owner\'s test alerts will arrive here.','good');return true}
      say(r.status===429?'A device check was just requested. Wait a minute before asking again.':'The device check could not be requested. Turn alerts off and on again, then try.','warn');
      return false;
    }catch{say('The device check could not be requested. Check your connection and try again.','bad');return false}
    finally{checkButton.disabled=false}
  }
  checkButton.addEventListener('click',()=>{void requestCheck()});
  const checkLink=(()=>{try{return new URLSearchParams((win.location?.hash||'').slice(1)).has('alerts-check')}catch{return false}})();
  if(checkLink&&state.phase==='on'){checkSection.open=true;void requestCheck()}

  test.addEventListener('click',async()=>{
    try{
      await reg.showNotification('Pool Alerts test',{body:'Alerts can appear on this device.',tag:'pool-alerts-test',icon:ICON,badge:BADGE,data:{kind:'test'}});
      say('A test alert was sent to this device. If you did not see it, check this device\'s notification settings.','good');
    }catch{say('The test alert could not be shown. Check this device\'s notification settings.','bad')}
  });
  return state;
}

if(typeof document!=='undefined'){
  void bootPush(document,window,{store:typeof indexedDB!=='undefined'?createDeviceStore(indexedDB):null}).catch(()=>{
    const card=document.querySelector('[aria-label="Pool Alerts"]');
    if(card){const p=document.createElement('p');p.className='pa-status pa-warn';p.textContent='Phone alerts could not be started on this device.';(card.querySelector('.pa-body')||card).append(p)}
  });
}
