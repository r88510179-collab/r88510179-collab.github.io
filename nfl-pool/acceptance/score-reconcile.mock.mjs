// Synthetic-only transport: never contacts an external API. Imported by the test subprocess.
import {projectScoreboard} from '../score-proxy/index.mjs';
const mode=process.env.SCORE_FIXTURE||'parity';
const complete={state:'post',completed:true,name:'STATUS_FINAL'};
const event={
  id:'synthetic-week-1-tie',date:'2026-09-10T20:00:00Z',
  status:{type:{...complete}},
  competitions:[{status:{type:{...complete}},competitors:[
    {homeAway:'away',team:{abbreviation:'BUF'},score:'17',winner:false},
    {homeAway:'home',team:{abbreviation:'BAL'},score:'17',winner:false}
  ]}]
};
const upstream={events:[event]};
const proxy=projectScoreboard(upstream,new Date().toISOString());
if(mode==='mismatch')proxy.events[0].competitions[0].competitors[1].score='99';
if(mode==='empty'){upstream.events=[];proxy.events=[];}
if(mode==='stale')proxy.fetchedAt='2020-01-01T00:00:00.000Z';
globalThis.fetch=async (url,options)=>{
  if(options?.method&&options.method!=='GET')throw new Error('fixture only allows GET');
  const payload=new URL(String(url)).hostname==='site.api.espn.com'?upstream:proxy;
  return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
};
