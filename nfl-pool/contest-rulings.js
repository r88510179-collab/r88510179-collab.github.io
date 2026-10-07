// HDC-12 contest-scoped halted-game rulings: the pure evaluator shared by Pick'em and Survivor.
//
// Three layers stay apart. An NFL FACT comes from the score feed and is never rewritten here. A CONTEST POLICY is the
// halted-game rule the commissioner chose for one contest; it never changes a standing by itself. An INCIDENT RULING is a
// commissioner-confirmed consequence for one halted game in one contest week, and the only thing that changes a pool
// result. A ruling's identity is contest + week + away team + home team + policy revision; event_id is evidence only.
//
// This module is pure: no network, no auth, no DOM, no writes, no makeup-game inference. The apps load the public columns
// (PUBLIC_COLUMNS) and pass them in; every answer is an explicit state object, never a bare boolean or a missing field.
// Anything that cannot be proven is HOLD, isolated to the smallest scope that can be named safely: the teams an incident
// names, else its week, else the whole contest. Nothing malformed is repaired by guessing.

const freeze=Object.freeze;
const TEAM_CODES=new Set(['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS']);
const TEAM_ALIASES={JAC:'JAX',WSH:'WAS'};
const MAX_WEEK=22,DAY_MS=24*60*60*1000;
const HALTED_NAME=/CANCEL|POSTPON|SUSPEND|FORFEIT/i,FORFEIT_NAME=/FORFEIT/i;

export const CONTEST_TYPES=freeze(['pickem','survivor']);
export const HALTED_GAME_POLICIES=freeze({pickem:freeze(['void']),survivor:freeze(['advance_team_used','eliminate','commissioner_decides'])});
export const RULING_CONSEQUENCES=freeze({pickem:freeze(['void']),survivor:freeze(['advance_team_used','eliminate'])});
export const WITHDRAWN='withdrawn';
// The only incident evidence a v1 ruling may rest on. A forfeit is out of scope: it never receives a cancellation ruling.
export const SUPPORTED_INCIDENT_STATUSES=freeze(['STATUS_CANCELED','STATUS_POSTPONED','STATUS_SUSPENDED']);
export const EVIDENCE_SOURCES=freeze(['espn-scoreboard','nflscores2']);
// Contest-scoped rulings begin with the two personal 2026 contests (migration 003). Earlier seasons have no contest and no
// ruling store, so the ruling layer is inactive there and HDC-11 behaviour is unchanged; from 2026 on, a contest that is
// missing or unreadable holds.
export const FIRST_RULING_SEASON=2026;
// The columns anonymous readers are granted (migration 002). created_by and admin_note are never requested.
export const PUBLIC_COLUMNS=freeze({
  contests:freeze(['contest_id','season','contest_type','display_name','starts_at','created_at']),
  policies:freeze(['contest_id','contest_type','revision','effective_week','halted_game_policy','public_note','created_at']),
  rulings:freeze(['ruling_id','contest_id','contest_type','week','away_team','home_team','policy_revision','chain_seq','parent_ruling_id','consequence','incident_status','event_id','evidence_source','public_note','created_at'])
});

const CONTEST_LABEL={pickem:"Pick'em",survivor:'Survivor'};
const isWeek=w=>Number.isInteger(w)&&w>=1&&w<=MAX_WEEK;
const isPositive=n=>Number.isInteger(n)&&n>0;
const text=v=>typeof v==='string'?v:null;
const absent=v=>v===null||v===undefined;
const aliasCode=code=>{const c=typeof code==='string'?code.trim().toUpperCase():'';return TEAM_ALIASES[c]||c};
// Unchecked values reach reason text only through this: never String() on an arbitrary object (which can throw).
const shown=v=>typeof v==='string'||typeof v==='number'||typeof v==='boolean'?String(v):v===null?'null':typeof v;

export function contestIdFor(season,contestType){
  return Number.isInteger(season)&&CONTEST_TYPES.includes(contestType)?`pool-center-${season}-${contestType}`:null;
}

// Canonical NFL code (JAC -> JAX, WSH -> WAS), or null for anything that is not one of the 32 teams.
export function rulingTeamCode(code){const c=aliasCode(code);return TEAM_CODES.has(c)?c:null}

export function validatePolicyValue(contestType,policy){
  if(!CONTEST_TYPES.includes(contestType))return{ok:false,reason:`unknown contest type ${shown(contestType)}`};
  if(typeof policy!=='string'||!HALTED_GAME_POLICIES[contestType].includes(policy))return{ok:false,reason:`"${shown(policy)}" is not a ${CONTEST_LABEL[contestType]} halted-game policy`};
  return{ok:true,policy};
}

// advance_team_used and eliminate each permit only themselves, commissioner_decides permits either Survivor consequence and
// void permits only void. "withdrawn" is a chain operation, not a consequence, so no policy "permits" it.
export function policyAllowsConsequence(contestType,policy,consequence){
  if(!validatePolicyValue(contestType,policy).ok||!RULING_CONSEQUENCES[contestType].includes(consequence))return false;
  return policy===consequence||policy==='commissioner_decides';
}

const rulingId=v=>Number.isSafeInteger(v)&&v>0?String(v):typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)?v:null;

function holdDataset(base,reason){
  return{...base,status:'hold',scope:'contest',reason,contest:null,policies:[],incidents:[],weekHolds:new Map()};
}

function validateContest(rows,{contestId,contestType,season}){
  if(rows.length!==1)return{reason:rows.length?'more than one contest record was returned':`contest ${contestId} is not published`};
  const c=rows[0];
  if(!c||c.contest_id!==contestId||c.contest_type!==contestType||c.season!==season)return{reason:`contest ${contestId} record does not match`};
  if(typeof c.display_name!=='string'||!c.display_name.trim()||typeof c.starts_at!=='string'||!Number.isFinite(Date.parse(c.starts_at)))return{reason:`contest ${contestId} record is incomplete`};
  return{contest:{displayName:c.display_name,startsAt:c.starts_at,startMs:Date.parse(c.starts_at)}};
}

// Revisions must be exactly 1..n, revision 1 in force from Week 1, effective weeks never moving backward, every value valid
// for the contest type, and every revision after the first that was written after the contest started prospective (its
// week nominally starts, at the verified Week-1 kickoff + 7 days per week, more than 3 days after it was written; the
// migration-002 insert check applies the same rule). Revision 1 is the contest's initial policy and is exempt, which is what
// lets the 2026 bootstrap record the policy in force from Week 1. Anything else is not guessed around: the contest holds.
function validatePolicies(rows,{contestId,contestType},contest){
  if(!rows.length)return{reason:'no halted-game policy is published'};
  const out=[];
  for(const p of rows){
    if(!p||p.contest_id!==contestId||(p.contest_type!==undefined&&p.contest_type!==contestType))return{reason:'a policy revision belongs to another contest'};
    if(!isPositive(p.revision))return{reason:'a policy revision number is invalid'};
    if(!isWeek(p.effective_week))return{reason:`policy revision ${p.revision} has no valid effective week`};
    const value=validatePolicyValue(contestType,p.halted_game_policy);
    if(!value.ok)return{reason:`policy revision ${p.revision}: ${value.reason}`};
    if(!absent(p.public_note)&&typeof p.public_note!=='string')return{reason:`policy revision ${p.revision} has an invalid public note`};
    out.push({revision:p.revision,effectiveWeek:p.effective_week,policy:p.halted_game_policy,publicNote:text(p.public_note),createdAt:text(p.created_at)});
  }
  out.sort((a,b)=>a.revision-b.revision);
  for(let i=0;i<out.length;i++){
    const p=out[i];
    if(p.revision!==i+1)return{reason:p.revision===out[i-1]?.revision?`policy revision ${p.revision} appears more than once`:`policy revisions skip revision ${i+1}`};
    const written=Date.parse(p.createdAt??'');
    if(!Number.isFinite(written))return{reason:`policy revision ${p.revision} has no verifiable creation time`};
    if(i===0){if(p.effectiveWeek!==1)return{reason:'policy revision 1 must be in force from Week 1'};continue}
    if(p.effectiveWeek<out[i-1].effectiveWeek)return{reason:`policy revision ${p.revision} moves the effective week backward`};
    // Revisions are appended in order, so a revision can never have been written before the one it follows.
    if(written<Date.parse(out[i-1].createdAt))return{reason:`policy revision ${p.revision} is dated before revision ${out[i-1].revision}`};
    if(written>=contest.startMs&&contest.startMs+(p.effectiveWeek-1)*7*DAY_MS-3*DAY_MS<=written)return{reason:`policy revision ${p.revision} was written after the contest started but reaches Week ${p.effectiveWeek}, which may already have been under way`};
  }
  return{policies:out};
}

function inForce(policies,week){let found=null;for(const p of policies)if(p.effectiveWeek<=week)found=p;return found}

function sanitizeRow(raw,away,home){
  return{id:rulingId(raw.ruling_id),contestId:raw.contest_id,contestType:raw.contest_type,week:raw.week,away,home,
    policyRevision:raw.policy_revision,chainSeq:raw.chain_seq,rawParent:raw.parent_ruling_id,parentId:absent(raw.parent_ruling_id)?null:rulingId(raw.parent_ruling_id),
    consequence:raw.consequence,incidentStatus:raw.incident_status,eventId:absent(raw.event_id)?null:raw.event_id,
    evidenceSource:absent(raw.evidence_source)?null:raw.evidence_source,publicNote:absent(raw.public_note)?null:raw.public_note,createdAt:text(raw.created_at)};
}

const teamsOf=x=>[...new Set([x.away,x.home].filter(Boolean))];

function resolveIncident(rows,ctx){
  const {contestId,contestType,policies,idCounts,idOwner,tainted,key}=ctx,first=rows[0];
  const sorted=rows.slice().sort((a,b)=>(Number.isInteger(a.chainSeq)?a.chainSeq:Infinity)-(Number.isInteger(b.chainSeq)?b.chainSeq:Infinity));
  const incident={key,week:first.week,away:first.away,home:first.home,policyRevision:isPositive(first.policyRevision)?first.policyRevision:null,
    state:'hold',consequence:null,reason:null,evidence:null,history:[]};
  const hold=reason=>({...incident,state:'hold',reason});
  for(const r of sorted){
    if(r.contestId!==contestId||r.contestType!==contestType)return hold('the ruling belongs to another contest');
    if(r.id===null)return hold('a ruling row has no valid identity');
    if(idCounts.get(r.id)>1)return hold('a ruling row identity appears more than once');
    if(!isPositive(r.policyRevision))return hold('a ruling row has no valid policy revision');
    if(!isPositive(r.chainSeq))return hold('a ruling row has no valid chain position');
    if(r.away===r.home)return hold('the ruling names the same team twice');
    if(r.consequence!==WITHDRAWN&&!RULING_CONSEQUENCES[contestType].includes(r.consequence))return hold(`"${shown(r.consequence)}" is not a ${CONTEST_LABEL[contestType]} ruling consequence`);
    if(typeof r.incidentStatus==='string'&&FORFEIT_NAME.test(r.incidentStatus))return hold('a forfeit is not a supported halted-game incident; no v1 ruling applies to it');
    if(!SUPPORTED_INCIDENT_STATUSES.includes(r.incidentStatus))return hold('the incident evidence is not a supported halted status (canceled, postponed or suspended)');
    if(r.eventId!==null&&!(typeof r.eventId==='string'&&/^[0-9]{1,20}$/.test(r.eventId)))return hold('the recorded event evidence is invalid');
    if(r.evidenceSource!==null&&!EVIDENCE_SOURCES.includes(r.evidenceSource))return hold('the recorded evidence source is invalid');
    if(r.publicNote!==null&&typeof r.publicNote!=='string')return hold('a ruling public note is invalid');
  }
  if(tainted.has(key))return hold('a ruling row of another incident names a row of this incident as its predecessor');
  // Deterministic order: chain positions are exactly 1..n.
  for(let i=0;i<sorted.length;i++){
    const seq=sorted[i].chainSeq;
    if(seq===i+1)continue;
    if(seq===sorted[i-1]?.chainSeq)return hold(seq===1?'the incident has more than one original ruling':`chain position ${seq} appears more than once`);
    return hold(`the ruling chain skips position ${i+1}`);
  }
  // Each later row must name the row immediately before it in the same incident; the first names none.
  for(let i=0;i<sorted.length;i++){
    const r=sorted[i];
    if(i===0){if(!absent(r.rawParent))return hold(r.parentId===r.id?'the ruling chain contains a cycle':'the original ruling names a predecessor');continue}
    if(absent(r.rawParent))return hold(`chain position ${r.chainSeq} has no predecessor (a second original ruling)`);
    if(r.parentId===sorted[i-1].id)continue;
    if(r.parentId!==null&&r.parentId===r.id)return hold('the ruling chain contains a cycle');
    if(r.parentId!==null&&idOwner.has(r.parentId)&&idOwner.get(r.parentId)!==key)return hold(`chain position ${r.chainSeq} names a predecessor from another incident`);
    if(r.parentId===null||!idOwner.has(r.parentId))return hold(`chain position ${r.chainSeq} names a predecessor that does not exist`);
    return hold(`chain position ${r.chainSeq} does not follow the preceding ruling (broken or cyclic chain)`);
  }
  // Evidence: the first row records the original incident. A later row may repeat its event id but never name another
  // event, so a makeup game is never followed.
  const eventId=sorted[0].eventId;
  if(sorted.some(r=>r.eventId!==null&&r.eventId!==eventId))return hold('a later ruling row names an event the original ruling did not record; makeup games are never followed');
  // Policy: the revision named must be the one in force for the incident week, and must permit every consequence.
  const cited=policies.find(p=>p.revision===first.policyRevision),current=inForce(policies,first.week);
  if(!cited)return hold(`the ruling cites policy revision ${first.policyRevision}, which does not exist`);
  if(!current||current.revision!==cited.revision)return hold(`the ruling cites policy revision ${cited.revision}, but revision ${current?.revision??'—'} is in force for Week ${first.week}`);
  // Chain semantics: the same consequence again = reaffirmed; withdrawn after an active ruling clears it; a permitted
  // consequence after a withdrawal = re-ruled. A direct change, or a first or repeated withdrawal, is never repaired: HOLD.
  let active=null;const history=[];
  for(let i=0;i<sorted.length;i++){
    const r=sorted[i],c=r.consequence;let action;
    if(c!==WITHDRAWN&&!policyAllowsConsequence(contestType,cited.policy,c))return hold(`policy ${cited.policy} does not permit ${c}`);
    if(i===0){if(c===WITHDRAWN)return hold('the ruling chain starts with a withdrawal');action='ruled';active=c}
    else if(active===null){if(c===WITHDRAWN)return hold('the ruling chain withdraws a ruling that is not active');action='re-ruled';active=c}
    else if(c===WITHDRAWN){action='withdrawn';active=null}
    else if(c===active)action='reaffirmed';
    else return hold(`the ruling chain changes ${active} to ${c} without a withdrawal`);
    history.push({seq:r.chainSeq,action,consequence:c,publicNote:r.publicNote,createdAt:r.createdAt,incidentStatus:r.incidentStatus});
  }
  return{...incident,state:active===null?'withdrawn':'effective',consequence:active,reason:null,
    evidence:{incidentStatus:sorted[0].incidentStatus,eventId,source:sorted[0].evidenceSource},history};
}

// Validates one contest's published policy history and ruling rows. data = {contests, policies, rulings} as loaded from the
// public columns. error means the store could not be read: the contest holds, unless this session already validated the
// same contest's data (previous), which is then kept and marked stale rather than dropped on a passing network failure.
// Data that loads but does not validate always holds; it never falls back to an older dataset.
// Unexpected input that still gets past the checks below (for example a hostile JSON value) holds the contest: the
// evaluator never throws, so a caller can never fall back to older rulings because of it.
export function evaluateContestRulings(input={}){
  try{return evaluate(input)}
  catch{const {contestId,contestType,season}=input||{};return holdDataset({contestId,contestType,season},'ruling data could not be validated')}
}
function evaluate({contestId,contestType,season,data,error,previous=null}={}){
  const base={contestId,contestType,season};
  if(!CONTEST_TYPES.includes(contestType)||typeof contestId!=='string'||!Number.isInteger(season))return holdDataset(base,'the contest identity is invalid');
  if(season<FIRST_RULING_SEASON)return{...base,status:'inactive',scope:null,reason:`contest-scoped rulings begin with the ${FIRST_RULING_SEASON} season`,contest:null,policies:[],incidents:[],weekHolds:new Map()};
  if(error){
    if(previous?.status==='ready'&&previous.contestId===contestId&&previous.contestType===contestType&&previous.season===season)return{...previous,stale:true};
    return holdDataset(base,'ruling data unavailable');
  }
  if(!data||!Array.isArray(data.contests)||!Array.isArray(data.policies)||!Array.isArray(data.rulings))return holdDataset(base,'ruling data unavailable');
  const contest=validateContest(data.contests,base);if(contest.reason)return holdDataset(base,contest.reason);
  const policy=validatePolicies(data.policies,base,contest.contest);if(policy.reason)return holdDataset(base,`policy history is invalid: ${policy.reason}`);
  const weekHolds=new Map(),groups=new Map(),idCounts=new Map(),idOwner=new Map(),partial=[];
  for(const raw of data.rulings){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||!isWeek(raw.week))return holdDataset(base,'a ruling row cannot be attributed to a week');
    const away=rulingTeamCode(raw.away_team),home=rulingTeamCode(raw.home_team);
    // One usable team: hold that team's coverage. Neither: the week cannot be isolated further.
    if(!away||!home){
      if(away||home)partial.push({key:`${raw.week}|partial|${away||home}|${partial.length}`,week:raw.week,away,home,policyRevision:null,state:'hold',consequence:null,
        reason:`a Week ${raw.week} ruling names an unknown team`,evidence:null,history:[]});
      else if(!weekHolds.has(raw.week))weekHolds.set(raw.week,`a Week ${raw.week} ruling names no valid team`);
      continue;
    }
    const row=sanitizeRow(raw,away,home),key=`${row.week}|${away}|${home}|${isPositive(row.policyRevision)?row.policyRevision:'invalid'}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
    if(row.id!==null){idCounts.set(row.id,(idCounts.get(row.id)||0)+1);if(!idOwner.has(row.id))idOwner.set(row.id,key)}
  }
  // A predecessor link that crosses incidents taints both incidents.
  const tainted=new Set();
  for(const [key,rows] of groups)for(const r of rows)if(r.parentId!==null&&idOwner.has(r.parentId)&&idOwner.get(r.parentId)!==key){tainted.add(key);tainted.add(idOwner.get(r.parentId))}
  const incidents=[...[...groups].map(([key,rows])=>resolveIncident(rows,{contestId,contestType,policies:policy.policies,idCounts,idOwner,tainted,key})),...partial];
  // One team, one incident per contest week. The rows of one chain are one incident and never count twice, and a withdrawn
  // incident (no active ruling) covers nothing, so a mistaken ruling, once withdrawn, never blocks the correct one.
  const cover=new Map();
  for(const x of incidents.filter(i=>i.state!=='withdrawn'))for(const team of teamsOf(x)){const k=`${x.week}|${team}`;if(!cover.has(k))cover.set(k,[]);cover.get(k).push(x)}
  for(const [k,list] of cover)if(list.length>1){
    const team=k.split('|')[1];
    for(const x of list){x.doubleCoverage=true;if(x.state!=='hold'){x.state='hold';x.consequence=null;x.reason=`${team} is covered by more than one Week ${x.week} incident`}}
  }
  incidents.sort((a,b)=>a.week-b.week||(a.away||'').localeCompare(b.away||'')||(a.home||'').localeCompare(b.home||'')||String(a.policyRevision).localeCompare(String(b.policyRevision)));
  return{...base,status:'ready',scope:null,reason:null,stale:false,contest:contest.contest,policies:policy.policies,incidents,weekHolds};
}

export function policyForWeek(dataset,week){
  if(dataset?.status!=='ready')return{status:dataset?.status==='inactive'?'inactive':'hold',reason:dataset?.reason||'ruling data unavailable'};
  if(!isWeek(week))return{status:'hold',reason:'invalid week'};
  const p=inForce(dataset.policies,week);
  return p?{status:'ok',...p}:{status:'hold',reason:`no policy is in force for Week ${week}`};
}

function fromIncident(x){
  if(x.state==='hold')return{state:'hold',scope:'incident',reason:x.reason,incident:x};
  if(x.state==='withdrawn')return{state:'withdrawn',incident:x};
  return{state:'effective',consequence:x.consequence,incident:x};
}
function slotPrecheck(dataset,week){
  if(dataset?.status==='inactive')return{state:'none',inactive:true};
  if(dataset?.status!=='ready')return{state:'hold',scope:'contest',reason:dataset?.reason||'ruling data unavailable'};
  if(dataset.weekHolds.has(week))return{state:'hold',scope:'week',reason:dataset.weekHolds.get(week)};
  return null;
}

// Pick'em: the published slot is the configured away/home pair for that week. A ruling that names either team with any
// other opponent, or the pair inverted, does not match the published game: the slot holds rather than matching loosely.
export function rulingForSlot(dataset,{week,away,home}={}){
  const pre=slotPrecheck(dataset,week);if(pre)return pre;
  const a=aliasCode(away),h=aliasCode(home);
  const touching=dataset.incidents.filter(x=>x.week===week&&teamsOf(x).some(t=>t===a||t===h));
  // A withdrawn incident has no active ruling: it neither holds nor decides the slot.
  const active=touching.filter(x=>x.state!=='withdrawn');
  const other=active.find(x=>!(x.away===a&&x.home===h));
  if(other)return{state:'hold',scope:'incident',reason:other.away&&other.home?`a Week ${week} ruling for ${other.away} @ ${other.home} does not match the published game ${a} @ ${h}`:other.reason,incident:other};
  if(active.length>1)return{state:'hold',scope:'incident',reason:`more than one Week ${week} incident covers ${a} @ ${h}`,incident:active[0]};
  if(active.length)return fromIncident(active[0]);
  const withdrawn=touching.find(x=>x.away===a&&x.home===h);
  return withdrawn?fromIncident(withdrawn):{state:'none'};
}

// Survivor: the published slot is the picked team in that week. advance_team_used keeps the entry alive with the team
// still used; eliminate puts it out. Neither invents an NFL winner.
export function rulingForTeam(dataset,{week,team}={}){
  const pre=slotPrecheck(dataset,week);if(pre)return pre;
  const t=aliasCode(team);
  const touching=dataset.incidents.filter(x=>x.week===week&&teamsOf(x).includes(t));
  // A withdrawn incident has no active ruling: it neither holds nor decides the pick.
  const active=touching.filter(x=>x.state!=='withdrawn');
  if(active.length>1)return{state:'hold',scope:'incident',reason:`${t} is covered by more than one Week ${week} incident`,incident:active[0]};
  if(active.length)return withOutcome(fromIncident(active[0]));
  return touching.length?fromIncident(touching[0]):{state:'none'};
}
const withOutcome=slot=>slot.state!=='effective'?slot:slot.consequence==='advance_team_used'?{...slot,outcome:'alive',teamUsed:true}:{...slot,outcome:'out'};

const eventIdOf=e=>absent(e?.id)?null:String(e.id);
const contextNumber=v=>typeof v==='number'?v:typeof v==='string'&&/^\d+$/.test(v.trim())?Number(v.trim()):NaN;
function eventCodes(e){
  const out=[];
  for(const c of Array.isArray(e?.competitions)?e.competitions:[])for(const x of Array.isArray(c?.competitors)?c.competitors:[])out.push(aliasCode(x?.team?.abbreviation));
  return out;
}
function describeEvent(e,{a,h,season,week,seasonType},tied){
  const eventId=eventIdOf(e);
  for(const [actual,expected] of [[e?.season?.year,season],[e?.season?.type,seasonType],[e?.week?.number,week]])
    if(!absent(actual)&&!absent(expected)&&contextNumber(actual)!==expected)return{kind:'context',eventId,tied};
  const comps=Array.isArray(e?.competitions)?e.competitions:[],c=comps[0],competitors=Array.isArray(c?.competitors)?c.competitors:[];
  const aways=competitors.filter(x=>x?.homeAway==='away'),homes=competitors.filter(x=>x?.homeAway==='home');
  if(comps.length!==1||competitors.length!==2||aways.length!==1||homes.length!==1)return{kind:'malformed',eventId,tied};
  const ea=aliasCode(aways[0]?.team?.abbreviation),eh=aliasCode(homes[0]?.team?.abbreviation);
  if(ea!==a||eh!==h)return{kind:'opponent',away:ea,home:eh,eventId,tied};
  const type=e?.status?.type||{},names=[type.name,c?.status?.type?.name].filter(n=>typeof n==='string');
  const forfeit=names.find(n=>FORFEIT_NAME.test(n));
  if(forfeit)return{kind:'forfeit',eventId,status:forfeit,tied};
  if(type.completed===true)return{kind:'final',eventId,status:names[0]??null,tied};
  const halted=names.find(n=>HALTED_NAME.test(n));
  if(halted)return{kind:'halted',eventId,status:halted,tied};
  if(type.state==='in')return{kind:'live',eventId,status:names[0]??null,tied};
  if(type.state==='pre')return{kind:'scheduled',eventId,status:names[0]??null,tied};
  return{kind:'unfinished',eventId,status:names[0]??null,tied};
}
// A listing that can be read (well-formed and in context), and one of exactly the ruled pair.
const readable=x=>x.kind!=='context'&&x.kind!=='malformed',samePair=x=>readable(x)&&x.kind!=='opponent';

// What the raw feed says now about an incident's teams, read separately from the protected grading path (HDC-09/10/11 stay
// untouched). The event the ruling recorded, when present in the feed, is the incident (tied); otherwise the one event that
// involves either team is described. The feed is evidence about a ruling, never its identity: no other event or matchup is
// ever adopted as the incident. A ruled team the feed also places in another game that week is a re-pairing the ruling
// never covered ('repaired'); the ruled pair also listed under another event id is 'relisted' (the HDC-09 duplicate the
// protected path reports, which is also a conflict for the ruling). Both are UNDER REVIEW, unless the feed reports a forfeit
// for the ruled pair, which no v1 ruling covers.
// Copies of one event are one logical event: listings that read alike count once, so a duplicate is never independent
// evidence and never hides other evidence, while copies of one event id that read differently are a conflict
// ('conflicting'), never settled by whichever copy comes first. A forfeit of the ruled pair in any well-formed, in-context
// listing decides before anything else. The ruled pair's own listings are read in a canonical order, so the feed order
// never changes the result; a re-pairing is still named by the first one the feed lists.
export function observeIncident(events,{away,home,eventId=null,season,week,seasonType=2}={}){
  if(!Array.isArray(events))return{kind:'unavailable'};
  const ctx={a:aliasCode(away),h:aliasCode(home),season,week,seasonType},seen=new Map();
  for(const e of events){
    const tied=Boolean(eventId)&&eventIdOf(e)===eventId;
    if(!tied&&!eventCodes(e).some(t=>t===ctx.a||t===ctx.h))continue;
    const d=describeEvent(e,ctx,tied),key=JSON.stringify([d.eventId,d.kind,d.status??null,d.away??null,d.home??null]);
    if(!seen.has(key))seen.set(key,d);
  }
  const described=[...seen.values()],canonical=[...seen.keys()].sort().map(k=>seen.get(k));
  if(!described.length)return{kind:'missing',tied:false};
  const forfeit=canonical.find(x=>x.kind==='forfeit');
  if(forfeit)return forfeit;
  if(described.length===1)return described[0];
  const repaired=(incident,other)=>({...incident,kind:'repaired',incidentKind:incident.kind,otherAway:other.away,otherHome:other.home,otherEventId:other.eventId});
  const relisted=(incident,others)=>({...incident,kind:'relisted',incidentKind:incident.kind,otherEventIds:others.map(x=>x.eventId)});
  const conflicting=copies=>({kind:'conflicting',eventId:copies[0].eventId,tied:copies[0].tied});
  const recorded=canonical.filter(x=>x.tied);
  if(recorded.length){
    // The recorded event: a copy that cannot be read is no evidence, readable copies that disagree are a conflict.
    const copies=recorded.filter(readable),d=(copies.length?copies:recorded)[0],same=canonical.filter(x=>!x.tied&&samePair(x));
    if(same.length)return relisted(d,same);
    if(copies.length>1)return conflicting(copies);
    const other=described.find(x=>!x.tied&&x.kind==='opponent');
    return other?repaired(d,other):d;
  }
  // Several listings, none of them the recorded event. The ruled pair under more than one event id is relisted, whatever
  // else the feed lists, and copies of its one event id that disagree are a conflict; otherwise an event that cannot be read
  // leaves no usable evidence, unless it is a copy of the ruled pair's listing (the same event id), which is no evidence.
  // The ruled pair once plus a ruled team against another opponent is a re-pairing.
  const exact=canonical.filter(samePair),ids=new Set(exact.map(x=>x.eventId)),others=exact.filter(x=>x.eventId!==exact[0].eventId);
  if(others.length)return relisted(exact[0],others);
  if(exact.length>1)return conflicting(exact);
  if(described.some(x=>!readable(x)&&!ids.has(x.eventId)))return{kind:'ambiguous',tied:false};
  const other=described.find(x=>x.kind==='opponent');
  return exact.length?(other?repaired(exact[0],other):exact[0]):described[0];
}

// Compares an effective ruling's recorded incident with what the feed says now. A valid ruling is the commissioner's
// confirmed decision whether or not it recorded an event (event_id is evidence, never identity), so a later feed change never
// removes it: only a forfeit, which no v1 ruling covers, makes it unusable.
//   agrees  - the feed still reports the recorded halted incident
//   unknown - the feed gives no usable evidence (unavailable, malformed or outside the season/week, which the protected
//             grading path already reports); the ruling stays applied. Copies of one event that read alike are that one
//             event, judged as if listed once.
//   review  - the feed changed after confirmation (final, live, scheduled, other status, other event id, other opponent,
//             inverted pair, gone, malformed): the ruling STAYS APPLIED and is UNDER REVIEW; nothing is withdrawn or re-slotted
//   review  - also when the feed places a ruled team in another game that week (a re-pairing), lists the ruled pair under
//             another event id as well (relisted) or lists one event more than once with copies that disagree
//             (conflicting); no event is adopted
//   hold    - the ruling cannot be applied: the feed now reports a forfeit for the ruled pair (out of scope for v1)
export function incidentFeedCheck(incident,observation){
  if(!incident||incident.state!=='effective')return{status:'none'};
  const o=observation||{kind:'unavailable'},stored=incident.evidence||{};
  const changedId=stored.eventId&&o.eventId&&o.eventId!==stored.eventId?` (feed event ${o.eventId}; the ruling recorded event ${stored.eventId})`:'';
  const review=reason=>({status:'review',kind:o.kind,reason});
  switch(o.kind){
    case 'unavailable':return{status:'unknown'};
    case 'forfeit':return{status:'hold',kind:'forfeit',reason:`the feed now reports ${o.status}; a forfeit is not covered by v1 rulings`};
    case 'opponent':return review(`the feed now lists ${o.away} @ ${o.home}${changedId}`);
    case 'repaired':return review(`the feed also lists ${o.otherAway} @ ${o.otherHome} this week${o.otherEventId?` (feed event ${o.otherEventId})`:''}`);
    case 'relisted':{
      const ids=[...new Set((o.otherEventIds||[]).filter(Boolean))];
      return review(`the feed also lists ${incident.away} @ ${incident.home} under another event${ids.length?` (feed event ${ids.join(', ')})`:''}${!o.tied&&stored.eventId?`; the ruling recorded event ${stored.eventId}`:''}`);
    }
    case 'conflicting':return review(`the feed lists ${o.eventId?`event ${o.eventId}`:`${incident.away} @ ${incident.home}`} more than once with conflicting information${!o.tied&&stored.eventId?`; the ruling recorded event ${stored.eventId}`:''}`);
    case 'ambiguous':case 'malformed':case 'context':return{status:'unknown',kind:o.kind};
    case 'halted':
      if(o.status!==stored.incidentStatus)return review(`the feed now reports ${o.status}; the ruling recorded ${stored.incidentStatus}${changedId}`);
      return changedId?review(`the feed now reports a different event${changedId}`):{status:'agrees'};
    case 'final':return review(`the feed now reports a completed final${changedId}`);
    case 'live':return review(`the feed now reports the game live${changedId}`);
    case 'scheduled':return review(`the feed now reports the game scheduled${changedId}`);
    case 'unfinished':return review(`the feed no longer reports the game as halted${changedId}`);
    case 'missing':return review("the game is no longer in this week's feed");
    default:return review('the feed no longer matches the recorded incident');
  }
}

// Applies the feed check to a slot's ruling state: an effective ruling the feed now makes unusable (a forfeit) becomes HOLD;
// an effective ruling the feed contradicts stays effective with underReview set. Pick'em and Survivor are checked alike.
function checkedSlot(slot,events,{season,week}){
  if(slot.state!=='effective')return slot;
  const x=slot.incident,obs=observeIncident(events,{away:x.away,home:x.home,eventId:x.evidence?.eventId||null,season,week});
  const check=incidentFeedCheck(x,obs);
  if(check.status==='hold')return{state:'hold',scope:'incident',reason:check.reason,incident:x};
  return{...slot,feed:check,underReview:check.status==='review'?check.reason:null};
}

// Pick'em: one published slot's ruling state against the raw feed of its week.
export function pickemSlotRuling(dataset,{week,season,away,home,events}={}){
  return checkedSlot(rulingForSlot(dataset,{week,away,home}),events,{season,week});
}

// Pick'em: the effect of a slot's ruling state. VOID is a commissioner ruling, never an NFL tie.
export function pickemSlotEffect(slot){
  if(slot?.state==='hold')return{kind:'hold',scope:slot.scope,reason:slot.reason};
  if(slot?.state==='effective'&&slot.consequence==='void')return{kind:'void',underReview:slot.underReview||null,incident:slot.incident};
  if(slot?.state==='effective')return{kind:'hold',scope:'incident',reason:`unsupported Pick'em consequence ${String(slot.consequence)}`};
  return{kind:'nfl',withdrawn:slot?.state==='withdrawn'};
}

// The scoring view of one Pick'em game. A void slot scores like nothing at all (completed, no winner, no scores: no win,
// no loss, no remaining game and no tiebreak total) and carries void:true so it is shown as VOID, never as a tie. A held
// slot is never graded. The NFL fact passed in is not modified.
export function pickemEffectiveGame(game,effect){
  if(effect?.kind==='void')return{...game,state:'post',completed:true,winner:null,awayScore:null,homeScore:null,void:true,underReview:effect.underReview||null};
  if(effect?.kind==='hold')return{...game,state:'pre',completed:false,winner:null,awayScore:null,homeScore:null,hold:effect.reason||'ruling unavailable'};
  return game;
}

// Survivor: the ruling overlay survivor-math.js reads. forPick(week, team) is the team's ruling state in that week, with
// an effective ruling checked against that week's raw feed.
export function survivorRulingLookup(dataset,{eventsByWeek=[],season}={}){
  const status=dataset?.status==='ready'?'ready':dataset?.status==='inactive'?'inactive':'hold';
  return{
    status,
    reason:status==='ready'?null:(dataset?.reason||'ruling data unavailable'),
    forPick(week,team){return checkedSlot(rulingForTeam(dataset,{week,team}),eventsByWeek[week-1],{season,week})}
  };
}

const POLICY_TEXT={
  void:'A canceled, postponed or suspended game that is never completed is void once the commissioner confirms a ruling for it: it is removed from scoring, with no win, no loss and no points. If it is the tiebreak game, there is no tiebreak that week and tied leaders are co-winners.',
  advance_team_used:'When the commissioner confirms a ruling for a canceled, postponed or suspended game that is never completed, its pickers advance to the next week and the team still counts as used.',
  eliminate:'When the commissioner confirms a ruling for a canceled, postponed or suspended game that is never completed, its pickers are eliminated.',
  commissioner_decides:'For each canceled, postponed or suspended game that is never completed, the commissioner confirms whether its pickers advance (the team still counts as used) or are eliminated.'
};
const POLICY_NAME={void:'Void',advance_team_used:'Advance, team used',eliminate:'Eliminate',commissioner_decides:'Commissioner decides'};
const CONSEQUENCE_NAME={void:'VOID',advance_team_used:'ADVANCE',eliminate:'ELIMINATE'};
const CONSEQUENCE_TEXT={
  void:'VOID: removed from scoring, with no win, no loss and no points',
  advance_team_used:'ADVANCE: its pickers advance and the team still counts as used',
  eliminate:'ELIMINATE: its pickers are eliminated'
};
const ACTION_TEXT={ruled:'Ruled','reaffirmed':'Reaffirmed',withdrawn:'Withdrawn','re-ruled':'Re-ruled'};

export function describePolicy(policy){return POLICY_TEXT[policy]||'Unknown policy.'}
export function consequenceText(consequence){return CONSEQUENCE_TEXT[consequence]||String(consequence)}

// Plain-text model of the participant-visible "Rules & rulings" card. Only public fields reach it; row ids never do.
export function rulesModel(dataset,{week,slotState=null}={}){
  const type=`${CONTEST_LABEL[dataset?.contestType]||'Pool'} contest`;
  const confirmation='Commissioner confirmation is required: a halted game changes standings only through a ruling the commissioner confirms for that incident. The policy alone never changes standings, and a later change in the NFL feed never removes a confirmed ruling.';
  if(dataset?.status==='inactive')return{state:'inactive',contestType:type,heading:'No contest-scoped rulings',text:`Contest-scoped halted-game rulings begin with the ${FIRST_RULING_SEASON} season. This week uses NFL results, and a halted game awaits a pool ruling.`,confirmation};
  if(dataset?.status!=='ready')return{state:'hold',contestType:type,heading:'ON HOLD · Ruling data unavailable',
    text:`The contest rules and rulings could not be loaded or verified (${dataset?.reason||'ruling data unavailable'}). Results that depend on them are on hold until they load; nothing is graded from the NFL feed alone.`,confirmation};
  const current=policyForWeek(dataset,week);
  const incidents=dataset.incidents.filter(x=>!Number.isInteger(week)||x.week<=week).map(x=>{
    const slot=slotState?slotState(x):null;
    // A withdrawn incident is WITHDRAWN whatever now decides its teams (another incident's hold is shown on that incident).
    // A ruling that matches no published game is invalid stored ruling information for this contest: HOLD, never APPLIED.
    const slotHold=x.state==='withdrawn'?null:slot?.state==='hold'?slot.reason:slot?.unmatched?'it does not match a published game in this contest':null;
    const held=x.state==='hold'||Boolean(slotHold),review=!held&&x.state==='effective'?slot?.underReview||null:null;
    const status=held?'HOLD':x.state==='withdrawn'?'WITHDRAWN':review?'UNDER REVIEW':'APPLIED';
    const detail=held?`On hold: ${slotHold||x.reason}. No consequence is applied.`
      :x.state==='withdrawn'?'The ruling was withdrawn: there is no active ruling, so the NFL result or the awaiting-ruling state applies.'
      :`${consequenceText(x.consequence)}. Applied by commissioner ruling under policy revision ${x.policyRevision}.`;
    return{key:x.key,week:x.week,matchup:x.away&&x.home?`${x.away} @ ${x.home}`:(x.away||x.home||'Unknown teams'),status,detail,
      review:review?`UNDER REVIEW: ${review}. The ruling stays applied until the commissioner changes it.`:null,
      evidence:x.evidence?`Recorded incident: ${x.evidence.incidentStatus}${x.evidence.eventId?` · event ${x.evidence.eventId}`:''}`:null,
      history:x.history.map(h=>({label:`${ACTION_TEXT[h.action]}${h.action==='withdrawn'?'':` ${CONSEQUENCE_NAME[h.consequence]||h.consequence}`}`,date:h.createdAt?h.createdAt.slice(0,10):null,note:h.publicNote||null}))};
  });
  return{state:'ready',contestType:type,contestName:dataset.contest.displayName,
    stale:dataset.stale?'The rules and rulings could not be refreshed just now; these are the ones last verified on this page.':null,
    policy:current.status==='ok'?{revision:current.revision,effectiveWeek:current.effectiveWeek,name:POLICY_NAME[current.policy],text:describePolicy(current.policy),publicNote:current.publicNote}:null,
    revisions:dataset.policies.map(p=>({revision:p.revision,effectiveWeek:p.effectiveWeek,name:POLICY_NAME[p.policy],publicNote:p.publicNote})),
    confirmation,incidents,
    empty:incidents.length?null:'No incident ruling has been confirmed for this contest so far.'};
}
