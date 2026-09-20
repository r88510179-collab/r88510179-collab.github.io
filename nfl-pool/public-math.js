'use strict';
(function(root){
  const score=x=>{let n;if(typeof x==='string'){const v=x.trim();if(!v||!/^\d+$/.test(v))return null;n=Number(v)}else if(typeof x==='number')n=x;else return null;return Number.isFinite(n)&&Number.isInteger(n)&&n>=0?n:null};
  function stats(entry,games){let w=0,l=0,left=0;games.forEach((g,i)=>{if(g.completed){if(g.winner)entry.picks[i]===g.winner?w++:l++}else left++});return{w,l,left}}
  function tiebreak(games,tiebreakIndex){const g=games[tiebreakIndex],a=score(g?.awayScore),h=score(g?.homeScore),ok=a!==null&&h!==null;return{final:!!(g?.completed&&ok),total:ok&&(g?.state==='in'||g?.completed)?a+h:null}}
  function sameStanding(a,b,t){return !!a&&!!b&&a.w===b.w&&a.l===b.l&&(!t.final||a.diff===b.diff)}
  function rankCompetition(entries,games,tiebreakIndex){
    const t=tiebreak(games,tiebreakIndex),ranked=entries.map((p,i)=>({...p,...stats(p,games),diff:t.final?Math.abs(p.mnf-t.total):null,_order:Number.isInteger(p._order)?p._order:i}))
      .sort((a,b)=>b.w-a.w||a.l-b.l||(t.final?a.diff-b.diff:0)||a._order-b._order);
    let rank=1;ranked.forEach((p,i)=>{if(i&&!sameStanding(p,ranked[i-1],t))rank=i+1;p.rank=rank});
    const counts=new Map();for(const p of ranked){const key=`${p.w}|${p.l}|${t.final?p.diff:'x'}`;counts.set(key,(counts.get(key)||0)+1)}
    ranked.forEach(p=>{const key=`${p.w}|${p.l}|${t.final?p.diff:'x'}`;p.tieCount=counts.get(key)||1});
    return{rows:ranked,byId:new Map(ranked.map(p=>[p.id,p])),size:ranked.length,bestWins:ranked[0]?.w??0,t};
  }
  function fieldSnapshot(trackedEntries,fieldEntries,games,tiebreakIndex){
    const all=[...trackedEntries.map((p,i)=>({...p,_order:i,_tracked:true})),...fieldEntries.map((p,i)=>({...p,_order:trackedEntries.length+i,_tracked:false}))];
    const base=rankCompetition(all,games,tiebreakIndex),metrics=new Map();
    for(const p of trackedEntries){
      const current=base.byId.get(p.id);
      const ceilingGames=games.map((g,i)=>g.completed?g:{...g,state:'post',completed:true,winner:p.picks[i],awayScore:null,homeScore:null,detail:'Win-ceiling simulation'});
      const ceiling=rankCompetition(all,ceilingGames,tiebreakIndex),cm=ceiling.byId.get(p.id)||current;
      metrics.set(p.id,{rank:current.rank,tieCount:current.tieCount,topPercent:Math.max(1,Math.ceil(current.rank/base.size*100)),behind:Math.max(0,base.bestWins-current.w),ceilingRank:cm.rank,ceilingTieCount:cm.tieCount,ceilingTiebreakProjected:ceiling.t.final});
    }
    return{...base,metrics};
  }
  function ownershipForGame(entries,gameIndex,away,home){
    let awayCount=0,homeCount=0,invalidCount=0;
    for(const p of entries){const pick=p?.picks?.[gameIndex];if(pick===away)awayCount++;else if(pick===home)homeCount++;else invalidCount++}
    const denominator=awayCount+homeCount;
    return{awayCount,homeCount,denominator,invalidCount,awayPct:denominator?Math.round(awayCount/denominator*100):null,homePct:denominator?Math.round(homeCount/denominator*100):null};
  }
  root.PoolMath={score,stats,tiebreak,sameStanding,rankCompetition,fieldSnapshot,ownershipForGame};
})(typeof globalThis!=='undefined'?globalThis:this);
