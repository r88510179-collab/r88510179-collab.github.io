// HDC-13: the commissioner incident-ruling write path, the Admin's pure logic.
//
// This module owns candidate discovery, eligibility, the action state, request and preview construction, error-token
// mapping and evidence-source mapping. It is pure: no DOM, no network, no auth, no storage, no timers. rulings-admin.js
// does the reading, the sign-in and the RPC; the database function (migration 004) is the authority and refuses anything
// this module would have refused, and more.
//
// Every judgement reuses the shared HDC-12 code the public pages run: the feed is read with observeIncident and
// incidentFeedCheck (no second incident classifier), the ruling layer with evaluateContestRulings and the slot functions,
// Survivor results with survivorBuildResults and the entry functions, the Rules card with rulesModel, a Pick'em record with
// scoreEntry. The NFL fact of a game is never graded here: the preview knows it only for a halted game (not completed, no
// win, no loss, still remaining); any other game is graded on the public page by its protected feed path.
//
// Eligibility is the HDC-13 boundary. A first ruling or a re-ruling is offered only for a game the production feed path
// (score-feed-proxy.js -> nflscores2) explicitly reports halted (STATUS_CANCELED, STATUS_POSTPONED or STATUS_SUSPENDED)
// under its one event, in the published orientation, with the published event id where the published game has one,
// such that the new ruling would read as APPLIED on the public pages at once. A game absent from the week, moved, inverted,
// re-paired, relisted, read with conflicting copies, recorded under another event, or forfeited is refused: it requires the
// future exception workflow (HDC-14).

import {CONTEST_TYPES,PUBLIC_COLUMNS,RULING_CONSEQUENCES,SUPPORTED_INCIDENT_STATUSES,WITHDRAWN,contestIdFor,rulingTeamCode,
  evaluateContestRulings,policyForWeek,policyAllowsConsequence,observeIncident,incidentFeedCheck,pickemSlotRuling,
  pickemSlotEffect,pickemEffectiveGame,survivorRulingLookup,rulesModel} from '../contest-rulings.js?v=1';
import {survivorBuildResults,survivorEntryState,survivorEligibleEntering,survivorSummary,survivorAwaitingRuling,survivorOnHold,
  survivorFeedContextError,survivorScore} from '../survivor-math.js?v=7';
import {scoreEntry} from '../public-math.js?v=2';

export {PUBLIC_COLUMNS};

const freeze=Object.freeze;
export const RPC_FUNCTION='nfl_append_incident_ruling';
// The 13 approved arguments, in the function's order. Nothing else is ever sent (created_by, chain_seq, parent_ruling_id,
// root_ruling_id and created_at are derived by the server).
export const RPC_ARGUMENTS=freeze(['p_contest_id','p_week','p_away_team','p_home_team','p_action','p_consequence',
  'p_expected_policy_revision','p_expected_parent_ruling_id','p_incident_status','p_event_id','p_evidence_source',
  'p_public_note','p_admin_note']);
export const ACTIONS=freeze(['rule','reaffirm','withdraw','rerule']);
// The write-access check withdraws with an expected parent no chain can have: an authorized caller is refused with
// HDC13_STALE_CHAIN after passing the commissioner check, and nothing is written.
export const WRITE_PROBE_PARENT=9007199254740991;
// The feed path the public pages read: score-feed-proxy.js sends the ESPN scoreboard request to the nflscores2 Function.
export const PRODUCTION_FEED_SOURCE='nflscores2';
export const ESPN_SCOREBOARD='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
export const NFLSCORES2_ORIGIN='https://br-late-hat-b55ygmj4-nflscores2.compute.c-7.us-east-2.aws.neon.tech';
export const HDC14_REFUSAL='requires the future exception workflow';
export const PUBLIC_NOTE_MAX=500,ADMIN_NOTE_MAX=2000;

// Fixed, safe messages for the database's HDC-13 refusal tokens. A refusal never writes anything.
export const HDC13_ERROR_TEXT=freeze({
  HDC13_NOT_COMMISSIONER:'The database refused this account: only the commissioner can record incident rulings. Nothing was written.',
  HDC13_ISOLATION:'The database refused the write because the request did not run under READ COMMITTED. Nothing was written.',
  HDC13_INVALID_INPUT:'The database refused the request as invalid. Nothing was written. Reload, then build a new preview.',
  HDC13_STALE_POLICY:'The contest policy changed after this preview was built. Nothing was written. Reload, then build a new preview.',
  HDC13_STALE_CHAIN:'The ruling chain changed after this preview was built (another tab, a retry or a double submit). Nothing was written. Reload, then build a new preview.',
  HDC13_INVALID_TRANSITION:"That action is not valid for the incident's current state. Nothing was written. Reload, then build a new preview.",
  HDC13_NOT_PERMITTED:'The governing policy does not permit that consequence. Nothing was written.',
  HDC13_NOT_PUBLISHED:'That game is not in the published Pool Center data for this contest week. Nothing was written.',
  HDC13_EVENT_MISMATCH:"The incident's event does not match the published game's event. Nothing was written; this requires the future exception workflow."
});

const ALIASES=freeze({JAC:'JAX',WSH:'WAS'});
const aliasOnly=code=>ALIASES[code]||code;
const DIGITS=/^[0-9]{1,20}$/;
const absent=v=>v===null||v===undefined;
const codePoints=s=>[...s].length;
const shown=v=>typeof v==='string'||typeof v==='number'?String(v):'—';

// ---- the feed path and its evidence source ----------------------------------------------------------------------------

// The URL the Admin requests, exactly as the public pages do; score-feed-proxy.js rewrites it to nflscores2.
export function scoreboardUrl(season,week){return`${ESPN_SCOREBOARD}?dates=${season}&seasontype=2&week=${week}&limit=100`}

// The evidence source of a response, from the URL that answered it: nflscores2, the ESPN scoreboard, or unknown (null).
export function evidenceSourceFor(url){
  if(typeof url!=='string'||!url)return null;
  let u;try{u=new URL(url)}catch{return null}
  if(u.origin===NFLSCORES2_ORIGIN)return'nflscores2';
  if(`${u.origin}${u.pathname}`===ESPN_SCOREBOARD)return'espn-scoreboard';
  return null;
}

// A week's payload as the public Survivor page accepts it: an event list with games, no contradicting season or week.
export function readFeed(payload,{season,week}={}){
  if(!payload||typeof payload!=='object'||!Array.isArray(payload.events))return{ok:false,reason:`the Week ${shown(week)} score feed returned no event list`};
  const error=survivorFeedContextError(payload,{season,week});
  return error?{ok:false,reason:error}:{ok:true,events:payload.events};
}

// ---- notes (the database applies the same rules) ----------------------------------------------------------------------

const PUBLIC_NOTE_FORBIDDEN=/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ADMIN_NOTE_FORBIDDEN=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

// The public note: required, one line of plain text (no tab, line break or control character), trimmed of spaces, 1-500
// characters counted as the database counts them (code points). Never rendered as HTML anywhere.
export function checkPublicNote(value){
  if(typeof value!=='string')return{ok:false,reason:'a public note is required'};
  if(PUBLIC_NOTE_FORBIDDEN.test(value))return{ok:false,reason:'the public note must be one line of plain text, with no tab, line break or control character'};
  const v=value.replace(/^ +| +$/g,'');
  if(!v)return{ok:false,reason:'a public note is required'};
  if(codePoints(v)>PUBLIC_NOTE_MAX)return{ok:false,reason:`the public note is longer than ${PUBLIC_NOTE_MAX} characters`};
  return{ok:true,value:v};
}

// The private note: at most 2000 characters, tabs and line breaks kept, no other control character, trimmed of
// whitespace; empty means none. Required for withdraw and re-rule.
export function checkAdminNote(value,{required=false}={}){
  if(!absent(value)&&typeof value!=='string')return{ok:false,reason:'the private note must be text'};
  const raw=typeof value==='string'?value:'';
  if(ADMIN_NOTE_FORBIDDEN.test(raw))return{ok:false,reason:'the private note may contain tabs and line breaks but no other control character'};
  const v=raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g,'');
  if(!v)return required?{ok:false,reason:'a private note is required for withdraw and re-rule'}:{ok:true,value:null};
  if(codePoints(v)>ADMIN_NOTE_MAX)return{ok:false,reason:`the private note is longer than ${ADMIN_NOTE_MAX} characters`};
  return{ok:true,value:v};
}

// ---- selection: contests, weeks and published games (nothing free-form) ------------------------------------------------

// The contests the Pool Center pages read (contest_id = pool-center-<season>-<type>), newest season first.
export function contestOptions(rows){
  if(!Array.isArray(rows))return[];
  const out=[];
  for(const r of rows){
    if(!r||typeof r!=='object'||!CONTEST_TYPES.includes(r.contest_type)||!Number.isInteger(r.season))continue;
    if(r.contest_id!==contestIdFor(r.season,r.contest_type)||typeof r.display_name!=='string'||!r.display_name.trim())continue;
    out.push({contestId:r.contest_id,contestType:r.contest_type,season:r.season,displayName:r.display_name});
  }
  return out.sort((a,b)=>b.season-a.season||a.contestType.localeCompare(b.contestType));
}

// A published Pick'em week's games, read with the canonical alias map only (as the public Pick'em page reads them).
export function pickemGames(config){
  if(!config||typeof config!=='object'||!Array.isArray(config.games))return null;
  const out=[];
  for(const [index,g] of config.games.entries()){
    if(!g||typeof g!=='object'||typeof g.away!=='string'||typeof g.home!=='string')return null;
    out.push({index,away:aliasOnly(g.away),home:aliasOnly(g.home),eventId:absent(g.eventId)?null:String(g.eventId)});
  }
  return out;
}

// Locked Pick'em weeks of the season whose configuration is that season and week, in order.
export function pickemWeeks(rows,{season}={}){
  if(!Array.isArray(rows))return[];
  return rows.filter(r=>r&&r.season===season&&r.status==='locked'&&Number.isInteger(r.week)&&r.config&&typeof r.config==='object'
      &&r.config.season===season&&r.config.week===r.week&&pickemGames(r.config))
    .map(r=>({week:r.week,revision:r.revision,config:r.config,games:pickemGames(r.config)}))
    .sort((a,b)=>a.week-b.week);
}

// The latest locked Survivor snapshot of the season, and every week it covers (a ruling needs a snapshot covering its week).
export function survivorWeeks(rows,{season}={}){
  const locked=(Array.isArray(rows)?rows:[]).filter(r=>r&&r.season===season&&r.status==='locked'&&Number.isInteger(r.week)&&r.week>=1
    &&r.week<=22&&r.config&&typeof r.config==='object'&&r.config.season===season&&r.config.week===r.week);
  if(!locked.length)return{snapshot:null,weeks:[]};
  const latest=locked.reduce((a,b)=>b.week>a.week?b:a);
  return{snapshot:{week:latest.week,revision:latest.revision,config:latest.config},weeks:Array.from({length:latest.week},(_,i)=>i+1)};
}

// ---- chains, policy, candidates and the action state --------------------------------------------------------------------

// One incident's chain from the public ruling rows: EMPTY, ACTIVE (its last row is a consequence) or WITHDRAWN.
export function chainState(rows,{week,away,home,policyRevision}={}){
  const list=(Array.isArray(rows)?rows:[]).filter(r=>r&&r.week===week&&r.away_team===away&&r.home_team===home&&r.policy_revision===policyRevision)
    .sort((a,b)=>a.chain_seq-b.chain_seq);
  const root=list[0]||null,last=list[list.length-1]||null;
  const state=!last?'empty':last.consequence===WITHDRAWN?'withdrawn':'active';
  return{state,rows:list,root,last,consequence:state==='active'?last.consequence:null};
}

// The consequences a policy permits for a contest type, exactly as policyAllowsConsequence decides.
export function consequenceChoices(contestType,policy){
  return CONTEST_TYPES.includes(contestType)?RULING_CONSEQUENCES[contestType].filter(c=>policyAllowsConsequence(contestType,policy,c)):[];
}

const refuse=(reason,hdc14=false)=>({ok:false,reason,hdc14,evidence:null,observation:null});

// What a reading of the feed means for a new ruling. Only an explicitly halted, supported status is recordable.
function haltedReading(o){
  switch(o?.kind){
    case 'halted':return SUPPORTED_INCIDENT_STATUSES.includes(o.status)?{ok:true}:refuse(`${shown(o.status)} is not a supported halted status (canceled, postponed or suspended)`);
    case 'forfeit':return refuse(`the feed reports ${shown(o.status)}: a forfeit is never ruled on as a halted game; it ${HDC14_REFUSAL}`,true);
    case 'missing':return refuse(`the game is not in this week's feed (absent, or moved to another week); it ${HDC14_REFUSAL}`,true);
    case 'opponent':return refuse(`the feed lists ${shown(o.away)} @ ${shown(o.home)} for these teams (an inverted or re-paired matchup); it ${HDC14_REFUSAL}`,true);
    case 'repaired':return refuse(`the feed also lists ${shown(o.otherAway)} @ ${shown(o.otherHome)} this week (a re-paired team); it ${HDC14_REFUSAL}`,true);
    case 'relisted':return refuse(`the feed lists this matchup under more than one event (relisted); it ${HDC14_REFUSAL}`,true);
    case 'conflicting':return refuse(`the feed lists event ${shown(o.eventId)} more than once with conflicting information; it ${HDC14_REFUSAL}`,true);
    case 'final':return refuse('the feed reports a completed final: only an explicitly halted game is ruled on');
    case 'live':return refuse('the feed reports the game live: only an explicitly halted game is ruled on');
    case 'scheduled':return refuse('the feed reports the game scheduled: only an explicitly halted game is ruled on');
    case 'unfinished':return refuse('the feed does not report the game as halted');
    case 'unavailable':return refuse('the score feed for this week could not be read');
    default:return refuse('the feed evidence for this game cannot be read (malformed, ambiguous, or outside the season and week)');
  }
}

// The factual preflight of a first ruling (root null) or a re-ruling (root = the chain's first row). The feed must be the
// production path and report the game halted under the event that is or will be recorded, matching the published event
// where there is one, so that the public evaluator would read the ruling as APPLIED (incidentFeedCheck: agrees).
function assessFacts({away,home,season,week,events,source,publishedEventId,root}){
  if(source!==PRODUCTION_FEED_SOURCE)return refuse(source?`the score feed was read from ${source}, not the production nflscores2 path the public pages use`
    :'the score feed came from an unknown source, so its evidence is not used');
  if(!Array.isArray(events))return refuse('the score feed for this week could not be read');
  const pinned=root?(root.event_id??null):(publishedEventId??null);
  const first=observeIncident(events,{away,home,eventId:pinned,season,week});
  const reading=haltedReading(first);
  if(!reading.ok)return reading;
  const feedEvent=first.eventId;
  if(!(typeof feedEvent==='string'&&DIGITS.test(feedEvent)))return refuse('the halted listing has no usable event id, so it cannot be recorded');
  const recorded=root?(root.event_id??null):feedEvent;
  if(root&&recorded!==null&&feedEvent!==recorded)return refuse(`the feed lists this game as event ${feedEvent}, not the recorded event ${recorded}; it ${HDC14_REFUSAL}`,true);
  if(!absent(publishedEventId)&&publishedEventId!==recorded)return refuse(`the published game is event ${publishedEventId} but the incident's event is ${recorded??'none'}; it ${HDC14_REFUSAL}`,true);
  const evidence=root?{incidentStatus:root.incident_status,eventId:root.event_id??null,evidenceSource:root.evidence_source??null}
    :{incidentStatus:first.status,eventId:feedEvent,evidenceSource:source};
  const observation=pinned===recorded?first:observeIncident(events,{away,home,eventId:recorded,season,week});
  const check=incidentFeedCheck({state:'effective',away,home,evidence:{incidentStatus:evidence.incidentStatus,eventId:evidence.eventId,source:evidence.evidenceSource}},observation);
  if(check.status!=='agrees')return refuse(`the feed does not confirm the recorded incident (${check.reason||check.status}); it ${HDC14_REFUSAL}`,true);
  return{ok:true,reason:null,hdc14:false,evidence,observation};
}

const yes=freeze({ok:true,reason:null}),no=reason=>({ok:false,reason});

// One candidate: its chain, the public reading of its slot, its factual preflight, and which actions are valid.
function assessCandidate(x){
  const {contestId,contestType,season,week,away,home,events,source,dataset,policy,rows}=x;
  const policyReady=policy.status==='ok';
  const revision=policyReady?policy.revision:null;
  const chain=chainState(rows,{week,away,home,policyRevision:revision});
  const consequences=policyReady?consequenceChoices(contestType,policy.policy):[];
  const canonical=rulingTeamCode(away)===away&&rulingTeamCode(home)===home&&away!==home;
  const listed=contestType==='survivor'||(x.published&&x.publishedOnce);
  const observation=Array.isArray(events)?observeIncident(events,{away,home,eventId:chain.root?.event_id??x.publishedEventId??null,season,week}):null;
  // The reading the public page shows: Pick'em by its published slot (a ruling that matches no published game is HOLD
  // there), Survivor by the picked team.
  let slot=null;
  if(dataset.status==='ready'){
    if(contestType==='pickem')slot=listed?pickemSlotRuling(dataset,{week,season,away,home,events}):{state:'hold',reason:'it does not match a published game'};
    else{const eventsByWeek=[];eventsByWeek[week-1]=events;slot=survivorRulingLookup(dataset,{eventsByWeek,season}).forPick(week,away)}
  }
  const underReview=slot?.state==='effective'?(slot.underReview||null):null;
  const factual=chain.state==='empty'?assessFacts({away,home,season,week,events,source,publishedEventId:x.publishedEventId,root:null})
    :chain.state==='withdrawn'?assessFacts({away,home,season,week,events,source,publishedEventId:x.publishedEventId,root:chain.root}):null;
  const blocked=!policyReady?`the contest's rules and rulings are not ready (${policy.reason||'no governing policy revision'})`:null;
  const writable=()=>!canonical?'the matchup is not two canonical NFL team codes'
    :contestType==='survivor'&&!x.published?'no locked Survivor snapshot covers this week'
    :contestType==='pickem'&&!x.published?`the game is not in the published week; it ${HDC14_REFUSAL}`
    :contestType==='pickem'&&!x.publishedOnce?`the matchup is not published exactly once, in its orientation, with no other game of its teams; it ${HDC14_REFUSAL}`
    :!consequences.length?'the governing policy permits no consequence for this contest':null;
  const actions={
    rule:blocked?no(blocked):chain.state!=='empty'?no('a ruling already exists for this incident: use its chain actions'):writable()?no(writable()):factual.ok?yes:no(factual.reason),
    reaffirm:blocked?no(blocked):chain.state!=='active'?no(chain.state==='empty'?'there is no ruling to reaffirm':'a withdrawn ruling cannot be reaffirmed; re-rule it')
      :!underReview?no('reaffirm is offered only while the public evaluator shows the ruling UNDER REVIEW'):yes,
    withdraw:blocked?no(blocked):chain.state==='active'?yes:no(chain.state==='empty'?'there is no ruling to withdraw':'the ruling is already withdrawn'),
    rerule:blocked?no(blocked):chain.state!=='withdrawn'?no('re-rule is only available after a withdrawal'):writable()?no(writable()):factual.ok?yes:no(factual.reason)
  };
  const evidence=chain.state==='empty'?(factual.ok?factual.evidence:null)
    :chain.root?{incidentStatus:chain.root.incident_status,eventId:chain.root.event_id??null,evidenceSource:chain.root.evidence_source??null}:null;
  return{key:`${away}@${home}`,matchup:`${away} @ ${home}`,contestId,contestType,season,week,away,home,gameIndex:x.gameIndex,
    published:x.published,publishedOnce:x.publishedOnce,publishedEventId:x.publishedEventId,
    policy:policyReady?{revision:policy.revision,policy:policy.policy,effectiveWeek:policy.effectiveWeek}:null,
    consequences,chain,observation,slot,underReview,factual:factual||{ok:false,reason:null,hdc14:false,evidence:null,observation:null},
    evidence,actions};
}

// Every pair of this week that has ruling rows (an existing chain is always listed, so it can be withdrawn).
function chainPairs(rows,week){
  const out=[];
  for(const r of Array.isArray(rows)?rows:[])
    if(r&&r.week===week&&typeof r.away_team==='string'&&typeof r.home_team==='string'&&!out.some(p=>p.away===r.away_team&&p.home===r.home_team))
      out.push({away:r.away_team,home:r.home_team});
  return out;
}
const datasetFor=(contestId,contestType,season,data)=>evaluateContestRulings({contestId,contestType,season,data});

// Pick'em candidates: every published game of the week (with its published event id), then any chain of the week no
// published game names.
export function pickemCandidates({contestId,season,week,config,events,source,data}={}){
  const contestType='pickem',dataset=datasetFor(contestId,contestType,season,data),policy=policyForWeek(dataset,week);
  const games=pickemGames(config)||[],rows=Array.isArray(data?.rulings)?data.rulings:[],list=[];
  for(const g of games){
    if(list.some(x=>x.away===g.away&&x.home===g.home))continue;
    const pairs=games.filter(o=>o.away===g.away&&o.home===g.home).length,teams=games.filter(o=>[o.away,o.home].some(t=>t===g.away||t===g.home)).length;
    list.push({away:g.away,home:g.home,gameIndex:g.index,publishedEventId:g.eventId,published:true,publishedOnce:pairs===1&&teams===1});
  }
  for(const p of chainPairs(rows,week))if(!list.some(x=>x.away===p.away&&x.home===p.home))
    list.push({...p,gameIndex:null,publishedEventId:null,published:false,publishedOnce:false});
  return list.map(x=>assessCandidate({...x,contestId,contestType,season,week,events,source,dataset,policy,rows}));
}

// The teams picked in a Survivor week by any entry of the snapshot.
function pickedTeams(config,week){
  const out=new Set();
  for(const e of [...(Array.isArray(config?.trackedEntries)?config.trackedEntries:[]),...(Array.isArray(config?.fieldEntries)?config.fieldEntries:[])]){
    const t=rulingTeamCode(Array.isArray(e?.picks)?e.picks[week-1]:null);if(t)out.add(t);
  }
  return out;
}
// A listing's exact away/home pair in canonical codes, or null.
function listedPair(e){
  const c=Array.isArray(e?.competitions)&&e.competitions.length===1?e.competitions[0]:null,cs=Array.isArray(c?.competitors)?c.competitors:[];
  const aways=cs.filter(x=>x?.homeAway==='away'),homes=cs.filter(x=>x?.homeAway==='home');
  if(cs.length!==2||aways.length!==1||homes.length!==1)return null;
  const away=rulingTeamCode(aways[0]?.team?.abbreviation),home=rulingTeamCode(homes[0]?.team?.abbreviation);
  return away&&home&&away!==home?{away,home}:null;
}

// Survivor candidates: the feed's games of the week that involve a team some entry picked (the published snapshot names
// the picks, the feed the matchups), then any chain of the week the feed no longer lists.
export function survivorCandidates({contestId,season,week,snapshot,events,source,data}={}){
  const contestType='survivor',dataset=datasetFor(contestId,contestType,season,data),policy=policyForWeek(dataset,week);
  const covered=Number.isInteger(snapshot?.week)&&snapshot.week>=week,picked=covered?pickedTeams(snapshot.config,week):new Set();
  const rows=Array.isArray(data?.rulings)?data.rulings:[],list=[];
  for(const e of Array.isArray(events)?events:[]){
    const p=listedPair(e);
    if(p&&(picked.has(p.away)||picked.has(p.home))&&!list.some(x=>x.away===p.away&&x.home===p.home))list.push(p);
  }
  for(const p of chainPairs(rows,week))if(!list.some(x=>x.away===p.away&&x.home===p.home))list.push(p);
  return list.map(p=>assessCandidate({...p,gameIndex:null,publishedEventId:null,published:covered,publishedOnce:covered,
    contestId,contestType,season,week,events,source,dataset,policy,rows}));
}

// ---- requests ----------------------------------------------------------------------------------------------------------

const rulingIdValue=v=>Number.isSafeInteger(v)&&v>0?v:typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)?v:null;

// The RPC arguments for one offered action: exactly the 13 approved keys, in order, with an explicit NULL for every
// argument the action does not use. The expected policy revision and expected parent are compare-and-swap tokens; the
// consequence of reaffirm and withdraw, and the evidence of every later row, are left NULL for the server to derive.
export function buildRequest({contestId,week,candidate:c,action,consequence=null,publicNote,adminNote}={}){
  if(!c)return{ok:false,reason:'choose a matchup first'};
  if(contestId!==c.contestId||week!==c.week)return{ok:false,reason:'the matchup belongs to another contest or week'};
  if(!ACTIONS.includes(action))return{ok:false,reason:'choose an action'};
  if(!c.actions[action]?.ok)return{ok:false,reason:c.actions[action]?.reason||'that action is not available'};
  const pub=checkPublicNote(publicNote);if(!pub.ok)return{ok:false,reason:pub.reason};
  const adm=checkAdminNote(adminNote,{required:action==='withdraw'||action==='rerule'});if(!adm.ok)return{ok:false,reason:adm.reason};
  const rules=action==='rule'||action==='rerule';
  if(rules&&!c.consequences.includes(consequence))return{ok:false,reason:'the governing policy does not permit that consequence'};
  const evidence=action==='rule'?c.evidence:null;
  if(action==='rule'&&!evidence)return{ok:false,reason:'there is no recordable evidence for this game'};
  const parent=action==='rule'?null:rulingIdValue(c.chain.last?.ruling_id);
  if(action!=='rule'&&parent===null)return{ok:false,reason:'the chain has no current ruling to follow'};
  return{ok:true,reason:null,request:{
    p_contest_id:contestId,p_week:week,p_away_team:c.away,p_home_team:c.home,p_action:action,p_consequence:rules?consequence:null,
    p_expected_policy_revision:c.policy.revision,p_expected_parent_ruling_id:parent,
    p_incident_status:evidence?evidence.incidentStatus:null,p_event_id:evidence?evidence.eventId:null,p_evidence_source:evidence?evidence.evidenceSource:null,
    p_public_note:pub.value,p_admin_note:adm.value}};
}

// The non-writing permission test: a withdrawal whose expected parent no chain can have.
export function writeProbeRequest({contestId,week,away,home,policyRevision}={}){
  return{p_contest_id:contestId,p_week:week,p_away_team:away,p_home_team:home,p_action:'withdraw',p_consequence:null,
    p_expected_policy_revision:policyRevision,p_expected_parent_ruling_id:WRITE_PROBE_PARENT,p_incident_status:null,p_event_id:null,
    p_evidence_source:null,p_public_note:'HDC-13 write-access check; writes nothing.',
    p_admin_note:'Write-access check with an impossible expected parent; the database must refuse it with HDC13_STALE_CHAIN.'};
}

// The row the server would write for a request, in public columns: derived position, parent, consequence and (for every
// later row) the root's evidence. Its id and time are placeholders, never part of a compared outcome.
export function hypotheticalRow(request,{contestType,chain,rulingId,createdAt}={}){
  const later=request.p_action!=='rule',root=chain?.root||null,last=chain?.last||null;
  return{ruling_id:rulingId,contest_id:request.p_contest_id,contest_type:contestType,week:request.p_week,away_team:request.p_away_team,
    home_team:request.p_home_team,policy_revision:request.p_expected_policy_revision,chain_seq:(last?.chain_seq||0)+1,
    parent_ruling_id:last?last.ruling_id:null,
    consequence:request.p_action==='withdraw'?WITHDRAWN:request.p_action==='reaffirm'?(last?.consequence??null):request.p_consequence,
    incident_status:later?(root?.incident_status??null):request.p_incident_status,event_id:later?(root?.event_id??null):request.p_event_id,
    evidence_source:later?(root?.evidence_source??null):request.p_evidence_source,public_note:request.p_public_note,created_at:createdAt};
}

// ---- previews: the shared HDC-12 evaluator before and after the hypothetical row ---------------------------------------

// Tracked and (where published) full-field Pick'em entries with their pick per game, mapped as the public Pick'em page maps them.
function pickemEntries(config,games){
  const numbers=new Map();
  games.forEach(g=>{const raw=config.games[g.index];numbers.set(raw.awayNumber,{i:g.index,team:g.away});numbers.set(raw.homeNumber,{i:g.index,team:g.home})});
  const tracked=(Array.isArray(config.participants)?config.participants:[]).map((p,pi)=>{
    const picks=Array(games.length).fill(null);
    for(const n of Array.isArray(p?.pickNumbers)?p.pickNumbers:[]){if(n===null)continue;const hit=numbers.get(n);if(hit)picks[hit.i]=hit.team}
    return{name:typeof p?.displayName==='string'?p.displayName:`Entry ${pi+1}`,tracked:true,picks};
  });
  const field=config.fullFieldReady===true&&Array.isArray(config.fieldEntries)?config.fieldEntries.map((p,fi)=>({name:typeof p?.id==='string'?p.id:`field-${fi+1}`,tracked:false,
    picks:games.map(g=>{const n=Array.isArray(p?.pickNumbers)?p.pickNumbers[g.index]:null,raw=config.games[g.index];return n===raw.awayNumber?g.away:n===raw.homeNumber?g.home:null})})):[];
  return[...tracked,...field];
}
// The public Pick'em page's card slot: a ruling's published game slot; withdrawn; otherwise HOLD (it matches no published game).
function cardSlot(games,slots){
  return x=>{
    const i=games.findIndex(g=>g.away===x.away&&g.home===x.home);
    if(i>=0)return slots[i].ruling;
    if(x.state==='withdrawn')return{state:'withdrawn'};
    return{state:'hold',reason:games.some(g=>[g.away,g.home].some(t=>t===x.away||t===x.home))?'it does not match the published game':'it does not match a published game in this contest'};
  };
}
// The NFL fact of the ruled game, known here only when the feed reports it halted: not completed, no winner.
function haltedFact(events,c){
  const o=c.observation,kind=o?.kind==='repaired'?o.incidentKind:o?.kind;
  if(kind!=='halted')return null;
  const e=(Array.isArray(events)?events:[]).find(x=>!absent(x?.id)&&String(x.id)===o.eventId);
  const comps=e?.competitions?.[0]?.competitors||[],away=comps.find(x=>x?.homeAway==='away'),home=comps.find(x=>x?.homeAway==='home');
  return{away:c.away,home:c.home,state:typeof e?.status?.type?.state==='string'?e.status.type.state:'pre',completed:false,winner:null,
    awayScore:survivorScore(away?.score),homeScore:survivorScore(home?.score),halted:o.status||null};
}
const cellOf=(game,pick)=>!game?'nfl':game.void?'void':game.hold?'hold':game.completed?(game.winner?(pick===game.winner?'ok':'bad'):'neutral'):'pending';

// One side (before or after) of a Pick'em preview, or the actual state read back after a write.
export function pickemState({contestId,season,week,config,events,data,candidate:c}){
  const dataset=datasetFor(contestId,'pickem',season,data),games=pickemGames(config)||[];
  const slots=games.map(g=>{const ruling=pickemSlotRuling(dataset,{week,season,away:g.away,home:g.home,events});return{ruling,effect:pickemSlotEffect(ruling)}});
  const at=Number.isInteger(c.gameIndex)?slots[c.gameIndex]:null,fact=haltedFact(events,c);
  // The week's tiebreak, whichever game is previewed: the public Pick'em page voids it exactly when the configured tiebreak
  // game is VOID (games[TIEBREAK_INDEX].void, which pickemEffectiveGame sets for a void slot effect only).
  const tiebreak=Number.isInteger(config?.tiebreakGameIndex)?slots[config.tiebreakGameIndex]:null;
  const slot=at?at.ruling:null,effect=at?at.effect:null;
  const game=!at?null:effect.kind==='nfl'?(fact?pickemEffectiveGame(fact,effect):null)
    :pickemEffectiveGame(fact||{away:c.away,home:c.home,state:'pre',completed:false,winner:null,awayScore:null,homeScore:null},effect);
  const entries=at?pickemEntries(config,games).map(e=>({name:e.name,tracked:e.tracked,pick:e.picks[c.gameIndex]}))
    .filter(e=>e.pick===c.away||e.pick===c.home).map(e=>({...e,cell:cellOf(game,e.pick),...(game?scoreEntry([e.pick],[game]):{w:null,l:null,left:null})})):[];
  return{status:dataset.status,slot,effect,game,graded:effect?.kind==='nfl'&&!fact?'nfl':null,entries,
    remaining:game?(game.completed?0:1):null,tiebreakVoid:tiebreak?.effect.kind==='void',rules:rulesModel(dataset,{week,slotState:cardSlot(games,slots)})};
}

// The Pick'em preview: before (the rows as loaded) and after (with the row the server would write).
export function pickemPreview({contestId,season,week,config,events,data,request,candidate:c,rulingId,createdAt}){
  const row=hypotheticalRow(request,{contestType:'pickem',chain:c.chain,rulingId,createdAt});
  const before=pickemState({contestId,season,week,config,events,data,candidate:c});
  const after=pickemState({contestId,season,week,config,events,data:{...data,rulings:[...(data.rulings||[]),row]},candidate:c});
  const entries=before.entries.map((e,i)=>({name:e.name,tracked:e.tracked,pick:e.pick,
    before:{cell:e.cell,w:e.w,l:e.l,left:e.left},after:{cell:after.entries[i].cell,w:after.entries[i].w,l:after.entries[i].l,left:after.entries[i].left}}));
  return{contestType:'pickem',before,after,entries,affected:entries.length,remaining:{before:before.remaining,after:after.remaining},
    tiebreak:{isTiebreakGame:Number.isInteger(c.gameIndex)&&config?.tiebreakGameIndex===c.gameIndex,beforeVoid:before.tiebreakVoid,afterVoid:after.tiebreakVoid}};
}

const survivorLabel=s=>s.halted?'RULING':s.status==='hold'?'HOLD':s.status==='alive'?'ALIVE':s.status==='live'?'LIVE':s.status==='pending'?'PENDING':'OUT';
const survivorReview=s=>s.ruling?.underReview||s.rulings?.find(r=>r.underReview)?.underReview||null;

// One side of a Survivor preview (or the state read back after a write), at the snapshot's week as the public page shows
// it, with results built by the protected Survivor feed path for every week through it.
export function survivorState({contestId,season,week,snapshot,eventsByWeek,data,candidate:c}){
  const dataset=datasetFor(contestId,'survivor',season,data),config=snapshot.config,S=snapshot.week,wi=S-1;
  const resultsByWeek=[];
  for(let i=0;i<S;i++)if(Array.isArray(eventsByWeek?.[i]))resultsByWeek[i]=survivorBuildResults(eventsByWeek[i],{season,week:i+1});
  const R=survivorRulingLookup(dataset,{eventsByWeek,season});
  const all=[...(config.trackedEntries||[]).map(e=>({...e,name:e.displayName,tracked:true})),...(config.fieldEntries||[]).map(e=>({...e,name:e.id,tracked:false}))];
  const read=e=>{const s=survivorEntryState(e,wi,resultsByWeek,R),w=survivorEntryState(e,week-1,resultsByWeek,R);
    return{name:e.name,tracked:e.tracked,pick:e.picks?.[week-1]??null,label:survivorLabel(s),status:s.status,reason:s.reason,underReview:survivorReview(s),
      weekLabel:survivorLabel(w),nextWeekEligible:survivorEligibleEntering(e,week,resultsByWeek,R),used:(e.picks||[]).slice(0,week).filter(Boolean)}};
  const entries=all.map(read);
  return{status:dataset.status,entries,summary:survivorSummary(all,wi,resultsByWeek,R),awaiting:survivorAwaitingRuling(all,wi,resultsByWeek,R),
    held:survivorOnHold(all,wi,resultsByWeek,R),rules:rulesModel(dataset,{week:S,slotState:x=>R.forPick(x.week,x.away||x.home)||null}),
    slot:c?R.forPick(week,c.away):null};
}

// The Survivor preview: affected entries (week pick in the ruled game), the tracked entries the page lists, the summary,
// the awaiting and on-hold counts and the Rules card, before and after.
export function survivorPreview({contestId,season,week,snapshot,eventsByWeek,data,request,candidate:c,rulingId,createdAt}){
  const row=hypotheticalRow(request,{contestType:'survivor',chain:c.chain,rulingId,createdAt});
  const before=survivorState({contestId,season,week,snapshot,eventsByWeek,data,candidate:c});
  const after=survivorState({contestId,season,week,snapshot,eventsByWeek,data:{...data,rulings:[...(data.rulings||[]),row]},candidate:c});
  const pair=(e,i)=>({name:e.name,tracked:e.tracked,pick:e.pick,before:e,after:after.entries[i]});
  const entries=before.entries.map(pair).filter(e=>e.pick===c.away||e.pick===c.home);
  return{contestType:'survivor',before,after,entries,affected:entries.length,tracked:before.entries.map(pair).filter(e=>e.tracked)};
}

// What a side renders, without ids or dates, so a preview AFTER can be compared with the state read back after a write.
export function previewOutcome(side){
  if(!side)return null;
  const slot=side.slot?{state:side.slot.state,consequence:side.slot.consequence??null,underReview:side.slot.underReview??null,reason:side.slot.reason??null}:null;
  const rules=side.rules?{state:side.rules.state,policy:side.rules.policy?.revision??null,incidents:(side.rules.incidents||[]).map(x=>({key:x.key,matchup:x.matchup,
    status:x.status,detail:x.detail,review:x.review,evidence:x.evidence,history:x.history.map(h=>({label:h.label,note:h.note}))}))}:null;
  if(side.summary)return{kind:'survivor',status:side.status,slot,rules,summary:side.summary,awaiting:side.awaiting,held:side.held,
    entries:side.entries.map(e=>({name:e.name,label:e.label,status:e.status,reason:e.reason,underReview:e.underReview,nextWeekEligible:e.nextWeekEligible}))};
  return{kind:'pickem',status:side.status,slot,effect:side.effect?{kind:side.effect.kind,withdrawn:side.effect.withdrawn??null,underReview:side.effect.underReview??null,reason:side.effect.reason??null}:null,
    game:side.game?{completed:side.game.completed,winner:side.game.winner,void:side.game.void===true,hold:side.game.hold??null}:null,
    entries:side.entries.map(e=>({name:e.name,cell:e.cell,w:e.w,l:e.l,left:e.left})),remaining:side.remaining,tiebreakVoid:side.tiebreakVoid,rules};
}
export function sameOutcome(a,b){return JSON.stringify(a)===JSON.stringify(b)}

// ---- confirmation, preflight, errors, read-back, the write-access check --------------------------------------------------

export function confirmationPhrase(c){return`${c.away} @ ${c.home}`}
const squash=s=>s.toUpperCase().replace(/\s+/g,'');
// The typed matchup must be the phrase; letter case and spacing do not matter.
export function confirmationMatches(typed,phrase){return typeof typed==='string'&&typeof phrase==='string'&&squash(phrase).length>0&&squash(typed)===squash(phrase)}

// The material state a preview was built on: event, status, matchup, event id, policy and chain. The submit is cancelled
// when a fresh reading differs.
export function preflightKey(c){
  if(!c)return null;
  const o=c.observation;
  return JSON.stringify([c.contestId,c.week,c.key,c.published,c.publishedOnce,c.publishedEventId??null,c.policy?.revision??null,c.policy?.policy??null,
    c.chain.state,c.chain.last?.ruling_id??null,c.chain.rows.length,o?[o.kind,o.status??null,o.eventId??null,o.tied??null,o.incidentKind??null]:null,
    c.evidence?[c.evidence.incidentStatus,c.evidence.eventId,c.evidence.evidenceSource]:null,c.underReview??null,ACTIONS.map(a=>c.actions[a].ok)]);
}

const TOKEN=/^(HDC13_[A-Z_]+)(?::|$)/;
// A failed RPC: a known HDC13 token (a fixed message; nothing was written), PostgreSQL's permission denied, another
// database refusal (it has an SQLSTATE or a Data API code: nothing was written; the text is shown as plain text), or a
// lost response (no code: the outcome is unknown until the chain is read back).
export function rpcErrorInfo(error){
  const message=typeof error?.message==='string'?error.message:typeof error==='string'?error:'';
  const code=typeof error?.code==='string'?error.code:'';
  const hint=typeof error?.hint==='string'?error.hint:'';
  const token=[hint,message.match(TOKEN)?.[1]].find(t=>t&&Object.hasOwn(HDC13_ERROR_TEXT,t))||null;
  if(token)return{token,known:true,definitive:true,text:HDC13_ERROR_TEXT[token]};
  if(code==='42501')return{token:null,known:true,definitive:true,text:'The database denied access to the incident-ruling write (permission denied). Nothing was written.'};
  const definitive=/^(PGRST\d+|[0-9A-Z]{5})$/.test(code);
  return{token:null,known:false,definitive,text:definitive?`The database refused the request: ${message||code}. Nothing was written.`
    :`The response was lost or unreadable (${message||'no detail'}); the outcome is unknown until the chain is read back.`};
}

// After a lost response: LANDED (exactly the row this request would write follows the chain as it was), NOT_WRITTEN (the
// chain is as it was) or CHANGED (anything else: the preview is no longer valid).
export function classifyReadBack({beforeRows,afterRows,request,chain}={}){
  if(!Array.isArray(afterRows)||!request)return'CHANGED';
  const mine=r=>r&&r.contest_id===request.p_contest_id&&r.week===request.p_week&&r.away_team===request.p_away_team&&r.home_team===request.p_home_team;
  const before=(Array.isArray(beforeRows)?beforeRows:[]).filter(mine),after=afterRows.filter(mine);
  const ids=new Set(before.map(r=>String(r.ruling_id)));
  if(!before.every(b=>after.some(a=>String(a.ruling_id)===String(b.ruling_id)&&a.chain_seq===b.chain_seq&&a.consequence===b.consequence)))return'CHANGED';
  const added=after.filter(a=>!ids.has(String(a.ruling_id)));
  if(!added.length)return'NOT_WRITTEN';
  if(added.length!==1)return'CHANGED';
  const expected=hypotheticalRow(request,{contestType:added[0].contest_type,chain,rulingId:added[0].ruling_id,createdAt:added[0].created_at});
  return['contest_id','week','away_team','home_team','policy_revision','chain_seq','parent_ruling_id','consequence','incident_status','event_id',
    'evidence_source','public_note'].every(f=>(added[0][f]??null)===(expected[f]??null))?'LANDED':'CHANGED';
}

// The write-access check's answer: HDC13_STALE_CHAIN means the caller passed the commissioner check and nothing was written.
export function probeOutcome({data,error}={}){
  if(!error)return{status:'unexpected',token:null,text:`UNEXPECTED: the write-access check returned ${data?'a written row':'no refusal'}. It must never write; read the chain back and investigate before using this page.`};
  const info=rpcErrorInfo(error);
  if(info.token==='HDC13_STALE_CHAIN')return{status:'authorized',token:info.token,text:'Write access confirmed: the database answered HDC13_STALE_CHAIN to the impossible expected parent, after the commissioner check.'};
  if(info.token==='HDC13_NOT_COMMISSIONER'||(!info.token&&String(error?.code)==='42501'))return{status:'denied',token:info.token,text:'This account is not authorized to record incident rulings: the database refused it.'};
  return{status:'inconclusive',token:info.token,text:`The write-access check was inconclusive: ${info.text}`};
}
