export const TARGETS=[
  {id:'dc',displayName:'D.C.',aliases:['D.C.','D.C','DC']},
  {id:'jc',displayName:'JC',aliases:['JC']},
  {id:'djs',displayName:'DJS',aliases:['DJS']},
  {id:'thaddeus',displayName:'Thaddeus',aliases:['Thaddius','Thaddeus']},
];

export const FULL_FIELD_VALIDATION_VERSION=2;

const TEAM_ALIASES={
  cardinals:'ARI',falcons:'ATL',ravens:'BAL',bills:'BUF',panthers:'CAR',bears:'CHI',bengals:'CIN',browns:'CLE',cowboys:'DAL',broncos:'DEN',lions:'DET',packers:'GB',texans:'HOU',colts:'IND',jaguars:'JAX',jags:'JAX',chiefs:'KC',raiders:'LV',chargers:'LAC',rams:'LAR',dolphins:'MIA',vikings:'MIN',patriots:'NE',pats:'NE',saints:'NO',giants:'NYG',jets:'NYJ',eagles:'PHI',steelers:'PIT','49ers':'SF',niners:'SF',seahawks:'SEA',buccaneers:'TB',bucs:'TB',titans:'TEN',commanders:'WAS',washington:'WAS'
};

const clean=s=>String(s??'').replace(/\s+/g,' ').trim();
const exactName=s=>clean(s).toLowerCase();
const normalizeTeamCode=x=>{const code=String(x??'').toUpperCase();return({JAC:'JAX',WSH:'WAS'}[code]||code)};
const integerToken=s=>/^\d+$/.test(String(s??''))?Number(s):null;
const rowText=row=>clean(typeof row==='string'?row:row?.text);
const rowKind=row=>typeof row==='string'?'text':String(row?.kind||row?.sourceType||'text');
const safeKey=s=>clean(s).toLowerCase();

export function teamAbbr(name){
  const raw=clean(name).toLowerCase().replace(/[.]/g,'');
  if(TEAM_ALIASES[raw])return TEAM_ALIASES[raw];
  for(const [key,val] of Object.entries(TEAM_ALIASES))if(raw.endsWith(key)||raw.includes(` ${key}`))return val;
  return null;
}

export function detectWeek(value){const m=rowText(value).match(/\bWeek\s+(\d{1,2})\b/i);return m?Number(m[1]):null}

export function carryForwardWeekHints(groups){
  let active=null;
  return (groups||[]).map(group=>{
    if(Number.isInteger(group?.week))active=group.week;
    return {...group,week:active};
  });
}

export function groupPdfTextItems(items,{pageNumber=null}={}){
  const rows=[];
  (items||[]).forEach((item,order)=>{
    const text=clean(item?.str);if(!text)return;
    const tr=item?.transform||[],x=Number(tr[4]??0),y=Number(tr[5]??0);
    let row=rows.find(r=>Math.abs(r.y-y)<=1.5);
    if(!row){row={kind:'pdf',pageNumber,y,parts:[]};rows.push(row)}
    row.parts.push({x,text,order});
  });
  return rows.sort((a,b)=>b.y-a.y).map((r,rowIndex)=>{
    const parts=r.parts.sort((a,b)=>a.x-b.x||a.order-b.order);
    return {...r,rowIndex,text:clean(parts.map(p=>p.text).join(' ')),parts};
  }).filter(r=>r.text);
}

function normalizeRow(row,groupIndex,rowIndex,group={}){
  if(typeof row==='string')return{kind:group.sourceType||'text',text:clean(row),groupIndex,rowIndex,pageNumber:group.pageNumber??null,sheetName:group.sheetName??null};
  return{...row,kind:row.kind||group.sourceType||'text',text:rowText(row),groupIndex:row.groupIndex??groupIndex,rowIndex:row.rowIndex??rowIndex,pageNumber:row.pageNumber??group.pageNumber??null,sheetName:row.sheetName??group.sheetName??null};
}

function matchupFromLine(value){
  const s=rowText(value);const m=s.match(/(?:^|\s)(\d{1,2})\)\s*([A-Za-z0-9 .'-]+?)\s+at\s+(\d{1,2})\)\s*([A-Za-z0-9 .'-]+?)(?=\s*$)/i);
  if(!m)return null;const awayNumber=Number(m[1]),homeNumber=Number(m[3]),awayName=clean(m[2]),homeName=clean(m[4]),away=teamAbbr(awayName),home=teamAbbr(homeName);if(!away||!home)return{error:`Unknown team name in: ${s}`};return{awayNumber,homeNumber,awayName,homeName,away,home};
}

function tokenMeta(row){
  if(row&&Array.isArray(row.parts)&&row.parts.length){
    const out=[];
    for(const part of row.parts){for(const token of clean(part.text).split(' ').filter(Boolean))out.push({text:token,x:Number.isFinite(part.x)?part.x:null})}
    return out;
  }
  return rowText(row).split(' ').filter(Boolean).map(text=>({text,x:null}));
}

function parseRegularPdfRow(row,matchups){
  const tokens=tokenMeta(row),gameCount=matchups.length,candidates=[];
  for(let start=1;start+gameCount+2<=tokens.length;start++){
    const picks=[];let ok=true;
    for(let gi=0;gi<gameCount;gi++){
      const n=integerToken(tokens[start+gi].text),g=matchups[gi];
      if(n===null||(n!==g.awayNumber&&n!==g.homeNumber)){ok=false;break}
      picks.push(n);
    }
    if(!ok)continue;
    const tiebreak=integerToken(tokens[start+gameCount].text),wins=integerToken(tokens[start+gameCount+1].text);
    if(tiebreak===null||wins===null||wins<0||wins>gameCount)continue;
    if(start+gameCount+2!==tokens.length)continue;
    const sourceName=clean(tokens.slice(0,start).map(t=>t.text).join(' '));if(!sourceName)continue;
    candidates.push({sourceName,pickNumbers:picks,tiebreak,wins,start,numericXs:tokens.slice(start,start+gameCount+2).map(t=>t.x)});
  }
  if(candidates.length===1)return{status:'valid',...candidates[0]};
  if(candidates.length>1)return{status:'ambiguous'};
  return{status:'none'};
}

function leadingTrackedTarget(row){
  if(row?.cells&&row.cells.length){
    const name=clean(row.cells[0]);
    const target=TARGETS.find(t=>t.aliases.some(a=>exactName(a)===exactName(name)));
    if(target)return target;
  }
  if(row?.parts?.length){
    const first=clean(row.parts[0]?.text);
    const target=TARGETS.find(t=>t.aliases.some(a=>exactName(a)===exactName(first)));
    if(target)return target;
  }
  const s=rowText(row);
  for(const target of TARGETS){
    for(const alias of [...target.aliases].sort((a,b)=>b.length-a.length)){
      const a=clean(alias);if(s.slice(0,a.length).toLowerCase()!==a.toLowerCase())continue;
      const boundary=s[a.length];if(boundary&& !/\s/.test(boundary))continue;
      const next=clean(s.slice(a.length)).split(' ')[0]||'';
      if(/^\d+$/.test(next)||/^[-—–?]$/.test(next))return target;
    }
  }
  return null;
}

function validatePickNumbers(label,pickNumbers,tiebreak,numberToGame,gameCount){
  const errors=[],seenGames=new Set();
  for(const n of pickNumbers){const gi=numberToGame.get(n);if(gi===undefined)errors.push(`${label}: pick ${n} is not in the matchup key`);else if(seenGames.has(gi))errors.push(`${label}: two picks in matchup ${gi+1}`);else seenGames.add(gi)}
  if(seenGames.size!==gameCount)errors.push(`${label}: expected ${gameCount} unique game picks, found ${seenGames.size}`);
  if(!Number.isInteger(tiebreak))errors.push(`${label}: missing tiebreak total`);
  return errors;
}

function numericDensity(row){const tokens=tokenMeta(row);return tokens.reduce((n,t)=>n+(integerToken(t.text)!==null?1:0),0)}
function isExplicitSurvivorBoundary(row){return /\bsurvivor\b/i.test(rowText(row))}
function isBenignTableText(row){const s=rowText(row);return !s||/\bweek\s+\d+\b/i.test(s)||/\bpts\b/i.test(s)&&/\bw\b/i.test(s)||/^page\s+\d+/i.test(s)}
function sourceLocator(row){
  if(rowKind(row)==='pdf')return`pdf:${row.pageNumber??'?'}:${row.rowIndex??'?'}:${Number.isFinite(row.y)?row.y.toFixed(2):'?'}`;
  if(rowKind(row)==='spreadsheet')return`sheet:${row.sheetName??'?'}:${row.rowNumber??row.rowIndex??'?'}`;
  return`text:${row.groupIndex??'?'}:${row.rowIndex??'?'}`;
}
function participantFingerprint(parsed){return`${safeKey(parsed.sourceName)}|${parsed.pickNumbers.join(',')}|${parsed.tiebreak}|${parsed.wins}`}

function xLayoutUseful(rows){return rows.some(p=>Array.isArray(p.numericXs)&&new Set(p.numericXs.filter(Number.isFinite).map(x=>Math.round(x))).size>=Math.max(6,p.pickNumbers.length));}
function layoutMatches(candidate,templates){
  if(!templates.length||!Array.isArray(candidate.numericXs))return true;
  const xs=candidate.numericXs;if(xs.some(x=>!Number.isFinite(x)))return false;
  return templates.some(t=>t.length===xs.length&&t.every((x,i)=>Math.abs(x-xs[i])<=6));
}

function spreadsheetContract(rows,gameCount){
  const headers=[];
  rows.forEach((row,i)=>{
    if(rowKind(row)!=='spreadsheet'||!Array.isArray(row.cells))return;
    const cells=row.cells.map(clean),lower=cells.map(x=>x.toLowerCase());
    const pts=lower.findIndex(x=>['pts','points','tb','tiebreak','tie break'].includes(x));
    const w=lower.findIndex((x,idx)=>idx>pts&&['w','wins','win'].includes(x));
    if(pts<gameCount||w!==pts+1)return;
    const pickStart=pts-gameCount;
    if(pickStart<1)return;
    const trailing=cells.slice(w+1).filter(Boolean);
    headers.push({index:i,pickStart,pickColumns:Array.from({length:gameCount},(_,n)=>pickStart+n),ptsColumn:pts,wColumn:w,trailing,explicitSurvivor:trailing.length>0&&trailing.every(x=>/survivor/i.test(x))});
  });
  return headers.length===1?headers[0]:null;
}

function parseSpreadsheetRow(row,contract,matchups){
  const cells=(row.cells||[]).map(clean),gameCount=matchups.length;
  const sourceName=clean(cells.slice(0,contract.pickStart).filter(Boolean).join(' '));
  if(!sourceName)return{status:'none'};
  const picks=[];
  for(let gi=0;gi<gameCount;gi++){
    const n=integerToken(cells[contract.pickColumns[gi]]),g=matchups[gi];
    if(n===null||(n!==g.awayNumber&&n!==g.homeNumber))return{status:'invalid',sourceName};
    picks.push(n);
  }
  const tiebreak=integerToken(cells[contract.ptsColumn]),wins=integerToken(cells[contract.wColumn]);
  if(tiebreak===null||wins===null||wins<0||wins>gameCount)return{status:'invalid',sourceName};
  const trailing=cells.slice(contract.wColumn+1).filter(Boolean);
  if(trailing.length&&!contract.explicitSurvivor)return{status:'invalid',sourceName};
  return{status:'valid',sourceName,pickNumbers:picks,tiebreak,wins};
}

function buildFullField(rows,matchups,trackedRows,sourceGroups){
  const gameCount=matchups.length,errors=[],fieldEntries=[],sourceSeen=new Set(),participantSeen=new Set();
  let fieldOrdinal=0;
  const duplicatePages=new Map();
  for(const g of sourceGroups||[]){
    if(g.sourceType!=='pdf'||!g.pageFingerprint)continue;
    const fp=String(g.pageFingerprint);const prior=duplicatePages.get(fp);
    if(prior!==undefined&&prior!==g.pageNumber)errors.push('duplicate PDF page or table region detected');else duplicatePages.set(fp,g.pageNumber);
  }

  const spreadsheetRows=rows.filter(r=>rowKind(r)==='spreadsheet');
  const isSheet=spreadsheetRows.length>0;
  const sheetContract=isSheet?spreadsheetContract(rows,gameCount):null;
  if(isSheet&&!sheetContract)errors.push('regular competition spreadsheet columns could not be established');

  const trackedParsed=[];
  for(const {row,parsed} of trackedRows)if(parsed?.status==='valid')trackedParsed.push(parsed);
  const layoutTemplates=xLayoutUseful(trackedParsed)?trackedParsed.map(p=>p.numericXs):[];

  let survivorMode=false,unknownBoundary=false,participantStarted=false;
  for(let i=0;i<rows.length;i++){
    const row=rows[i],text=rowText(row);if(!text||matchupFromLine(row))continue;
    if(isExplicitSurvivorBoundary(row)){survivorMode=true;unknownBoundary=false;continue}
    if(survivorMode)continue;
    if(leadingTrackedTarget(row)){participantStarted=true;continue}

    let parsed;
    if(isSheet){
      if(!sheetContract||i<=sheetContract.index)continue;
      parsed=parseSpreadsheetRow(row,sheetContract,matchups);
    }else parsed=parseRegularPdfRow(row,matchups);

    if(parsed.status==='valid'){
      if(unknownBoundary){errors.push('regular competition boundary became ambiguous after an unknown section');continue}
      if(layoutTemplates.length&&!layoutMatches(parsed,layoutTemplates)){continue}
      participantStarted=true;
      const locator=sourceLocator(row);if(sourceSeen.has(locator)){errors.push('duplicate source row detected');continue}sourceSeen.add(locator);
      const fp=participantFingerprint(parsed);if(participantSeen.has(fp)){errors.push('repeated identical participant source row detected');continue}participantSeen.add(fp);
      fieldOrdinal++;fieldEntries.push({id:`field-${String(fieldOrdinal).padStart(3,'0')}`,pickNumbers:parsed.pickNumbers,tiebreak:parsed.tiebreak});
      continue;
    }

    if(parsed.status==='ambiguous'){if(participantStarted)errors.push('ambiguous regular competition row boundary detected');continue}
    if(parsed.status==='invalid'){if(participantStarted)errors.push('regular competition row failed explicit column validation');continue}
    if(participantStarted&&numericDensity(row)>=gameCount){errors.push('regular competition row has missing, shifted, or extra unresolved values');continue}
    if(participantStarted&&!isBenignTableText(row)&&/[A-Za-z]/.test(text))unknownBoundary=true;
  }

  return{ready:errors.length===0,errors:[...new Set(errors)],fieldEntries:errors.length?[]:fieldEntries};
}

function parseWeekGroup(week,rows,filename,season,sourceGroups=[]){
  const errors=[],seenPair=new Set(),seenTeams=new Set(),matchups=[];
  for(const row of rows){const m=matchupFromLine(row);if(!m)continue;if(m.error){errors.push(m.error);continue}const key=`${m.awayNumber}-${m.homeNumber}`;if(seenPair.has(key)){errors.push(`Duplicate matchup pair ${key}`);continue}const teamKey=`${m.away}-${m.home}`;if(seenTeams.has(teamKey)){errors.push(`Duplicate matchup teams ${teamKey}`);continue}seenPair.add(key);seenTeams.add(teamKey);matchups.push(m)}
  matchups.sort((a,b)=>Math.min(a.awayNumber,a.homeNumber)-Math.min(b.awayNumber,b.homeNumber));
  if(!matchups.length)return null;
  const gameCount=matchups.length,numberToGame=new Map();
  matchups.forEach((g,i)=>{if(numberToGame.has(g.awayNumber)||numberToGame.has(g.homeNumber))errors.push('Duplicate matchup number');numberToGame.set(g.awayNumber,i);numberToGame.set(g.homeNumber,i)});

  const participants=[],trackedRows=[];
  for(const target of TARGETS){
    const hits=rows.filter(row=>leadingTrackedTarget(row)?.id===target.id);
    if(hits.length!==1){errors.push(hits.length>1?`Multiple ${target.displayName} rows found`:`Missing ${target.displayName}`);continue}
    const row=hits[0];let parsed;
    if(rowKind(row)==='spreadsheet'&&Array.isArray(row.cells)){
      const cells=row.cells.map(clean),nameIndex=cells.findIndex(c=>target.aliases.some(a=>exactName(a)===exactName(c)));
      if(nameIndex<0)parsed={status:'none'};else{
        const tokens=[cells[nameIndex],...cells.slice(nameIndex+1).filter(Boolean)].join(' ');
        parsed=parseRegularPdfRow({text:tokens},matchups);
      }
    }else parsed=parseRegularPdfRow(row,matchups);
    trackedRows.push({target,row,parsed});
    if(parsed.status!=='valid'||!target.aliases.some(a=>exactName(a)===exactName(parsed.sourceName))){errors.push(`${target.displayName}: regular weekly row must contain exactly ${gameCount} picks + Pts + W and no trailing values`);continue}
    errors.push(...validatePickNumbers(target.displayName,parsed.pickNumbers,parsed.tiebreak,numberToGame,gameCount));
    participants.push({id:target.id,displayName:target.displayName,sourceName:parsed.sourceName,pickNumbers:parsed.pickNumbers,tiebreak:parsed.tiebreak});
  }

  const games=matchups.map((g,index)=>({index,awayNumber:g.awayNumber,homeNumber:g.homeNumber,away:g.away,home:g.home,awayName:g.awayName,homeName:g.homeName}));
  const full=participants.length===TARGETS.length&&!errors.length?buildFullField(rows,matchups,trackedRows,sourceGroups):{ready:false,errors:['tracked competition rows are not valid'],fieldEntries:[]};
  const config={schemaVersion:1,season,week,label:`Week ${week}`,tiePoints:0,tiebreakGameIndex:Math.max(0,games.length-1),games,participants,fullFieldReady:full.ready,fullFieldValidationVersion:FULL_FIELD_VALIDATION_VERSION,source:{kind:'weekly-upload',filename}};
  if(full.ready){config.fieldEntries=full.fieldEntries;config.fullFieldEntryCount=full.fieldEntries.length;config.competitionSize=participants.length+full.fieldEntries.length}
  return{week,gameCount,errors,fullFieldErrors:full.errors,competitionSize:full.ready?config.competitionSize:participants.length,config};
}

export function parseDocumentGroups(groups,{filename='weekly-picks',season=2026}={}){
  const byWeek=new Map(),normalizedGroups=[];
  (groups||[]).forEach((group,groupIndex)=>{
    const rawRows=group.rows||group.lines||[];
    const rows=rawRows.map((row,rowIndex)=>normalizeRow(row,groupIndex,rowIndex,group));
    const normalized={...group,rows};normalizedGroups.push(normalized);
    const hinted=Number.isInteger(group.week)?group.week:null;let current=hinted;
    for(const row of rows){const found=detectWeek(row);if(found)current=found;if(!current)continue;if(!byWeek.has(current))byWeek.set(current,{rows:[],groups:[]});const bucket=byWeek.get(current);bucket.rows.push(row);if(!bucket.groups.includes(normalized))bucket.groups.push(normalized)}
  });
  const candidates=[];for(const [week,bucket] of byWeek){const parsed=parseWeekGroup(week,bucket.rows,filename,season,bucket.groups);if(parsed)candidates.push(parsed)}return candidates.sort((a,b)=>a.week-b.week);
}

export function chooseBestCandidate(candidates){const valid=(candidates||[]).filter(c=>!c.errors.length&&c.config.participants.length===TARGETS.length);return valid.length?valid[valid.length-1]:null}

export function validateConfig(config){
  const errors=[];if(!config)return['No configuration'];
  const games=config.games||[],participants=config.participants||[];
  if(!games.length)errors.push('No games found');
  if(participants.length!==TARGETS.length)errors.push(`Expected ${TARGETS.length} tracked entries`);
  if(!Number.isInteger(config.tiebreakGameIndex)||config.tiebreakGameIndex<0||config.tiebreakGameIndex>=games.length)errors.push('Invalid tiebreak game');
  const nums=new Map(),teamPairs=new Set();
  games.forEach((g,i)=>{const teamKey=`${normalizeTeamCode(g?.away)}-${normalizeTeamCode(g?.home)}`;if(teamPairs.has(teamKey))errors.push(`Duplicate matchup teams ${teamKey}`);else teamPairs.add(teamKey);for(const n of [g.awayNumber,g.homeNumber]){if(!Number.isInteger(n))errors.push(`Game ${i+1}: invalid number`);else if(nums.has(n))errors.push(`Duplicate number ${n}`);else nums.set(n,i)}});
  const validateEntry=(p,label)=>{if(!Number.isInteger(p?.tiebreak))errors.push(`${label}: invalid tiebreak`);if(!Array.isArray(p?.pickNumbers)||p.pickNumbers.length!==games.length)errors.push(`${label}: wrong pick count`);const seen=new Set();for(const n of p?.pickNumbers||[]){if(!nums.has(n))errors.push(`${label}: unknown pick ${n}`);else if(seen.has(nums.get(n)))errors.push(`${label}: not exactly one pick per game`);else seen.add(nums.get(n))}if(seen.size!==games.length)errors.push(`${label}: not exactly one pick per game`)};
  participants.forEach(p=>validateEntry(p,p.displayName||'Tracked entry'));
  const ready=config.fullFieldReady===true;
  if(ready){
    if(config.fullFieldValidationVersion!==FULL_FIELD_VALIDATION_VERSION)errors.push('Unsupported full-field validation version');
    if(!Array.isArray(config.fieldEntries))errors.push('Field entries must be an array');
    else{
      const ids=new Set();for(const [i,p] of config.fieldEntries.entries()){
        const label=`Field entry ${i+1}`,keys=p&&typeof p==='object'&&!Array.isArray(p)?Object.keys(p).sort():[];
        if(keys.join(',')!=='id,pickNumbers,tiebreak')errors.push(`${label}: anonymous field keys must be exactly id, pickNumbers, tiebreak`);
        if(!p||typeof p.id!=='string'||!p.id)errors.push(`${label}: missing id`);else if(ids.has(p.id))errors.push(`Duplicate field entry id ${p.id}`);else ids.add(p.id);
        validateEntry(p,label);
      }
      const expected=participants.length+config.fieldEntries.length;
      if(config.competitionSize!==expected)errors.push(`Competition size mismatch: expected ${expected}`);
      if(config.fullFieldEntryCount!==undefined&&config.fullFieldEntryCount!==config.fieldEntries.length)errors.push(`Full-field entry count mismatch: expected ${config.fieldEntries.length}`);
    }
  }else if(Array.isArray(config.fieldEntries)&&config.fieldEntries.length)errors.push('Field entries require fullFieldReady=true');
  return[...new Set(errors)];
}
