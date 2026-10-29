#!/usr/bin/env node
// Read-only NFL Pool score reconciliation. Never logs in, submits picks, or writes a database.
// Default mode checks the *deployed* nflscores2 proxy against ESPN's upstream scoreboard.
// Optional --official CSV adds an INDEPENDENT, owner-transcribed NFL.com final-score check.
// Neither ESPN parity nor this script alone proves participant/admin end-to-end workflows.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectScoreboard} from '../score-proxy/index.mjs';

const PROXY='https://br-late-hat-b55ygmj4-nflscores2.compute.c-7.us-east-2.aws.neon.tech/';
const ESPN='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const options={season:2026,weeks:'1-8',official:null};
for(let i=2;i<process.argv.length;i++){
  const arg=process.argv[i];
  if(!['--season','--weeks','--official'].includes(arg)||!process.argv[i+1]){
    console.error('Usage: node score-reconcile.mjs [--season 2026] [--weeks 1-8] [--official manually-verified-nfl-finals.csv]');
    process.exit(2);
  }
  options[arg.slice(2)]=process.argv[++i];
}
const season=Number(options.season);
if(!Number.isSafeInteger(season)||season<2020||season>2100)throw new Error('invalid season');
const match=String(options.weeks).match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
if(!match)throw new Error('weeks must be N or N-M');
const start=Number(match[1]),end=Number(match[2]??match[1]);
if(start<1||end>22||end<start)throw new Error('invalid week range');

function team(code){
  const val=String(code??'').trim().toUpperCase();
  // NFL.com writes Arizona as AZ; ESPN and the pool use ARI.
  return ({JAC:'JAX',WSH:'WAS',LA:'LAR',AZ:'ARI'})[val]||val;
}
function competition(e){return e?.competitions?.[0]||{}}
function matchup(e){
  const out={};
  for(const c of competition(e).competitors||[]){
    if(c?.homeAway!=='home'&&c?.homeAway!=='away')continue;
    out[c.homeAway]={team:team(c.team?.abbreviation),score:String(c.score??''),winner:c.winner??null};
  }
  return out;
}
function completed(e){
  // Any source-level finality is a candidate: missing/contradictory competition finality is itself a failure.
  return e?.status?.type?.completed===true
    || competition(e)?.status?.type?.completed===true;
}
function view(e){
  const c=competition(e);
  return {
    id:String(e.id),date:e.date,
    event:e.status?.type?.name??null,
    competition:c.status?.type?.name??null,
    eventCompleted:e.status?.type?.completed??null,
    competitionCompleted:c.status?.type?.completed??null,
    sides:matchup(e)
  };
}
async function getJson(url){
  const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('HTTP '+response.status+' from '+new URL(url).hostname);
  const value=await response.json();
  if(!Array.isArray(value?.events))throw new Error('invalid events array');
  return value;
}
function loadOfficial(path){
  if(!path)return null;
  const rows=new Map();
  const lines=readFileSync(path,'utf8').trim().split(/\r?\n/);
  assert.equal(lines.shift()?.trim(),'week,away,home,awayScore,homeScore',
    'official CSV must have exact header week,away,home,awayScore,homeScore');
  for(const [index,line] of lines.entries()){
    if(!line.trim()||line.trim().startsWith('#'))continue;
    const fields=line.split(',').map(x=>x.trim());
    if(fields.length!==5||!fields[3].match(/^\d+$/)||!fields[4].match(/^\d+$/))
      throw new Error('bad official CSV line '+(index+2));
    const [w,a,h,as,hs]=fields,week=Number(w);
    if(!Number.isSafeInteger(week)||week<1||week>22||!team(a)||!team(h))
      throw new Error('invalid official matchup on line '+(index+2));
    const key=week+'|'+team(a)+'|'+team(h);
    if(rows.has(key))throw new Error('duplicate official matchup '+key);
    rows.set(key,{as,hs});
  }
  return rows;
}

const official=loadOfficial(options.official);
const observed=new Set();
let fails=0,finals=0,parity=0;
for(let week=start;week<=end;week++){
  try{
    const q=new URL(ESPN);
    q.searchParams.set('dates',String(season));
    q.searchParams.set('week',String(week));
    q.searchParams.set('seasontype','2');
    const upstream=await getJson(q.toString());
    const proxy=new URL(PROXY);
    proxy.searchParams.set('season',String(season));
    proxy.searchParams.set('week',String(week));
    const deployed=await getJson(proxy.toString());
    const expected=projectScoreboard(upstream,'test-ignored')?.events;
    assert(Array.isArray(expected),'local projection failed');
    const live=new Map(deployed.events.map(e=>[String(e.id),e]));
    const source=new Map(expected.map(e=>[String(e.id),e]));
    if(live.size!==deployed.events.length||source.size!==expected.length)
      throw new Error('duplicate game IDs in feed');
    let weekFail=0,weekFinals=0;
    for(const [id,e] of source){
      const actual=live.get(id);
      if(!actual){console.error('FAIL week '+week+' missing proxy game '+id);weekFail++;continue}
      // Compare final results separately from in-progress data to avoid clock-skew false failures.
      if(completed(e)){
        weekFinals++;finals++;
        if(e?.status?.type?.completed!==true||competition(e)?.status?.type?.completed!==true){
          console.error('FAIL week '+week+' contradictory finality evidence '+id);
          weekFail++;
        }
        if(JSON.stringify(view(e))!==JSON.stringify(view(actual))){
          console.error('FAIL week '+week+' final mismatch for '+id);
          weekFail++;
        }else parity++;
        if(official){
          const sides=matchup(actual),away=sides.away,home=sides.home;
          const key=week+'|'+away?.team+'|'+home?.team;
          const ref=official.get(key);
          observed.add(key);
          if(!ref||away?.score!==ref.as||home?.score!==ref.hs){
            console.error('FAIL week '+week+' official NFL.com manual-reference mismatch or missing row for '+key);
            weekFail++;
          }
        }
      }
    }
    for(const id of live.keys())if(!source.has(id)){
      console.error('FAIL week '+week+' extra deployed game '+id);weekFail++;
    }
    console.log((weekFail?'FAIL':'PASS')+' week '+week+': '+source.size+' events, '+weekFinals+' finals checked against ESPN'
      +(official?', manual official-reference cross-check applied':''));
    fails+=weekFail;
  }catch(error){
    fails++;
    console.error('FAIL week '+week+': '+String(error?.message??error));
  }
}
if(official){
  for(const key of official.keys())if(!observed.has(key)&&Number(key.split('|')[0])>=start&&Number(key.split('|')[0])<=end){
    fails++;
    console.error('FAIL reference row has no finalized game in proxy: '+key);
  }
  if(!finals){fails++;console.error('FAIL no final games to verify');}
}
console.log('RESULT '+(fails?'FAIL':'PASS')+': '+parity+' finalized-game projections match ESPN, '+finals
  +' games evaluated'+(official?'; owner-supplied NFL.com reference included':'; NO independent official NFL reference yet')
  +'; '+fails+' failures.');
if(fails)process.exitCode=1;
