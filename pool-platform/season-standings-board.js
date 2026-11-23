// Authenticated, pool-scoped, read-only season standings, recomputed on every load from the final scores the
// commissioner attested. Nothing derived is stored, nothing here is an official result, and no pick is touched.
import {LAST_REGULAR_SEASON_WEEK,seasonStandingsFromSnapshot} from './season-standings-core.js';

const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
// Why counting stopped before the season's last week, in the reader's words.
function stoppedText(stopped,laterWeeksHaveFinals){
  if(!stopped)return '';
  const week=stopped.week;
  if(stopped.reason==='awaiting_finals')return ` Week ${week}: final scores have not been recorded yet${
    laterWeeksHaveFinals?', so later weeks are not counted':''}.`;
  if(stopped.reason==='week_missing')return ` Week ${week} is not set up in this season, so later weeks are not counted.`;
  if(stopped.reason==='regular_season_only')return ` Weeks after week ${LAST_REGULAR_SEASON_WEEK} are not counted.`;
  return ` Week ${week} could not be graded from its stored picks and scores, so it and later weeks are not counted.`;
}
const WEEK_STATE={counted:'',sealed:'not played yet',awaiting_finals:'awaiting final scores',
  not_gradable:'not counted',not_counted:'not counted'};
const OUT_REASON={loss:'lost',tie:'tied game',no_pick:'no pick'};

export function createSeasonStandingsBoard(root,{client}={}){
  if(!root||!client?.seasonStandingsSnapshot)throw new Error('season standings dependency missing');
  const status=root.querySelector('[data-season-status]');
  const list=root.querySelector('[data-season-list]');
  const weekLine=root.querySelector('[data-season-weeks]');
  if(!status||!list||!weekLine)throw new Error('season standings card incomplete');
  let active=null,generation=0;
  const clear=()=>{list.replaceChildren();weekLine.textContent=''};
  function hide(){generation++;active=null;clear();status.textContent='';root.classList.add('hidden')}

  function row(first,second,third){
    const item=document.createElement('div'),name=document.createElement('span'),
      score=document.createElement('strong'),detail=document.createElement('small');
    item.setAttribute('role','listitem');item.className='standings-row';
    name.textContent=first;score.textContent=second;detail.textContent=third;
    item.append(name,score,detail);list.append(item);
  }
  function paint(view){
    clear();
    if(!view.ok){
      status.textContent=view.reason==='unsupported_pool_rules'
        ?'This pool’s rules are not ones season standings can be computed for, so none are shown. Picks are not affected.'
        :'Season standings could not be verified, so none are shown. Picks are not affected.';
      return;
    }
    const laterFinals=view.stopped?view.weeks.some(w=>w.week>view.stopped.week&&w.revision!==null):false;
    if(!view.countedWeeks){
      status.textContent=(view.stopped&&view.stopped.reason!=='awaiting_finals'
        ?'No week can be counted yet.':'No final scores have been recorded for this season yet.')
        +(view.stopped&&view.stopped.reason!=='awaiting_finals'?stoppedText(view.stopped,laterFinals):'');
    }else{
      const shared=view.kind==='pickem'&&new Set(view.rows.map(r=>r.rank)).size<view.rows.length;
      status.textContent=`Through week ${view.throughWeek} · ${plural(view.countedWeeks,'week')} counted · `
        +'final scores recorded by your commissioner, not official NFL results.'
        +(shared?' Equal totals share a place; no tiebreak is applied.':'')
        +(view.noPickRule?' An entry with no pick for a week is out from that week.':'')
        +stoppedText(view.stopped,laterFinals);
      for(const r of view.rows){
        if(view.kind==='pickem'){
          row(`${r.rank}. ${r.name}`,`${r.correct} correct`,
            `${r.code} · ${r.incorrect} incorrect`+(r.missing_weeks?` · ${plural(r.missing_weeks,'week')} without picks`:''));
        }else{
          row(r.name,r.status==='active'?'Still in':`Out in week ${r.eliminated_week} (${OUT_REASON[r.elimination_reason]??'eliminated'})`,
            `${r.code} · ${plural(r.advanced_weeks,'week')} survived`+(r.used_teams.length?` · picked ${r.used_teams.join(', ')}`:''));
        }
      }
    }
    weekLine.textContent=view.weeks.map(w=>`Week ${w.week}`
      +(w.state==='counted'?` · revision ${w.revision}${w.revision>1?' (corrected)':''}`
        :` · ${WEEK_STATE[w.state]}${w.state==='not_counted'&&w.revision!==null?`, revision ${w.revision} recorded`:''}`)).join('; ');
  }
  async function load(next){
    const current=++generation;
    active=next;root.classList.remove('hidden');
    if(!list.childElementCount)status.textContent='Loading season standings…';
    try{
      const snapshot=await client.seasonStandingsSnapshot(next.poolId,next.season);
      if(generation!==current)return;
      paint(seasonStandingsFromSnapshot(snapshot,{poolId:next.poolId,season:next.season}));
    }catch(error){
      if(generation!==current)return;
      // A backend that does not have the season read yet simply has no season card.
      if(/could not find the function|PGRST202/i.test(String(error?.code??''))){hide();return}
      clear();status.textContent='Season standings are unavailable right now. Picks are not affected.';
    }
  }
  function show({poolId,season}={}){
    if(typeof poolId!=='string'||!poolId||!Number.isInteger(season)){hide();return Promise.resolve()}
    if(active&&active.poolId===poolId&&active.season===season)return Promise.resolve();
    clear();
    return load({poolId,season});
  }
  // After final scores were recorded or corrected: replay the season again from its first week.
  const refresh=()=>active?load(active):Promise.resolve();
  return {show,hide,refresh};
}
