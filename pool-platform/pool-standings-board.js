// Authenticated, pool-scoped, read-only unofficial rankings for one week.
// Final scores the commissioner attested for the week are the record and are shown whenever they exist; live score
// facts from the gateway, when it is on, are only a projection for a week that has none.
import {attestedScoreFacts,projectPoolStandings} from './pool-projection.js';
export function createPoolStandingsBoard(root,{client,clock=()=>new Date()}={}){
  if(!root||!client?.weekProjectionSnapshot)throw new Error('standings dependency missing');
  const status=root.querySelector('[data-standings-status]');
  const list=root.querySelector('[data-standings-list]');
  if(!status||!list)throw new Error('standings card incomplete');
  let active=null,snapshot=null,scoreFacts=null,attested=null,sourceStale=false,generation=0;
  const clear=()=>list.replaceChildren();
  function hide(){
    generation++;active=null;snapshot=null;scoreFacts=null;attested=null;sourceStale=false;
    clear();status.textContent='';root.classList.add('hidden');
  }
  const viewKey=ctx=>JSON.stringify([ctx.poolId,ctx.season,ctx.week,ctx.weekId]);
  function paint(){
    if(!active||!snapshot)return;
    const result=projectPoolStandings({
      snapshot,config:active.config,scoreFacts:attested??scoreFacts,
      poolId:active.poolId,season:active.season,week:active.week
    });
    clear();
    if(!result.ok){
      status.textContent='Pool standings could not be verified. Picks remain unchanged.';
      return;
    }
    if(result.reason==='deadline_not_passed'){
      status.textContent='Standings are sealed until the pick deadline. Other entries remain private.';
      return;
    }
    if(result.reason==='scores_unavailable'){
      status.textContent='NFL scores unavailable. Showing only this pool’s entries; rankings are not calculated.';
    }else if(attested){
      status.textContent='Final scores recorded by your commissioner · revision '+attested.revision+
        (attested.revision>1?' (corrected)':'')+' · not official NFL results.';
    }else{
      status.textContent='Unofficial live projection · '+result.completed+' of '+
        result.total+' games final'+(sourceStale?' · score updates delayed':'')+
        '. Official standings require separately verified final results.';
    }
    for(const row of result.rows){
      const item=document.createElement('div'),
        name=document.createElement('span'),
        score=document.createElement('strong'),
        detail=document.createElement('small');
      item.setAttribute('role','listitem');item.className='standings-row';
      name.textContent=(row.rank===null?'—':String(row.rank)+'.')+' '+row.name;
      if(attested&&result.kind==='pickem'&&row.submission==='submitted'){
        score.textContent=row.confirmed+' correct';
        detail.textContent=row.code+' · '+row.losses+' incorrect'+
          (row.tiedGames?' · '+row.tiedGames+' tied game'+(row.tiedGames===1?'':'s')+' count against both sides':'');
      }else if(result.kind==='pickem'&&result.reason==='unofficial_projection'
        &&row.submission==='submitted'){
        score.textContent=row.projected+' projected';
        detail.textContent=row.confirmed+' final wins · '+row.provisional+
          ' live leads · '+row.pending+' pending';
      }else{
        score.textContent=row.label;
        detail.textContent=row.code;
      }
      item.append(name,score,detail);list.append(item);
    }
  }
  function setScores(event){
    if(!active)return;
    if(!event){scoreFacts=null;sourceStale=false;paint();return}
    if(event.poolId!==active.poolId||event.season!==active.season||
      event.week!==active.week)return;
    // The gateway's already-validated score facts are per-week only.
    scoreFacts=event.data||null;sourceStale=!!event.stale;
    paint();
  }
  async function show({poolId,season,week,weekId,config}={}){
    if(typeof poolId!=='string'||!poolId||!Number.isInteger(season)
      ||!Number.isInteger(week)||typeof weekId!=='string'||!weekId
      ||!Array.isArray(config?.games)||!config.games.length){hide();return}
    const next={poolId,season,week,weekId,config,
      key:viewKey({poolId,season,week,weekId})};
    if(active?.key===next.key)return;
    const current=++generation;
    active=next;snapshot=null;scoreFacts=null;attested=null;sourceStale=false;
    root.classList.remove('hidden');clear();
    status.textContent='Checking this pool’s standings access…';
    try{
      // A week without attested finals, or a backend without that read, simply has none: the card still works.
      const [loaded,result]=await Promise.all([client.weekProjectionSnapshot(weekId),
        client.weekResultSnapshot?Promise.resolve(client.weekResultSnapshot(weekId)).catch(()=>null):null]);
      if(generation!==current||active?.key!==next.key)return;
      snapshot=loaded;attested=attestedScoreFacts(config,result);paint();
    }catch{
      if(generation!==current||active?.key!==next.key)return;
      clear();status.textContent='Pool standings are unavailable. Picks and scores still work.';
    }
  }
  // Loads the current view again, after the commissioner recorded or corrected this week's final scores.
  function reload(){
    if(!active)return Promise.resolve();
    const view=active;active=null;
    return show(view);
  }
  return {show,hide,setScores,reload};
}
