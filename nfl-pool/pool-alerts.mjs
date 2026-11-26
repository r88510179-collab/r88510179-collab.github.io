// Pool Alerts (Home): the latest official publication, its Eastern release time and revision, an unread marker until it
// has been viewed, a direct link to its picks, the official release history with per-week unread markers, one-tap
// sharing of the announcement and the installed app's badge. Presentation only: it reads the verified, locked
// publication index the Pick'em app already loaded (poolcenter:season) and writes nothing anywhere but this browser.
export const STORAGE_KEY='poolcenter.alerts.seen.v1';
export const WEEKS_KEY='poolcenter.alerts.weeks.v2';
const WEEK_MAX=22;
const HISTORY_LIMIT=6;

export function latestPublication(state){
  if(state?.ready!==true||state.publishedStale!==false||!Array.isArray(state.index)||!state.index.length)return null;
  const rows=state.index;
  if(rows.some(x=>!Number.isSafeInteger(x?.season)||x.season<1900||!Number.isSafeInteger(x.week)||x.week<1||x.week>WEEK_MAX||!Number.isSafeInteger(x.revision)||x.revision<1))return null;
  const keys=rows.map(x=>x.season+':'+x.week);
  if(new Set(keys).size!==keys.length)return null;
  return [...rows].sort((a,b)=>b.season-a.season||b.week-a.week)[0];
}
export const publicationKey=x=>x.season+':'+x.week+':'+x.revision;
export const weekKey=x=>x.season+':'+x.week;
export function publicationTime(x){
  if(typeof x?.publishedAt!=='string'||!Number.isFinite(Date.parse(x.publishedAt)))return 'Release time unavailable';
  return new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(x.publishedAt));
}
// Every verified release, newest first ([] whenever the latest cannot be trusted).
export function releases(state){
  return latestPublication(state)?[...state.index].sort((a,b)=>b.season-a.season||b.week-a.week):[];
}
export function picksUrl(x,origin){
  const url=new URL('/nfl-pool/',origin);
  url.searchParams.set('view','picks');url.searchParams.set('season',String(x.season));url.searchParams.set('week',String(x.week));
  return url.href;
}
export function releaseNote(x){
  const time=publicationTime(x);
  return x.season+' season · Revision '+x.revision+' · '+(time==='Release time unavailable'?time:(x.revision>1?'Updated ':'Published ')+time);
}

// Per-week read state: the newest revision of each week this browser has viewed. On the first run every release but the
// newest counts as read, so nothing historical is ever "new"; the PR #46 latest-release key is carried over.
export function readWeeks(storage){
  try{const v=JSON.parse(storage?.getItem(WEEKS_KEY)||'null');if(v&&v.v===2&&v.weeks&&typeof v.weeks==='object'&&!Array.isArray(v.weeks))return v}catch{}
  return null;
}
export function baselineWeeks(list,legacySeen,now=new Date()){
  const weeks={};
  for(const x of list.slice(1))weeks[weekKey(x)]=x.revision;
  const m=/^(\d+):(\d+):(\d+)$/.exec(legacySeen||'');
  if(m)weeks[m[1]+':'+m[2]]=Math.max(weeks[m[1]+':'+m[2]]||0,Number(m[3]));
  return{v:2,weeks,baselineAt:now.toISOString()};
}
export function readState(x,weeks){
  const seen=weeks?.weeks?.[weekKey(x)];
  if(!Number.isSafeInteger(seen))return 'new';
  return seen<x.revision?'updated':'read';
}
export function unreadCount(list,weeks){return list.filter(x=>readState(x,weeks)!=='read').length}

export function shareDetails(x,origin){
  const time=publicationTime(x),when=time==='Release time unavailable'?'':', '+time;
  return{title:'Week '+x.week+' official picks',
    text:'Week '+x.week+' official picks are '+(x.revision>1?'updated':'published')+' in Pool Center ('+x.season+' season, revision '+x.revision+when+').',
    url:picksUrl(x,origin)};
}

function ensureBody(card,doc){
  let body=card.querySelector('.pa-body');
  if(!body){body=doc.createElement('div');body.className='pa-body';card.append(body)}
  return body;
}

export function bootPoolAlerts(doc=globalThis.document,storage,win=globalThis){
  const title=doc.getElementById('poolAlertsTitle'),note=doc.getElementById('poolAlertsNote'),link=doc.getElementById('poolAlertsLink');
  if(!title||!note||!link)return;
  let seen=null,weeks=null;
  try{storage=storage??globalThis.localStorage;seen=storage?.getItem(STORAGE_KEY)||null;weeks=readWeeks(storage)}catch{}
  // Nothing is written until a week is actually viewed (merely opening Home never marks anything read).
  const save=()=>{try{if(seen)storage?.setItem(STORAGE_KEY,seen);storage?.setItem(WEEKS_KEY,JSON.stringify(weeks))}catch{}};

  // Optional richer layer (history, share, badge) when the page offers a full DOM; the core card works without it.
  const card=typeof doc.querySelector==='function'&&typeof doc.createElement==='function'?doc.querySelector('[aria-label="Pool Alerts"]'):null;
  let extras=null,latestShown=null;
  if(card){
    const body=ensureBody(card,doc);
    const section=doc.createElement('div');section.className='pa-row';section.dataset.paRelease='';
    const share=doc.createElement('button');share.type='button';share.className='dash-tool';share.textContent='Share announcement';share.hidden=true;
    const status=doc.createElement('p');status.className='pa-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    section.append(share);
    const history=doc.createElement('details');history.className='pa-section pa-details';history.dataset.paHistory='';history.hidden=true;
    const summary=doc.createElement('summary');summary.textContent='Official release history';
    const list=doc.createElement('ul');list.className='pa-list';
    history.append(summary,list);
    body.prepend(section,status,history);
    extras={share,status,history,summary,list};
    share.addEventListener('click',async()=>{
      if(!latestShown)return;
      const details=shareDetails(latestShown,win.location?.origin||'https://r88510179-collab.github.io'),nav=win.navigator;
      status.textContent='';status.className='pa-status';
      // navigator.share is called directly in the tap, so the tap's user activation is never lost.
      if(typeof nav?.share==='function'){
        try{await nav.share(details);return}
        catch(error){if(error?.name==='AbortError')return}
      }
      try{await nav.clipboard.writeText(details.text+' '+details.url);status.textContent='Announcement and link copied. Paste it into your group chat.';status.className='pa-status pa-good'}
      catch{status.textContent='Copy this link to share: '+details.url}
    });
  }

  const badge=count=>{
    const nav=win.navigator;
    try{
      if(count>0&&typeof nav?.setAppBadge==='function')nav.setAppBadge(count)?.catch?.(()=>{});
      else if(!count&&typeof nav?.clearAppBadge==='function')nav.clearAppBadge()?.catch?.(()=>{});
    }catch{}
  };

  const render=()=>{
    const detail={op:'state'};
    doc.dispatchEvent(new CustomEvent('poolcenter:season',{detail}));
    const state=detail.result,latest=latestPublication(state);
    if(!latest){
      title.textContent=state?.ready||state?.failed?'Publication status unavailable':'Checking official picks…';
      note.textContent='The latest release has not been verified. Try again when connected.';
      link.hidden=true;link.removeAttribute('href');
      latestShown=null;
      if(extras){extras.share.hidden=true;extras.history.hidden=true}
      return;
    }
    const list=releases(state);
    if(!weeks)weeks=baselineWeeks(list,seen);
    const key=publicationKey(latest);
    const current=state.current?.week;
    if(doc.body?.dataset.view==='picks'&&current&&Number.isSafeInteger(current.revision)){
      const viewed=list.find(x=>x.season===current.season&&x.week===current.week&&x.revision===current.revision);
      if(viewed&&readState(viewed,weeks)!=='read'){
        weeks.weeks[weekKey(viewed)]=viewed.revision;
        if(publicationKey(viewed)===key)seen=key;
        save();
        doc.dispatchEvent(new CustomEvent('poolalerts:seen',{detail:{season:viewed.season,week:viewed.week,revision:viewed.revision}}));
      }else if(viewed&&publicationKey(viewed)===key&&seen!==key){seen=key;save()}
    }
    title.textContent=(seen===key?'':'New · ')+'Week '+latest.week+' official picks published';
    note.textContent=releaseNote(latest);
    link.href='./?view=picks&season='+latest.season+'&week='+latest.week;
    link.hidden=false;
    latestShown=latest;
    // The newest release is unread exactly while the title says "New"; older weeks by their per-week read state.
    const unread=unreadCount(list.slice(1),weeks)+(seen===key?0:1);
    badge(unread);
    if(extras){
      extras.share.hidden=false;
      extras.history.hidden=false;
      extras.summary.textContent='Official release history'+(unread?' · '+unread+' unread':'');
      extras.list.replaceChildren(...list.slice(0,HISTORY_LIMIT).map(x=>{
        const li=doc.createElement('li'),a=doc.createElement('a'),when=doc.createElement('small');
        a.href='./?view=picks&season='+x.season+'&week='+x.week;a.textContent='Week '+x.week+(x.season!==latest.season?' ('+x.season+')':'')+' · revision '+x.revision;
        const state=x===latest?(seen===key?'read':readState(x,weeks)==='updated'?'updated':'new'):readState(x,weeks);
        if(state!=='read'){const tag=doc.createElement('span');tag.className='pa-tag'+(state==='updated'?' pa-updated':'');tag.textContent=state==='updated'?'Updated':'New';a.append(tag)}
        when.textContent=publicationTime(x);
        li.append(a,when);
        return li;
      }));
    }
  };
  doc.addEventListener('poolcenter:update',event=>{if(event.detail?.contest==='pickem')render()});
  doc.addEventListener('poolcenter:viewchange',event=>{if(event.detail?.view!=='survivor')render()});
  // A notification tapped while Pool Center is already open: the service worker asks this page to open the week.
  try{
    win.navigator?.serviceWorker?.addEventListener?.('message',event=>{
      const data=event.data;
      if(data?.type!=='pool-alerts-open'||typeof data.url!=='string')return;
      const url=new URL(data.url,win.location.href);
      if(url.origin===win.location.origin&&url.pathname==='/nfl-pool/')win.location.assign(url.href);
    });
  }catch{}
  render();
}
if(typeof document!=='undefined')bootPoolAlerts();
