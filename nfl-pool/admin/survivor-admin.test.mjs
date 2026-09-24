// Behavioral tests for the Survivor publisher state machine (survivor-admin.js) against a fake DOM, a mock Neon client,
// a mock PDF reader and a mock NFL score feed. Only the CDN imports are rewritten; all publisher logic runs unmodified.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSurvivorPages} from './survivor-parser.js';

const here=new URL('.',import.meta.url);
const source=readFileSync(new URL('./survivor-admin.js',import.meta.url),'utf8');
const replacements=[
  ["import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';","const {createClient}=globalThis.__survivorTest.neonModule;"],
  ["from './survivor-parser.js?v=2';",`from '${new URL('./survivor-parser.js?v=2',here).href}';`],
  ["from './survivor-publish-checks.js?v=1';",`from '${new URL('./survivor-publish-checks.js?v=1',here).href}';`],
  ["await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs')","globalThis.__survivorTest.pdfjs"]
];
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

// ---- mock Neon (PostgREST-style builder over an in-memory table)
function neonModule(db){
  class Query{
    constructor(){this.op='select';this.filters=[];this.row=null}
    select(){return this}
    eq(k,v){this.filters.push([k,v]);return this}
    limit(){return this}
    insert(row){this.op='insert';this.row=row;return this}
    update(row){this.op='update';this.row=row;return this}
    then(ok,fail){return this.run().then(ok,fail)}
    async run(){
      const match=r=>this.filters.every(([k,v])=>r[k]===v);
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
  },from:()=>new Query()})};
}

async function boot({signedIn=true,rows=[],sheets={}}={}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new El(id));return els.get(id)};
  const db={session:signedIn?{id:'admin-1',email:'djsmokke@gmail.com'}:null,pendingSession:{id:'admin-1',email:'djsmokke@gmail.com'},rows:structuredClone(rows),log:[]};
  const net={fetches:0,gate:null,fail:null};
  globalThis.document={getElementById:$};
  globalThis.__survivorTest={
    neonModule:neonModule(db),
    pdfjs:{GlobalWorkerOptions:{},getDocument:({data})=>{const name=new TextDecoder().decode(data);return{promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>({items:sheets[name]})})})}}}
  };
  globalThis.fetch=async url=>{
    net.fetches++;const week=Number(new URL(url).searchParams.get('week'));
    if(net.gate)await net.gate.promise;
    if(net.fail)throw net.fail;
    return{ok:true,status:200,json:async()=>feedPayload(week)};
  };
  await import(`data:text/javascript;base64,${Buffer.from(patched+`\n//instance ${++instance}`).toString('base64')}`);
  await flush();
  $('season').value='2026';
  const choose=name=>{$('file').files=[new File([name],name,{type:'application/pdf'})];$('file').dispatch('change')};
  return{$,db,net,choose,parse:()=>$('parseBtn').onclick(),publish:()=>$('publishBtn').onclick()};
}
const sheets={'week2.pdf':sheetItems(SHEET),'week2-complete.pdf':sheetItems(COMPLETE),'other.pdf':sheetItems(COMPLETE)};

// ---- 1. Happy path: validate, confirmation gate, publish exactly one locked row with the private-safe config.
{
  const t=await boot({rows:[week1Row(SHEET)],sheets});
  t.choose('week2.pdf');await t.parse();
  assert.equal(t.$('review').hidden,false,t.$('message').textContent);
  assert.match(t.$('reviewTitle').textContent,/2026 · Week 2 · 6 entries · 3 with Week 2 pick/);
  assert.match(t.$('publishChecks').innerHTML,/1 of 4 entries alive entering Week 2 has no Week 2 pick\. Publishing shows it OUT \(no pick\) in Week 2\./);
  assert.equal(t.$('confirmWrap').hidden,false);assert.equal(t.$('publishBtn').disabled,true,'confirmation required first');
  assert.equal(t.$('confirmText').textContent,'I confirm this sheet is the final Week 2 pick list — no more Week 2 picks will be added. Publishing shows 1 entry OUT for no pick.');
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

console.log('survivor publisher stale-context, confirmation, schedule, compare-and-swap, double-submit and write-outcome regressions passed');
