// Behavioral tests for the Survivor publisher state machine (survivor-admin.js) against a fake DOM, a mock Neon client,
// a mock PDF reader and a mock NFL score feed. Only the CDN imports are rewritten; all publisher logic runs unmodified.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSurvivorPages} from './survivor-parser.js';

const here=new URL('.',import.meta.url);
const source=readFileSync(new URL('./survivor-admin.js',import.meta.url),'utf8');
// The survivor-publish-checks import is rewritten whatever its version; the HDC-14 regressions pin the version.
const checksImport=source.match(/from '\.\/survivor-publish-checks\.js\?v=(\d+)';/);
assert(checksImport,'harness expects a versioned survivor-publish-checks import');
const replacements=[
  ["import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';","const {createClient}=globalThis.__survivorTest.neonModule;"],
  ["from './survivor-parser.js?v=3';",`from '${new URL('./survivor-parser.js?v=3',here).href}';`],
  [checksImport[0],`from '${new URL(`./survivor-publish-checks.js?v=${checksImport[1]}`,here).href}';`],
  ["await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs')","globalThis.__survivorTest.pdfjs"]
];
assert(source.includes('gridBreaks:c.review.gridBreaks'),'publisher must pass parser-proven grid restarts to the confirmation guard');
let patched=source;
for(const [from,to] of replacements){assert(patched.includes(from),`harness expects: ${from}`);patched=patched.split(from).join(to)}
let instance=0;

// ---- fixtures
const W1=[['PIT','CLE'],['LV','NE'],['KC','LAC'],['JAX','CAR'],['ARI','ATL'],['BAL','BUF'],['CHI','CIN'],['DAL','DEN'],['DET','GB'],['HOU','IND'],['LAR','MIA'],['MIN','NO'],['NYG','NYJ'],['PHI','SEA'],['SF','TB'],['TEN','WAS']];
const W2=[['SF','ARI'],['ATL','BAL'],['BUF','CAR'],['CHI','CIN'],['CLE','DAL'],['DEN','DET'],['GB','HOU'],['IND','JAX'],['KC','LV'],['LAC','LAR'],['MIA','MIN'],['NE','NO'],['NYG','NYJ'],['PHI','PIT'],['SEA','TB'],['TEN','WAS']];
const feedEvent=(away,home,week)=>({id:`${week}-${away}`,week:{number:week},season:{year:2026,type:2},status:{type:{completed:true,state:'post',name:'STATUS_FINAL'}},competitions:[{competitors:[{homeAway:'away',team:{abbreviation:away},score:'24'},{homeAway:'home',team:{abbreviation:home},score:'10'}]}]});
const feedPayload=week=>({season:{year:2026,type:2},week:{number:week},events:(week===1?W1:W2).map(([a,h])=>feedEvent(a,h,week))});
const item=(str,x,y)=>({str,transform:[1,0,0,1,x,y]});
function sheetItems(rows){
  const items=[item('Week',116,760),item('1',159,760),item('2',192,760),item('3',225,760),item('4',258,760)];
  rows.forEach(([name,w1,w2],i)=>{const y=748-12*i;items.push(item(name,20,y));if(w1)items.push(item(w1,151,y-1.8));if(w2)items.push(item(w2,184,y-1.8))});
  return items;
}
const SHEET=[['D.C.','PIT','SF'],['DJS','LV','SF'],['Thaddius','LAC',null],['Alpha','JAX','BAL'],['Bravo','CLE',null],['Charlie','JAX',null]];
const COMPLETE=SHEET.map(r=>r[0]==='Charlie'?['Charlie','JAX','BUF']:r);
const toPages=items=>[{pageNumber:1,rows:(()=>{const rows=[];for(const it of items){const x=it.transform[4],y=it.transform[5];let row=rows.find(r=>Math.abs(r.y-y)<=2.2);if(!row){row={y,parts:[]};rows.push(row)}row.parts.push({x,text:it.str})}return rows.sort((a,b)=>b.y-a.y).map((r,rowIndex)=>{const parts=r.parts.sort((a,b)=>a.x-b.x);return{text:parts.map(p=>p.text).join(' '),y:r.y,rowIndex,parts}})})()}];
function week1Row(rows,revision=1){
  const cfg=parseSurvivorPages(toPages(sheetItems(rows)),{season:2026,filename:'w2.pdf'}).config;
  cfg.week=1;cfg.label='Survivor Week 1';for(const e of [...cfg.trackedEntries,...cfg.fieldEntries])e.picks=e.picks.slice(0,1);
  cfg.currentWeekEntryCount=[...cfg.trackedEntries,...cfg.fieldEntries].filter(e=>e.picks[0]).length;
  return{season:2026,week:1,status:'locked',revision,config:cfg,source_sha256:'w1',updated_at:'2026-09-15T00:00:00.000Z'};
}

// ---- fake DOM
class El{
  constructor(id){this.id=id;this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.textContent='';this.innerHTML='';this.className='';this.files=null;this.listeners={};this.classList={add(){},remove(){}}}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn)}
  dispatch(type,extra={}){for(const fn of this.listeners[type]||[])fn({preventDefault(){},target:this,...extra})}
  focus(){}
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const flush=async(n=8)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};

// ---- mock Neon (PostgREST-style builder over in-memory tables). nfl_survivor_weeks is db.rows and logs [op, ...filters];
// any other table (the locked Pick'em slates, nfl_pool_weeks, are db.pickem) logs [`${table}:${op}`, ...filters].
function neonModule(db){
  class Query{
    constructor(table){this.table=table;this.op='select';this.filters=[];this.row=null}
    get survivor(){return this.table==='nfl_survivor_weeks'}
    select(){return this}
    eq(k,v){this.filters.push([k,v]);return this}
    limit(){return this}
    insert(row){this.op='insert';this.row=row;return this}
    update(row){this.op='update';this.row=row;return this}
    then(ok,fail){return this.run().then(ok,fail)}
    async run(){
      const match=r=>this.filters.every(([k,v])=>r[k]===v);
      if(!this.survivor){db.log.push([`${this.table}:${this.op}`,...this.filters.map(f=>f.join('='))]);if(this.op!=='select')throw new Error(`unexpected ${this.op} on ${this.table}`);if(db.pickemFail){const e=db.pickemFail;db.pickemFail=null;throw e}return{data:(db.pickem||[]).filter(match).map(r=>structuredClone(r)),error:null}}
      if(this.op==='select'){db.log.push(['select',...this.filters.map(f=>f.join('='))]);if(db.readFail){const e=db.readFail;db.readFail=null;throw e}return{data:db.rows.filter(match).map(r=>structuredClone(r)),error:null}}
      db.log.push([this.op,...this.filters.map(f=>f.join('='))]);
      if(db.beforeWrite)await db.beforeWrite(this);
      let data;
      if(this.op==='insert'){
        if(db.rows.some(r=>r.season===this.row.season&&r.week===this.row.week))return{data:null,error:{code:'23505',message:'duplicate key value violates unique constraint'}};
        db.rows.push(structuredClone(this.row));data=[{season:this.row.season,week:this.row.week,revision:this.row.revision}];
      }else{
        const hits=db.rows.filter(match);for(const r of hits)Object.assign(r,structuredClone(this.row));data=hits.map(r=>({season:r.season,week:r.week,revision:r.revision}));
      }
      if(db.afterWrite){const f=db.afterWrite;db.afterWrite=null;await f()}
      return{data,error:null};
    }
  }
  return{createClient:()=>({auth:{
    getSession:async()=>({data:db.session?{user:db.session,session:{token:'t'}}:null}),
    signOut:async()=>{db.session=null},
    emailOtp:{sendVerificationOtp:async()=>({error:null})},
    signIn:{emailOtp:async()=>{db.session=db.pendingSession;return{error:null}}}
  },from:table=>new Query(table)})};
}

async function boot({signedIn=true,rows=[],sheets={},pickem=[],feed=feedPayload}={}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El(id));return els.get(id)};
  const db={session:signedIn?{id:'admin-1',email:'djsmokke@gmail.com'}:null,pendingSession:{id:'admin-1',email:'djsmokke@gmail.com'},rows:structuredClone(rows),pickem:structuredClone(pickem),log:[]};
  // `net.feed` maps a requested week to the NFL score-feed payload; `net.weeks` records every requested week.
  const net={fetches:0,gate:null,fail:null,feed,weeks:[]};
  globalThis.document={getElementById:$};
  globalThis.__survivorTest={
    neonModule:neonModule(db),
    pdfjs:{GlobalWorkerOptions:{},getDocument:({data})=>{const name=new TextDecoder().decode(data),pages=Array.isArray(sheets[name][0])?sheets[name]:[sheets[name]];return{promise:Promise.resolve({numPages:pages.length,getPage:async n=>({getTextContent:async()=>({items:pages[n-1]})})})}}}
  };
  globalThis.fetch=async url=>{
    net.fetches++;const week=Number(new URL(url).searchParams.get('week'));net.weeks.push(week);
    if(net.gate)await net.gate.promise;
    if(net.fail)throw net.fail;
    return{ok:true,status:200,json:async()=>net.feed(week)};
  };
  await import(`data:text/javascript;base64,${Buffer.from(patched+`\n//instance ${++instance}`).toString('base64')}`);
  await flush();
  $('season').value='2026';
  const choose=name=>{$('file').files=[new File([name],name,{type:'application/pdf'})];$('file').dispatch('change')};
  return{$,db,net,choose,parse:()=>$('parseBtn').onclick(),publish:()=>$('publishBtn').onclick()};
}
const sheets={'week2.pdf':sheetItems(SHEET),'week2-complete.pdf':sheetItems(COMPLETE),'other.pdf':sheetItems(COMPLETE),'blank-page.pdf':[sheetItems(COMPLETE),[item('Zed Blank',20,760),item('Zoe Blank',20,748)]],'symbol.pdf':[...sheetItems(COMPLETE),item('*',20,748-12*6)],'symbol-note.pdf':[...sheetItems(COMPLETE),item('*',20,748-12*6),item('n/a',151,748-12*6-1.8)]};

// ---- 1. Happy path: validate, confirmation gate, publish exactly one locked row with the private-safe config.
{
  const t=await boot({rows:[week1Row(SHEET)],sheets});
  t.choose('week2.pdf');await t.parse();
  assert.equal(t.$('review').hidden,false,t.$('message').textContent);
  assert.match(t.$('reviewTitle').textContent,/2026 · Week 2 · 6 entries · 3 with Week 2 pick/);
  assert.match(t.$('publishChecks').innerHTML,/1 of 4 entries alive entering Week 2 has no Week 2 pick\. Publishing shows it OUT \(no pick\) in Week 2\./);
  assert.equal(t.$('confirmWrap').hidden,false);assert.equal(t.$('publishBtn').disabled,true,'confirmation required first');
  assert.equal(t.$('confirmText').textContent,'I reviewed every item listed above and confirm this sheet is the final Survivor Week 2 submission set — no more Week 2 picks will be added. Publishing shows 1 entry OUT for no pick (Week 2).');
  t.$('confirmPartial').checked=true;t.$('confirmPartial').dispatch('change');
  assert.equal(t.$('publishBtn').disabled,false);
  const first=t.publish(),second=t.publish();await Promise.all([first,second]);
  const writes=t.db.log.filter(l=>l[0]==='insert'||l[0]==='update');
  assert.equal(writes.length,1,'double submit writes once');
  const row=t.db.rows.find(r=>r.week===2);
  assert.equal(row.status,'locked');assert.equal(row.revision,1);assert.match(row.source_sha256,/^[0-9a-f]{64}$/);
  assert.equal(row.config.source.sha256,row.source_sha256);
  assert.deepEqual(Object.keys(row.config.fieldEntries[0]).sort(),['id','picks']);
  assert.equal(JSON.stringify(row.config).includes('Charlie'),false);
  assert.match(t.$('message').textContent,/published and locked\. Revision 1\./);
  assert.equal(t.$('publishBtn').disabled,true,'a published candidate cannot be republished by another click');
  await t.publish();assert.equal(t.db.log.filter(l=>l[0]==='insert'||l[0]==='update').length,1);
}

// ---- 2. Stale parse completion never replaces a newer file; season change invalidates.
{
  const t=await boot({rows:[week1Row(SHEET)],sheets});
  t.net.gate=deferred();t.choose('week2.pdf');const pending=t.parse();await flush();
  t.choose('week2-complete.pdf');
  t.net.gate.resolve();await pending;await flush();
  assert.equal(t.$('review').hidden,true,'stale parse result discarded');assert.equal(t.$('message').textContent,'');
  t.net.gate=null;await t.parse();
  assert.match(t.$('reviewTitle').textContent,/4 with Week 2 pick/);assert.equal(t.$('confirmWrap').hidden,true);assert.equal(t.$('publishBtn').disabled,false);
  t.$('season').value='2025';t.$('season').dispatch('change');
  assert.equal(t.$('review').hidden,true);assert.equal(t.$('publishBtn').disabled,true);assert.match(t.$('message').textContent,/Season changed/);
  t.$('season').value='2026';await t.publish();
  assert.equal(t.db.log.some(l=>l[0]==='insert'),false,'no publish without a current candidate');
}

// ---- 3. Schedule verification failures fail closed.
{
  const t=await boot({rows:[week1Row(SHEET)],sheets});
  t.net.fail=new TypeError('Failed to fetch');t.choose('week2.pdf');await t.parse();
  assert.equal(t.$('review').hidden,true);assert.match(t.$('message').textContent,/NFL Week \d schedule could not be loaded \(Failed to fetch\)\. Schedule verification is required before publishing/);
  assert.equal(t.$('publishBtn').disabled,true);
}

// ---- 4. Signed-out validation is blocked; signing in runs the published-state check automatically.
{
  const t=await boot({signedIn:false,rows:[week1Row(COMPLETE)],sheets});
  t.choose('week2-complete.pdf');await t.parse();
  assert.match(t.$('publishChecks').innerHTML,/Published Survivor weeks for this season have not been checked/);
  assert.equal(t.$('publishBtn').disabled,true);
  t.$('otp').value='123456';await t.$('verifyCode').onclick();await flush();
  assert.equal(t.$('publishChecks').innerHTML.includes('have not been checked'),false);
  assert.match(t.$('publishChecks').innerHTML,/Entry count and Week 1 pick histories match published Week 1 \(revision 1\)/);
  assert.equal(t.$('publishBtn').disabled,false);
  await t.$('signOut').onclick();await flush();
  assert.equal(t.$('publishBtn').disabled,true,'sign-out removes the database check');
}

// ---- 5. Published state changing between validation and publish writes nothing.
{
  const t=await boot({rows:[week1Row(COMPLETE)],sheets});
  t.choose('week2-complete.pdf');await t.parse();assert.equal(t.$('publishBtn').disabled,false);
  t.db.rows[0].revision=2;
  await t.publish();
  assert.match(t.$('message').textContent,/changed since this sheet was validated\. Nothing was written/);
  assert.equal(t.db.rows.some(r=>r.week===2),false);assert.equal(t.$('publishBtn').disabled,true);
}

// ---- 6. Locked-week replacement stays explicit and uses compare-and-swap on the revision.
{
  const existing={...week1Row(COMPLETE),week:2,revision:4,status:'locked',config:parseSurvivorPages(toPages(sheetItems(COMPLETE)),{season:2026}).config,source_sha256:'old',updated_at:'2026-09-20T00:00:00.000Z'};
  const t=await boot({rows:[week1Row(COMPLETE),existing],sheets});
  t.choose('week2-complete.pdf');await t.parse();
  assert.match(t.$('publishChecks').innerHTML,/identical to published Week 2 revision 4/);
  await t.publish();
  assert.match(t.$('message').textContent,/already locked\. Check replace only for an intentional correction\. Nothing was written/);
  t.$('replaceLocked').checked=true;await t.publish();
  const update=t.db.log.find(l=>l[0]==='update');
  assert.deepEqual(update,['update','season=2026','week=2','revision=4']);
  assert.equal(t.db.rows.find(r=>r.week===2).revision,5);assert.equal(t.$('replaceLocked').checked,false);
}

// ---- 7. Compare-and-swap miss: a concurrent publish between the re-read and the write is never overwritten.
{
  const existing={season:2026,week:2,revision:4,status:'locked',config:parseSurvivorPages(toPages(sheetItems(COMPLETE)),{season:2026}).config,source_sha256:'old',updated_at:'2026-09-20T00:00:00.000Z'};
  const t=await boot({rows:[week1Row(COMPLETE),existing],sheets});
  t.choose('week2-complete.pdf');await t.parse();t.$('replaceLocked').checked=true;
  t.db.beforeWrite=async()=>{t.db.beforeWrite=null;t.db.rows.find(r=>r.week===2).revision=5};
  await t.publish();
  assert.match(t.$('message').textContent,/changed before this write \(no row matched revision 4\)\. This attempt wrote nothing/);
  assert.equal(t.db.rows.find(r=>r.week===2).revision,5);assert.equal(t.$('publishBtn').disabled,true);
}

// ---- 8. Network failure before the write lands: clear, recoverable state; retry succeeds.
{
  const t=await boot({rows:[week1Row(COMPLETE)],sheets});
  t.choose('week2-complete.pdf');await t.parse();
  t.db.beforeWrite=async()=>{t.db.beforeWrite=null;throw new TypeError('NetworkError when attempting to fetch resource.')};
  await t.publish();
  assert.match(t.$('message').textContent,/Read-back shows Survivor Week 2 is not published; this attempt wrote nothing\. You can retry Publish\./);
  assert.equal(t.$('publishBtn').disabled,false,'recoverable: retry allowed');
  await t.publish();
  assert.equal(t.db.rows.find(r=>r.week===2).revision,1);assert.match(t.$('message').textContent,/published and locked\. Revision 1\./);
}

// ---- 9. Write lands but the response is lost: read-back confirms it; nothing is written twice.
{
  const t=await boot({rows:[week1Row(COMPLETE)],sheets});
  t.choose('week2-complete.pdf');await t.parse();
  t.db.afterWrite=async()=>{throw new TypeError('Failed to fetch')};
  await t.publish();
  assert.match(t.$('message').textContent,/published and locked\. Revision 1\. \(confirmed by read-back after a lost response\)/);
  assert.equal(t.db.log.filter(l=>l[0]==='insert').length,1);assert.equal(t.$('publishBtn').disabled,true);
}

// ---- 10. Unknown outcome (write and read-back both fail): a later attempt detects the landed write instead of duplicating it.
{
  const t=await boot({rows:[week1Row(COMPLETE)],sheets});
  t.choose('week2-complete.pdf');await t.parse();
  t.db.afterWrite=async()=>{t.db.readFail=new TypeError('offline');throw new TypeError('Failed to fetch')};
  await t.publish();
  assert.match(t.$('message').textContent,/Publish outcome unknown/);assert.equal(t.$('publishBtn').disabled,true);
  await t.parse();
  assert.match(t.$('publishChecks').innerHTML,/identical to published Week 2 revision 1/);
  t.$('replaceLocked').checked=false;await t.publish();
  assert.match(t.$('message').textContent,/the previous attempt had already been written/);
  assert.equal(t.db.log.filter(l=>l[0]==='insert'||l[0]==='update').length,1,'no duplicate revision');
}

// ---- 11. Controls cannot drift during publication, and a file change is refused mid-publish.
{
  const t=await boot({rows:[week1Row(COMPLETE)],sheets});
  t.choose('week2-complete.pdf');await t.parse();
  const gate=deferred();t.db.beforeWrite=async()=>{t.db.beforeWrite=null;await gate.promise};
  const pending=t.publish();await flush();
  for(const id of ['file','season','replaceLocked','confirmPartial','parseBtn','publishBtn','signOut'])assert.equal(t.$(id).disabled,true,`${id} disabled during publish`);
  t.choose('other.pdf');assert.match(t.$('message').textContent,/Publishing is in progress/);
  gate.resolve();await pending;
  assert.equal(t.db.rows.find(r=>r.week===2).revision,1);assert.match(t.$('message').textContent,/published and locked/);
}

// ---- 12. Insert race: another publish created the week first -> definitive "not written" (PK conflict).
{
  const t=await boot({rows:[week1Row(COMPLETE)],sheets});
  t.choose('week2-complete.pdf');await t.parse();
  t.db.beforeWrite=async()=>{t.db.beforeWrite=null;t.db.rows.push({season:2026,week:2,status:'locked',revision:1,config:{},source_sha256:'theirs',updated_at:'2026-09-24T00:00:00.000Z'})};
  await t.publish();
  assert.match(t.$('message').textContent,/another publish created Survivor Week 2 first/);assert.equal(t.$('publishBtn').disabled,true);
  assert.equal(t.db.rows.find(r=>r.week===2).source_sha256,'theirs');
}

// ---- 13. Unknown outcome for file A, then a corrected file B: B is really written (never a false "already written").
{
  const t=await boot({rows:[week1Row(COMPLETE)],sheets});
  t.choose('week2.pdf');await t.parse();t.$('confirmPartial').checked=true;t.$('confirmPartial').dispatch('change');
  t.db.afterWrite=async()=>{t.db.readFail=new TypeError('offline');throw new TypeError('Failed to fetch')};
  await t.publish();assert.match(t.$('message').textContent,/Publish outcome unknown/);
  t.choose('week2-complete.pdf');await t.parse();
  assert.match(t.$('publishChecks').innerHTML,/This replaces published Week 2 revision 1:/);
  t.$('confirmPartial').checked=true;t.$('confirmPartial').dispatch('change');t.$('replaceLocked').checked=true;
  await t.publish();
  assert.equal(t.$('message').textContent.includes('already been written'),false,t.$('message').textContent);
  assert.deepEqual(t.db.log.filter(l=>l[0]==='insert'||l[0]==='update'),[['insert'],['update','season=2026','week=2','revision=1']]);
  const row=t.db.rows.find(r=>r.week===2);
  assert.equal(row.revision,2);assert.equal(row.config.currentWeekEntryCount,4,'corrected sheet (Charlie BUF) is live');
}

// ---- 14. Blank entrants on a page without picks are counted only behind an explicit, named confirmation.
{
  const t=await boot({rows:[week1Row(COMPLETE)],sheets});
  t.choose('blank-page.pdf');await t.parse();
  assert.match(t.$('reviewTitle').textContent,/8 entries/);
  assert.match(t.$('publishChecks').innerHTML,/2 rows without picks on a page with no participant picks were counted as entrants \(OUT for no pick\): &quot;Zed Blank&quot; \(page 2\), &quot;Zoe Blank&quot; \(page 2\)/);
  assert.equal(t.$('confirmWrap').hidden,false);assert.equal(t.$('publishBtn').disabled,true);
  assert.match(t.$('confirmText').textContent,/The 2 rows counted from a page without picks are real entrants\.$/);
}

// ---- 15. A name-column row with no letter or digit is not counted and reaches the guard for explicit confirmation.
{
  const t=await boot({rows:[week1Row(COMPLETE)],sheets});
  t.choose('symbol.pdf');await t.parse();
  assert.match(t.$('reviewTitle').textContent,/6 entries/);
  assert.match(t.$('publishChecks').innerHTML,/1 name-column row has no letter or digit and was NOT counted as an entrant: &quot;\*&quot; \(page 1\)/);
  assert.equal(t.$('confirmWrap').hidden,false);assert.equal(t.$('publishBtn').disabled,true);
  assert.match(t.$('confirmText').textContent,/The 1 row without a letter or digit listed above is not an entrant\.$/);
}
// ---- 16. The same row beside Week-column text that is not a team still reaches the guard for confirmation.
{
  const t=await boot({rows:[week1Row(COMPLETE)],sheets});
  t.choose('symbol-note.pdf');await t.parse();
  assert.match(t.$('reviewTitle').textContent,/6 entries/);
  assert.match(t.$('publishChecks').innerHTML,/1 name-column row has no letter or digit and was NOT counted as an entrant: &quot;\*&quot; \(page 1\)/);
  assert.equal(t.$('confirmWrap').hidden,false);assert.equal(t.$('publishBtn').disabled,true);
}

// ---- HDC-14: the Survivor publisher's absent-game exception, end to end. SF @ ARI left the Week 2 feed; the locked
// Pick'em Week 2 slate (revision 3) proves the matchup. Without the typed confirmation the sheet still cannot be
// published; with WEEK 2 SF @ ARI ABSENT it publishes a snapshot that records the exception and leaves every pick as the
// sheet has it. The publish re-checks the slate revision and the Week 2 feed before writing; an edited confirmation, a
// bye pick, a changed slate or a game listed again writes nothing. Every regression reports through one collector.
{
  const failures=[];
  const regression=async(name,check)=>{try{await check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const html=readFileSync(new URL('./survivor.html',import.meta.url),'utf8');
  const W2_NO_SF=W2.filter(([a])=>a!=='SF');
  const absentFeed=week=>week===2?{...feedPayload(2),events:W2_NO_SF.map(([a,h])=>feedEvent(a,h,2))}:feedPayload(week);
  const pickemRow=(pairs,revision=3)=>({season:2026,week:2,status:'locked',revision,config:{schemaVersion:1,season:2026,week:2,games:pairs.map(([away,home],i)=>({away,home,awayNumber:2*i+1,homeNumber:2*i+2,eventId:String(402600+i)}))}});
  const PHRASE='WEEK 2 SF @ ARI ABSENT';
  const EXC={type:'absent-from-week-feed',week:2,away:'SF',home:'ARI',pickemRevision:3,confirmation:PHRASE};
  const OLD_SF="Week 2: SF is not scheduled in verified NFL Week 2 (bye or invalid team) — 2 entries: D.C., DJS. Check the sheet's Week 2 column for SF.";
  const HINT=" Pick'em Week 2 (revision 3) proves SF @ ARI, and neither team is listed in the NFL Week 2 feed: if that game was moved out of Week 2, type WEEK 2 SF @ ARI ABSENT under Absent games and Read & validate again.";
  const FAILED='NFL schedule verification failed; this sheet cannot be published: ';
  const confirm=(t,text)=>{t.$('absenceConfirm').value=text;t.$('absenceConfirm').dispatch('input')};
  const ready=async({text=PHRASE,pickem=[pickemRow(W2)],feed=absentFeed}={})=>{
    const t=await boot({rows:[week1Row(COMPLETE)],sheets,pickem,feed});
    if(text!==null)confirm(t,text);
    t.choose('week2-complete.pdf');await t.parse();return t;
  };
  const writes=t=>t.db.log.filter(l=>l[0]==='insert'||l[0]==='update').length;

  await regression('survivor.html: the Absent games field, its format, every element the script uses, and survivor-admin.js v4 importing checks v3',()=>{
    assert(/<textarea id="absenceConfirm"[^>]*>/.test(html),'an #absenceConfirm textarea');
    assert.match(html,/<label for="absenceConfirm">Absent games/);assert.match(html,/WEEK N AWAY @ HOME ABSENT/);
    for(const [,id] of source.matchAll(/\$\('([A-Za-z]+)'\)/g))assert(html.includes(`id="${id}"`),`survivor.html lacks #${id}`);
    assert.match(html,/<script type="module" src="survivor-admin\.js\?v=4"><\/script>/);
    assert.equal(checksImport[1],'3','survivor-admin.js imports survivor-publish-checks.js v3');
  });
  await regression('without the typed confirmation the moved-game pick still blocks, naming the exact phrase',async()=>{
    const t=await ready({text:null});
    assert.equal(t.$('message').textContent,FAILED+OLD_SF+HINT);assert.equal(t.$('review').hidden,true);
    await t.publish();assert.equal(writes(t),0);
    assert(t.db.log.some(l=>l[0]==='nfl_pool_weeks:select'&&l.includes('season=2026')&&l.includes('status=locked')),'the locked 2026 Pick\'em slates are read');
  });
  await regression('with the exact confirmation the snapshot publishes with the exception and unchanged picks',async()=>{
    const t=await ready();
    assert.equal(t.$('review').hidden,false,t.$('message').textContent);
    assert.match(t.$('validation').innerHTML,/SF @ ARI: ABSENT FROM WEEK 2 FEED/);
    assert.match(t.$('validation').innerHTML,/stay pending until a ruling is recorded/);
    assert.equal(t.$('publishBtn').disabled,false);
    const before=t.net.fetches;await t.publish();
    assert.equal(writes(t),1);assert.match(t.$('message').textContent,/published and locked\. Revision 1\./);
    const row=t.db.rows.find(r=>r.week===2);
    assert.deepEqual(row.config.publicationExceptions,[EXC]);
    assert.deepEqual(row.config.trackedEntries.find(e=>e.displayName==='D.C.').picks,['PIT','SF'],'the pick is published as the sheet has it');
    assert.equal(t.net.fetches,before+1,'the publish re-checks the Week 2 feed once');
    assert.deepEqual([...new Set(t.net.weeks)].sort(),[1,2],'no later week is ever requested');
  });
  await regression('a bye pick (no slate game for SF) still blocks with the typed phrase',async()=>{
    const t=await ready({pickem:[pickemRow(W2_NO_SF)]});
    assert.equal(t.$('message').textContent,`${FAILED}${OLD_SF} · Absent-game confirmation "${PHRASE}" does not match a picked game that the same-week Pick'em slate proves and the NFL feed no longer lists. Correct or clear it, then Read & validate again.`);
    assert.equal(t.$('review').hidden,true);await t.publish();assert.equal(writes(t),0);
  });
  await regression('ordinary sheets are unchanged: no slate read, no exception key, no publish-time feed read',async()=>{
    const t=await ready({text:null,feed:feedPayload});
    assert.equal(t.db.log.some(l=>String(l[0]).startsWith('nfl_pool_weeks')),false,'no Pick\'em slate is read');
    const before=t.net.fetches;await t.publish();
    assert.equal(writes(t),1);assert.equal('publicationExceptions' in t.db.rows.find(r=>r.week===2).config,false);
    assert.equal(t.net.fetches,before,'no feed is read again');
  });
  await regression('a confirmation edited after validation invalidates the sheet; an unseen edit is refused at publish',async()=>{
    const t=await ready();
    confirm(t,'');
    assert.equal(t.$('review').hidden,true);assert.equal(t.$('publishBtn').disabled,true);
    assert.equal(t.$('message').textContent,'Absent-game confirmation changed. Read & validate the Survivor sheet again.');
    await t.publish();assert.equal(writes(t),0);
    const u=await ready();
    u.$('absenceConfirm').value='';await u.publish();
    assert.equal(writes(u),0);
    assert.equal(u.$('message').textContent,'This Survivor sheet is not fully validated for the current file, season and account. Read & validate it again before publishing.');
  });
  await regression('the game listed in Week 2 again before the publish writes nothing',async()=>{
    const t=await ready();
    t.net.feed=feedPayload;await t.publish();
    assert.equal(t.$('message').textContent,'Publish refused: SF @ ARI is no longer absent from the NFL Week 2 feed (a game of SF or ARI is listed), so its absence exception no longer holds. Nothing was written. Read & validate again.');
    assert.equal(writes(t),0);assert.equal(t.$('publishBtn').disabled,true);
  });
  await regression('a Pick\'em slate changed or removed before the publish writes nothing',async()=>{
    for(const [label,change] of [['revised',db=>{db.pickem[0].revision=4}],['removed',db=>{db.pickem.length=0}],['unlocked',db=>{db.pickem[0].status='draft'}]]){
      const t=await ready();
      change(t.db);await t.publish();
      assert.equal(t.$('message').textContent,"Publish refused: Pick'em Week 2 changed since this sheet was validated, so the absence exception for SF @ ARI no longer holds. Nothing was written. Read & validate again.",label);
      assert.equal(writes(t),0,label);assert.equal(t.$('publishBtn').disabled,true,label);
    }
  });
  await regression('a feed that cannot be re-checked refuses the write and allows a retry',async()=>{
    const t=await ready();
    t.net.fail=new TypeError('Failed to fetch');await t.publish();
    assert.equal(t.$('message').textContent,'Publish refused: the NFL Week 2 feed could not be re-checked for SF @ ARI (Failed to fetch). Nothing was written. You can retry Publish.');
    assert.equal(writes(t),0);assert.equal(t.$('publishBtn').disabled,false);
    t.net.fail=null;await t.publish();
    assert.equal(writes(t),1);assert.deepEqual(t.db.rows.find(r=>r.week===2).config.publicationExceptions,[EXC]);
  });
  await regression('the confirmation is frozen while a publish is running',async()=>{
    const t=await ready();
    const gate=deferred();t.db.beforeWrite=async()=>{t.db.beforeWrite=null;await gate.promise};
    const pending=t.publish();await flush();
    assert.equal(t.$('absenceConfirm').disabled,true,'the field is disabled during the publish');
    confirm(t,'');
    assert.equal(t.$('absenceConfirm').value,PHRASE);
    assert.equal(t.$('message').textContent,'Publishing is in progress. The absent-game confirmation cannot be changed until it finishes.');
    gate.resolve();await pending;
    assert.equal(writes(t),1);assert.deepEqual(t.db.rows.find(r=>r.week===2).config.publicationExceptions,[EXC]);
  });
  assert.equal(failures.length,0,`HDC-14 Survivor publisher regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('survivor publisher stale-context, confirmation, schedule, compare-and-swap, double-submit and write-outcome regressions passed');
