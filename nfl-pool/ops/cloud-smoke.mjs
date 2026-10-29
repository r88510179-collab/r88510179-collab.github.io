// Public, credential-free cloud availability checks. No production writes.
// This runs in GitHub Actions without relying on a powered-on Mac.
const EXPECTED = [
  {id:"public-site",url:"https://smokkeventures.com/",kind:"html"},
  {id:"personal-pool",url:"https://r88510179-collab.github.io/nfl-pool/",kind:"html"},
  {id:"commercial-pool",url:"https://pool-platform-commercial-v1.netlify.app/",kind:"html"},
  {id:"fantasy-gm",url:"https://fantasy.smokkeventures.com/",kind:"html"},
  {id:"score-function",url:"https://br-late-hat-b55ygmj4-nflscores2.compute.c-7.us-east-2.aws.neon.tech/?season=2026&week=1",kind:"score"},
];
const T=12000;
async function probe(check, fetcher=fetch){
  const start=Date.now();
  try{
    const response=await fetcher(check.url,{method:"GET",redirect:"follow",cache:"no-store",
      headers:{Accept:check.kind==="score"?"application/json":"text/html"},
      signal:AbortSignal.timeout(T)});
    // Prevent accidental redirects to login walls from counting as app availability.
    if(!response.ok)throw Error("HTTP "+response.status);
    if(check.kind==="score"){
      const payload=await response.json();
      if(!Array.isArray(payload.events)||payload.events.length<1||payload.events.length>32)
        throw Error("invalid game-event array");
      if(!payload.events.every(e=>e&&typeof e.id==="string"&&e.competitions?.length))
        throw Error("malformed game-event evidence");
    }else{
      const type=response.headers.get("content-type")||"";
      if(!type.includes("text/html"))throw Error("unexpected content type");
      const sample=(await response.text()).slice(0,40000).toLowerCase();
      if(!sample.includes("<html")&&!sample.includes("<!doctype html"))throw Error("no HTML document");
      if(sample.includes("vercel.com/sso-api")||sample.includes("log in to netlify"))throw Error("login wall, not public page");
    }
    return {id:check.id,state:"pass",duration_ms:Date.now()-start};
  }catch(error){
    return {id:check.id,state:"fail",reason:String(error?.message??error).slice(0,110),duration_ms:Date.now()-start};
  }
}
async function main(){
  const results=await Promise.all(EXPECTED.map(c=>probe(c)));
  console.log("SMOKKE CLOUD CHECK "+new Date().toISOString());
  for(const r of results)console.log(r.state.toUpperCase()+" "+r.id+" "+r.duration_ms+"ms"+(r.reason?" ("+r.reason+")":""));
  const count=results.filter(r=>r.state==="pass").length;
  console.log("RESULT "+count+"/"+results.length+" public service probes passed. No logins, picks or DB writes tested.");
  if(process.env.GITHUB_STEP_SUMMARY){
    const fs=await import("node:fs");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      "## Smokke cloud checks\n\n"+results.map(r=>"- "+(r.state==="pass"?"PASS":"FAIL")+" **"+r.id+"**"+(r.reason?" — "+r.reason:"")).join("\n")+
      "\n\nThis checks public availability only, not login/pick persistence or backups.\n");
  }
  if(count!==results.length)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===new URL("file://"+process.argv[1]).href)await main();
export {EXPECTED,probe,main};
