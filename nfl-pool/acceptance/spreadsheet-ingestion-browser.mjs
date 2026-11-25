// Spreadsheet import acceptance: real .xls (BIFF8), .xlsx and .xlsm workbooks through both admin flows, read by the real
// pinned SheetJS release in Chromium. Weekly Admin reads, reviews and publishes each workbook into an in-memory table;
// Organizer Corrections then reconciles that published week against the same workbook, entry by entry. Nothing is mocked
// between the selected file and the parsed picks. The reader is served from the verified local copy, every other outside
// request is refused, and no real data service is contacted.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {SHEETJS_URL,SHEETJS_INTEGRITY,loadPinnedSheetJS,servePinnedSheetJS,sha256Hex} from './sheetjs-pinned.mjs';
import {SYNTHETIC,workbookBytes,writeSyntheticWorkbooks} from './synthetic-workbooks.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const temp=mkdtempSync(join(tmpdir(),'spreadsheet-qa-'));
const {XLSX,bytes:sheetjs}=await loadPinnedSheetJS();
const workbooks=writeSyntheticWorkbooks(XLSX,temp);
const variant=(name,bytes)=>{const path=join(temp,name);writeFileSync(path,bytes);return{name,path,bytes,sha256:sha256Hex(bytes)}};
const withRow=(index,row)=>SYNTHETIC.rows.map((r,i)=>i===index?row:r);
const lastRow=SYNTHETIC.rows.length-1;

const read=path=>readFileSync(join(root,path),'utf8');
const adminEmail=read('nfl-pool/admin/admin.js').match(/const ADMIN_EMAIL='([^']+)'/)[1];
// Both pages declare exactly the recorded integrity for the reader, before their module script starts.
for(const page of ['nfl-pool/admin/index.html','nfl-pool/admin/organizer-corrections.html']){
  const html=read(page),maps=[...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)];
  assert.equal(maps.length,1,`${page}: one import map`);
  assert.deepEqual(JSON.parse(maps[0][1]),{integrity:{[SHEETJS_URL]:SHEETJS_INTEGRITY}},`${page}: import map pins only the reader`);
  assert(maps[0].index<html.indexOf('<script type="module"'),`${page}: import map precedes the module script`);
}

// An in-memory nfl_pool_weeks table behind the Neon client both pages import. Reads return copies; an insert of an
// existing season/week is refused as the real unique key refuses it.
const neonStub=`
const copy=v=>JSON.parse(JSON.stringify(v));
export function createClient(){
  const db=window.__testDb;
  return{
    auth:{
      getSession:async()=>({data:{session:{synthetic:true},user:{email:db.email}}}),
      signOut:async()=>({error:null}),
      emailOtp:{sendVerificationOtp:async()=>({error:null})},
      signIn:{emailOtp:async()=>({error:null})}
    },
    from(table){
      if(table!=='nfl_pool_weeks')throw Error('Synthetic database only');
      return{
        op:'read',filters:[],value:null,
        select(){return this},
        insert(value){this.op='insert';this.value=value;return this},
        update(value){this.op='update';this.value=value;return this},
        eq(field,value){this.filters.push([field,value]);return this},
        then(ok,fail){
          const match=row=>this.filters.every(([k,v])=>row[k]===v);
          let data,error=null;
          if(this.op==='read')data=db.rows.filter(match).map(copy);
          else if(this.op==='insert'){
            if(db.rows.some(r=>r.season===this.value.season&&r.week===this.value.week)){data=null;error={code:'23505',message:'duplicate key value violates unique constraint'}}
            else{db.rows.push(copy(this.value));db.writes++;data=[copy(this.value)]}
          }else{
            const hits=db.rows.filter(match);
            for(const row of hits)Object.assign(row,copy(this.value));
            db.writes+=hits.length;data=hits.map(copy);
          }
          return Promise.resolve({data,error}).then(ok,fail);
        }
      };
    }
  };
}
`;

const port=18341,base='http://127.0.0.1:'+port;
const opened=[];
let server,browser;
// A page of the app with its own empty or seeded table. `library` is what the pinned reader address answers with.
async function open(path,{rows=[],library=sheetjs}={}){
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  const page=await context.newPage(),t={path,page,context,errors:[],refused:[]};
  opened.push(t);
  page.on('pageerror',e=>t.errors.push(String(e)));
  await page.addInitScript(state=>{window.__testDb=state},{rows,writes:0,email:adminEmail});
  // Routes are consulted newest first, so this one only sees what no stand-in below answers.
  await context.route(url=>url.hostname!=='127.0.0.1',route=>{t.refused.push(route.request().url());return route.abort()});
  await context.route(/neon-js@0\.7\.0-beta/,route=>route.fulfill({status:200,contentType:'text/javascript',
    headers:{'access-control-allow-origin':'*'},body:neonStub}));
  await context.route(/nflscores2\./,route=>route.fulfill({status:200,contentType:'application/json',
    headers:{'access-control-allow-origin':'*'},body:JSON.stringify(SYNTHETIC.schedule)}));
  t.library=await servePinnedSheetJS(context,sheetjs,{body:library});
  await page.goto(base+path,{waitUntil:'load'});
  await page.locator('#authState').getByText('AUTHORIZED').waitFor({timeout:15000});
  return t;
}
const db=t=>t.page.evaluate(()=>window.__testDb);

// Weekly Admin: select the file, read and validate it, and report what the page shows once it has finished.
async function readSheet(t,file){
  const {page}=t;
  await page.locator('#season').fill(String(SYNTHETIC.season));
  await page.locator('#file').setInputFiles(file.path);
  await page.locator('#parseBtn').click();
  await page.waitForFunction(()=>document.querySelector('#busy').hidden&&!document.querySelector('#message').hidden,null,{timeout:20000});
  return page.evaluate(()=>{
    const $=id=>document.getElementById(id),cells=id=>[...$(id).querySelectorAll('tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim()));
    return{message:$('message').textContent,kind:$('message').className,reviewHidden:$('review').hidden,title:$('reviewTitle').textContent,
      entries:cells('entryReview'),games:cells('gameReview'),validation:[...$('validation').children].map(e=>e.textContent),
      publishDisabled:$('publishBtn').disabled};
  });
}
// Organizer Corrections: load the published week, select its source file, and preview one correction.
async function previewCorrection(t,file,{name,picks,tiebreak}){
  const {page}=t;
  await page.locator('#season').fill(String(SYNTHETIC.season));await page.locator('#week').fill(String(SYNTHETIC.week));
  await page.locator('#loadWeek').click();
  await page.locator('#weekDetails').getByText('revision 1',{exact:false}).waitFor({timeout:15000});
  await page.locator('#sourceFile').setInputFiles(file.path);
  await page.locator('#participantName').fill(name);
  await page.locator('#picks').fill(picks);await page.locator('#tiebreak').fill(tiebreak);
  await page.locator('#preview').click();
  await page.waitForFunction(()=>!document.querySelector('#preview').disabled&&!document.querySelector('#message').hidden,null,{timeout:20000});
  return page.evaluate(()=>{
    const $=id=>document.getElementById(id);
    return{message:$('message').textContent,kind:$('message').className,reviewHidden:$('review').hidden,summary:$('reviewSummary').textContent,
      changes:[...$('changes').querySelectorAll('tr')].map(tr=>[...tr.children].map(td=>td.textContent)),tieChange:$('tieChange').textContent,
      publishDisabled:$('publish').disabled};
  });
}
const blocked=(shown,why)=>{
  assert.equal(shown.kind,'notice error',why+': '+shown.message);
  assert.equal(shown.publishDisabled,true,why+': publishing stays blocked');
};

try{
  server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1','--directory',root],{stdio:'ignore'});
  let ready=false;
  for(let i=0;i<70;i++){
    try{const r=await fetch(base+'/nfl-pool/admin/index.html');if(r.ok){ready=true;break}}catch{}
    await delay(150);
  }
  assert(ready,'Static HTTP server must start');
  let bin='';
  for(const name of ['google-chrome-stable','google-chrome','chromium','chromium-browser']){
    try{bin=execFileSync('which',[name],{encoding:'utf8'}).trim();if(bin)break}catch{}
  }
  assert(bin,'Chrome/Chromium not present');
  browser=await chromium.launch({executablePath:bin,headless:true,args:['--no-sandbox']});

  const published={};
  for(const file of workbooks){
    const label=file.extension.toUpperCase();
    const admin=await open('/nfl-pool/admin/index.html');
    const shown=await readSheet(admin,file);
    assert.equal(shown.kind,'notice success',label+': '+shown.message);
    assert.equal(shown.message,`Week ${SYNTHETIC.week} parsed with 6 competition entries and matched to the NFL schedule. Review it before publishing.`);
    assert.equal(shown.title,`${SYNTHETIC.season} · Week ${SYNTHETIC.week} · 3 games · 6 entries`);
    assert.deepEqual(shown.entries,SYNTHETIC.tracked.map(p=>[p.displayName,p.pickNumbers.join(' '),String(p.tiebreak)]),label+': tracked picks on the review');
    assert.deepEqual(shown.games,[['1','1 Jaguars','at','2 Ravens',SYNTHETIC.kickoffDate],['2','3 Bengals','at','4 Falcons',SYNTHETIC.kickoffDate],['3','5 Packers','at','6 Bears',SYNTHETIC.kickoffDate]],label+': matchup key');
    assert(shown.validation.includes("✓ Full-field regular Pick'em data validated · 6 entries · standard parse"),label+': '+shown.validation.join(' | '));
    assert(shown.validation.includes('✓ NFL schedule matched'),label+': schedule matched');
    assert.equal(shown.publishDisabled,false,label+': a fully validated sheet can be published');

    await admin.page.locator('#publishBtn').click();
    await admin.page.locator('#message').getByText(`Week ${SYNTHETIC.week} published and locked successfully. Revision 1.`).waitFor({timeout:20000});
    const table=await db(admin),row=table.rows[0],config=row.config;
    assert.equal(table.writes,1);assert.equal(table.rows.length,1);
    assert.deepEqual([row.season,row.week,row.status,row.revision,row.source_filename,row.source_sha256],
      [SYNTHETIC.season,SYNTHETIC.week,'locked',1,file.name,file.sha256],label+': published row');
    assert.deepEqual(config.source,{kind:'weekly-upload',filename:file.name,sha256:file.sha256});
    assert.deepEqual(config.games.map(g=>({awayNumber:g.awayNumber,away:g.away,homeNumber:g.homeNumber,home:g.home})),SYNTHETIC.games,label+': matchups');
    assert.deepEqual(config.participants.map(p=>({displayName:p.displayName,pickNumbers:p.pickNumbers,tiebreak:p.tiebreak})),SYNTHETIC.tracked,label+': tracked picks');
    assert.deepEqual(config.fieldEntries,SYNTHETIC.field,label+': full-field picks');
    assert.deepEqual([config.fullFieldReady,config.fullFieldEntryCount,config.competitionSize],[true,2,6],label+': complete field');
    for(const name of SYNTHETIC.fieldNames)assert(!JSON.stringify(row).includes(name),'Source participant names cannot be stored');
    assert.equal(admin.library.pinned,1,label+': Weekly Admin read the workbook with the pinned reader');
    published[file.extension]=row;
    await admin.context.close();

    const corrections=await open('/nfl-pool/admin/organizer-corrections.html',{rows:[row]});
    const plan=await previewCorrection(corrections,file,{name:SYNTHETIC.fieldNames[0],picks:'1 3 5',tiebreak:'51'});
    assert.equal(plan.reviewHidden,false,label+': '+plan.message);
    assert.equal(plan.summary,'Published revision 1 → 2 · field-001 · 1 changed game pick(s) · no other entries affected');
    assert.deepEqual(plan.changes,[['Game 1: JAX at BAL','2','1']],label+': the published entry reconciles with the workbook as read on this page');
    assert.equal(plan.tieChange,'Tiebreak: 51 → 51');
    assert.equal((await db(corrections)).writes,0,'A preview writes nothing');
    assert.equal(corrections.library.pinned,1,label+': Organizer Corrections read the workbook with the pinned reader');
    await corrections.context.close();
    console.log(`PASS ${label}: real ${file.name} (${file.bytes.length} bytes, sha256 ${file.sha256.slice(0,12)}…) read by SheetJS ${XLSX.version} in Weekly Admin and Organizer Corrections; all 6 entries' picks match`);
  }
  // The same sheet must read identically from all three containers.
  const withoutSource=row=>({...row.config,source:null});
  assert.deepEqual(withoutSource(published.xls),withoutSource(published.xlsx),'XLS and XLSX publish the same week');
  assert.deepEqual(withoutSource(published.xlsm),withoutSource(published.xlsx),'XLSM and XLSX publish the same week');
  console.log('PASS: XLS, XLSX and XLSM publish identical configurations apart from the source fingerprint');

  // A reader that is not the recorded release is refused by the page's own integrity pin and never runs.
  const altered=Buffer.concat([sheetjs,Buffer.from('\n;globalThis.__alteredReaderRan=true;\n')]),xlsx=workbooks.find(w=>w.extension==='xlsx');
  {
    const admin=await open('/nfl-pool/admin/index.html',{library:altered});
    const shown=await readSheet(admin,xlsx);
    blocked(shown,'Weekly Admin with an altered reader');
    assert.equal(shown.reviewHidden,true,'No review is shown without the pinned reader');
    assert.equal(admin.library.pinned,1,'The altered reader was requested');
    assert.equal(await admin.page.evaluate(()=>globalThis.__alteredReaderRan),undefined,'The altered reader never ran');
    assert.deepEqual((await db(admin)).rows,[]);
    const corrections=await open('/nfl-pool/admin/organizer-corrections.html',{rows:[published.xlsx],library:altered});
    const plan=await previewCorrection(corrections,xlsx,{name:SYNTHETIC.fieldNames[0],picks:'1 3 5',tiebreak:'51'});
    blocked(plan,'Organizer Corrections with an altered reader');
    assert.equal(plan.reviewHidden,true,'No correction is prepared without the pinned reader');
    assert.equal(corrections.library.pinned,1,'The altered reader was requested');
    assert.equal(await corrections.page.evaluate(()=>globalThis.__alteredReaderRan),undefined,'The altered reader never ran');
    assert.equal((await db(corrections)).writes,0);
    console.log('PASS: an altered reader at the pinned address is refused by import-map integrity on both pages; nothing parsed or written');
  }

  // Sheets the real reader cannot prove complete stay blocked: a damaged file, and a missing pick or tiebreak cell.
  {
    const admin=await open('/nfl-pool/admin/index.html');
    const truncated=await readSheet(admin,variant('truncated.xlsx',xlsx.bytes.subarray(0,Math.floor(xlsx.bytes.length/2))));
    blocked(truncated,'Truncated workbook');
    assert.equal(truncated.reviewHidden,true,'A damaged workbook yields no review');
    const [name,,pick2,pick3,points,wins]=SYNTHETIC.rows[lastRow];
    for(const [what,row] of [['missing pick',[name,null,pick2,pick3,points,wins]],['blank tiebreak',[name,1,pick2,pick3,null,wins]]]){
      const shown=await readSheet(admin,variant(what.replace(' ','-')+'.xlsx',workbookBytes(XLSX,'xlsx',withRow(lastRow,row))));
      blocked(shown,'Workbook with a '+what);
      assert.match(shown.message,/PUBLISHING BLOCKED: full-field validation failed/,what+': '+shown.message);
      assert.deepEqual(shown.entries,SYNTHETIC.tracked.map(p=>[p.displayName,p.pickNumbers.join(' '),String(p.tiebreak)]),what+': tracked entries are still read');
      assert(shown.validation.some(v=>v.startsWith('⚠ PUBLISHING BLOCKED')),what+': '+shown.validation.join(' | '));
    }
    assert.deepEqual((await db(admin)).rows,[],'Nothing was published from a blocked sheet');
    console.log('PASS: a truncated workbook, a missing pick and a blank tiebreak are each refused; publishing stays blocked');
  }

  for(const t of opened){
    assert.deepEqual(t.errors,[],t.path+': no browser errors');
    assert.deepEqual(t.library.refused,[],t.path+': no other spreadsheet reader was requested');
    for(const url of t.refused)assert.equal(new URL(url).hostname,'a.espncdn.com',t.path+': unexpected outside request '+url);
  }
  console.log('PASS synthetic Chromium spreadsheet ingestion: pinned reader served locally, no outside service contacted');
}finally{
  if(browser)await browser.close().catch(()=>{});
  if(server)server.kill('SIGTERM');
  rmSync(temp,{recursive:true,force:true});
}
