export const TARGETS=[
  {id:'dc',displayName:'D.C.',aliases:['D.C.','D.C','DC']},
  {id:'jc',displayName:'JC',aliases:['JC']},
  {id:'djs',displayName:'DJS',aliases:['DJS']},
  {id:'thaddeus',displayName:'Thaddeus',aliases:['Thaddius','Thaddeus']},
];

const TEAM_ALIASES={
  cardinals:'ARI',falcons:'ATL',ravens:'BAL',bills:'BUF',panthers:'CAR',bears:'CHI',bengals:'CIN',browns:'CLE',cowboys:'DAL',broncos:'DEN',lions:'DET',packers:'GB',texans:'HOU',colts:'IND',jaguars:'JAX',jags:'JAX',chiefs:'KC',raiders:'LV',chargers:'LAC',rams:'LAR',dolphins:'MIA',vikings:'MIN',patriots:'NE',pats:'NE',saints:'NO',giants:'NYG',jets:'NYJ',eagles:'PHI',steelers:'PIT','49ers':'SF',niners:'SF',seahawks:'SEA',buccaneers:'TB',bucs:'TB',titans:'TEN',commanders:'WAS',washington:'WAS'
};

const clean=s=>String(s??'').replace(/\s+/g,' ').trim();
const escapeRegex=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const normalizeTeamCode=x=>{const code=String(x??'').toUpperCase();return({JAC:'JAX',WSH:'WAS'}[code]||code)};
const exactName=s=>clean(s).toLowerCase();

export function teamAbbr(name){
  const raw=clean(name).toLowerCase().replace(/[.]/g,'');
  if(TEAM_ALIASES[raw])return TEAM_ALIASES[raw];
  for(const [key,val] of Object.entries(TEAM_ALIASES))if(raw.endsWith(key)||raw.includes(` ${key}`))return val;
  return null;
}

export function detectWeek(text){const m=clean(text).match(/\bWeek\s+(\d{1,2})\b/i);return m?Number(m[1]):null}

export function carryForwardWeekHints(groups){
  let active=null;
  return (groups||[]).map(group=>{
    if(Number.isInteger(group?.week))active=group.week;
    return {...group,week:active};
  });
}

export function groupPdfTextItems(items){
  const rows=[];
  for(const item of items||[]){const text=clean(item?.str);if(!text)continue;const tr=item?.transform||[];const x=Number(tr[4]??0),y=Number(tr[5]??0);let row=rows.find(r=>Math.abs(r.y-y)<=1.5);if(!row){row={y,parts:[]};rows.push(row)}row.parts.push({x,text})}
  return rows.sort((a,b)=>b.y-a.y).map((r,rowIndex)=>{const parts=r.parts.sort((a,b)=>a.x-b.x);const text=parts.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim();return{text,y:r.y,rowIndex,parts:parts.map(p=>({x:p.x,text:p.text}))}}).filter(r=>r.text);
}

function matchupFromLine(line){
  const s=clean(line);const m=s.match(/(?:^|\s)(\d{1,2})\)\s*([A-Za-z0-9 .'-]+?)\s+at\s+(\d{1,2})\)\s*([A-Za-z0-9 .'-]+?)(?=\s*$)/i);
  if(!m)return null;const awayNumber=Number(m[1]),homeNumber=Number(m[3]),awayName=clean(m[2]),homeName=clean(m[4]),away=teamAbbr(awayName),home=teamAbbr(homeName);if(!away||!home)return{error:`Unknown team name in: ${s}`};return{awayNumber,homeNumber,awayName,homeName,away,home};
}

function targetRowIdentity(line,target){
  const s=clean(line);
  for(const alias of target.aliases){
    const m=s.match(new RegExp('^('+escapeRegex(clean(alias))+')\\s+(.+)$','i'));
    if(m&&/^\d+$/.test(clean(m[2]).split(' ')[0]))return true;
  }
  return false;
}

function trackedTargetForName(name){
  const n=exactName(name);
  return TARGETS.find(target=>target.aliases.some(alias=>exactName(alias)===n))||null;
}

function structuralParticipantRow(line,gameCount){
  const tokens=clean(line).split(' ').filter(Boolean),candidates=[];
  if(tokens.length<gameCount+3)return null;
  for(let start=1;start<tokens.length;start++){
    if(tokens.length-start!==gameCount+2)continue;
    const nums=tokens.slice(start);
    if(!nums.every(token=>/^\d+$/.test(token)))continue;
    const values=nums.map(Number),sourceName=clean(tokens.slice(0,start).join(' '));if(!sourceName)continue;
    candidates.push({sourceName,pickNumbers:values.slice(0,gameCount),tiebreak:values[gameCount],wins:values[gameCount+1]});
  }
  return candidates.length===1?candidates[0]:null;
}

function regularParticipantRow(line,matchups){
  const parsed=structuralParticipantRow(line,matchups.length);if(!parsed)return null;
  for(let i=0;i<matchups.length;i++){const g=matchups[i],n=parsed.pickNumbers[i];if(n!==g.awayNumber&&n!==g.homeNumber)return null}
  return parsed;
}

function anonymousParticipantRow(line,matchups){
  const parsed=structuralParticipantRow(line,matchups.length);if(!parsed)return null;
  let noPicks=0;
  const pickNumbers=parsed.pickNumbers.map((n,i)=>{const g=matchups[i];if(n===g.awayNumber||n===g.homeNumber)return n;noPicks++;return 0});
  return noPicks<=1?{...parsed,pickNumbers}:null;
}

function median(values){const a=values.slice().sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}

function pdfRowGap(a,b){
  const ay=Number(a?.row?.y),by=Number(b?.row?.y);
  return Number.isFinite(ay)&&Number.isFinite(by)?Math.abs(ay-by):null;
}

function pdfParticipantSpacingModel(pageMap){
  const anchoredPages=new Set();
  for(const [page,pageRecords] of pageMap){if(pageRecords.some(r=>r.tracked&&r.geometryMatch))anchoredPages.add(page)}
  const anchorGaps=[];
  for(const page of anchoredPages){
    const pageRecords=pageMap.get(page)||[];
    for(let i=1;i<pageRecords.length;i++){
      const prev=pageRecords[i-1],next=pageRecords[i];
      if(!prev.geometryMatch||!next.geometryMatch||(!prev.tracked&&!next.tracked))continue;
      const gap=pdfRowGap(prev,next);if(Number.isFinite(gap)&&gap>0)anchorGaps.push(gap);
    }
  }
  if(anchorGaps.length<2)return null;
  const normalGap=median(anchorGaps),deviations=anchorGaps.map(g=>Math.abs(g-normalGap)),mad=median(deviations);
  const tolerance=Math.max(normalGap*0.75,Math.min(normalGap,mad*4));
  return{normalGap,maxGap:normalGap+tolerance};
}

function pdfParticipantGeometry(row,parsed,gameCount){
  if(!row||row.kind!=='pdf'||!Array.isArray(row.parts)||!parsed)return null;
  const tokens=[];
  for(const part of row.parts){
    const x=Number(part?.x);if(!Number.isFinite(x))continue;
    for(const token of clean(part?.text).split(' ').filter(Boolean))tokens.push({token,x});
  }
  const tailCount=gameCount+2;
  if(tokens.length<=tailCount)return null;
  const tail=tokens.slice(-tailCount);
  if(!tail.every(t=>/^\d+$/.test(t.token)))return null;
  const expected=[...(parsed.pickNumbers||[]),parsed.tiebreak,parsed.wins].map(String);
  if(expected.length!==tail.length||tail.some((t,i)=>t.token!==expected[i]))return null;
  const numericXs=tail.map(t=>t.x),distinct=new Set(numericXs.map(x=>x.toFixed(2))).size;
  if(distinct<Math.min(6,tailCount))return null;
  const nameTokens=tokens.slice(0,-tailCount),firstNumericX=numericXs[0];
  if(!nameTokens.length||nameTokens.some(t=>t.x>=firstNumericX-4))return null;
  return{nameX:nameTokens[0]?.x,numericXs};
}

function pdfHeaderFingerprint(row,ref){
  if(!row||row.kind!=='pdf'||!Array.isArray(row.parts))return null;
  const tokens=[];
  for(const part of row.parts){
    const x=Number(part?.x);if(!Number.isFinite(x))continue;
    for(const token of clean(part?.text).split(' ').filter(Boolean))tokens.push({token,x});
  }
  const pts=tokens.find(t=>/^pts(?:\/tiebreak)?$/i.test(t.token)),win=tokens.find(t=>/^w$/i.test(t.token));
  if(!pts||!win)return null;
  const last=ref.numericXs.length-1;
  if(Math.abs(pts.x-ref.numericXs[last-1])>8||Math.abs(win.x-ref.numericXs[last])>8)return null;
  return clean(row.text).toLowerCase();
}

function pdfSparseTableEvidence(row,ref){
  if(!row||row.kind!=='pdf'||!Array.isArray(row.parts))return false;
  const tokens=[];
  for(const part of row.parts){
    const x=Number(part?.x);if(!Number.isFinite(x))continue;
    for(const token of clean(part?.text).split(' ').filter(Boolean))tokens.push({token,x});
  }
  const numerics=tokens.filter(t=>/^\d+$/.test(t.token));
  if(tokens.length<2||numerics.length!==1||/^\d+$/.test(tokens[0]?.token||''))return false;
  if(Math.abs(tokens[0].x-ref.nameX)>14)return false;
  const last=ref.numericXs.length-1,x=numerics[0].x;
  return Math.abs(x-ref.numericXs[last])<=10||Math.abs(x-ref.numericXs[last-1])<=10;
}

function pdfTableBoundary(sourceRows,matchups){
  const pdfRows=(sourceRows||[]).filter(r=>r?.kind==='pdf').slice().sort((a,b)=>(a.pageNumber??0)-(b.pageNumber??0)||(a.rowIndex??0)-(b.rowIndex??0)||Number(b.y??0)-Number(a.y??0));
  if(!pdfRows.length)return null;
  const gameCount=matchups.length,records=pdfRows.map(row=>{
    const isMatchup=!!matchupFromLine(row.text),structural=isMatchup?null:structuralParticipantRow(row.text,gameCount),parsed=structural?regularParticipantRow(row.text,matchups):null;
    return{row,structural,parsed,tracked:parsed?trackedTargetForName(parsed.sourceName):null,geometry:structural?pdfParticipantGeometry(row,structural,gameCount):null};
  });
  const trackedRecords=records.filter(r=>r.tracked);
  const issues=[];
  if(trackedRecords.length!==TARGETS.length){issues.push('PDF regular participant table could not be anchored to all tracked entries');return{accepted:new Set(),records,issues};}
  const geometries=trackedRecords.map(r=>r.geometry);
  if(geometries.some(g=>!g)){issues.push('PDF regular participant table column geometry could not be proven');return{accepted:new Set(),records,issues};}
  const nameXs=geometries.map(g=>g.nameX),nameSpread=Math.max(...nameXs)-Math.min(...nameXs);
  const columnXs=Array.from({length:gameCount+2},(_,i)=>geometries.map(g=>g.numericXs[i]));
  if(nameSpread>14||columnXs.some(xs=>Math.max(...xs)-Math.min(...xs)>8)){
    issues.push('PDF regular participant table geometry is inconsistent across tracked entries');return{accepted:new Set(),records,issues};
  }
  const ref={nameX:median(nameXs),numericXs:columnXs.map(median)};
  const matchesGeometry=record=>{
    const g=record.geometry;if(!g)return false;
    if(Math.abs(g.nameX-ref.nameX)>14)return false;
    return g.numericXs.every((x,i)=>Math.abs(x-ref.numericXs[i])<=8);
  };
  records.forEach(r=>{r.geometryMatch=!!(r.structural&&matchesGeometry(r));r.sparseTableEvidence=!r.structural&&pdfSparseTableEvidence(r.row,ref);});

  const pageMap=new Map();
  for(const record of records){const p=record.row.pageNumber??0;if(!pageMap.has(p))pageMap.set(p,[]);pageMap.get(p).push(record)}
  for(const pageRecords of pageMap.values())pageRecords.sort((a,b)=>(a.row.rowIndex??0)-(b.row.rowIndex??0)||Number(b.row.y??0)-Number(a.row.y??0));
  const spacing=pdfParticipantSpacingModel(pageMap);
  const runs=[];
  for(const [page,pageRecords] of [...pageMap.entries()].sort((a,b)=>a[0]-b[0])){
    let current=null;
    pageRecords.forEach((record,pos)=>{
      if(record.geometryMatch){
        const prev=current?.lastEvidence||null,gap=prev?pdfRowGap(prev,record):null;
        const yContinuous=!prev||(spacing&&Number.isFinite(gap)&&gap<=spacing.maxGap);
        if(!current||!yContinuous){current={page,records:[],startPos:pos,endPos:pos,pageSize:pageRecords.length,firstEvidence:record,lastEvidence:record,sparseBridgeCount:0};runs.push(current)}
        current.records.push(record);current.endPos=pos;current.lastEvidence=record;current.sparseBridgeCount=0;
      }else if(current&&record.sparseTableEvidence&&current.sparseBridgeCount===0){
        const gap=pdfRowGap(current.lastEvidence,record);
        if(spacing&&Number.isFinite(gap)&&gap<=spacing.maxGap){current.endPos=pos;current.lastEvidence=record;current.sparseBridgeCount=1}
        else current=null;
      }else current=null;
    });
  }
  const anchorRuns=runs.filter(run=>run.records.some(r=>r.tracked)).sort((a,b)=>a.page-b.page||a.startPos-b.startPos);
  if(!anchorRuns.length){issues.push('PDF regular participant table region could not be anchored');return{accepted:new Set(),records,issues};}
  const seed=anchorRuns[0],acceptedRuns=new Set([seed]);
  const pageRuns=new Map();for(const run of runs){if(!pageRuns.has(run.page))pageRuns.set(run.page,[]);pageRuns.get(run.page).push(run)}
  const headerBefore=run=>{
    const pageRecords=pageMap.get(run.page)||[];
    for(let i=run.startPos-1;i>=Math.max(0,run.startPos-4);i--){
      const record=pageRecords[i],fingerprint=pdfHeaderFingerprint(record?.row,ref);
      if(fingerprint)return{fingerprint,record};
    }
    return null;
  };
  const headerGapIsProven=(header,run)=>{
    if(!header||!spacing)return false;
    const headerY=header.record?.row?.y,firstY=run.records[0]?.row?.y;
    if(!Number.isFinite(headerY)||!Number.isFinite(firstY))return false;
    const gap=headerY-firstY;
    return gap>0&&gap<=spacing.normalGap*2;
  };
  const headerFingerprint=anchorRuns.map(run=>{
    const header=headerBefore(run);
    return headerGapIsProven(header,run)?header.fingerprint:null;
  }).find(Boolean)||null;
  const hasMatchingHeader=run=>{
    const header=headerBefore(run);
    return !!headerFingerprint&&headerGapIsProven(header,run)&&header.fingerprint===headerFingerprint;
  };
  const allYs=records.map(r=>Number(r.row?.y)).filter(Number.isFinite),documentTopY=allYs.length?Math.max(...allYs):null;
  const edgeBand=spacing&&Number.isFinite(documentTopY)?Math.max(spacing.maxGap*2,documentTopY*0.08):null;
  const nearPhysicalBottom=run=>{
    if(!edgeBand)return false;
    const y=Number((run.lastEvidence||run.records[run.records.length-1])?.row?.y);
    return Number.isFinite(y)&&y>=0&&y<=edgeBand;
  };
  const nearPhysicalTop=run=>{
    if(!edgeBand||!Number.isFinite(documentTopY))return false;
    const y=Number((run.firstEvidence||run.records[0])?.row?.y);
    return Number.isFinite(y)&&documentTopY-y<=edgeBand;
  };
  const strictEdgeContinuation=(prev,next)=>prev.endPos===prev.pageSize-1&&next.startPos<=1&&next.records.length>=2&&nearPhysicalBottom(prev)&&nearPhysicalTop(next);
  const headerContinuation=(prev,next)=>prev.endPos===prev.pageSize-1&&nearPhysicalBottom(prev)&&nearPhysicalTop(next)&&hasMatchingHeader(next);
  const canContinue=(prev,next)=>next.page===prev.page+1&&(headerContinuation(prev,next)||strictEdgeContinuation(prev,next));

  let frontier=seed;
  while(frontier){
    const nextPage=frontier.page+1,candidates=(pageRuns.get(nextPage)||[]).filter(run=>canContinue(frontier,run));
    if(candidates.length!==1)break;
    frontier=candidates[0];acceptedRuns.add(frontier);
  }
  frontier=seed;
  while(frontier){
    const prevPage=frontier.page-1,candidates=(pageRuns.get(prevPage)||[]).filter(run=>canContinue(run,frontier));
    if(candidates.length!==1)break;
    frontier=candidates[0];acceptedRuns.add(frontier);
  }
  if(anchorRuns.some(run=>!acceptedRuns.has(run)))issues.push('Tracked entries do not form one continuous PDF participant-table chain');
  const accepted=new Set();for(const run of acceptedRuns)for(const record of run.records)accepted.add(sourceRowKey(record.row));
  const outside=records.filter(r=>r.parsed&&!r.tracked&&!accepted.has(sourceRowKey(r.row)));
  if(outside.length)issues.push('Participant-shaped PDF row exists outside the proven regular participant table');
  return{accepted,records,issues};
}

function spreadsheetContract(sourceRows,gameCount){
  const header=(sourceRows||[]).find(r=>r&&r.kind==='spreadsheet'&&Array.isArray(r.cells)&&r.cells.some(c=>/^pts(?:\/tiebreak)?$/i.test(clean(c)))&&r.cells.some(c=>/^w$/i.test(clean(c))));
  if(!header)return null;
  const cells=header.cells.map(clean),ptsIndex=cells.findIndex(c=>/^pts(?:\/tiebreak)?$/i.test(c)),wIndex=cells.findIndex(c=>/^w$/i.test(c));
  if(ptsIndex<0||wIndex!==ptsIndex+1||ptsIndex-gameCount<1)return null;
  return{sheetName:header.sheetName,headerRowNumber:header.rowNumber,nameIndex:ptsIndex-gameCount-1,pickStart:ptsIndex-gameCount,ptsIndex,wIndex};
}

function spreadsheetParticipantRow(sourceRow,contract,matchups){
  if(!sourceRow||sourceRow.kind!=='spreadsheet'||!contract||sourceRow.sheetName!==contract.sheetName||sourceRow.rowNumber===contract.headerRowNumber)return null;
  const cells=(sourceRow.cells||[]).map(clean);
  if(cells.length<=contract.wIndex)return null;
  const sourceName=cells[contract.nameIndex],pickCells=cells.slice(contract.pickStart,contract.ptsIndex),tail=cells.slice(contract.ptsIndex,contract.wIndex+1),extra=cells.slice(contract.wIndex+1).filter(Boolean);
  if(!sourceName||extra.length||pickCells.length!==matchups.length||!pickCells.every(v=>/^\d+$/.test(v))||!tail.every(v=>/^\d+$/.test(v)))return null;
  const pickNumbers=pickCells.map(Number);
  for(let i=0;i<matchups.length;i++){const g=matchups[i],n=pickNumbers[i];if(n!==g.awayNumber&&n!==g.homeNumber)return null}
  return{sourceName,pickNumbers,tiebreak:Number(tail[0]),wins:Number(tail[1])};
}

function looksLikeDamagedParticipantRow(line,gameCount){
  const tokens=clean(line).split(' ');
  const numericCount=tokens.reduce((n,token)=>n+(/^\d+$/.test(token)?1:0),0);
  return tokens.length>=gameCount+1&&numericCount>=gameCount&&tokens.some(t=>!/^\d+$/.test(t));
}

function validatePickNumbers(label,pickNumbers,tiebreak,numberToGame,gameCount,{allowNoPick=false}={}){
  const errors=[],seenGames=new Set();let noPicks=0;
  for(const n of pickNumbers||[]){
    if(allowNoPick&&n===0){noPicks++;continue}
    const gi=numberToGame.get(n);
    if(gi===undefined)errors.push(label+': pick '+n+' is not in the matchup key');
    else if(seenGames.has(gi))errors.push(label+': two picks in matchup '+(gi+1));
    else seenGames.add(gi);
  }
  if(noPicks>1)errors.push(label+': at most one explicit no-pick is allowed');
  if((pickNumbers||[]).length!==gameCount||seenGames.size+noPicks!==gameCount)errors.push(label+': expected exactly one pick or explicit no-pick for each of '+gameCount+' games');
  if(!Number.isInteger(tiebreak))errors.push(label+': missing tiebreak total');
  return errors;
}

function sourceRowKey(row){
  if(row&&row.kind==='pdf')return 'pdf:'+(row.pageNumber??'?')+':'+Number(row.y??0).toFixed(2)+':'+clean(row.text);
  if(row&&row.kind==='spreadsheet')return 'sheet:'+(row.sheetName??'?')+':'+(row.rowNumber??'?')+':'+(row.cells||[]).map(clean).join('|');
  return 'text:'+clean(row&&row.text!==undefined?row.text:row);
}

function parseWeekGroup(week,weekGroups,filename,season){
  const errors=[],fullFieldIssues=[],lines=[],sourceRows=[],pageFingerprints=new Set();
  for(const group of weekGroups||[]){
    if(group.pageFingerprint){
      if(pageFingerprints.has(group.pageFingerprint)){fullFieldIssues.push('Duplicate PDF page or repeated source table region detected');continue}
      pageFingerprints.add(group.pageFingerprint);
    }
    for(const line of group.lines||[])lines.push(clean(line));
    for(const row of group.sourceRows||[])sourceRows.push(row);
  }
  const seenPair=new Set(),seenTeams=new Set(),matchups=[];
  for(const line of lines){
    const m=matchupFromLine(line);if(!m)continue;if(m.error){errors.push(m.error);continue}
    const key=m.awayNumber+'-'+m.homeNumber;if(seenPair.has(key)){errors.push('Duplicate matchup pair '+key);continue}
    const teamKey=m.away+'-'+m.home;if(seenTeams.has(teamKey)){errors.push('Duplicate matchup teams '+teamKey);continue}
    seenPair.add(key);seenTeams.add(teamKey);matchups.push(m);
  }
  matchups.sort((a,b)=>Math.min(a.awayNumber,a.homeNumber)-Math.min(b.awayNumber,b.homeNumber));
  if(!matchups.length)return null;
  const gameCount=matchups.length,numberToGame=new Map();
  matchups.forEach((g,i)=>{if(numberToGame.has(g.awayNumber)||numberToGame.has(g.homeNumber))errors.push('Duplicate matchup number');numberToGame.set(g.awayNumber,i);numberToGame.set(g.homeNumber,i)});

  const sourceByText=new Map();
  for(const row of sourceRows){const t=clean(row.text);if(t&&!sourceByText.has(t))sourceByText.set(t,[]);if(t)sourceByText.get(t).push(row)}
  const sheetContract=spreadsheetContract(sourceRows,gameCount),hasSpreadsheet=sourceRows.some(r=>r.kind==='spreadsheet'),hasPdf=sourceRows.some(r=>r.kind==='pdf');
  if(hasSpreadsheet&&!sheetContract)fullFieldIssues.push('Spreadsheet regular-pool headers could not be proven');
  const pdfBoundary=hasPdf?pdfTableBoundary(sourceRows,matchups):null;
  if(pdfBoundary)fullFieldIssues.push(...pdfBoundary.issues);
  const parseLine=line=>{
    const matches=sourceByText.get(clean(line))||[];
    if(sheetContract&&matches.length===1&&matches[0].kind==='spreadsheet')return spreadsheetParticipantRow(matches[0],sheetContract,matchups);
    return regularParticipantRow(line,matchups);
  };

  const participants=[];
  for(const target of TARGETS){
    const sourceHits=lines.filter(line=>targetRowIdentity(line,target));
    if(sourceHits.length!==1){errors.push(sourceHits.length>1?'Multiple '+target.displayName+' rows found':'Missing '+target.displayName);continue}
    const parsed=parseLine(sourceHits[0]);
    if(!parsed){errors.push(target.displayName+': regular weekly row is structurally invalid');continue}
    if(!target.aliases.some(alias=>exactName(alias)===exactName(parsed.sourceName))){errors.push(target.displayName+': participant identity mismatch');continue}
    errors.push(...validatePickNumbers(target.displayName,parsed.pickNumbers,parsed.tiebreak,numberToGame,gameCount));
    participants.push({id:target.id,displayName:target.displayName,sourceName:parsed.sourceName,pickNumbers:parsed.pickNumbers,tiebreak:parsed.tiebreak});
  }

  const temporary=[],seenSourceKeys=new Set(),acceptedAnonymousSourceKeys=new Set();
  const considerRow=(row,parsed,{allowNoPick=false}={})=>{
    if(!parsed||trackedTargetForName(parsed.sourceName))return;
    const rowErrors=validatePickNumbers('Anonymous field entry',parsed.pickNumbers,parsed.tiebreak,numberToGame,gameCount,{allowNoPick});
    if(rowErrors.length){fullFieldIssues.push('An anonymous regular-pool entry failed pick validation');return}
    const key=sourceRowKey(row);
    if(seenSourceKeys.has(key)){fullFieldIssues.push('Duplicate source participant row detected');return}
    seenSourceKeys.add(key);acceptedAnonymousSourceKeys.add(key);
    temporary.push({sourceName:parsed.sourceName,pickNumbers:parsed.pickNumbers,tiebreak:parsed.tiebreak});
  };

  if(hasPdf){
    const accepted=pdfBoundary?.accepted||new Set();
    for(const row of sourceRows){
      if(row?.kind!=='pdf'||!accepted.has(sourceRowKey(row)))continue;
      const structural=structuralParticipantRow(row.text,gameCount);
      if(structural&&trackedTargetForName(structural.sourceName))continue;
      const anonymous=anonymousParticipantRow(row.text,matchups);
      if(structural&&!anonymous){
        fullFieldIssues.push('A participant-shaped PDF row inside the proven regular participant table failed anonymous pick validation');
        continue;
      }
      considerRow(row,anonymous,{allowNoPick:true});
    }
  }else if(hasSpreadsheet){
    for(const row of sourceRows){if(row?.kind!=='spreadsheet')continue;considerRow(row,spreadsheetParticipantRow(row,sheetContract,matchups))}
  }else{
    fullFieldIssues.push('Regular participant-table source region could not be proven');
  }

  for(const line of lines){
    if(matchupFromLine(line))continue;
    if(TARGETS.some(target=>targetRowIdentity(line,target)))continue;
    const row=parseLine(line),matches=sourceByText.get(clean(line))||[];
    if(!row&&matches.some(source=>acceptedAnonymousSourceKeys.has(sourceRowKey(source))))continue;
    if(!row&&looksLikeDamagedParticipantRow(line,gameCount))fullFieldIssues.push('A supposed regular-pool participant row is structurally invalid');
  }
  if(!temporary.length)fullFieldIssues.push('No validated anonymous regular-pool entries were found');

  const fullFieldReady=errors.length===0&&fullFieldIssues.length===0;
  const fieldEntries=fullFieldReady?temporary.map((row,i)=>({id:'field-'+String(i+1).padStart(3,'0'),pickNumbers:row.pickNumbers.slice(),tiebreak:row.tiebreak})):[];
  const games=matchups.map((g,index)=>({index,awayNumber:g.awayNumber,homeNumber:g.homeNumber,away:g.away,home:g.home,awayName:g.awayName,homeName:g.homeName}));
  const config={schemaVersion:1,season,week,label:'Week '+week,tiePoints:0,tiebreakGameIndex:Math.max(0,games.length-1),games,participants,fullFieldReady,fullFieldValidationVersion:2,source:{kind:'weekly-upload',filename}};
  if(fullFieldReady){config.fieldEntries=fieldEntries;config.fullFieldEntryCount=fieldEntries.length;config.competitionSize=participants.length+fieldEntries.length}
  return{week,gameCount,errors,fullFieldIssues:[...new Set(fullFieldIssues)],competitionSize:fullFieldReady?config.competitionSize:participants.length,config};
}

export function parseDocumentGroups(groups,{filename='weekly-picks',season=2026}={}){
  const byWeek=new Map();let activeWeek=null;
  for(const group of groups||[]){
    const explicitWeek=Number.isInteger(group?.week)?group.week:null;
    let current=explicitWeek??activeWeek;
    if(!current){
      for(const line of group.lines||[]){const found=detectWeek(line);if(found){current=found;break}}
    }
    if(!current)continue;
    activeWeek=current;
    if(!byWeek.has(current))byWeek.set(current,[]);
    byWeek.get(current).push(group);
  }
  const candidates=[];
  for(const [week,weekGroups] of byWeek){const parsed=parseWeekGroup(week,weekGroups,filename,season);if(parsed)candidates.push(parsed)}
  return candidates.sort((a,b)=>a.week-b.week);
}

export function chooseBestCandidate(candidates){const valid=(candidates||[]).filter(c=>!c.errors.length&&c.config.participants.length===TARGETS.length);return valid.length?valid[valid.length-1]:null}

export function validateConfig(config){
  const errors=[];
  if(!config)return ['No configuration'];
  const games=config.games||[],participants=config.participants||[],fieldEntries=config.fieldEntries;
  if(!games.length)errors.push('No games found');
  if(participants.length!==TARGETS.length)errors.push('Expected '+TARGETS.length+' tracked entries');
  if(!Number.isInteger(config.tiebreakGameIndex)||config.tiebreakGameIndex<0||config.tiebreakGameIndex>=games.length)errors.push('Invalid tiebreak game');
  const nums=new Map(),teamPairs=new Set();
  games.forEach((g,i)=>{
    const teamKey=normalizeTeamCode(g?.away)+'-'+normalizeTeamCode(g?.home);
    if(teamPairs.has(teamKey))errors.push('Duplicate matchup teams '+teamKey);else teamPairs.add(teamKey);
    for(const n of [g.awayNumber,g.homeNumber]){if(!Number.isInteger(n))errors.push('Game '+(i+1)+': invalid number');else if(nums.has(n))errors.push('Duplicate number '+n);else nums.set(n,i)}
  });
  const validateEntry=(p,label,{allowNoPick=false}={})=>{
    if(!Number.isInteger(p?.tiebreak))errors.push(label+': invalid tiebreak');
    if(!Array.isArray(p?.pickNumbers)||p.pickNumbers.length!==games.length)errors.push(label+': wrong pick count');
    const seen=new Set();let noPicks=0;
    for(const n of p?.pickNumbers||[]){if(allowNoPick&&n===0){noPicks++;continue}if(!nums.has(n))errors.push(label+': unknown pick '+n);else seen.add(nums.get(n))}
    if(noPicks>1)errors.push(label+': at most one no-pick is allowed');
    if(seen.size+noPicks!==games.length)errors.push(label+': not exactly one pick/no-pick per game');
  };
  participants.forEach(p=>validateEntry(p,p.displayName||'Tracked entry'));

  if(config.fullFieldReady===true){
    if(!Array.isArray(fieldEntries)||!fieldEntries.length)errors.push('Full-field ready requires anonymous field entries');
    else{
      const ids=new Set(),allowed=['id','pickNumbers','tiebreak'].sort();
      fieldEntries.forEach((p,i)=>{
        const label='Field entry '+(i+1);
        if(!p||typeof p!=='object'||Array.isArray(p)){errors.push(label+': invalid object');return}
        const keys=Object.keys(p).sort();
        if(keys.length!==allowed.length||keys.some((k,ki)=>k!==allowed[ki]))errors.push(label+': only id, pickNumbers, and tiebreak are allowed');
        if(typeof p.id!=='string'||!p.id)errors.push(label+': missing id');
        else if(ids.has(p.id))errors.push('Duplicate field entry id '+p.id);else ids.add(p.id);
        validateEntry(p,label,{allowNoPick:true});
      });
      const expected=participants.length+fieldEntries.length;
      if(config.competitionSize!==expected)errors.push('Competition size mismatch: expected '+expected);
      if(config.fullFieldEntryCount!==undefined&&config.fullFieldEntryCount!==fieldEntries.length)errors.push('Full-field entry count mismatch: expected '+fieldEntries.length);
    }
  }else if(Array.isArray(fieldEntries)&&fieldEntries.length){
    errors.push('Anonymous field entries must not be published when fullFieldReady is false');
  }
  return [...new Set(errors)];
}
