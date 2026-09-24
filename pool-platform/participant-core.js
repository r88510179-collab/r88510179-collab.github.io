export function teamObject(value,fallbackKey){
  if(value&&typeof value==='object'){
    const key=String(value.key??value.id??fallbackKey??'').trim();
    const label=String(value.label??value.name??value.city??key).trim();
    return{key,label};
  }
  const label=String(value??'').trim();
  return{key:String(fallbackKey??label).trim(),label};
}

export function normalizeGames(config={}){
  return (Array.isArray(config.games)?config.games:[]).map((game,index)=>{
    const id=String(game?.id??`g${index+1}`);
    return{
      id,
      away:teamObject(game?.away,`${id}-away`),
      home:teamObject(game?.home,`${id}-home`)
    };
  }).filter(g=>g.away.key&&g.home.key);
}

export function pickemPayloadFromSelections(selections,tiebreak){
  const picks={};
  for(const [gameId,side] of Object.entries(selections||{})){
    if(side==='away'||side==='home')picks[gameId]=side;
  }
  const n=Number(tiebreak);
  return{picks,tiebreak:Number.isInteger(n)?n:tiebreak};
}

export function survivorBurnedTeams(history=[]){
  return new Set((history||[]).map(row=>row?.payload?.team).filter(Boolean));
}

export function survivorLegalTeams(config={},history=[]){
  const burned=survivorBurnedTeams(history),seen=new Set(),out=[];
  for(const game of normalizeGames(config)){
    for(const team of [game.away,game.home]){
      if(!seen.has(team.key)){
        seen.add(team.key);
        out.push({...team,burned:burned.has(team.key)});
      }
    }
  }
  return out;
}

export function validateSurvivorSelection(team,config={},history=[]){
  const legal=survivorLegalTeams(config,history);
  const row=legal.find(x=>x.key===team);
  if(!row)return{ok:false,code:'unknown_team'};
  if(row.burned)return{ok:false,code:'team_already_used'};
  return{ok:true,code:'valid'};
}

export function entrySubmissionAccess(entry,weekStatus,now,deadline){
  const submitted=entry?.submission??null;
  const nowMs=new Date(now).getTime(),deadlineMs=new Date(deadline).getTime();
  if(weekStatus!=='open'||!Number.isFinite(nowMs)||!Number.isFinite(deadlineMs)||nowMs>=deadlineMs){
    return{editable:false,reason:'closed',source:submitted?.source??null};
  }
  if(!submitted)return{editable:true,reason:'unclaimed',source:null};
  if(submitted.status==='locked')return{editable:false,reason:'locked',source:submitted.source};
  if(submitted.source!=='participant')return{editable:false,reason:'commissioner_claimed',source:submitted.source};
  return{editable:true,reason:'participant_update',source:submitted.source};
}
