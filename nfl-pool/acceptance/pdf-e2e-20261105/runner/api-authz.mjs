// QA ONLY (PR #29). Backend authorization probe against the isolated QA child branch only (ep-shiny-snow-bbx446zt).
// Credentials are read from a local file outside the repository; no token, cookie or password is ever printed or saved.
// Writes attempted here are NEGATIVE controls that RLS must refuse; they target only the QA child.
import {readFileSync,writeFileSync} from 'node:fs';
const AUTH='https://ep-shiny-snow-bbx446zt.neonauth.c-15.us-east-1.aws.neon.tech/nfl_pool/auth';
const DATA='https://ep-shiny-snow-bbx446zt.apirest.c-15.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
for(const u of [AUTH,DATA])if(!new URL(u).hostname.startsWith('ep-shiny-snow-bbx446zt.'))throw new Error('refusing non-child target');
const [credsFile,outFile]=process.argv.slice(2);
const accounts=JSON.parse(readFileSync(credsFile,'utf8'));
const ORIGIN='http://localhost:8765';
const claims=jwt=>{try{const c=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url').toString('utf8'));return{sub:c.sub,role:c.role,hasEmail:'email' in c,exp:c.exp,iss:c.iss}}catch{return null}};
async function signIn(a){
  const r=await fetch(AUTH+'/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},body:JSON.stringify({email:a.email,password:a.password})});
  const cookie=(r.headers.getSetCookie?.()||[]).map(c=>c.split(';')[0]).join('; ');
  const body=await r.json().catch(()=>({}));
  const t=await fetch(AUTH+'/token',{headers:{Cookie:cookie,Origin:ORIGIN}});
  const tb=await t.json().catch(()=>({}));
  return{signInStatus:r.status,userId:body?.user?.id??null,role:body?.user?.role??null,tokenStatus:t.status,jwt:tb?.token||null};
}
async function rest(method,path,jwt,body,extra={}){
  // return=representation makes every write report the rows it touched (a DELETE otherwise answers 204 with no count).
  const headers={Accept:'application/json',...(jwt?{Authorization:'Bearer '+jwt}:{}),...(body?{'Content-Type':'application/json'}:{}),...(method==='GET'?{}:{Prefer:'return=representation'}),...extra};
  const r=await fetch(DATA+path,{method,headers,body:body?JSON.stringify(body):undefined});
  const text=await r.text();let json=null;try{json=JSON.parse(text)}catch{}
  return{status:r.status,rows:Array.isArray(json)?json.length:null,code:json?.code??null,message:Array.isArray(json)?null:(json?.message||text.slice(0,160))};
}
const results={at:new Date().toISOString(),target:{auth:AUTH,data:DATA},checks:[]};
const check=(name,observed,pass)=>{results.checks.push({name,observed,pass:!!pass});console.log((pass?'PASS ':'FAIL ')+name+' :: '+JSON.stringify(observed))};
const probeRow={season:2026,week:22,status:'draft',config:{schemaVersion:1,qaNegativeControl:'must be refused by RLS'},revision:1};

const anon=await fetch(AUTH+'/token/anonymous',{headers:{Origin:ORIGIN}}).then(r=>r.json()).then(j=>j.token);
check('anonymous token issued by child Auth',{role:claims(anon)?.role},claims(anon)?.role==='anonymous');
let r=await rest('GET','/nfl_pool_weeks?select=season,week,status,revision',anon);check('anonymous reads locked Pick\'em weeks',r,r.status===200&&r.rows>=1);
r=await rest('POST','/nfl_pool_weeks',anon,probeRow);check('anonymous INSERT refused',r,r.status>=400&&r.rows===null);
r=await rest('PATCH','/nfl_pool_weeks?season=eq.2026&week=eq.9&revision=eq.3',anon,{status:'locked'});check('anonymous UPDATE refused or matches nothing',r,r.status>=400||r.rows===0);
r=await rest('GET','/nfl_pool_weeks?select=season',null);check('no-credential read refused',r,(r.status===400||r.status===401)&&r.rows===null);
r=await rest('GET','/nfl_pool_weeks?select=season','not.a.jwt');check('malformed bearer refused',r,(r.status===400||r.status===401)&&r.rows===null);
const forged=anon.split('.').slice(0,2).join('.')+'.'+Buffer.from('forged-signature').toString('base64url');
r=await rest('GET','/nfl_pool_weeks?select=season',forged);check('forged-signature JWT refused',r,(r.status===400||r.status===401)&&r.rows===null);

const intr=await signIn(accounts.intruder);
check('wrong account (synthetic, role user) signs in to child Auth',{signIn:intr.signInStatus,token:intr.tokenStatus,role:intr.role,jwtRole:claims(intr.jwt)?.role},intr.signInStatus===200&&!!intr.jwt);
r=await rest('GET','/nfl_pool_weeks?select=season,week,revision',intr.jwt);check('wrong account sees no publisher rows',r,r.status===200&&r.rows===0);
r=await rest('POST','/nfl_pool_weeks',intr.jwt,probeRow);check('wrong account Pick\'em INSERT refused by RLS',r,r.status===403&&r.code==='42501');
r=await rest('POST','/nfl_survivor_weeks',intr.jwt,probeRow);check('wrong account Survivor INSERT refused by RLS',r,r.status===403&&r.code==='42501');
r=await rest('PATCH','/nfl_pool_weeks?season=eq.2026&week=eq.9&revision=eq.3',intr.jwt,{status:'locked'});check('wrong account Pick\'em UPDATE matches 0 rows',r,r.status===200&&r.rows===0);
r=await rest('PATCH','/nfl_survivor_weeks?season=eq.2026&week=eq.9&revision=eq.1',intr.jwt,{status:'locked'});check('wrong account Survivor UPDATE matches 0 rows',r,r.status===200&&r.rows===0);
r=await rest('DELETE','/nfl_pool_weeks?season=eq.2026&week=eq.9',intr.jwt);check('wrong account DELETE removes nothing (no DELETE policy)',r,(r.status===200&&r.rows===0)||r.status>=400);

const pub=await signIn(accounts.publisher);
check('synthetic publisher signs in to child Auth',{signIn:pub.signInStatus,token:pub.tokenStatus,role:pub.role,jwtRole:claims(pub.jwt)?.role,sub:claims(pub.jwt)?.sub===pub.userId},pub.signInStatus===200&&!!pub.jwt&&pub.role==='admin');
r=await rest('GET','/nfl_pool_weeks?select=season,week,status,revision',pub.jwt);check('synthetic publisher reads Pick\'em rows via admin policy',r,r.status===200&&r.rows>=1);
r=await rest('GET','/nfl_survivor_weeks?select=season,week,status,revision',pub.jwt);check('synthetic publisher reads Survivor rows via admin policy',r,r.status===200&&r.rows>=2);
r=await rest('DELETE','/nfl_pool_weeks?season=eq.2026&week=eq.9',pub.jwt);check('even the synthetic publisher cannot DELETE (no DELETE policy)',r,(r.status===200&&r.rows===0)||r.status>=400);

results.pass=results.checks.every(c=>c.pass);
if(outFile)writeFileSync(outFile,JSON.stringify(results,null,1));
console.log('OVERALL='+results.pass);
