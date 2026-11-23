import {parseTiebreak} from './submission-core.js';

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
  // A blank or whitespace-only tiebreak is left out (so a required tiebreak fails) instead of becoming 0.
  const parsed=parseTiebreak(tiebreak);
  if(!parsed.present)return{picks};
  return{picks,tiebreak:parsed.valid?parsed.value:tiebreak};
}

export function survivorBurnedTeams(history=[]){
  return new Set((history||[]).map(row=>row?.payload?.team).filter(Boolean));
}

// Names compare the way the commissioner import matches team names (trimmed, in any case), with runs of
// whitespace collapsed as the page renders them.
const sameName=value=>String(value??'').trim().replace(/\s+/g,' ').toLowerCase();
const nameCounts=names=>names.reduce((counts,name)=>counts.set(sameName(name),(counts.get(sameName(name))||0)+1),new Map());

// Every choice carries `display`, the text shown for it. A name two or more choices share, used ones included,
// gets the choice's stable key appended ("New York (NYG)" and "New York (NYJ)"); a unique name is shown as is,
// and a blank one shows the key. A plain name that then equals an appended one is appended too. Choices that
// still read alike are `ambiguous` and not offered, so the reader always knows which key a choice submits.
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
  const plain=out.map(team=>team.label||team.key),display=[...plain];
  for(let changed=true;changed;){
    changed=false;const counts=nameCounts(display);
    display.forEach((name,i)=>{if(name===plain[i]&&counts.get(sameName(name))>1){display[i]=`${plain[i]} (${out[i].key})`;changed=true}});
  }
  const counts=nameCounts(display);
  return out.map((team,i)=>({...team,display:display[i],ambiguous:counts.get(sameName(display[i]))>1}));
}

export function validateSurvivorSelection(team,config={},history=[]){
  const legal=survivorLegalTeams(config,history);
  const row=legal.find(x=>x.key===team);
  if(!row)return{ok:false,code:'unknown_team'};
  if(row.burned)return{ok:false,code:'team_already_used'};
  if(row.ambiguous)return{ok:false,code:'ambiguous_team'};
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

/**
 * Display only server-returned pools already linked to this authenticated participant.
 * Never infer authorization from a URL or select ambiguous tenant-local slugs.
 * The database must authorize every read and write independently of this display helper.
 */
export function chooseParticipantPool(pools,preferredSlug=''){
  const valid=pool=>pool&&typeof pool.slug==='string'
    &&/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(pool.slug)
    &&typeof pool.id==='string'
    &&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pool.id)
    &&typeof pool.display_name==='string'&&pool.display_name.length>0
    &&Number.isInteger(pool.season)&&pool.season>=2000&&pool.season<=2100
    &&['pickem','survivor'].includes(pool.pool_type);
  const known=new Map(),ambiguous=new Set();
  for(const pool of Array.isArray(pools)?pools:[]){
    if(!valid(pool))continue;
    const previous=known.get(pool.slug);
    if(previous&&previous.id!==pool.id)ambiguous.add(pool.slug);
    else if(!previous)known.set(pool.slug,pool);
  }
  const available=[...known.values()].filter(pool=>!ambiguous.has(pool.slug));
  // A supplied link must never silently switch to another pool, even one
  // the same account also owns. A missing/ambiguous link goes to the chooser.
  const selected=preferredSlug
    ?(available.some(p=>p.slug===preferredSlug)?preferredSlug:null)
    :(available.length===1?available[0].slug:null);
  return{available,selected,automatic:!!selected,ambiguous:[...ambiguous]};
}
