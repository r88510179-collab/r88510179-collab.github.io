// Pure commissioner workflow helpers. None of these functions write or authorize database state:
// the database remains responsible for tenant authorization, source ownership and audit history.
import {prepareCommissionerImport} from './import-core.js';

const gameTeams=game=>['away','home'].map(side=>{
  const raw=game?.[side];
  return {side,key:String(typeof raw==='object'?(raw?.key??raw?.id??''):raw??''),label:String(typeof raw==='object'?(raw?.label??raw?.name??raw?.city??raw?.key??''):raw??'')};
});
// Server returned list is only for presentation. Authorization stays in the DB function.
export function chooseCommissionerPool(pools,preferredSlug=''){
  const valid=p=>p&&typeof p.slug==='string'&&/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(p.slug)
    &&typeof p.display_name==='string'&&p.display_name.length>0
    &&['survivor','pickem'].includes(p.pool_type);
  const dedup=new Map();
  for(const pool of Array.isArray(pools)?pools:[]){if(valid(pool)&&!dedup.has(pool.slug))dedup.set(pool.slug,pool)}
  const available=[...dedup.values()];
  if(preferredSlug&&available.some(p=>p.slug===preferredSlug))return {available,selected:preferredSlug,automatic:true};
  return {available,selected:available.length===1?available[0].slug:null,automatic:available.length===1};
}
export function newEntryDraft({entryCode,displayName,season,entries=[]}){
  const code=String(entryCode??'').trim().toUpperCase();
  const name=String(displayName??'').trim();
  if(!season||!['setup','active'].includes(season.status))return {ok:false,error:'This season cannot accept new entries.'};
  if(!/^[A-Z0-9][A-Z0-9_-]{1,23}$/.test(code))return {ok:false,error:'Use 2–24 letters, numbers, dashes or underscores for the entry code.'};
  if(!name||name.length>120)return {ok:false,error:'Enter a participant name of 1–120 characters.'};
  if(entries.some(e=>e.entry_code?.toUpperCase()===code))return {ok:false,error:'That entry code already exists in this season.'};
  return {ok:true,code,name,seasonId:season.id};
}
// Pure form validation. Never opens a week, accepts picks, or trusts a client for authorization.
export function newDraftWeek({season,weekNumber,deadlineLocal,opensLocal='',weeks=[],now=new Date()}){
  if(!season||!['setup','active'].includes(season.status))return {ok:false,error:'This season cannot add weeks.'};
  const week=Number(weekNumber);
  if(!Number.isInteger(week)||week<1||week>25)return {ok:false,error:'Enter a week number between 1 and 25.'};
  if(weeks.some(w=>w.week===week))return {ok:false,error:`Week ${week} already exists for this season.`};
  // datetime-local should be supplied by the browser. Conversion to UTC is unambiguous after Date construction.
  if(typeof deadlineLocal!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(deadlineLocal))return {ok:false,error:'Select a deadline date and time.'};
  const deadline=new Date(deadlineLocal),opens=opensLocal?new Date(opensLocal):null;
  if(!Number.isFinite(deadline.getTime())||deadline.getTime()<=now.getTime()+5*60000||deadline.getTime()>now.getTime()+18*31*86400000)return {ok:false,error:'Deadline must be more than five minutes ahead and within 18 months.'};
  if(opensLocal&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(opensLocal)||!Number.isFinite(opens.getTime())||opens.getTime()>=deadline.getTime()))return {ok:false,error:'Opening time must be earlier than the deadline.'};
  return {ok:true,week,seasonId:season.id,deadlineAt:deadline.toISOString(),opensAt:opens?.toISOString()??null};
}
export function weekSubmission(entry,week){return (entry?.submissions||[]).find(s=>s.week===week?.week)||null}
export function weekCanAcceptPicks(week,now=new Date()){
  if(!week)return {ok:false,reason:'Select a week first.'};
  if(week.status!=='open')return {ok:false,reason:'This week is not open for new picks.'};
  if(week.opens_at&&Date.parse(week.opens_at)>now.getTime())return {ok:false,reason:'Picks are not open yet.'};
  if(week.deadline_at&&Date.parse(week.deadline_at)<=now.getTime())return {ok:false,reason:'The deadline has passed; picks cannot be changed.'};
  return {ok:true,reason:''};
}
export function isParticipantOwned(entry,week){return weekSubmission(entry,week)?.source==='participant'}
export function eligibleImportEntries(entries,week){return (entries||[]).filter(e=>e.status==='active'&&!isParticipantOwned(e,week)&&(!weekSubmission(e,week)||weekSubmission(e,week).source==='commissioner_import'))}
export function survivorTeams(weekConfig){
  const seen=new Set();return (weekConfig?.games||[]).flatMap(g=>gameTeams(g)).filter(t=>{
    if(!t.key||seen.has(t.key))return false;seen.add(t.key);return true;
  });
}
export function readableGame(game,index=0){
  const [away,home]=gameTeams(game);return `${away.label||away.key||'Away team'} vs ${home.label||home.key||'Home team'}${game?.kickoff_at?` · ${new Date(game.kickoff_at).toLocaleString()}`:''}`;
}
export function sampleImport({poolType,entries,weekConfig,week}){
  const candidate=eligibleImportEntries(entries,week)[0];
  if(!candidate)return '';
  if(poolType==='survivor'){
    const team=survivorTeams(weekConfig)[0];
    return team?`entry_code,team\n${candidate.entry_code},${team.key}`:'';
  }
  const games=weekConfig?.games||[];
  if(!games.length)return '';
  const ids=games.map((g,i)=>String(g?.id??`g${i+1}`));
  const tbRequired=weekConfig?.tiebreakRequired===true||weekConfig?.tiebreak_required===true;
  return `entry_code,${ids.join(',')}${tbRequired?',tiebreak':''}\n${candidate.entry_code},${ids.map((_,i)=>i%2?'home':'away').join(',')}${tbRequired?',47':''}`;
}
// Builds one-row CSV from form controls; existing import-core remains the validator and canonical
// interpreter. Inputs never bypass the import validator or the database submission-source guard.
export function guidedCsv({poolType,entryCode,team,choices={},tiebreak,weekConfig}){
  if(!entryCode)return '';
  if(poolType==='survivor')return `entry_code,team\n${entryCode},${team||''}`;
  const ids=(weekConfig?.games||[]).map((g,i)=>String(g?.id??`g${i+1}`));
  const required=weekConfig?.tiebreakRequired===true||weekConfig?.tiebreak_required===true;
  // All mapped values are fixed away/home radio values; entry codes are database values and must be CSV-safe.
  const quote=v=>`"${String(v??'').replaceAll('"','""')}"`;
  return `entry_code,${ids.map(quote).join(',')}${required?',tiebreak':''}\n${quote(entryCode)},${ids.map(id=>choices[id]||'').join(',')}${required?`,${quote(tiebreak)}`:''}`;
}
export function previewCommissionerImport({text,poolType,entries,weekConfig,week,now=new Date()}){
  const open=weekCanAcceptPicks(week,now);
  if(!open.ok)return{items:[],errors:[{code:'week_closed',detail:open.reason}],warnings:[]};
  const parsed=prepareCommissionerImport({text,poolType,entries,weekConfig});
  const byId=new Map((entries||[]).map(e=>[e.id,e]));
  const blocked=parsed.items.filter(item=>{
    const e=byId.get(item.entry_id),sub=weekSubmission(e,week);
    return !e||e.status!=='active'||(sub&&sub.source!=='commissioner_import');
  });
  return {items:parsed.items.filter(x=>!blocked.includes(x)),
    errors:[...parsed.errors,...blocked.map(item=>({code:'source_conflict',entry_code:byId.get(item.entry_id)?.entry_code||'Unknown entry'}))],
    warnings:parsed.items.filter(x=>weekSubmission(byId.get(x.entry_id),week)?.source==='commissioner_import').map(x=>`This will replace the earlier commissioner import for ${byId.get(x.entry_id).entry_code}.`)};
}
export function importErrorText(error){
  const labels={week_closed:error.detail||'This week is closed.',source_conflict:'A pick was already submitted using a different method. It will not be changed.',
    no_data:'Add at least one entry and its pick.',missing_entry_code:'The entry column is missing.',missing_team:'Choose a team.',
    unknown_team:'This team is not on the selected week’s schedule.',invalid_picks:'Choose a valid team for every game.',
    unknown_entry:'This entry was not found in this pool.',duplicate_entry_row:'The same entry appears more than once. Keep one row per entry.',
    invalid_tiebreak:'Enter a valid whole-number tiebreak score.',missing_tiebreak:'A tiebreak score is required.',missing_game_columns:'The file is missing one or more scheduled games.',
    ambiguous_team_label:'This team name matches more than one choice; use a specific team key.',ambiguous_entry_code:'Multiple entries share that name; use the exact entry code.'};
  const base=labels[error?.code]||'This row could not be imported.';
  return `${base}${error?.value?` (Entered: ${error.value})`:''}`;
}
