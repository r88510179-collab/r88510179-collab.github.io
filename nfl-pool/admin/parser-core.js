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
const nameKey=s=>clean(s).toLowerCase().replace(/[^a-z0-9]/g,'');

export function teamAbbr(name){
  const raw=clean(name).toLowerCase().replace(/[.]/g,'');
  if(TEAM_ALIASES[raw])return TEAM_ALIASES[raw];
  for(const [key,val] of Object.entries(TEAM_ALIASES))if(raw.endsWith(key)||raw.includes(` ${key}`))return val;
  return null;
}

export function detectWeek(text){const m=clean(text).match(/\bWeek\s+(\d{1,2})\b/i);return m?Number(m[1]):null}

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
  const s=clean(line);for(const alias of target.aliases){const a=nameKey(alias);const words=s.split(' ');for(let i=0;i<Math.min(words.length,5);i++){for(let j=i+1;j<=Math.min(words.length,i+3);j++){const candidate=words.slice(i,j).join(' ');if(nameKey(candidate)===a){const rest=words.slice(j).join(' '),nums=(rest.match(/\b\d+\b/g)||[]).map(Number);return{sourceName:candidate,nums}}}}}return null;
}

function parseWeekGroup(week,lines,filename,season){
  const errors=[],seenPair=new Set(),matchups=[];
  for(const line of lines){const m=matchupFromLine(line);if(!m)continue;if(m.error){errors.push(m.error);continue}const key=`${m.awayNumber}-${m.homeNumber}`;if(!seenPair.has(key)){seenPair.add(key);matchups.push(m)}}
  matchups.sort((a,b)=>Math.min(a.awayNumber,a.homeNumber)-Math.min(b.awayNumber,b.homeNumber));
  if(!matchups.length)return null;
  const gameCount=matchups.length,numberToGame=new Map();
  matchups.forEach((g,i)=>{if(numberToGame.has(g.awayNumber)||numberToGame.has(g.homeNumber))errors.push('Duplicate matchup number');numberToGame.set(g.awayNumber,i);numberToGame.set(g.homeNumber,i)});
  const participants=[];
  for(const target of TARGETS){let hit=null;for(const line of lines){const h=targetMatch(line,target);if(h&&h.nums.length>=gameCount+1){hit=h;break}}if(!hit){errors.push(`Missing ${target.displayName}`);continue}const pickNumbers=hit.nums.slice(0,gameCount),tiebreak=hit.nums[gameCount],seenGames=new Set();for(const n of pickNumbers){const gi=numberToGame.get(n);if(gi===undefined)errors.push(`${target.displayName}: pick ${n} is not in the matchup key`);else if(seenGames.has(gi))errors.push(`${target.displayName}: two picks in matchup ${gi+1}`);else seenGames.add(gi)}if(seenGames.size!==gameCount)errors.push(`${target.displayName}: expected ${gameCount} unique game picks, found ${seenGames.size}`);if(!Number.isInteger(tiebreak))errors.push(`${target.displayName}: missing tiebreak total`);participants.push({id:target.id,displayName:target.displayName,sourceName:hit.sourceName,pickNumbers,tiebreak})}
  const games=matchups.map((g,index)=>({index,awayNumber:g.awayNumber,homeNumber:g.homeNumber,away:g.away,home:g.home,awayName:g.awayName,homeName:g.homeName}));
  return{week,gameCount,errors,config:{schemaVersion:1,season,week,label:`Week ${week}`,tiePoints:0,tiebreakGameIndex:Math.max(0,games.length-1),games,participants,source:{kind:'weekly-upload',filename}}};
}

export function parseDocumentGroups(groups,{filename='weekly-picks',season=2026}={}){
  const byWeek=new Map();
  for(const group of groups||[]){const hinted=Number.isInteger(group.week)?group.week:null;let current=hinted;for(const line of group.lines||[]){const found=detectWeek(line);if(found)current=found;if(!current)continue;if(!byWeek.has(current))byWeek.set(current,[]);byWeek.get(current).push(clean(line))}}
  const candidates=[];for(const [week,lines] of byWeek){const parsed=parseWeekGroup(week,lines,filename,season);if(parsed)candidates.push(parsed)}return candidates.sort((a,b)=>a.week-b.week);
}

export function chooseBestCandidate(candidates){const valid=(candidates||[]).filter(c=>!c.errors.length&&c.config.participants.length===TARGETS.length);return valid.length?valid[valid.length-1]:null}

export function validateConfig(config){
  const errors=[];if(!config) return ['No configuration'];const games=config.games||[],participants=config.participants||[];if(!games.length)errors.push('No games found');if(participants.length!==TARGETS.length)errors.push(`Expected ${TARGETS.length} tracked entries`);if(!Number.isInteger(config.tiebreakGameIndex)||config.tiebreakGameIndex<0||config.tiebreakGameIndex>=games.length)errors.push('Invalid tiebreak game');const nums=new Map();games.forEach((g,i)=>{for(const n of [g.awayNumber,g.homeNumber]){if(!Number.isInteger(n))errors.push(`Game ${i+1}: invalid number`);else if(nums.has(n))errors.push(`Duplicate number ${n}`);else nums.set(n,i)}});participants.forEach(p=>{if(!Number.isInteger(p.tiebreak))errors.push(`${p.displayName}: invalid tiebreak`);if(!Array.isArray(p.pickNumbers)||p.pickNumbers.length!==games.length)errors.push(`${p.displayName}: wrong pick count`);const seen=new Set();for(const n of p.pickNumbers||[]){if(!nums.has(n))errors.push(`${p.displayName}: unknown pick ${n}`);else seen.add(nums.get(n))}if(seen.size!==games.length)errors.push(`${p.displayName}: not exactly one pick per game`)});return [...new Set(errors)];
}
