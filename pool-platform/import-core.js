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
      items.push({entry_id:entry.id,payload:{team}});
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
      const value=String(rows[i][gameColumns[j]]||'').toLowerCase();
      if(value!=='away'&&value!=='home')invalid=true;
      else picks[id]=value;
    });
    const tb=tbIndex>=0?Number(rows[i][tbIndex]):null;
    if(invalid||tbRequired&&!Number.isInteger(tb)){errors.push({row:i+1,code:'invalid_picks',entry_code:entry.entry_code});continue}
    items.push({entry_id:entry.id,payload:{picks,...(tbIndex>=0?{tiebreak:tb}:{})}});
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
