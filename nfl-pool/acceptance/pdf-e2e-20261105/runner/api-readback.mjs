// QA ONLY (PR #29). Authorized read-back of the published synthetic weeks from the isolated QA child only, compared
// field-by-field with the fixture PDFs parsed independently in Node (same committed parsers, same pinned PDF.js version).
// Reads as the anonymous public role and as the synthetic publisher (admin RLS policy). Never writes. No token, cookie or
// password is printed or saved. Usage:
//   node api-readback.mjs <credentials.json> <pdfjs-dist dir> <out.json> <pickem fixture> <pickem revision> <survivor fixture> <survivor revision>
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [credsFile,pdfjsDir,outFile,pickemFile,pickemRevision,survivorFile,survivorRevision]=process.argv.slice(2);
const AUTH='https://ep-shiny-snow-bbx446zt.neonauth.c-15.us-east-1.aws.neon.tech/nfl_pool/auth';
const DATA='https://ep-shiny-snow-bbx446zt.apirest.c-15.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const ORIGIN='http://localhost:8765';
const repo=new URL('../../../',import.meta.url),fixtures=new URL('../fixtures/',import.meta.url);
const pdfjs=await import(pathToFileURL(pdfjsDir+'/legacy/build/pdf.mjs').href);
const core=await import(new URL('admin/parser-core.js',repo));
const sp=await import(new URL('admin/survivor-parser.js',repo));
const creds=JSON.parse(readFileSync(credsFile,'utf8'));
const bytes=name=>readFileSync(new URL(name,fixtures));
const sha=name=>createHash('sha256').update(bytes(name)).digest('hex');
async function pages(name){const pdf=await pdfjs.getDocument({data:new Uint8Array(bytes(name)),isEvalSupported:false}).promise,out=[];for(let n=1;n<=pdf.numPages;n++){const p=await pdf.getPage(n);out.push({n,items:(await p.getTextContent()).items})}return out}
async function expectedPickem(name){
  const groups=core.carryForwardWeekHints((await pages(name)).map(({n,items})=>{const sourceRows=core.groupPdfTextItems(items).map(r=>({...r,kind:'pdf',pageNumber:n})),lines=sourceRows.map(r=>r.text);return{week:lines.map(core.detectWeek).find(Boolean)||null,lines,sourceRows,pageNumber:n,pageFingerprint:lines.join('\n').replace(/\s+/g,' ').trim().toLowerCase()}}));
  return core.chooseBestCandidate(core.parseDocumentGroups(groups,{filename:name,season:2026,expectedCompetitionSize:null})).config;
}
async function expectedSurvivor(name){
  return sp.parseSurvivorPages((await pages(name)).map(({n,items})=>({pageNumber:n,rows:sp.groupSurvivorPdfTextItems(items)})),{season:2026,filename:name}).config;
}
async function publisherJwt(){
  const r=await fetch(AUTH+'/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},body:JSON.stringify({email:creds.publisher.email,password:creds.publisher.password})});
  if(r.status!==200)throw new Error('publisher sign-in failed: '+r.status);
  const cookie=(r.headers.getSetCookie?.()||[]).map(c=>c.split(';')[0]).join('; ');
  return(await (await fetch(AUTH+'/token',{headers:{Cookie:cookie,Origin:ORIGIN}})).json()).token;
}
const anonJwt=async()=>(await (await fetch(AUTH+'/token/anonymous',{headers:{Origin:ORIGIN}})).json()).token;
async function read(jwt,table,week){
  const r=await fetch(`${DATA}/${table}?select=season,week,status,revision,source_filename,source_sha256,published_at,locked_at,updated_at,config&season=eq.2026&week=eq.${week}`,{headers:{Accept:'application/json',Authorization:'Bearer '+jwt}});
  return{status:r.status,rows:await r.json()};
}
const checks=[];const check=(name,observed,pass)=>{checks.push({name,observed,pass:!!pass});console.log((pass?'PASS ':'FAIL ')+name+(pass?'':' :: '+JSON.stringify(observed).slice(0,400)))};
// JSONB keeps no key order of its own, so values are compared as canonical JSON: object keys sorted, arrays in order.
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v!==null&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const same=(a,b)=>canonical(a)===canonical(b);

const [anon,pub]=[await anonJwt(),await publisherJwt()];
// ---- Pick'em
{
  const exp=await expectedPickem(pickemFile),digest=sha(pickemFile);
  for(const [who,jwt] of [['anonymous public role',anon],['synthetic publisher (admin RLS policy)',pub]]){
    const {status,rows}=await read(jwt,'nfl_pool_weeks',exp.week),row=rows?.[0],cfg=row?.config;
    check(`Pick'em Week ${exp.week} readable by ${who}`,{status,rows:rows?.length},status===200&&rows?.length===1);
    if(!row)continue;
    check(`Pick'em revision/status/source via ${who}`,{revision:row.revision,status:row.status,source_filename:row.source_filename,source_sha256:row.source_sha256,configSource:cfg.source},
      row.revision===Number(pickemRevision)&&row.status==='locked'&&row.source_filename===pickemFile&&row.source_sha256===digest&&same(cfg.source,{kind:'weekly-upload',filename:pickemFile,sha256:digest}));
    check(`Pick'em locked/published timestamps are one instant via ${who}`,{published_at:row.published_at,locked_at:row.locked_at,updated_at:row.updated_at},
      Date.parse(row.published_at)===Date.parse(row.locked_at)&&Date.parse(row.locked_at)===Date.parse(row.updated_at));
    check(`Pick'em games: 14 real Week 10 games with NFL event ids via ${who}`,{games:cfg.games.length,eventIds:cfg.games.map(g=>g.eventId),dates:[...new Set(cfg.games.map(g=>g.date))]},
      cfg.games.length===14&&cfg.games.every(g=>/^\d{9}$/.test(g.eventId||''))&&same(cfg.games.map(({index,awayNumber,homeNumber,away,home,awayName,homeName})=>({index,awayNumber,homeNumber,away,home,awayName,homeName})),exp.games));
    check(`Pick'em tracked entries and picks equal the fixture via ${who}`,{participants:cfg.participants.map(p=>`${p.displayName}:${p.pickNumbers.join(' ')}|tb ${p.tiebreak}`)},same(cfg.participants,exp.participants));
    check(`Pick'em anonymous field (39 entries, ids/picks/tiebreaks only) equals the fixture via ${who}`,{fieldEntries:cfg.fieldEntries.length,competitionSize:cfg.competitionSize,keys:[...new Set(cfg.fieldEntries.flatMap(Object.keys))]},
      cfg.fullFieldReady===true&&cfg.competitionSize===43&&cfg.fullFieldEntryCount===39&&same(cfg.fieldEntries,exp.fieldEntries)&&same([...new Set(cfg.fieldEntries.flatMap(Object.keys))].sort(),['id','pickNumbers','tiebreak']));
    check(`Pick'em published config contains no anonymous entrant names via ${who}`,{},!/Avery Lantern|Synthetic Twin|Gap Cell Entrant|Jasper Quint/.test(JSON.stringify(cfg)));
    check(`Pick'em tiebreak game is the last matchup via ${who}`,{tiebreakGameIndex:cfg.tiebreakGameIndex},cfg.tiebreakGameIndex===13);
  }
}
// ---- Survivor
{
  const exp=await expectedSurvivor(survivorFile),digest=sha(survivorFile);
  for(const [who,jwt] of [['anonymous public role',anon],['synthetic publisher (admin RLS policy)',pub]]){
    const {status,rows}=await read(jwt,'nfl_survivor_weeks',exp.week),row=rows?.[0],cfg=row?.config;
    check(`Survivor Week ${exp.week} readable by ${who}`,{status,rows:rows?.length},status===200&&rows?.length===1);
    if(!row)continue;
    check(`Survivor revision/status/source via ${who}`,{revision:row.revision,status:row.status,source_filename:row.source_filename,source_sha256:row.source_sha256,configSource:cfg.source},
      row.revision===Number(survivorRevision)&&row.status==='locked'&&row.source_filename===survivorFile&&row.source_sha256===digest&&same(cfg.source,{kind:'survivor-upload',filename:survivorFile,sha256:digest}));
    check(`Survivor selection histories equal the fixture via ${who}`,{tracked:cfg.trackedEntries.map(t=>`${t.displayName}:${t.picks.map(x=>x||'-').join(',')}`),field:cfg.fieldEntries.map(f=>`${f.id}:${f.picks.join(',')}`)},
      same(cfg.trackedEntries,exp.trackedEntries)&&same(cfg.fieldEntries,exp.fieldEntries)&&cfg.competitionSize===4&&cfg.currentWeekEntryCount===exp.currentWeekEntryCount&&cfg.sheetWeeks===18);
    check(`Survivor published config contains no anonymous entrant name via ${who}`,{},!JSON.stringify(cfg).includes('Lumen Hart'));
  }
}
const result={at:new Date().toISOString(),target:DATA,pickem:{fixture:pickemFile,sha256:sha(pickemFile),revision:Number(pickemRevision)},survivor:{fixture:survivorFile,sha256:sha(survivorFile),revision:Number(survivorRevision)},checks,pass:checks.every(c=>c.pass)};
writeFileSync(outFile,JSON.stringify(result,null,1));
console.log('OVERALL='+result.pass);
