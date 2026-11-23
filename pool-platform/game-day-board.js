// Mobile-first, read-only public NFL score card. It never reads, writes or
// transmits a pool entry, submission, auth token or pool ID to the score endpoint.
// The caller supplies only the authorized week it already loaded from the API.
import {validateGameDayFeed} from './game-day-core.js';
// This release installs no live-score gateway: nothing in netlify/functions, api/ or the hosting configuration serves
// SCORE_GATEWAY_PATH, and ops/release/README.md keeps it that way. While SCORE_GATEWAY_INSTALLED is false the card says
// so, offers no refresh and never requests the path, so no page load, week change or tap ends in a 404. A release that
// installs the gateway sets it to true in the same change: tests/game-day-board-release.test.mjs fails while this
// declaration and the deployed functions disagree. It is not a switch for another project's score service.
export const SCORE_GATEWAY_PATH='/api/nfl-scores';
export const SCORE_GATEWAY_INSTALLED=false;
export const SCORE_GATEWAY_NOT_INSTALLED='Live NFL scores are not installed on this site, so this page does not check for them. Picks, pool management and recorded final scores work without them.';
export function createGameDayBoard(root,{fetchImpl=fetch,clock=()=>new Date(),intervalMs=30000,onUpdate=()=>{},
  gatewayInstalled=SCORE_GATEWAY_INSTALLED}={}){
  if(!root)throw new Error('score card root missing');
  const status=root.querySelector('[data-score-status]');
  const list=root.querySelector('[data-score-list]');
  const refreshButton=root.querySelector('[data-score-refresh]');
  if(!status||!list||!refreshButton)throw new Error('score card content incomplete');
  let active=null,last=null,controller=null,timer=null,run=0,disabled=false;
  const installed=gatewayInstalled===true;
  // Not installed: the refresh control is taken away for good, and nothing below asks for the gateway.
  if(!installed){refreshButton.disabled=true;refreshButton.classList.add('hidden')}
  const notify=value=>{try{onUpdate(value)}catch{ /* Never interrupt pick or score behavior for an optional view. */ }};
  const display=(text,rows=null)=>{
    status.textContent=text;
    if(rows===null)return;
    list.replaceChildren();
    for(const game of rows){
      const item=document.createElement('div'),teams=document.createElement('span'),
        score=document.createElement('strong'),label=document.createElement('span');
      item.className='scoreboard-row';item.setAttribute('role','listitem');
      teams.textContent=game.away+' vs '+game.home;
      score.textContent=game.awayScore===null||game.homeScore===null
        ?'—':game.awayScore+'–'+game.homeScore;
      label.textContent=game.label;label.className='scoreboard-state';
      if(game.status==='live')label.classList.add('live');
      item.append(teams,score,label);list.append(item);
    }
  };
  const keyOf=x=>JSON.stringify([x.poolId,x.season,x.week,x.config?.games]);
  function stop(){
    run++;controller?.abort();controller=null;
    if(timer!==null)clearInterval(timer);timer=null;
    refreshButton.disabled=!installed;
  }
  function hide(){
    stop();active=null;last=null;disabled=false;
    list.replaceChildren();status.textContent='';root.classList.add('hidden');
    notify(null);
  }
  async function refresh(){
    if(!installed||!active||controller||document.visibilityState==='hidden')return;
    const id=run,current=active,signalController=new AbortController();
    controller=signalController;refreshButton.disabled=true;
    const timeout=setTimeout(()=>signalController.abort(),10000);
    if(last)status.textContent='Updating scores… last verified results remain visible.';
    else status.textContent='Checking NFL scores…';
    try{
      const url=SCORE_GATEWAY_PATH+'?season='+encodeURIComponent(current.season)
        +'&week='+encodeURIComponent(current.week);
      const response=await fetchImpl(url,{cache:'no-store',signal:signalController.signal,
        headers:{Accept:'application/json'}});
      if(!response.ok){
        let unavailable=response.status===404;
        if(response.status===503){
          const error=await response.json().catch(()=>({}));
          unavailable=error.error==='score_feed_not_enabled';
        }
        if(run!==id||active?.key!==current.key)return;
        if(unavailable)disabled=true;
        throw new Error('score feed unavailable');
      }
      const data=await response.json();
      if(run!==id||active?.key!==current.key)return;
      const verified=validateGameDayFeed({season:current.season,week:current.week,
        config:current.config,feed:data,now:clock()});
      if(!verified.ok)throw new Error('score feed did not match this week');
      last=verified;
      const seconds=Math.max(0,Math.floor((new Date(clock()).getTime()-
        Date.parse(last.fetchedAt))/1000));
      display('NFL score facts · checked '+seconds+'s ago · unofficial feed. Final standings require the pool rules.',
        verified.rows);
      notify({poolId:current.poolId,season:current.season,week:current.week,
        data:verified,stale:false});
    }catch{
      if(run!==id||active?.key!==current.key)return;
      if(disabled)display('Live scores are not enabled here. Picks and pool management still work.',last?.rows??[]);
      else if(last)display('Score feed unavailable · last verified scores retained. Picks still work.',last.rows);
      else display('Score feed unavailable · no verified scores yet. Picks still work.',[]);
      notify({poolId:current.poolId,season:current.season,week:current.week,
        data:last,stale:true});
    }finally{
      clearTimeout(timeout);
      if(controller===signalController)controller=null;
      if(run===id)refreshButton.disabled=false;
    }
  }
  function show({poolId,season,week,config}={}){
    if(typeof poolId!=='string'||!poolId||!Number.isInteger(season)||
      !Number.isInteger(week)||!Array.isArray(config?.games)||!config.games.length){
      hide();return;
    }
    const incoming={poolId,season,week,config,key:keyOf({poolId,season,week,config})};
    if(active?.key===incoming.key)return;
    stop();active=incoming;last=null;disabled=false;
    notify(null);
    root.classList.remove('hidden');
    if(!installed){
      // What an unreachable gateway reported before: no score facts for this week. Standings behave exactly as they did.
      display(SCORE_GATEWAY_NOT_INSTALLED,[]);
      notify({poolId,season,week,data:null,stale:true});
      return;
    }
    display('Checking NFL scores…',[]);
    void refresh();
    timer=setInterval(()=>{if(!disabled)void refresh()},intervalMs);
  }
  refreshButton.addEventListener('click',()=>{void refresh()});
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible'&&active&&!disabled)void refresh();
  });
  return {show,hide,refresh};
}
