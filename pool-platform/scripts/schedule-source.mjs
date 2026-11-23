// Privileged ingestion only: this file is NEVER copied into the browser build.
// The nflverse schedules release is community-maintained, NOT an official NFL feed.
// CC BY 4.0 attribution must accompany imported data; check applicability before launch.
import crypto from 'node:crypto';
import {parseCsv} from '../import-core.js';
import {NFL_TEAMS} from '../schedule-core.js';

export const SCHEDULE_SOURCE_URL='https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';
export const SCHEDULE_ATTRIBUTION='nflverse and Lee Sharpe / nfldata (CC BY 4.0)';
const teamByKey=new Map(NFL_TEAMS.map(team=>[team.key,team]));
const aliases=Object.freeze({LA:'LAR',JAC:'JAX',WSH:'WAS'});
const COLUMN_NAMES=['game_id','season','game_type','week','gameday','gametime','away_team','home_team'];
const MAX_SOURCE_BYTES=4_000_000;
const MAX_AGE_MS=48*60*60*1000;

function fail(code){throw new Error(code)}
function normalizedTeam(key){
  const canonical=aliases[String(key??'').trim().toUpperCase()]||String(key??'').trim().toUpperCase();
  const team=teamByKey.get(canonical);
  if(!team)fail('unknown_nfl_team');
  return {key:team.key,city:team.city,name:team.name};
}
function easternKickoff(gameday,gametime){
  if(!/^20\d\d-\d\d-\d\d$/.test(gameday)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(gametime))
    fail('invalid_eastern_kickoff');
  const [y,m,d]=gameday.split('-').map(Number),[hh,mm]=gametime.split(':').map(Number);
  const guess=Date.UTC(y,m-1,d,hh,mm);
  if(!Number.isFinite(guess)||new Date(guess).toISOString().slice(0,10)!==gameday)
    fail('invalid_eastern_kickoff');
  // NFLverse gametime is local Eastern time, not UTC. Resolve DST from IANA rules.
  const tz=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'});
  const z=tz.formatToParts(new Date(guess)).find(p=>p.type==='timeZoneName')?.value||'';
  const match=/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(z);
  if(!match)fail('unknown_eastern_offset');
  const minutes=(Number(match[2])*60+Number(match[3]||0))*(match[1]==='+'?1:-1);
  const kickoff=new Date(guess-minutes*60_000);
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hourCycle:'h23',
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(kickoff);
  const p=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  const roundTrip=`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  if(roundTrip!==`${gameday}T${gametime}`)fail('invalid_eastern_kickoff');
  return kickoff.toISOString();
}
export function validatedNflverseWeek(csv,{season,week,now=new Date(),fetchedAt=new Date()}={}){
  if(!Number.isInteger(season)||season<2020||season>2100
      ||!Number.isInteger(week)||week<1||week>18)fail('invalid_season_week');
  if(typeof csv!=='string'||Buffer.byteLength(csv,'utf8')>MAX_SOURCE_BYTES)fail('invalid_source_size');
  if(!Number.isFinite(now.getTime())||!Number.isFinite(fetchedAt.getTime())
      ||fetchedAt.getTime()>now.getTime()+5*60_000
      ||now.getTime()-fetchedAt.getTime()>MAX_AGE_MS)fail('stale_source');
  const rows=parseCsv(csv);const header=rows.shift()?.map(x=>x.trim());
  if(!header||new Set(header).size!==header.length)fail('invalid_csv_header');
  if(COLUMN_NAMES.some(name=>!header.includes(name)))fail('missing_required_columns');
  const index=Object.fromEntries(header.map((key,i)=>[key,i]));
  const records=rows.map(row=>Object.fromEntries(COLUMN_NAMES.map(key=>[key,row[index[key]]])));
  const matches=records.filter(row=>Number(row.season)===season&&Number(row.week)===week
    &&row.game_type==='REG');
  if(matches.length<13||matches.length>16)fail('incomplete_regular_season_week');
  const seenTeams=new Set(),seenIds=new Set();
  const games=matches.map(row=>{
    const away=normalizedTeam(row.away_team),home=normalizedTeam(row.home_team);
    if(away.key===home.key||seenTeams.has(away.key)||seenTeams.has(home.key))fail('impossible_matchup');
    const kickoff=easternKickoff(row.gameday,row.gametime);
    const id=`${season}_${String(week).padStart(2,'0')}_${away.key}_${home.key}`;
    const providerId=String(row.game_id??'');
    if(!/^20\d\d_\d\d_[A-Z]{2,3}_[A-Z]{2,3}$/.test(providerId)
      ||seenIds.has(id))fail('duplicate_or_invalid_game_id');
    // The provider identifier can use LA/JAC/WSH; validate its canonical teams.
    const sections=providerId.split('_');
    if(Number(sections[0])!==season||Number(sections[1])!==week
      ||normalizedTeam(sections[2]).key!==away.key||normalizedTeam(sections[3]).key!==home.key)
      fail('provider_game_id_mismatch');
    seenIds.add(id);seenTeams.add(away.key);seenTeams.add(home.key);
    return {id,away,home,kickoff};
  }).sort((a,b)=>a.kickoff.localeCompare(b.kickoff)||a.id.localeCompare(b.id));
  if(games.some(g=>Date.parse(g.kickoff)<now.getTime()-24*60*60_000))
    fail('historical_week_not_openable');
  const byeTeams=[...teamByKey.keys()].filter(t=>!seenTeams.has(t)).sort();
  if(byeTeams.length!==32-games.length*2)fail('invalid_bye_count');
  return {season,week,source:'nflverse_schedules',sourceUrl:SCHEDULE_SOURCE_URL,
    sourceSha256:crypto.createHash('sha256').update(JSON.stringify(games)).digest('hex'),
    rawSourceSha256:crypto.createHash('sha256').update(csv).digest('hex'),
    sourceFetchedAt:fetchedAt.toISOString(),games,byeTeams,attribution:SCHEDULE_ATTRIBUTION};
}
// One bounded read of the allow-listed release. A transient failure is retried once; anything else fails closed.
export async function fetchNflverseScheduleCsv({fetchImpl=fetch,clock=()=>new Date(),retries=1,retryDelayMs=2000}={}){
  let lastError;
  for(let attempt=0;attempt<=retries;attempt++){
    try{
      const response=await fetchImpl(SCHEDULE_SOURCE_URL,{headers:{Accept:'text/csv'},redirect:'follow',
        signal:AbortSignal.timeout(15000)});
      if(!response?.ok||Number(response.headers?.get('content-length')||0)>MAX_SOURCE_BYTES)
        fail('schedule_feed_unavailable');
      const csv=await response.text();
      if(typeof csv!=='string'||Buffer.byteLength(csv,'utf8')>MAX_SOURCE_BYTES)fail('invalid_source_size');
      return {csv,fetchedAt:clock(),bytes:Buffer.byteLength(csv,'utf8'),
        rawSourceSha256:crypto.createHash('sha256').update(csv).digest('hex')};
    }catch(error){
      lastError=error;
      if(attempt<retries&&retryDelayMs>0)await new Promise(resolve=>setTimeout(resolve,retryDelayMs));
    }
  }
  throw lastError;
}
export async function fetchValidatedNflverseWeek({season,week,fetchImpl=fetch,now=new Date(),fetchedAt=new Date()}={}){
  const {csv}=await fetchNflverseScheduleCsv({fetchImpl,clock:()=>fetchedAt,retries:0});
  return validatedNflverseWeek(csv,{season,week,now,fetchedAt});
}
// Construct a parameter-free, escaped INSERT for a privileged operator connection.
// Do NOT expose this SQL generator, PG credentials, or the write path to browsers.
export function catalogUpsertSql(validated){
  const quote=v=>`'${String(v).replaceAll("'","''")}'`;
  const g=quote(JSON.stringify(validated.games)),byes=quote(JSON.stringify(validated.byeTeams));
  return `INSERT INTO public.pool_platform_verified_schedule_catalog
(season,week,source,source_url,source_sha256,raw_source_sha256,source_fetched_at,verified_at,games,bye_teams)
VALUES (${validated.season},${validated.week},'nflverse_schedules',
${quote(SCHEDULE_SOURCE_URL)},${quote(validated.sourceSha256)},${quote(validated.rawSourceSha256)},
${quote(validated.sourceFetchedAt)}::timestamptz,now(),${g}::jsonb,${byes}::jsonb)
ON CONFLICT (season,week) DO UPDATE
SET source=EXCLUDED.source,source_url=EXCLUDED.source_url,
source_sha256=EXCLUDED.source_sha256,raw_source_sha256=EXCLUDED.raw_source_sha256,
source_fetched_at=EXCLUDED.source_fetched_at,
verified_at=EXCLUDED.verified_at,games=EXCLUDED.games,bye_teams=EXCLUDED.bye_teams;`;
}
