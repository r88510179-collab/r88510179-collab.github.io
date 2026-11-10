import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import XLSX from 'xlsx';
import {parseDocumentGroups} from '../admin/parser-core.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const temp=mkdtempSync(join(tmpdir(),'correction-qa-'));
const file=join(temp,'qa-week-9.xlsx');
const rows=[
  ['Week 9'],['1) Jaguars at 2) Ravens'],['3) Bengals at 4) Falcons'],
  ['Entry','Pick1','Pick2','Pts','W'],
  ['D.C.',1,3,42,0],['JC',2,3,43,0],['DJS',1,4,44,0],['Thaddius',2,4,45,0],
  ['Mackpool',2,3,51,0],['Other Entrant',1,4,49,0]
];
const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'Week 9');XLSX.writeFile(wb,file);
const sourceRows=rows.map((cells,i)=>({kind:'spreadsheet',sheetName:'Week 9',rowNumber:i+1,
  cells:cells.map(String),text:cells.map(String).filter(Boolean).join(' ')}));
const candidate=parseDocumentGroups([{week:9,lines:sourceRows.map(x=>x.text),sourceRows,sheetName:'Week 9'}],
  {filename:'qa-week-9.xlsx',season:2026,expectedCompetitionSize:6})[0];
assert.equal(candidate?.config?.fullFieldReady,true,JSON.stringify(candidate?.fullFieldIssues||candidate?.errors));
assert.deepEqual(candidate.localFieldNames,['Mackpool','Other Entrant']);
const sha=createHash('sha256').update(readFileSync(file)).digest('hex');
const initial={season:2026,week:9,revision:3,status:'locked',source_sha256:sha,source_filename:'qa-week-9.xlsx',
  config:{...candidate.config,source:{kind:'weekly-upload',filename:'qa-week-9.xlsx',sha256:sha}},
  updated_at:'2026-11-09T12:00:00Z'};
const neonStub=`
const copy=v=>JSON.parse(JSON.stringify(v));
export function createClient(){
  return {
    auth:{
      getSession:async()=>({data:{session:{synthetic:true},user:{email:'djsmokke@gmail.com'}}}),
      signOut:async()=>({error:null}),
      emailOtp:{sendVerificationOtp:async()=>({error:null})},
      signIn:{emailOtp:async()=>({error:null})}
    },
    from(table){
      if(table!=='nfl_pool_weeks')throw Error('Synthetic database only');
      return {
        op:'read',filters:[],rowPatch:null,
        select(){return this},
        update(value){this.op='update';this.rowPatch=value;return this},
        eq(field,value){this.filters.push([field,value]);return this},
        then(ok,fail){
          const db=window.__testDb;
          const matches=this.filters.every(([k,v])=>db.row[k]===v);
          let data=[];
          if(this.op==='update'&&matches){
            db.row={...db.row,...copy(this.rowPatch)};
            db.writes++;
            data=[{season:db.row.season,week:db.row.week,revision:db.row.revision}];
            if(db.writeMode==='lose-response')return Promise.reject(Error('Synthetic lost PATCH response')).then(ok,fail);
            if(db.writeMode==='different-timestamp')db.row.updated_at='2026-11-09T12:00:00Z';
          }else if(this.op==='read'&&matches)data=[copy(db.row)];
          return Promise.resolve({data,error:null}).then(ok,fail);
        }
      };
    }
  };
}
`;
const port=18339;
let server,browser;
try{
  server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1','--directory',root],{stdio:'ignore'});
  let ready=false;
  for(let i=0;i<70;i++){
    try{const r=await fetch('http://127.0.0.1:'+port+'/nfl-pool/admin/organizer-corrections.html');if(r.ok){ready=true;break}}catch{}
    await delay(150);
  }
  assert(ready,'Static HTTP server must start');
  let bin='';
  for(const name of ['google-chrome-stable','google-chrome','chromium','chromium-browser']){
    try{bin=execFileSync('which',[name],{encoding:'utf8'}).trim();if(bin)break}catch{}
  }
  assert(bin,'Chrome/Chromium not present');
  browser=await chromium.launch({executablePath:bin,headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1280,height:850}});
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(row=>{window.__testDb={row,writes:0}},initial);
  await page.route(/neon-js@0\.7\.0-beta/,route=>route.fulfill({status:200,contentType:'text/javascript',
    headers:{'access-control-allow-origin':'*'},body:neonStub}));
  await page.route(/neonauth\./,r=>r.abort());await page.route(/apirest\./,r=>r.abort());
  await page.goto('http://127.0.0.1:'+port+'/nfl-pool/admin/organizer-corrections.html',{waitUntil:'networkidle'});
  await page.locator('#authState').getByText('AUTHORIZED').waitFor({timeout:15000});
  await page.locator('#season').fill('2026');await page.locator('#week').fill('9');
  await page.locator('#loadWeek').click();await page.locator('#weekDetails').getByText('revision 3',{exact:false}).waitFor();
  await page.locator('#sourceFile').setInputFiles(file);
  await page.locator('#participantName').fill('Mackpool');
  await page.locator('#picks').fill('1 4');await page.locator('#tiebreak').fill('51');
  assert.equal(await page.locator('#noticeSubject').count(),0,'No free-text audit reference is exposed');
  await page.locator('#preview').click();await page.locator('#review').waitFor({state:'visible',timeout:20000});
  assert.match(await page.locator('#reviewSummary').innerText(),/2 changed game pick/);
  assert.equal(await page.locator('#changes tr').count(),2);
  await page.locator('#confirm').check();await page.locator('#publish').click();
  await page.getByText(/published and read-back verified/i).waitFor({timeout:20000});
  const saved=await page.evaluate(()=>window.__testDb);
  assert.equal(saved.writes,1);
  assert.equal(saved.row.revision,4);
  assert.equal(saved.row.config.competitionSize,6);
  assert.deepEqual(saved.row.config.fieldEntries.map(e=>e.pickNumbers),[[1,4],[1,4]]);
  assert.equal(saved.row.config.organizerCorrections.length,1);
  assert.equal(saved.row.config.organizerCorrections[0].noticeSubject,'Organizer email');
  assert.equal(saved.row.source_sha256,sha);
  for(const name of candidate.localFieldNames){
    assert(!JSON.stringify(saved.row.config).includes(name),'Source participant names cannot be stored');
  }
  console.log('PASS: synthetic Excel, unique name mapping, reviewed one-entry CAS update and readback');

  await page.locator('#sourceFile').setInputFiles(file);
  await page.locator('#participantName').fill('Mackpool');
  await page.locator('#picks').fill('1 4');await page.locator('#tiebreak').fill('51');
  await page.locator('#preview').click();
  await page.getByText(/already matches this correction/i).waitFor({timeout:20000});
  assert.equal(await page.evaluate(()=>window.__testDb.writes),1);
  console.log('PASS: duplicate notice refused without write');

  await page.locator('#picks').fill('2 4');await page.locator('#preview').click();
  await page.locator('#review').waitFor({state:'visible',timeout:20000});
  for(const width of [375,390,430,1280]){
    await page.setViewportSize({width,height:820});
    const m=await page.evaluate(()=>({
      inner:innerWidth,scroll:document.documentElement.scrollWidth,
      preview:document.querySelector('#preview').getBoundingClientRect().height,
      publish:document.querySelector('#publish').getBoundingClientRect().height,
      load:document.querySelector('#loadWeek').getBoundingClientRect().height,
      confirm:document.querySelector('label:has(#confirm)').getBoundingClientRect().height,
      weeklyAdmin:document.querySelector('.admin-actions .back').getBoundingClientRect().height
    }));
    assert.equal(m.inner,width);assert(m.scroll<=width,'Horizontal overflow at '+width);
    assert(Math.min(m.preview,m.publish,m.load,m.confirm,m.weeklyAdmin)>=44,'Touch control height below 44px at '+width);
    console.log('PASS viewport '+width+'px: '+JSON.stringify(m));
  }

  await page.evaluate(()=>{window.__testDb.row.revision=5});
  await page.locator('#confirm').check();await page.locator('#publish').click();
  await page.getByText(/changed after preview/i).waitFor({timeout:20000});
  assert.equal(await page.evaluate(()=>window.__testDb.writes),1);
  console.log('PASS: stale revision refused');

  await page.locator('#loadWeek').click();
  await page.locator('#weekDetails').getByText('revision 5',{exact:false}).waitFor();
  await page.evaluate(()=>{window.__testDb.writeMode='lose-response'});
  await page.locator('#preview').click();
  await page.locator('#confirm').check();
  await page.locator('#publish').click();
  await page.getByText(/did reach the database; confirmed by read-back/i).waitFor();
  assert.equal(await page.evaluate(()=>window.__testDb.writes),2);
  assert.match(await page.locator('#weekDetails').innerText(),/revision 6/);
  console.log('PASS: lost response confirmed by complete read-back without retrying');

  await page.evaluate(()=>{window.__testDb.writeMode='different-timestamp'});
  await page.locator('#picks').fill('1 3');
  await page.locator('#preview').click();
  await page.locator('#confirm').check();
  await page.locator('#publish').click();
  await page.getByText(/write result is not confirmed/i).waitFor();
  assert.equal(await page.evaluate(()=>window.__testDb.writes),3);
  console.log('PASS: matching picks and history with different publication metadata cannot report success');
  assert.deepEqual(errors,[],'No browser errors');
  console.log('PASS synthetic Chromium E2E: no real data services contacted');
}finally{
  if(browser)await browser.close().catch(()=>{});
  if(server)server.kill('SIGTERM');
  rmSync(temp,{recursive:true,force:true});
}
