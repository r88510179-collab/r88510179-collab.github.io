export function competitionRanks(rows,{tiebreakFinal=false}={}){
  const same=(a,b)=>!!a&&!!b&&a.w===b.w&&a.l===b.l&&(!tiebreakFinal||a.diff===b.diff);
  const ranked=(rows||[]).map((row,i)=>({...row,_mathOrder:Number.isInteger(row._order)?row._order:i}))
    .sort((a,b)=>b.w-a.w||a.l-b.l||(tiebreakFinal?(a.diff??Infinity)-(b.diff??Infinity):0)||a._mathOrder-b._mathOrder);
  let rank=1;
  ranked.forEach((row,i)=>{if(i&&!same(row,ranked[i-1]))rank=i+1;row.rank=rank});
  ranked.forEach(row=>{row.tieCount=ranked.filter(x=>same(x,row)).length});
  return ranked;
}

export function ownershipShare(entries,gameIndex,team,validTeams){
  const validSet=new Set(validTeams||[]);
  const valid=(entries||[]).filter(entry=>validSet.has(entry?.picks?.[gameIndex]));
  const count=valid.reduce((n,entry)=>n+(entry.picks[gameIndex]===team?1:0),0);
  return{count,denominator:valid.length,total:valid.length,pct:valid.length?Math.round(count/valid.length*100):0};
}
