// Conservative second-pass PDF row recovery for complete external Pick'em sheets.
// The source PDF stays in the browser; only anonymous validated picks can be published.
const strip = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const median = items => { const values = items.slice().sort((a,b)=>a-b); const n=values.length; return n%2?values[(n-1)/2]:(values[n/2-1]+values[n/2])/2; };
const norm = value => strip(value).toLowerCase();
const WIDTH_TOLERANCE=8;
const NAME_TOLERANCE=14;
const pickFor=(column,raw)=>raw===2*column+1||raw===2*column+2;

function tokensFor(row){
  if(!Array.isArray(row?.parts))return [];
  const tokens=[];
  for(const part of row.parts){
    if(!Number.isFinite(Number(part?.x)))return [];
    const words=strip(part?.text).split(' ').filter(Boolean);
    // Fused numeric text cannot prove positions for two separate columns.
    if(Number(part.x)>140 && words.length>1 && words.some(v=>/^\d+$/.test(v)))return [];
    for(const word of words)tokens.push({x:Number(part.x),value:word});
  }
  return tokens.sort((a,b)=>a.x-b.x);
}
function extractName(tokens,firstPickX){
  const lead=tokens.filter(t=>t.x<firstPickX-WIDTH_TOLERANCE);
  return {lead,name:strip(lead.map(t=>t.value).join(' '))};
}
function classifyRow(row,ref,gameCount){
  const tokens=tokensFor(row);
  if(!tokens.length)return {kind:'other'};
  const {lead,name}=extractName(tokens,ref.numbers[0]);
  if(!lead.length || !name || Math.abs(lead[0].x-ref.nameX)>NAME_TOLERANCE)return {kind:'other'};
  if(/^week\s+\d+$/i.test(name)||/^(entry|participant|name|pts|w)$/i.test(name))return {kind:'other'};
  const trailing=tokens.filter(t=>t.x>=ref.numbers[0]-WIDTH_TOLERANCE);
  const columns=Array(gameCount+2).fill(null);
  let lastColumn=-1;
  for(const t of trailing){
    if(!/^\d+$/.test(t.value))return {kind:'other'};
    const distances=ref.numbers.map(x=>Math.abs(x-t.x));
    const column=distances.indexOf(Math.min(...distances));
    if(distances[column]>WIDTH_TOLERANCE || column<=lastColumn || columns[column]!==null)return {kind:'unproven',name};
    columns[column]=Number(t.value);lastColumn=column;
  }
  const presentPicks=columns.slice(0,gameCount).filter(v=>v!==null).length;
  if(columns[gameCount+1]===null){
    if(presentPicks>0)return {kind:'unproven',name};
    return {kind:'other'};
  }
  if(!Number.isInteger(columns[gameCount+1]) || columns[gameCount+1]<0 || columns[gameCount+1]>gameCount)return {kind:'unproven',name};
  if(presentPicks===0){
    if(columns[gameCount]!==null || columns[gameCount+1]!==gameCount)return {kind:'unproven',name};
    return {kind:'no-submission',name};
  }
  const picks=[];
  let invalid=0;
  for(let i=0;i<gameCount;i++){
    const number=columns[i];
    if(number===null){picks.push(0);continue;}
    if(!pickFor(i,number)){invalid++;picks.push(0);continue;}
    picks.push(number);
  }
  if(invalid>2)return {kind:'unproven',name};
  return {kind:'entry',name,pickNumbers:picks,tiebreak:columns[gameCount],invalid,missing:gameCount-presentPicks};
}
function geometryFromTracked(groups,participants,gameCount){
  const anchors=[];
  for(const group of groups){
    for(const row of group.sourceRows||[]){
      const text=strip(row.text);
      for(const tracked of participants){
        const name=strip(tracked?.sourceName);
        if(!name || !text.toLowerCase().startsWith((name+' ').toLowerCase()))continue;
        const tokens=tokensFor(row);
        if(!tokens.length)continue;
        const values=[...(tracked.pickNumbers||[]),tracked.tiebreak];
        if(values.length!==gameCount+1||!values.every(Number.isInteger))continue;
        const numeric=tokens.filter(t=>/^\d+$/.test(t.value));
        if(numeric.length!==gameCount+2)continue;
        if(numeric.slice(0,gameCount+1).some((t,i)=>Number(t.value)!==values[i]))continue;
        if(Number(numeric[gameCount+1].value)<0||Number(numeric[gameCount+1].value)>gameCount)continue;
        const lead=tokens.filter(t=>t.x<numeric[0].x-WIDTH_TOLERANCE);
        if(!lead.length||norm(lead.map(t=>t.value).join(' '))!==norm(name))continue;
        anchors.push({nameX:lead[0].x,numbers:numeric.map(t=>t.x)});
      }
    }
  }
  if(anchors.length<2)return null;
  const names=anchors.map(a=>a.nameX),nameX=median(names);
  if(Math.max(...names)-Math.min(...names)>NAME_TOLERANCE)return null;
  const numbers=Array.from({length:gameCount+2},(_,i)=>median(anchors.map(a=>a.numbers[i])));
  if(numbers.some((x,i)=>anchors.some(a=>Math.abs(a.numbers[i]-x)>WIDTH_TOLERANCE)))return null;
  if(numbers.some((x,i)=>i>0&&x<=numbers[i-1]+WIDTH_TOLERANCE))return null;
  return {nameX,numbers};
}

// A long name may sit 1-2 PDF coordinate points below its numeric cells.
// Only fuse an isolated name and numeric row if their alignment gives one unique match.
function reflowSplitRows(sourceRows,ref,gameCount){
  const rows=(sourceRows||[]).slice();
  const consumed=new Set(),reflow=[];
  const firstX=ref.numbers[0];
  const cells=row=>tokensFor(row);
  const isNameOnly=row=>{const tokens=cells(row);return tokens.length>0&&tokens.every(t=>t.x<firstX-WIDTH_TOLERANCE)};
  const isNumericOnly=row=>{
    const tokens=cells(row);
    return tokens.length>=gameCount&&tokens.every(t=>t.x>=firstX-WIDTH_TOLERANCE&&/^\d+$/.test(t.value));
  };
  for(let i=0;i<rows.length;i++){
    if(consumed.has(i))continue;
    const row=rows[i];
    if(!isNumericOnly(row)){reflow.push(row);continue;}
    const matches=rows.map((other,j)=>({other,j})).filter(({other,j})=>
      !consumed.has(j)&&i!==j&&isNameOnly(other)&&
      Math.abs(Number(other.y)-Number(row.y))<=2.5&&
      Math.abs(cells(other)[0].x-ref.nameX)<=NAME_TOLERANCE);
    if(matches.length!==1){reflow.push({...row,_unpairedNumeric:true});continue;}
    const {other,j}=matches[0];consumed.add(j);
    reflow.push({...row,text:strip(other.text)+' '+strip(row.text),parts:[...other.parts,...row.parts],_geometryReflow:true});
  }
  return reflow;
}

/** Try a second, geometry-proven pass when the normal PDF parser fails.
 * No server writes occur here. Uncertain/damaged rows fail closed.
 */
export function recoverCompletePdfField(groups,candidate,expectedCompetitionSize=null){
  if(!candidate || candidate.errors?.length || candidate.config?.fullFieldReady===true)return null;
  const cfg=candidate.config,gameCount=cfg?.games?.length;
  if(!Number.isInteger(gameCount)||gameCount<1||!Array.isArray(cfg.participants)||cfg.participants.length!==4)return null;
  if(!Array.isArray(groups)||!groups.length||groups.some(g=>(g.sourceRows||[]).some(r=>r.kind!=='pdf')))return null;
  const pages=groups.map(g=>g.pageNumber),firstPage=pages[0];
  if(!Number.isInteger(firstPage)||new Set(pages).size!==groups.length||pages.some((p,i)=>p!==firstPage+i))return null;
  const fingerprints=groups.map(g=>g.pageFingerprint).filter(Boolean);
  if(new Set(fingerprints).size!==fingerprints.length)return null;
  const ref=geometryFromTracked(groups,cfg.participants,gameCount);
  if(!ref)return null;
  const trackedNames=new Set(cfg.participants.map(p=>norm(p.sourceName)));
  const seen=new Set(),anonymous=[];
  let nonsubmissions=0,invalidCells=0,missingCells=0;
  for(const group of groups){
    let proven=0,previousY=null;
    const rows=(group.sourceRows||[]).slice().sort((a,b)=>(a.rowIndex??0)-(b.rowIndex??0));
    for(const row of reflowSplitRows(rows,ref,gameCount)){
      if(row._unpairedNumeric)return null;
      const result=classifyRow(row,ref,gameCount);
      if(result.kind==='unproven')return null;
      if(result.kind==='other'){
        const numericTokens=strip(row.text).split(' ').filter(t=>/^\d+$/.test(t));
        if(numericTokens.length>=gameCount)return null;
        continue;
      }
      if(seen.has(norm(result.name)))return null;
      seen.add(norm(result.name));proven++;
      if(Number.isFinite(Number(row.y))){
        const y=Number(row.y);
        if(previousY!==null && Math.abs(previousY-y)<2)return null;
        previousY=y;
      }
      if(result.kind==='no-submission'){
        if(trackedNames.has(norm(result.name))){
          const tracked=cfg.participants.find(p=>norm(p.sourceName)===norm(result.name));
          if(!tracked||!Array.isArray(tracked.pickNumbers)||tracked.pickNumbers.length!==gameCount||
             !tracked.pickNumbers.every(v=>v===null)||tracked.tiebreak!==null)return null;
        }
        nonsubmissions++;continue;
      }
      if(trackedNames.has(norm(result.name))){
        const tracked=cfg.participants.find(p=>norm(p.sourceName)===norm(result.name));
        if(!tracked||JSON.stringify(result.pickNumbers)!==JSON.stringify(tracked.pickNumbers)||result.tiebreak!==tracked.tiebreak)return null;
        continue;
      }
      invalidCells+=result.invalid;missingCells+=result.missing;
      anonymous.push({id:'field-'+String(anonymous.length+1).padStart(3,'0'),pickNumbers:result.pickNumbers,tiebreak:result.tiebreak});
    }
    if(proven<2)return null;
  }
  if(anonymous.length===0)return null;
  if(!cfg.participants.every(p=>seen.has(norm(p.sourceName))))return null;
  const competitionSize=anonymous.length+cfg.participants.length;
  if(expectedCompetitionSize!==null&&expectedCompetitionSize!==undefined&&competitionSize!==expectedCompetitionSize)return null;
  return {
    ...candidate,
    config:{...cfg,fullFieldReady:true,fieldEntries:anonymous,fullFieldEntryCount:anonymous.length,competitionSize},
    fullFieldIssues:[],competitionSize,
    recovery:{method:'verified-pdf-geometry',anonymousEntries:anonymous.length,noSubmissions:nonsubmissions,invalidCells,missingCells,pages:groups.length}
  };
}
