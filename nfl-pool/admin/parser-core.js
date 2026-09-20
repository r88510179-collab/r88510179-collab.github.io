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
  return rows.sort((a,b)=>b.y-a.y).map(r=>r.parts.sort((a,b)=>a.x-b.x).map(p=>p.text).join(' ').replace(/\s+/g,' ').trim()).filter(Boolean);
}

function matchupFromLine(line){
  const s=clean(line);const m=s.match(/(?:^|\s)(\d{1,2})\)\s*([A-Za-z0-9 .'-]+?)\s+at\s+(\d{1,2})\)\s*([A-Za-z0-9 .'-]+?)(?=\s*$)/i);
  if(!m)return null;const awayNumber=Number(m[1]),homeNumber=Number(m[3]),awayName=clean(m[2]),homeName=clean(m[4]),away=teamAbbr(awayName),home=teamAbbr(homeName);if(!away||!home)return{error:`Unknown team name in: ${s}`};return{awayNumber,homeNumber,awayName,homeName,away,home};
}

function targetMatch(line,target){
  const s=clean(line);
  for(const alias of target.aliases){
    const pattern='^('+escapeRegex(clean(alias))+')(?=\\s+\\d+\\b)\\s+(.*)$';
    const m=s.match(new RegExp(pattern,'i'));
    if(!m)continue;
    const nums=(m[2].match(/\b\d+\b/g)||[]).map(Number);
    return{sourceName:m[1],nums};
  }
  return null;
}

function trackedTargetForName(name){
  const n=exactName(name);
  return TARGETS.find(target=>target.aliases.some(alias=>exactName(alias)===n))||null;
}

function trailingParticipantRow(line,fieldCount){
  const s=clean(line),tokens=s.split(' ');
  if(tokens.length<fieldCount+1)return null;
  const start=tokens.length-fieldCount,numeric=tokens.slice(start);
  if(!numeric.every(token=>/^\d+$/.test(token)))return null;
  const sourceName=clean(tokens.slice(0,start).join(' '));
  if(!sourceName)return null;
  return{sourceName,nums:numeric.map(Number)};
}

function validatePickNumbers(label,pickNumbers,tiebreak,numberToGame,gameCount){
  const errors=[],seenGames=new Set();
  for(const n of pickNumbers){
    const gi=numberToGame.get(n);
    if(gi===undefined)errors.push(`${label}: pick ${n} is not in the matchup key`);
    else if(seenGames.has(gi))errors.push(`${label}: two picks in matchup ${gi+1}`);
    else seenGames.add(gi);
  }
  if(seenGames.size!==gameCount)errors.push(`${label}: expected ${gameCount} unique game picks, found ${seenGames.size}`);
  if(!Number.isInteger(tiebreak))errors.push(`${label}: missing tiebreak total`);
  return errors;
}

function parseWeekGroup(week,lines,filename,season){
  const errors=[],seenPair=new Set(),seenTeams=new Set(),matchups=[];
  for(const line of lines){
    const m=matchupFromLine(line);if(!m)continue;if(m.error){errors.push(m.error);continue}
    const key=`${m.awayNumber}-${m.homeNumber}`;
    if(seenPair.has(key)){errors.push(`Duplicate matchup pair ${key}`);continue}
    const teamKey=`${m.away}-${m.home}`;
    if(seenTeams.has(teamKey)){errors.push(`Duplicate matchup teams ${teamKey}`);continue}
    seenPair.add(key);seenTeams.add(teamKey);matchups.push(m);
  }
  matchups.sort((a,b)=>Math.min(a.awayNumber,a.homeNumber)-Math.min(b.awayNumber,b.homeNumber));
  if(!matchups.length)return null;
  const gameCount=matchups.length,numberToGame=new Map();
  matchups.forEach((g,i)=>{if(numberToGame.has(g.awayNumber)||numberToGame.has(g.homeNumber))errors.push('Duplicate matchup number');numberToGame.set(g.awayNumber,i);numberToGame.set(g.homeNumber,i)});

  const participants=[];
  for(const target of TARGETS){
    const hits=[],wrongFieldCounts=[];
    for(const line of lines){const h=targetMatch(line,target);if(!h)continue;if(h.nums.length===gameCount+2)hits.push(h);else wrongFieldCounts.push(h.nums.length)}
    if(hits.length!==1){
      if(hits.length>1)errors.push(`Multiple ${target.displayName} rows found`);
      else if(wrongFieldCounts.length)errors.push(`${target.displayName}: expected ${gameCount+2} numeric fields (${gameCount} picks + Pts + W), found ${[...new Set(wrongFieldCounts)].join(', ')}`);
      else errors.push(`Missing ${target.displayName}`);
      continue;
    }
    const hit=hits[0],pickNumbers=hit.nums.slice(0,gameCount),tiebreak=hit.nums[gameCount];
    errors.push(...validatePickNumbers(target.displayName,pickNumbers,tiebreak,numberToGame,gameCount));
    participants.push({id:target.id,displayName:target.displayName,sourceName:hit.sourceName,pickNumbers,tiebreak});
  }

  const fieldEntries=[];
  let fieldOrdinal=0;
  for(const line of lines){
    if(matchupFromLine(line))continue;
    const row=trailingParticipantRow(line,gameCount+2);
    if(!row)continue;
    const pickNumbers=row.nums.slice(0,gameCount),tiebreak=row.nums[gameCount];
    const rowErrors=validatePickNumbers('Competition entry',pickNumbers,tiebreak,numberToGame,gameCount);
    if(rowErrors.length){
      errors.push(...rowErrors.map(e=>`${row.sourceName}: ${e.replace(/^Competition entry:\s*/,'')}`));
      continue;
    }
    if(trackedTargetForName(row.sourceName))continue;
    fieldOrdinal++;
    fieldEntries.push({id:`field-${String(fieldOrdinal).padStart(3,'0')}`,pickNumbers,tiebreak});
  }

  const games=matchups.map((g,index)=>({index,awayNumber:g.awayNumber,homeNumber:g.homeNumber,away:g.away,home:g.home,awayName:g.awayName,homeName:g.homeName}));
  const competitionSize=participants.length+fieldEntries.length;
  return{week,gameCount,errors,competitionSize,config:{schemaVersion:1,season,week,label:`Week ${week}`,tiePoints:0,tiebreakGameIndex:Math.max(0,games.length-1),games,participants,fieldEntries,competitionSize,source:{kind:'weekly-upload',filename}}};
}

export function parseDocumentGroups(groups,{filename='weekly-picks',season=2026}={}){
  const byWeek=new Map();
  for(const group of groups||[]){const hinted=Number.isInteger(group.week)?group.week:null;let current=hinted;for(const line of group.lines||[]){const found=detectWeek(line);if(found)current=found;if(!current)continue;if(!byWeek.has(current))byWeek.set(current,[]);byWeek.get(current).push(clean(line))}}
  const candidates=[];for(const [week,lines] of byWeek){const parsed=parseWeekGroup(week,lines,filename,season);if(parsed)candidates.push(parsed)}return candidates.sort((a,b)=>a.week-b.week);
}

export function chooseBestCandidate(candidates){const valid=(candidates||[]).filter(c=>!c.errors.length&&c.config.participants.length===TARGETS.length);return valid.length?valid[valid.length-1]:null}

export function validateConfig(config){
  const errors=[];
  if(!config)return ['No configuration'];
  const games=config.games||[],participants=config.participants||[],fieldEntries=config.fieldEntries;
  if(!games.length)errors.push('No games found');
  if(participants.length!==TARGETS.length)errors.push(`Expected ${TARGETS.length} tracked entries`);
  if(!Number.isInteger(config.tiebreakGameIndex)||config.tiebreakGameIndex<0||config.tiebreakGameIndex>=games.length)errors.push('Invalid tiebreak game');
  const nums=new Map(),teamPairs=new Set();
  games.forEach((g,i)=>{
    const teamKey=`${normalizeTeamCode(g?.away)}-${normalizeTeamCode(g?.home)}`;
    if(teamPairs.has(teamKey))errors.push(`Duplicate matchup teams ${teamKey}`);else teamPairs.add(teamKey);
    for(const n of [g.awayNumber,g.homeNumber]){if(!Number.isInteger(n))errors.push(`Game ${i+1}: invalid number`);else if(nums.has(n))errors.push(`Duplicate number ${n}`);else nums.set(n,i)}
  });
  const validateEntry=(p,label)=>{
    if(!Number.isInteger(p?.tiebreak))errors.push(`${label}: invalid tiebreak`);
    if(!Array.isArray(p?.pickNumbers)||p.pickNumbers.length!==games.length)errors.push(`${label}: wrong pick count`);
    const seen=new Set();
    for(const n of p?.pickNumbers||[]){if(!nums.has(n))errors.push(`${label}: unknown pick ${n}`);else seen.add(nums.get(n))}
    if(seen.size!==games.length)errors.push(`${label}: not exactly one pick per game`);
  };
  participants.forEach(p=>validateEntry(p,p.displayName||'Tracked entry'));
  if(fieldEntries!==undefined){
    if(!Array.isArray(fieldEntries))errors.push('Field entries must be an array');
    else{
      const ids=new Set();
      fieldEntries.forEach((p,i)=>{
        const label=`Field entry ${i+1}`;
        if(!p||typeof p.id!=='string'||!p.id)errors.push(`${label}: missing id`);
        else if(ids.has(p.id))errors.push(`Duplicate field entry id ${p.id}`);
        else ids.add(p.id);
        if(p&&('displayName' in p||'sourceName' in p||'name' in p))errors.push(`${label}: names must not be stored`);
        validateEntry(p,label);
      });
      const expected=participants.length+fieldEntries.length;
      if(config.competitionSize!==undefined&&config.competitionSize!==expected)errors.push(`Competition size mismatch: expected ${expected}`);
    }
  }
  return [...new Set(errors)];
}
