import {parseTiebreak} from './submission-core.js';

export function parseCsv(text){
  const rows=[];let row=[],cell='',quoted=false;
  const src=String(text??'');
  for(let i=0;i<src.length;i++){
    const ch=src[i];
    if(quoted){
      if(ch==='"'&&src[i+1]==='"'){cell+='"';i++}
      else if(ch==='"')quoted=false;
      else cell+=ch;
    }else{
      if(ch==='"')quoted=true;
      else if(ch===','){row.push(cell.trim());cell=''}
      else if(ch==='\n'){row.push(cell.trim());if(row.some(Boolean))rows.push(row);row=[];cell=''}
      else if(ch!=='\r')cell+=ch;
    }
  }
  row.push(cell.trim());if(row.some(Boolean))rows.push(row);
  if(quoted)throw new Error('CSV contains an unclosed quote.');
  return rows;
}

function teamCandidates(game,side){
  const raw=game?.[side],key=String(raw&&typeof raw==='object'?(raw.key??raw.id??''):raw??'').trim();
  const label=String(raw&&typeof raw==='object'?(raw.label??raw.name??raw.city??key):raw??'').trim();
  return{key,label};
}
// A typed value names a team when it equals that team's stable key or displayed label (trimmed, any case).
// Callers accept a value only when exactly one team matches: a label two teams share (two "New York" teams,
// say) or a key that is also another team's label is reported with every candidate, never resolved to the
// first match. Each candidate carries `use`, a value that names only that team, or null when none does.
function namesTeam(team,v){return[team.key,team.label].some(x=>x&&x.toLowerCase()===v)}
function sidesNamed(v,game){return['away','home'].filter(side=>v===side||namesTeam(teamCandidates(game,side),v))}
function resolveSide(value,game){
  const sides=sidesNamed(String(value??'').trim().toLowerCase(),game);
  if(sides.length===1)return{side:sides[0]};
  if(!sides.length)return{code:'invalid_picks'};
  return{code:'ambiguous_team_label',candidates:sides.map(side=>{
    const team=teamCandidates(game,side);
    return{side,...team,use:[side,team.key,team.label].find(x=>x&&sidesNamed(x.toLowerCase(),game).join()===side)||null};
  })};
}
function resolveSurvivorTeam(value,weekConfig){
  const slots=[];
  (weekConfig?.games||[]).forEach((game,i)=>{
    for(const side of ['away','home'])slots.push({game_id:String(game?.id??`g${i+1}`),side,...teamCandidates(game,side)});
  });
  const named=v=>slots.filter(slot=>namesTeam(slot,v)),matches=named(String(value??'').trim().toLowerCase());
  if(matches.length>1)return{code:'ambiguous_team_label',candidates:matches.map(slot=>({...slot,
    use:(slot.key&&[slot.key,slot.label].find(x=>{const m=x?named(x.toLowerCase()):[];return m.length===1&&m[0]===slot}))||null}))};
  return matches[0]?.key?{team:matches[0].key}:{code:'unknown_team'};
}

export function prepareCommissionerImport({text,poolType,entries,weekConfig}){
  const rows=parseCsv(text);
  if(rows.length<2)return{items:[],errors:[{code:'no_data'}]};
  const headers=rows[0].map(x=>x.toLowerCase());
  const entryIndex=headers.indexOf('entry_code');
  if(entryIndex<0)return{items:[],errors:[{code:'missing_entry_code'}]};
  const entryMap=new Map((entries||[]).map(e=>[String(e.entry_code).toLowerCase(),e]));
  const items=[],errors=[];
  if(poolType==='survivor'){
    const teamIndex=headers.indexOf('team');
    if(teamIndex<0)return{items:[],errors:[{code:'missing_team'}]};
    for(let i=1;i<rows.length;i++){
      const code=String(rows[i][entryIndex]||'').toLowerCase(),entry=entryMap.get(code),team=String(rows[i][teamIndex]||'').trim();
      if(!entry){errors.push({row:i+1,code:'unknown_entry',entry_code:rows[i][entryIndex]});continue}
      if(!team){errors.push({row:i+1,code:'missing_team',entry_code:entry.entry_code});continue}
      const resolved=resolveSurvivorTeam(team,weekConfig);
      if(!resolved.team){errors.push({row:i+1,code:resolved.code,entry_code:entry.entry_code,value:team,...(resolved.candidates?{candidates:resolved.candidates}:{})});continue}
      items.push({entry_id:entry.id,payload:{team:resolved.team}});
    }
    return{items,errors};
  }
  const gameIds=(weekConfig?.games||[]).map((g,i)=>String(g?.id??`g${i+1}`));
  const gameColumns=gameIds.map(id=>headers.indexOf(id.toLowerCase()));
  if(gameColumns.some(i=>i<0))return{items:[],errors:[{code:'missing_game_columns'}]};
  const tbRequired=weekConfig?.tiebreakRequired===true||weekConfig?.tiebreak_required===true;
  const tbIndex=headers.indexOf('tiebreak');
  if(tbRequired&&tbIndex<0)return{items:[],errors:[{code:'missing_tiebreak'}]};
  for(let i=1;i<rows.length;i++){
    const code=String(rows[i][entryIndex]||'').toLowerCase(),entry=entryMap.get(code);
    if(!entry){errors.push({row:i+1,code:'unknown_entry',entry_code:rows[i][entryIndex]});continue}
    // The row is rejected at its first unresolved game, naming that game, the value and any candidates.
    const picks={};let problem=null;
    for(let j=0;j<gameIds.length&&!problem;j++){
      const value=rows[i][gameColumns[j]]??'',resolved=resolveSide(value,weekConfig.games[j]);
      if(resolved.side)picks[gameIds[j]]=resolved.side;
      else problem={code:resolved.code,game_id:gameIds[j],value,...(resolved.candidates?{candidates:resolved.candidates}:{})};
    }
    if(problem){errors.push({row:i+1,entry_code:entry.entry_code,...problem});continue}
    // A blank tiebreak cell is missing, not 0: it fails when required and is left out when optional.
    const tb=parseTiebreak(tbIndex>=0?rows[i][tbIndex]:undefined);
    if(!tb.valid){errors.push({row:i+1,code:'invalid_tiebreak',entry_code:entry.entry_code});continue}
    if(tbRequired&&!tb.present){errors.push({row:i+1,code:'missing_tiebreak',entry_code:entry.entry_code});continue}
    items.push({entry_id:entry.id,payload:{picks,...(tb.present?{tiebreak:tb.value}:{})}});
  }
  return{items,errors};
}

// One line of row context for the commissioner: the failed rule, then the game and value it failed on and,
// for an ambiguous label, every team it could mean. Only values that name exactly one team are suggested;
// teams that no value can single out need distinct keys and labels in the schedule.
export function describeImportError(error){
  const e=error||{},parts=[String(e.code||'invalid_row')];
  if(e.game_id!==undefined)parts.push(`game ${e.game_id}`);
  if(e.value!==undefined)parts.push(`"${e.value}"`);
  if(Array.isArray(e.candidates)&&e.candidates.length){
    const pickem=e.game_id!==undefined,uses=e.candidates.map(c=>c.use).filter(Boolean);
    parts.push(`matches ${e.candidates.map(c=>{
      const name=c.key?`${c.key}${c.label&&c.label!==c.key?` (${c.label})`:''}`:c.label;
      return pickem?`${c.side} ${name}`:`${name} in ${c.game_id}`;
    }).join(' and ')}`);
    parts.push(uses.length===e.candidates.length?`type ${uses.join(' or ')} instead`
      :`${uses.length?`only ${uses.join(' or ')} names one of these teams alone`:'no value names one of these teams alone'}; give them distinct keys and labels in the schedule`);
  }
  return parts.join(' · ');
}

export function summarizeBatchResults(results=[]){
  const summary={submitted:0,conflicts:0,errors:0,rows:[]};
  for(const row of results||[]){
    if(row?.ok)summary.submitted++;
    else if(String(row?.code||'').includes('source_conflict'))summary.conflicts++;
    else summary.errors++;
    summary.rows.push(row);
  }
  return summary;
}
