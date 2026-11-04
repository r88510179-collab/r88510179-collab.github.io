// Isolated Personal Week 9 QA only. No secrets, authentication bypass, production data or writes.
const BASE='https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'method_not_allowed'})}
  const season=Number(req.query?.season),week=Number(req.query?.week);
  if(season!==2026||!Number.isInteger(week)||week<1||week>18)return res.status(400).json({error:'invalid_season_week'});
  const url=BASE+'?dates=2026&seasontype=2&week='+week+'&limit=100';
  const controller=new AbortController,timeout=setTimeout(()=>controller.abort(),9000);
  try{
    const upstream=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});
    if(!upstream.ok)return res.status(502).json({error:'espn_http_'+upstream.status});
    const data=await upstream.json();
    if(data?.season?.year!==season||data?.season?.type!==2||data?.week?.number!==week||!Array.isArray(data.events)||!data.events.length)
      return res.status(502).json({error:'espn_week_context_invalid'});
    return res.status(200).json(data);
  }catch(e){
    return res.status(502).json({error:e?.name==='AbortError'?'espn_timeout':'espn_fetch_failed'});
  }finally{clearTimeout(timeout)}
}