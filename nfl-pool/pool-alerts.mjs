// Pool Alerts: presentation only. Reuse the public locked publication index.
export const STORAGE_KEY='poolcenter.alerts.seen.v1';
export function latestPublication(state){
  if(state?.ready!==true||state.publishedStale!==false||!Array.isArray(state.index)||!state.index.length)return null;
  const rows=state.index;
  if(rows.some(x=>!Number.isSafeInteger(x?.season)||x.season<1900||!Number.isSafeInteger(x.week)||x.week<1||x.week>18||!Number.isSafeInteger(x.revision)||x.revision<1))return null;
  const keys=rows.map(x=>x.season+':'+x.week);
  if(new Set(keys).size!==keys.length)return null;
  return [...rows].sort((a,b)=>b.season-a.season||b.week-a.week)[0];
}
export const publicationKey=x=>x.season+':'+x.week+':'+x.revision;
export function publicationTime(x){
  if(typeof x?.publishedAt!=='string'||!Number.isFinite(Date.parse(x.publishedAt)))return 'Release time unavailable';
  return new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(x.publishedAt));
}
export function bootPoolAlerts(doc=globalThis.document,storage){
  const title=doc.getElementById('poolAlertsTitle'),note=doc.getElementById('poolAlertsNote'),link=doc.getElementById('poolAlertsLink');
  if(!title||!note||!link)return;
  let seen=null;
  try{storage=storage??globalThis.localStorage;seen=storage?.getItem(STORAGE_KEY)||null}catch{}
  const render=()=>{
    const detail={op:'state'};
    doc.dispatchEvent(new CustomEvent('poolcenter:season',{detail}));
    const state=detail.result,latest=latestPublication(state);
    if(!latest){
      title.textContent=state?.ready||state?.failed?'Publication status unavailable':'Checking official picks…';
      note.textContent='The latest release has not been verified. Try again when connected.';
      link.hidden=true;link.removeAttribute('href');return;
    }
    const key=publicationKey(latest);
    const current=state.current?.week;
    if(doc.body?.dataset.view==='picks'&&current&&publicationKey(current)===key){
      seen=key;try{storage?.setItem(STORAGE_KEY,key)}catch{}
    }
    title.textContent=(seen===key?'':'New · ')+'Week '+latest.week+' official picks published';
    note.textContent=latest.season+' season · Revision '+latest.revision+' · '+publicationTime(latest);
    link.href='./?view=picks&season='+latest.season+'&week='+latest.week;
    link.hidden=false;
  };
  doc.addEventListener('poolcenter:update',event=>{if(event.detail?.contest==='pickem')render()});
  doc.addEventListener('poolcenter:viewchange',event=>{if(event.detail?.view!=='survivor')render()});
  render();
}
if(typeof document!=='undefined')bootPoolAlerts();
