// Conservative second-pass PDF row recovery for complete external Pick'em sheets.
// The source PDF stays in the browser; only anonymous validated picks can be published.
// Recovery succeeds only when the PDF itself proves every participant row: verified columns, one unbroken table from the
// first page's Pts/W header to the last page, and a pool size consistent with the previous published week. Anything
// else is refused with a specific reason (page and row numbers, never names) so the publisher knows what to check.
const strip = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const median = items => { const values = items.slice().sort((a,b)=>a-b); const n=values.length; return n%2?values[(n-1)/2]:(values[n/2-1]+values[n/2])/2; };
const norm = value => strip(value).toLowerCase();
const WIDTH_TOLERANCE=8;
const NAME_TOLERANCE=14;
// Consecutive table rows sit one row pitch apart. A larger step means at least one row is absent from the PDF text.
const GAP_LIMIT=1.5;
// Every full page of the printed table starts and ends at the same height; allow a fraction of a row for print rounding.
const EDGE_LIMIT=0.75;
const pickFor=(games,column,raw)=>raw===games[column].awayNumber||raw===games[column].homeNumber;
const NOT_A_NAME=/^(week\s+\d+\b.*|entry|participant|name|pts|w)$/i;
const MATCHUP_KEY=/^\d{1,2}\)\s*\S.*\s+at\s+\d{1,2}\)/i;

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
function classifyRow(row,ref,games){
  const gameCount=games.length;
  const tokens=tokensFor(row);
  if(!tokens.length)return {kind:'other'};
  const {lead,name}=extractName(tokens,ref.numbers[0]);
  if(!lead.length || !name || Math.abs(lead[0].x-ref.nameX)>NAME_TOLERANCE)return {kind:'other'};
  if(NOT_A_NAME.test(name)||MATCHUP_KEY.test(strip(row.text)))return {kind:'other'};
  const trailing=tokens.filter(t=>t.x>=ref.numbers[0]-WIDTH_TOLERANCE);
  const columns=Array(gameCount+2).fill(null);
  let lastColumn=-1;
  for(const t of trailing){
    if(!/^\d+$/.test(t.value))return {kind:'unproven',why:'text in the pick columns is not a pick number'};
    const distances=ref.numbers.map(x=>Math.abs(x-t.x));
    const column=distances.indexOf(Math.min(...distances));
    if(distances[column]>WIDTH_TOLERANCE || column<=lastColumn || columns[column]!==null)return {kind:'unproven',why:'its numbers do not line up with the verified pick, Pts and W columns'};
    columns[column]=Number(t.value);lastColumn=column;
  }
  const presentPicks=columns.slice(0,gameCount).filter(v=>v!==null).length;
  if(columns[gameCount+1]===null){
    if(presentPicks>0||columns[gameCount]!==null)return {kind:'unproven',why:'its W column is empty'};
    // A name with no cells at all: a participant whose numbers are missing from the PDF text, or a note. Decided by
    // where it sits relative to the table (see nameOnly below).
    return {kind:'name-only'};
  }
  if(!Number.isInteger(columns[gameCount+1]) || columns[gameCount+1]<0 || columns[gameCount+1]>gameCount)return {kind:'unproven',why:'its W value is out of range'};
  if(presentPicks===0){
    if(columns[gameCount]!==null || columns[gameCount+1]!==gameCount)return {kind:'unproven',why:'it has no picks but is not a complete no-submission row'};
    return {kind:'no-submission',name};
  }
  const picks=[];
  let invalid=0;
  for(let i=0;i<gameCount;i++){
    const number=columns[i];
    if(number===null){picks.push(0);continue;}
    if(!pickFor(games,i,number)){invalid++;picks.push(0);continue;}
    picks.push(number);
  }
  if(invalid>2)return {kind:'unproven',why:`${invalid} of its pick cells are not valid for their games`};
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
    return tokens.length>=1&&tokens.every(t=>t.x>=firstX-WIDTH_TOLERANCE&&/^\d+$/.test(t.value)&&
      ref.numbers.some(x=>Math.abs(x-t.x)<=WIDTH_TOLERANCE));
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
  // A name-only row consumed by a later numeric row was pushed before its partner was seen; drop it now.
  return reflow.filter(row=>!consumed.has(rows.indexOf(row)));
}

// The Pts/W header of the participant table, aligned with the verified tiebreak and W columns.
function isTableHeader(row,ref,gameCount){
  const tokens=tokensFor(row);
  const pts=tokens.find(t=>/^pts(?:\/tiebreak)?$/i.test(t.value)),w=tokens.find(t=>/^w$/i.test(t.value));
  return !!pts&&!!w&&Math.abs(pts.x-ref.numbers[gameCount])<=WIDTH_TOLERANCE&&Math.abs(w.x-ref.numbers[gameCount+1])<=WIDTH_TOLERANCE;
}

// Pool-size cross-check for a document that cannot reveal a cleanly removed page: a recovered pool that is smaller
// than the previous published week by half a printed page or more is refused unless the publisher typed the total.
export function recoveredFieldSizeIssue(recovery,competitionSize,previous){
  const confirm=`If ${competitionSize} matches the organizer's pool, type ${competitionSize} in Total pool entries and read the sheet again`;
  if(!previous||!Number.isInteger(previous.week))
    return `there is no earlier week this season to cross-check the recovered pool size of ${competitionSize} entries. ${confirm}`;
  if(!Number.isSafeInteger(previous.competitionSize))
    return `Week ${previous.week} is not a published full-field week, so the recovered pool size of ${competitionSize} entries cannot be cross-checked. ${confirm}`;
  const halfPage=Math.max(5,Math.floor((recovery?.rowsPerFullPage||0)/2));
  if(previous.competitionSize-competitionSize>=halfPage)
    return `the PDF's rows add up to ${competitionSize} entries, ${previous.competitionSize-competitionSize} fewer than Week ${previous.week} (${previous.competitionSize}). A page may be missing from this PDF: check that every page of the organizer's sheet is present. If the pool really has ${competitionSize} entries, type ${competitionSize} in Total pool entries and read the sheet again`;
  return null;
}

/** Recovery applies only to a PDF week whose four tracked rows validated but whose full field the first pass could not prove. */
export function pdfRecoveryApplies(groups,candidate){
  if(!candidate || candidate.errors?.length || candidate.config?.fullFieldReady===true)return false;
  const cfg=candidate.config,gameCount=cfg?.games?.length;
  if(!Number.isInteger(gameCount)||gameCount<1||!Array.isArray(cfg.participants)||cfg.participants.length!==4)return false;
  return Array.isArray(groups)&&groups.length>0&&groups.every(g=>(g.sourceRows||[]).every(r=>r.kind==='pdf'));
}
/** Try a second, geometry-proven pass when the normal PDF parser fails.
 * Returns {candidate, reason}: a recovered candidate, or null with the specific reason recovery was refused (reason is
 * null when recovery does not apply). No server writes occur here. Uncertain/damaged rows fail closed.
 * options.previous: {week, competitionSize} of the week before (competitionSize null when it is not a published full-field
 * week), or null when there is no earlier week; leave it undefined only when expectedCompetitionSize is supplied (a typed
 * total replaces the cross-check) or the evidence could not be read (options.unavailable says why).
 */
export function attemptPdfFieldRecovery(groups,candidate,expectedCompetitionSize=null,options={}){
  const refuse=reason=>({candidate:null,reason});
  if(!pdfRecoveryApplies(groups,candidate))return {candidate:null,reason:null};
  const cfg=candidate.config,gameCount=cfg.games.length;
  const pages=groups.map(g=>g.pageNumber),firstPage=pages[0];
  if(!Number.isInteger(firstPage)||new Set(pages).size!==groups.length||pages.some((p,i)=>p!==firstPage+i))return refuse('the PDF pages are not one contiguous run');
  const fingerprints=groups.map(g=>g.pageFingerprint).filter(Boolean);
  if(fingerprints.length!==groups.length||new Set(fingerprints).size!==fingerprints.length)return refuse('a PDF page is repeated or unreadable');
  const ref=geometryFromTracked(groups,cfg.participants,gameCount);
  if(!ref)return refuse('the pick, Pts and W columns could not be verified from at least two complete tracked rows');
  const trackedNames=new Set(cfg.participants.map(p=>norm(p.sourceName)));
  const seen=new Set(),anonymous=[],tables=[];
  let nonsubmissions=0,invalidCells=0,missingCells=0;
  for(const group of groups){
    const page=group.pageNumber,table=[],nameOnly=[],headers=[];
    let previousY=null;
    const rows=(group.sourceRows||[]).slice().sort((a,b)=>(a.rowIndex??0)-(b.rowIndex??0));
    for(const row of reflowSplitRows(rows,ref,gameCount)){
      const at=()=>`PDF page ${page}, table row ${table.length+1}`;
      if(row._unpairedNumeric)return refuse(`${at()}: a row of pick numbers has no participant name beside it`);
      if(isTableHeader(row,ref,gameCount)){headers.push(Number(row.y));continue;}
      const result=classifyRow(row,ref,cfg.games);
      if(result.kind==='unproven')return refuse(`${at()}: ${result.why}`);
      if(result.kind==='name-only'){nameOnly.push({y:Number(row.y),position:table.length});continue;}
      if(result.kind==='other'){
        const numericTokens=strip(row.text).split(' ').filter(t=>/^\d+$/.test(t));
        if(numericTokens.length>=gameCount)return refuse(`PDF page ${page}: a row of ${numericTokens.length} numbers is outside the participant name column`);
        continue;
      }
      if(seen.has(norm(result.name)))return refuse(`${at()}: the same participant name appears on two rows, so a repeated row cannot be ruled out. If two entrants really share that name, ask the organizer for a sheet that tells them apart`);
      seen.add(norm(result.name));
      const y=Number(row.y);
      if(!Number.isFinite(y))return refuse(`${at()}: the row has no position on the page`);
      if(previousY!==null && Math.abs(previousY-y)<2)return refuse(`${at()}: two rows overlap at the same height`);
      previousY=y;table.push(y);
      if(result.kind==='no-submission'){
        if(trackedNames.has(norm(result.name))){
          const tracked=cfg.participants.find(p=>norm(p.sourceName)===norm(result.name));
          if(!tracked||!Array.isArray(tracked.pickNumbers)||tracked.pickNumbers.length!==gameCount||
             !tracked.pickNumbers.every(v=>v===null)||tracked.tiebreak!==null)return refuse(`${at()}: a tracked entry's row disagrees with its validated picks`);
        }
        nonsubmissions++;continue;
      }
      if(trackedNames.has(norm(result.name))){
        const tracked=cfg.participants.find(p=>norm(p.sourceName)===norm(result.name));
        if(!tracked||JSON.stringify(result.pickNumbers)!==JSON.stringify(tracked.pickNumbers)||result.tiebreak!==tracked.tiebreak)return refuse(`${at()}: a tracked entry's row disagrees with its validated picks`);
        continue;
      }
      invalidCells+=result.invalid;missingCells+=result.missing;
      anonymous.push({id:'field-'+String(anonymous.length+1).padStart(3,'0'),pickNumbers:result.pickNumbers,tiebreak:result.tiebreak});
    }
    tables.push({page,table,nameOnly,headers});
  }
  if(!cfg.participants.every(p=>seen.has(norm(p.sourceName))))return refuse('not every tracked entry was found in the participant table');
  if(anonymous.length===0)return refuse('no anonymous participant rows were found');

  // Continuity: the participant table must run unbroken from the first page's header to the last page.
  const last=tables.length-1;
  if(tables.some((t,i)=>i<last&&t.table.length===0))return refuse(`PDF page ${tables.find((t,i)=>i<last&&t.table.length===0).page} has no readable participant rows (it may be a scanned image or blank page)`);
  const gaps=tables.flatMap(t=>t.table.slice(1).map((y,i)=>t.table[i]-y));
  if(!gaps.length)return refuse('the participant table is too short to measure its row spacing');
  const pitch=median(gaps);
  if(!(pitch>0))return refuse('the participant table row spacing could not be measured');
  // A name with no cells inside (or right next to) the table is a participant whose numbers are missing: never dropped.
  for(const t of tables){
    const top=t.table.length?t.table[0]:Infinity,bottom=t.table.length?t.table[t.table.length-1]:-Infinity;
    for(const n of t.nameOnly){
      if(!t.table.length||n.y<=top+pitch*GAP_LIMIT&&n.y>=bottom-pitch*GAP_LIMIT)return refuse(`PDF page ${t.page}, table row ${n.position+1}: a participant name has no pick, Pts or W cells`);
    }
  }
  for(const t of tables){
    for(let i=1;i<t.table.length;i++){
      const gap=t.table[i-1]-t.table[i];
      if(gap<=0||gap>pitch*GAP_LIMIT)return refuse(`PDF page ${t.page}: between table rows ${i} and ${i+1} there is room for ${Math.max(1,Math.round(gap/pitch)-1)} more row(s), so a participant row may be missing from the PDF`);
    }
  }
  const first=tables[0];
  if(!first.table.length)return refuse(`PDF page ${first.page} has no readable participant rows`);
  const header=first.headers.filter(y=>y>first.table[0]).sort((a,b)=>a-b)[0];
  if(header===undefined||header-first.table[0]>pitch*GAP_LIMIT)return refuse(`PDF page ${first.page}: the Pts/W header is not directly above the first participant row, so rows missing at the top of the table cannot be ruled out`);
  // Every page but the last is filled down to the same bottom margin, so any two of them end within one row of each
  // other. Middle pages (neither first nor last) are printed identically and align exactly; the first page's rows follow
  // the title and header, so it may end anywhere less than one full row away from them. More space than that on a page
  // is room for a row that is missing from it.
  const bottomOf=t=>t.table[t.table.length-1],tops=tables.slice(1).filter(t=>t.table.length).map(t=>t.table[0]);
  const commonTop=tops.length?Math.max(...tops):null;
  for(let i=0;i<last;i++)for(let j=0;j<last;j++){
    const higher=bottomOf(tables[i])-bottomOf(tables[j]),limit=i===0||j===0?pitch-0.5:pitch*EDGE_LIMIT;
    if(i!==j&&higher>limit)return refuse(`PDF page ${tables[i].page}: the participant table stops about ${Math.max(1,Math.round(higher/pitch))} row(s) higher than on page ${tables[j].page}, so rows may be missing from page ${tables[i].page}`);
  }
  for(let i=1;i<tables.length;i++){
    const t=tables[i];if(!t.table.length)continue;
    if(commonTop-t.table[0]>pitch*EDGE_LIMIT)return refuse(`PDF page ${t.page}: the participant table starts about ${Math.max(1,Math.round((commonTop-t.table[0])/pitch))} row(s) below the top of the other pages, so rows may be missing from that page`);
  }

  const competitionSize=anonymous.length+cfg.participants.length;
  const rowsPerFullPage=Math.max(...tables.map(t=>t.table.length));
  const recovery={method:'verified-pdf-geometry',anonymousEntries:anonymous.length,noSubmissions:nonsubmissions,invalidCells,missingCells,
    missingTiebreaks:anonymous.filter(e=>e.tiebreak===null).length,pages:groups.length,rowsPerFullPage};
  if(expectedCompetitionSize!==null&&expectedCompetitionSize!==undefined){
    if(competitionSize!==expectedCompetitionSize)return refuse(`the PDF's verified rows add up to ${competitionSize} entries (${anonymous.length} anonymous and ${cfg.participants.length} tracked), but Total pool entries says ${expectedCompetitionSize}. Correct or clear the total and read the sheet again`);
  }else{
    if(options.previous===undefined)return refuse(`the recovered pool size of ${competitionSize} entries could not be cross-checked against the previous published week${options.unavailable?`: ${options.unavailable}. Or type the organizer's total in Total pool entries and read the sheet again`:`. Read the sheet again, or type the organizer's total in Total pool entries`}`);
    const issue=recoveredFieldSizeIssue(recovery,competitionSize,options.previous);
    if(issue)return refuse(issue);
  }
  return {reason:null,candidate:{
    ...candidate,
    config:{...cfg,fullFieldReady:true,fieldEntries:anonymous,fullFieldEntryCount:anonymous.length,competitionSize},
    fullFieldIssues:[],competitionSize,recovery
  }};
}

/** Backward-compatible form: the recovered candidate, or null. */
export function recoverCompletePdfField(groups,candidate,expectedCompetitionSize=null,options={}){
  return attemptPdfFieldRecovery(groups,candidate,expectedCompetitionSize,options).candidate;
}
