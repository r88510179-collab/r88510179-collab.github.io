// Pool Center score-feed proxy: the source of the Neon Function nflscores2 (runtime nodejs24; deployed as this one file
// at the zip root, unbundled). score-feed-proxy.js sends every ESPN scoreboard request from Pick'em, Survivor and Admin
// here as GET ?season=S&week=W, answered with {"fetchedAt","events"}: that regular-season week's ESPN events reduced to
// the fields the pages read. It keeps the nflscores deployment-1 contract (projection, parameters, origin rules and
// headers, as observed on 2026-09-26) and adds only the Survivor market-odds subset, competitions[].odds, and a 502 for
// a failed upstream. No imports, Node 24 globals only; no secrets or environment variables.

export const ALLOWED_ORIGIN='https://r88510179-collab.github.io';
export const ESPN_SCOREBOARD='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
export const UPSTREAM_TIMEOUT_MS=10000;
const CACHEABLE='public, max-age=5, s-maxage=10, stale-while-revalidate=20';
const JSON_TYPE='application/json; charset=utf-8';

// Number()-coerced integers, season 2020-2100 and week 1-22 ("03", " 2026", "3e0", "0x3" and "+3" are accepted, as by
// deployment 1); the first value of a repeated parameter counts. Anything else is null.
export function parseSeasonWeek(params){
  const season=Number(params.get('season')),week=Number(params.get('week'));
  if(!Number.isInteger(season)||season<2020||season>2100||!Number.isInteger(week)||week<1||week>22)return null;
  return{season,week};
}

// Regular season only: seasontype is pinned here and no client parameter (seasontype, limit, _) is forwarded.
export const upstreamUrl=(season,week)=>`${ESPN_SCOREBOARD}?dates=${season}&week=${week}&seasontype=2`;

// A JSON object: not null, not an array.
const isRecord=value=>typeof value==='object'&&value!==null&&!Array.isArray(value);
// The listed keys the source has, in list order, values copied verbatim. Absent keys stay absent.
function pick(source,keys){const out={};for(const key of keys)if(Object.hasOwn(source,key))out[key]=source[key];return out}

// odds[0] is the only line survivorMarketMatchups reads; its market subset is copied without coercion, normalization or
// inference, each side only when it is an object.
function projectOdds(line){
  const out=pick(line,['details','spread']);
  for(const side of ['awayTeamOdds','homeTeamOdds'])if(isRecord(line[side]))out[side]=pick(line[side],['favorite']);
  return[out];
}
// Competitions and competitors keep every position (a non-object entry becomes null) and are never truncated or
// repaired, so the pages' malformed-feed checks still see exactly what ESPN sent.
function projectCompetitor(competitor){
  if(!isRecord(competitor))return null;
  const out=pick(competitor,['homeAway','score']);
  if(isRecord(competitor.team))out.team=pick(competitor.team,['abbreviation']);
  return out;
}
function projectCompetition(competition){
  if(!isRecord(competition))return null;
  const out={};
  if(Array.isArray(competition.competitors))out.competitors=competition.competitors.map(projectCompetitor);
  if(Array.isArray(competition.odds)&&isRecord(competition.odds[0]))out.odds=projectOdds(competition.odds[0]);
  return out;
}
function projectEvent(event){
  const out=pick(event,['id','date']);
  if(isRecord(event.status)){
    out.status={};
    if(isRecord(event.status.type))out.status.type=pick(event.status.type,['state','completed','shortDetail','detail']);
  }
  if(Array.isArray(event.competitions))out.competitions=event.competitions.map(projectCompetition);
  return out;
}

// ESPN scoreboard payload -> the response body; null when the payload has no events array. Non-object events are
// skipped. Nothing else is added: no season, week, status name, competition status or winner flag.
export function projectScoreboard(payload,fetchedAt){
  if(!Array.isArray(payload?.events))return null;
  return{fetchedAt,events:payload.events.filter(isRecord).map(projectEvent)};
}

// CORS headers, and Vary, only for the Pages origin.
function headers(origin,{type=JSON_TYPE,cache=CACHEABLE}={}){
  const out=new Headers();
  if(type)out.set('content-type',type);
  if(origin===ALLOWED_ORIGIN){
    out.set('access-control-allow-origin',ALLOWED_ORIGIN);
    out.set('access-control-allow-methods','GET, OPTIONS');
    out.set('access-control-allow-headers','Accept, Content-Type');
    out.set('vary','Origin');
  }
  out.set('cache-control',cache);
  return out;
}
const json=(status,body,origin,cache)=>new Response(JSON.stringify(body),{status,headers:headers(origin,{cache})});

// Deployment-1 request order: OPTIONS answers only the Pages origin and never reads parameters; every other method but
// GET is 405; a GET from any other non-empty Origin (including "null") is 403 before its parameters are read, while a
// GET without an Origin is served without CORS headers; then 400 for invalid parameters. The path is ignored.
export function createHandler({fetch:upstream=(url,init)=>globalThis.fetch(url,init),now=Date.now,timeoutMs=UPSTREAM_TIMEOUT_MS}={}){
  return async function handle(request){
    const origin=request.headers.get('origin');
    if(request.method==='OPTIONS'){
      if(origin!==ALLOWED_ORIGIN)return json(403,{error:'origin_not_allowed'},origin);
      return new Response(null,{status:204,headers:headers(origin,{type:null})});
    }
    if(request.method!=='GET')return json(405,{error:'method_not_allowed'},origin);
    if(origin&&origin!==ALLOWED_ORIGIN)return json(403,{error:'origin_not_allowed'},origin);
    const params=parseSeasonWeek(new URL(request.url).searchParams);
    if(!params)return json(400,{error:'invalid_season_or_week'},origin);
    // Non-2xx, network failure, the time limit (headers and body), non-JSON or no events array: 502, never cached.
    let body=null;
    try{
      const response=await upstream(upstreamUrl(params.season,params.week),{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
      if(response.ok)body=projectScoreboard(await response.json(),new Date(now()).toISOString());
      else await response.body?.cancel();
    }catch{body=null}
    return body?json(200,body,origin):json(502,{error:'upstream_unavailable'},origin,'no-store');
  };
}

export default{fetch:createHandler()};
