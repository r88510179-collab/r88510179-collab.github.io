// Explicitly configured in the isolated deployment; never default to a live sender.
const API_ORIGIN=null;
const KEY='poolcenter.push.management.v1';
export function decodeVapid(key){
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]+$/.test(key))throw Error('Invalid public key');
  const raw=atob(key.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(key.length/4)*4,'='));
  const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(bytes.length!==65||bytes[0]!==4)throw Error('Invalid public key');
  return bytes;
}
export async function bootPush(doc=globalThis.document,win=globalThis,api=API_ORIGIN){
  const card=doc.querySelector('[aria-label="Pool Alerts"]');
  if(!card)return;
  const controls=doc.createElement('div');controls.className='meta';controls.style.padding='0 14px 14px';
  const status=doc.createElement('p');status.setAttribute('role','status');controls.append(status);card.append(controls);
  if(!api){status.textContent='Phone alerts are not yet available.';return}
  const endpoint=new URL(api);
  if(endpoint.protocol!=='https:'||endpoint.origin!==api){status.textContent='Phone alerts unavailable.';return}
  if(!win.isSecureContext||!('serviceWorker' in win.navigator)||!('PushManager' in win)||!('Notification' in win)){
    status.textContent='Phone alerts require a supported browser. On iPhone or iPad, install Pool Center on the Home Screen, then open it there.';return;
  }
  const request=async(path,body)=>{
    const res=await win.fetch(api+path,{method:body?'POST':'GET',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(12000)});
    if(!res.ok)throw Error('Phone alerts request failed ('+res.status+')');
    return res.json();
  };
  let stored=null;
  try{stored=JSON.parse(win.localStorage.getItem(KEY)||'null')}catch{}
  const reg=await Promise.race([win.navigator.serviceWorker.ready,new Promise(resolve=>win.setTimeout(()=>resolve(null),12000))]);
  if(!reg){status.textContent='Install or reload Pool Center to enable phone alerts.';return}
  let sub=await reg.pushManager.getSubscription();
  if(sub&&stored?.id&&stored?.token){status.textContent='Phone alerts enabled on this browser.'}
  else if(sub){status.textContent='This browser has an old subscription. Disable it before enrolling again.'}
  else{stored=null;status.textContent='Get official picks notifications on this device.'}
  const code=doc.createElement('input');code.type='password';code.autocomplete='off';code.maxLength=256;code.placeholder='Group invitation code';code.setAttribute('aria-label','Group invitation code');
  const label=doc.createElement('label'),corrections=doc.createElement('input');corrections.type='checkbox';corrections.checked=stored?.corrections!==false;label.append(corrections,doc.createTextNode(' Include official corrections'));
  const button=doc.createElement('button');button.type='button';button.className='dash-tool';button.style.minHeight='44px';
  const save=doc.createElement('button');save.type='button';save.className='dash-tool';save.style.minHeight='44px';save.textContent='Save preferences';
  controls.append(code,label,button,save);
  function sync(){
    code.hidden=!!sub;label.hidden=!!sub&&!stored;save.hidden=!sub||!stored;
    button.textContent=sub?'Disable phone alerts':'Enable phone alerts';
  }
  sync();
  async function updatePreferences(enabled){
    if(!stored)throw Error('Subscription credentials unavailable');
    await request('/v1/preferences',{id:stored.id,token:stored.token,enabled,corrections:corrections.checked});
    stored={...stored,corrections:corrections.checked};win.localStorage.setItem(KEY,JSON.stringify(stored));
  }
  save.addEventListener('click',async()=>{
    save.disabled=true;button.disabled=true;
    try{await updatePreferences(true);status.textContent='Notification preferences saved.'}catch{status.textContent='Could not save preferences; try again.'}
    finally{save.disabled=false;button.disabled=false}
  });
  button.addEventListener('click',async()=>{
    button.disabled=true;save.disabled=true;
    try{
      if(sub){
        if(stored)await updatePreferences(false);
        await sub.unsubscribe();sub=null;stored=null;win.localStorage.removeItem(KEY);status.textContent='Phone alerts disabled.';
      }else{
        if(!code.value.trim()){status.textContent='Enter your group invitation code.';return}
        // Request permission directly from the user's click, before asynchronous network calls.
        if(await win.Notification.requestPermission()!=='granted'){status.textContent='Notification permission was not granted. Check browser settings.';return}
        // Test storage before registering: a lost management credential cannot be recovered server-side.
        win.localStorage.setItem(KEY,'null');
        const {publicKey}=await request('/v1/config');
        const candidate=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeVapid(publicKey)});
        try{
          const result=await request('/v1/subscribe',{code:code.value,subscription:candidate.toJSON(),corrections:corrections.checked});
          stored={id:result.id,token:result.token,corrections:corrections.checked};
          win.localStorage.setItem(KEY,JSON.stringify(stored));sub=candidate;code.value='';status.textContent='Phone alerts enabled on this browser.';
        }catch(e){await candidate.unsubscribe().catch(()=>{});throw e}
      }
    }catch{status.textContent='Unable to change phone alerts. Check the connection, permission and invitation code, then retry.'}
    finally{button.disabled=false;save.disabled=false;sync()}
  });
}
if(typeof document!=='undefined')void bootPush().catch(()=>{const card=document.querySelector('[aria-label="Pool Alerts"]');if(card){const p=document.createElement('p');p.className='meta';p.textContent='Phone alerts could not be initialized.';card.append(p)}});
