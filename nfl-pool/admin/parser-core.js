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
    if(m&&/^\\d+$/.test(clean(m[2]).split(' ')[0]))return true;
  }
  return false;
}

function trackedTargetForName(name){
  const n=exactName(name);
  return TARGETS.find(target=>target.aliases.some(alias=>exactName(alias)===n))||null;
}

function regularParticipantRow(line,matchups){
  const tokens=clean(line).split(' ').filter(Boolean),gameCount=matchups.length,candidates=[];
  if(tokens.length<gameCount+3)return null;
  for(let start=1;start<tokens.length;start++){
    if(tokens.length-start!==gameCount+2)continue;
    const nums=tokens.slice(start);
    if(!nums.every(token=>/^\\d+$/.test(token)))continue;
    const values=nums.map(Number);
    let valid=true;
    for(let i=0;i<gameCount;i++){const g=matchups[i],n=values[i];if(n!==g.awayNumber&&n!==g.homeNumber){valid=false;break}}
    if(!valid)continue;
    const sourceName=clean(tokens.slice(0,start).join(' '));if(!sourceName)continue;
    candidates.push({sourceName,pickNumbers:values.slice(0,gameCount),tiebreak:values[gameCount],wins:values[gameCount+1]});
  }
  return candidates.length===1?candidates[0]:null;
}

function spreadsheetContract(sourceRows,gameCount){
  const header=(sourceRows||[]).find(r=>r&&r.kind==='spreadsheet'&&Array.isArray(r.cells)&&r.cells.some(c=>/^pts(?:\\/tiebreak)?$/i.test(clean(c)))&&r.cells.some(c=>/^w$/i.test(clean(c))));
  if(!header)return null;
  const cells=header.cells.map(clean),ptsIndex=cells.findIndex(c=>/^pts(?:\\/tiebreak)?$/i.test(c)),wIndex=cells.findIndex(c=>/^w$/i.test(c));
  if(ptsIndex<0||wIndex!==ptsIndex+1||ptsIndex-gameCount<1)return null;
  return{sheetName:header.sheetName,headerRowNumber:header.rowNumber,nameIndex:ptsIndex-gameCount-1,pickStart:ptsIndex-gameCount,ptsIndex,wIndex};
}

function spreadsheetParticipantRow(sourceRow,contract,matchups){
  if(!sourceRow||sourceRow.kind!=='spreadsheet'||!contract||sourceRow.sheetName!==contract.sheetName||sourceRow.rowNumber===contract.headerRowNumber)return null;
  const cells=(sourceRow.cells||[]).map(clean);
  if(cells.length<=contract.wIndex)return null;
  const sourceName=cells[contract.nameIndex],pickCells=cells.slice(contract.pickStart,contract.ptsIndex),tail=cells.slice(contract.ptsIndex,contract.wIndex+1),extra=cells.slice(contract.wIndex+1).filter(Boolean);
  if(!sourceName||extra.length||pickCells.length!==matchups.length||!pickCells.every(v=>/^\\d+$/.test(v))||!tail.every(v=>/^\\d+$/.test(v)))return null;
  const pickNumbers=pickCells.map(Number);
  for(let i=0;i<matchups.length;i++){const g=matchups[i],n=pickNumbers[i];if(n!==g.awayNumber&&n!==g.homeNumber)return null}
  return{sourceName,pickNumbers,tiebreak:Number(tail[0]),wins:Number(tail[1])};
}

function looksLikeDamagedParticipantRow(line,gameCount){
  const tokens=clean(line).split(' ');
  const numericCount=tokens.reduce((n,token)=>n+(/^\\d+$/.test(token)?1:0),0);
  return tokens.length>=gameCount+1&&numericCount>=gameCount&&tokens.some(t=>!/^\\d+$/.test(t));
}

function validatePickNumbers(label,pickNumbers,tiebreak,numberToGame,gameCount){
  const errors=[],seenGames=new Set();
  for(const n of pickNumbers||[]){
    const gi=numberToGame.get(n);
    if(gi===undefined)errors.push(label+': pick '+n+' is not in the matchup key');
    else if(seenGames.has(gi))errors.push(label+': two picks in matchup '+(gi+1));
    else seenGames.add(gi);
  }
  if((pickNumbers||[]).length!==gameCount||seenGames.size!==gameCount)errors.push(label+': expected exactly one pick for each of '+gameCount+' games');
  if(!Number.isInteger(tiebreak))errors.push(label+': missing tiebreak total');
  return errors;
}

function sourceRowKey(row){
  if(row&&row.kind==='pdf')return 'pdf:'+(row.pageNumber??'?')+':'+Number(row.y??0).toFixed(2)+':'+clean(row.text);
  if(row&&row.kind==='spreadsheet')return 'sheet:'+(row.sheetName??'?')+':'+(row.rowNumber??'?')+':'+(row.cells||[]).map(clean).join('|');
  return 'text:'+clean(row&&row.text!==undefined?row.text:row);
}

function parseWeekGroup(week,weekGroups,filename,season){
  const errors=[],fullFieldIssues=[],lines=[],sourceRows=[];
  for(const group of weekGroups||[]){for(const line of group.lines||[])lines.push(clean(line));for(const row of group.sourceRows||[])sourceRows.push(row)}
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
  const sheetContract=spreadsheetContract(sourceRows,gameCount);
  if(sourceRows.some(r=>r.kind==='spreadsheet')&&!sheetContract)fullFieldIssues.push('Spreadsheet regular-pool headers could not be proven');
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

  const pageFingerprints=new Set();
  for(const group of weekGroups||[]){
    if(!group.pageFingerprint)continue;
    if(pageFingerprints.has(group.pageFingerprint))fullFieldIssues.push('Duplicate PDF page or repeated source table region detected');
    pageFingerprints.add(group.pageFingerprint);
  }

  const temporary=[],seenSourceKeys=new Set();
  for(const line of lines){
    if(matchupFromLine(line))continue;
    if(TARGETS.some(target=>targetRowIdentity(line,target)))continue;
    const row=parseLine(line);
    if(!row){if(looksLikeDamagedParticipantRow(line,gameCount))fullFieldIssues.push('A supposed regular-pool participant row is structurally invalid');continue}
    if(trackedTargetForName(row.sourceName))continue;
    const rowErrors=validatePickNumbers('Anonymous field entry',row.pickNumbers,row.tiebreak,numberToGame,gameCount);
    if(rowErrors.length){fullFieldIssues.push('An anonymous regular-pool entry failed pick validation');continue}
    const matches=sourceByText.get(clean(line))||[];
    const key=matches.length===1?sourceRowKey(matches[0]):'text:'+clean(line);
    if(seenSourceKeys.has(key)){fullFieldIssues.push('Duplicate source participant row detected');continue}
    seenSourceKeys.add(key);
    temporary.push({sourceName:row.sourceName,pickNumbers:row.pickNumbers,tiebreak:row.tiebreak});
  }
  if(!temporary.length)fullFieldIssues.push('No validated anonymous regular-pool entries were found');

  const fullFieldReady=errors.length===0&&fullFieldIssues.length===0;
  const fieldEntries=fullFieldReady?temporary.map((row,i)=>({id:'field-'+String(i+1).padStart(3,'0'),pickNumbers:row.pickNumbers.slice(),tiebreak:row.tiebreak})):[];
  const games=matchups.map((g,index)=>({index,awayNumber:g.awayNumber,homeNumber:g.homeNumber,away:g.away,home:g.home,awayName:g.awayName,homeName:g.homeName}));
  const config={schemaVersion:1,season,week,label:'Week '+week,tiePoints:0,tiebreakGameIndex:Math.max(0,games.length-1),games,participants,fullFieldReady,fullFieldValidationVersion:2,source:{kind:'weekly-upload',filename}};
  if(fullFieldReady){config.fieldEntries=fieldEntries;config.fullFieldEntryCount=fieldEntries.length;config.competitionSize=participants.length+fieldEntries.length}
  return{week,gameCount,errors,fullFieldIssues,competitionSize:fullFieldReady?config.competitionSize:participants.length,config};
}

export function parseDocumentGroups(groups,{filename='weekly-picks',season=2026}={}){
  const byWeek=new Map();
  for(const group of carryForwardWeekHints(groups||[])){
    let current=Number.isInteger(group.week)?group.week:null;
    for(const line of group.lines||[]){const found=detectWeek(line);if(found)current=found}
    if(!current)continue;
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
  const validateEntry=(p,label)=>{
    if(!Number.isInteger(p?.tiebreak))errors.push(label+': invalid tiebreak');
    if(!Array.isArray(p?.pickNumbers)||p.pickNumbers.length!==games.length)errors.push(label+': wrong pick count');
    const seen=new Set();
    for(const n of p?.pickNumbers||[]){if(!nums.has(n))errors.push(label+': unknown pick '+n);else seen.add(nums.get(n))}
    if(seen.size!==games.length)errors.push(label+': not exactly one pick per game');
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
        validateEntry(p,label);
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
