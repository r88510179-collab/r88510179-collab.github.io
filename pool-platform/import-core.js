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
function resolveSide(value,game){
  const v=String(value??'').trim().toLowerCase();
  if(v==='away'||v==='home')return v;
  const away=teamCandidates(game,'away'),home=teamCandidates(game,'home');
  if([away.key,away.label].some(x=>x&&x.toLowerCase()===v))return'away';
  if([home.key,home.label].some(x=>x&&x.toLowerCase()===v))return'home';
  return null;
}
function resolveSurvivorTeam(value,weekConfig){
  const v=String(value??'').trim().toLowerCase();
  for(const game of weekConfig?.games||[]){
    for(const side of ['away','home']){
      const team=teamCandidates(game,side);
      if([team.key,team.label].some(x=>x&&x.toLowerCase()===v))return team.key;
    }
  }
  return null;
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
      const teamKey=resolveSurvivorTeam(team,weekConfig);
      if(!teamKey){errors.push({row:i+1,code:'unknown_team',entry_code:entry.entry_code});continue}
      items.push({entry_id:entry.id,payload:{team:teamKey}});
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
    const picks={};let invalid=false;
    gameIds.forEach((id,j)=>{
      const side=resolveSide(rows[i][gameColumns[j]],weekConfig.games[j]);
      if(!side)invalid=true;
      else picks[id]=side;
    });
    if(invalid){errors.push({row:i+1,code:'invalid_picks',entry_code:entry.entry_code});continue}
    // A blank tiebreak cell is missing, not 0: it fails when required and is left out when optional.
    const tb=parseTiebreak(tbIndex>=0?rows[i][tbIndex]:undefined);
    if(!tb.valid){errors.push({row:i+1,code:'invalid_tiebreak',entry_code:entry.entry_code});continue}
    if(tbRequired&&!tb.present){errors.push({row:i+1,code:'missing_tiebreak',entry_code:entry.entry_code});continue}
    items.push({entry_id:entry.id,payload:{picks,...(tb.present?{tiebreak:tb.value}:{})}});
  }
  return{items,errors};
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
