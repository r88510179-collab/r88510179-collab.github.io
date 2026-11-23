// Browser end-to-end checks of the commissioner final-score panel: the built page, the real same-origin Auth proxy
// and the real SQL migrations in a disposable PostgreSQL. See e2e-server.mjs for exactly what is a stand-in (Neon
// Auth and the Data API's token verification) and therefore NOT covered here.
//
//   E2E_BROWSERS=chromium,webkit   engines to run (default chromium); each needs its Playwright browser installed
//   E2E_EVIDENCE_DIR=<dir>         optional: screenshots of the panel at each width
//   E2E_HARDENING=0                leave out 20261112_final_attestation_hardening.sql (to reproduce the defects)
//   E2E_APP_DIR=<pool-platform>    build another checkout's frontend (default: this checkout)
// PostgreSQL comes from the usual PG* variables and must be a loopback or socket host. The database pool_e2e is
// DROPPED and re-created before every test.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {assertLocalDatabaseHost,DATA_API_PATH,E2E_OTP,runPsql,startE2eServer} from './e2e-server.mjs';
import {CONFIG_UNAVAILABLE,SIGN_IN_CHANGED,SIGNED_OUT_ELSEWHERE} from '../../platform-client.js';
import {STATIC_FILES} from '../../scripts/build.mjs';
import * as panel from './final-results-page.mjs';
import {runIssuerCheck,runSignedInAcceptance,summarize} from './signed-in-acceptance-core.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const appDir=path.resolve(process.env.E2E_APP_DIR||path.join(here,'../..'));
const hardening=process.env.E2E_HARDENING!=='0';
const database='pool_e2e';
const adminDatabase=process.env.PGDATABASE||'postgres';
const engines=(process.env.E2E_BROWSERS||'chromium').split(',').map(x=>x.trim()).filter(Boolean);
const evidenceDir=process.env.E2E_EVIDENCE_DIR?path.resolve(process.env.E2E_EVIDENCE_DIR):null;
const playwright=createRequire(import.meta.url)('playwright');
const launchOptions=engine=>engine==='chromium' && process.env.POOL_TEST_CHROMIUM_EXECUTABLE
  ? {executablePath:process.env.POOL_TEST_CHROMIUM_EXECUTABLE} : {};
const WIDTHS=[375,390,430];
const ALPHA='E2E Alpha Pickem',BETA='E2E Beta Survivor';
const BETA_SEASON=Object.freeze({poolId:'b0000000-0000-4000-8000-000000000002',season:2026});
const week={w9:'d0000000-0000-4000-8000-000000000009',w10:'d0000000-0000-4000-8000-000000000010',
  w11:'d0000000-0000-4000-8000-000000000011',w12:'d0000000-0000-4000-8000-000000000012',
  w13:'d0000000-0000-4000-8000-000000000013',beta9:'d0000000-0000-4000-8000-000000000109'};
const games={w9:['2026_09_JAX_BAL','2026_09_CIN_ATL'],w11:['2026_11_DEN_CAR','2026_11_DET_CHI'],
  w12:['2026_12_GB_NE','2026_12_HOU_LAC'],beta9:['2026_09_KC_LV','2026_09_SEA_SF']};
const final=(away,home)=>({status:'final',away_score:away,home_score:home});
const EVIDENCE='Checked against the league game book for both games';

// ---- one-time setup: certificate, free port, build, server ---------------------------------------------------
const work=fs.mkdtempSync(path.join(os.tmpdir(),'pool-e2e-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(work,'key.pem'),'-out',
  path.join(work,'cert.pem'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
const port=await new Promise((resolve,reject)=>{
  const probe=net.createServer();
  probe.once('error',reject);
  probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolve(port))});
});
const origin=`https://localhost:${port}`;
execFileSync(process.execPath,['scripts/build.mjs','--out',path.join(work,'dist')],{cwd:appDir,stdio:'pipe',
  env:{...process.env,POOL_PLATFORM_MODE:'live',POOL_PLATFORM_DATA_URL:`${origin}${DATA_API_PATH}`,
    POOL_PLATFORM_DEFAULT_POOL_SLUG:'',POOL_PLATFORM_AUTH_URL:''}});

// season:false builds a backend that does not have the season standings read yet.
function resetDatabase({season=true}={}){
  assertLocalDatabaseHost();
  const psql=(db,args)=>execFileSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',db,...args],{stdio:'pipe'});
  psql(adminDatabase,['-c',`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
  psql(adminDatabase,['-c',`CREATE DATABASE ${database}`]);
  psql(database,['-v',`hardening=${hardening?1:0}`,'-v',`season=${season?1:0}`,'-f',path.join(here,'final-results-e2e-db-fixture.sql')]);
  // The pick-writing functions exactly as deployed on the QA branch, so that "a pick after the deadline is refused"
  // is answered here by the same code that answers it there.
  psql(database,['-f',path.join(here,'../fixtures/deployed/qa-submission-paths-20261112.sql')]);
}
async function sql(text,vars={}){
  const result=await runPsql(text,{vars,database});
  assert.equal(result.code,0,result.stderr);
  return result.stdout;
}
const rows=async(text,vars)=>JSON.parse(await sql(`SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb)::text FROM (${text}) q`,vars));
const revisions=weekId=>rows(`SELECT r.revision,r.results,r.source_sha256,r.attested_by_auth_user_id AS by,r.correction_reason,
  e.source_reference FROM public.pool_platform_week_result_revisions r
  LEFT JOIN public.pool_platform_week_result_evidence e USING (week_id,revision)
  WHERE r.week_id=:'w' ORDER BY r.revision`,{w:weekId});
// Everything attestation must never touch, as one fingerprint.
const untouched=()=>sql(`SELECT md5(string_agg(x,'|' ORDER BY x)) FROM (
  SELECT 'sub:'||md5(s::text) AS x FROM public.pool_platform_submissions s
  UNION ALL SELECT 'week:'||md5(w::text) FROM public.pool_platform_weeks w
  UNION ALL SELECT 'entry:'||md5(e::text) FROM public.pool_platform_entries e
  UNION ALL SELECT 'member:'||md5(m::text) FROM public.pool_platform_memberships m) t`);
// Seeds a revision exactly as a signed-in subject would write it: role authenticated, through the evidence RPC.
async function attestAs(subject,weekId,expected,results,reason=null){
  return JSON.parse(await sql(`BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('test.uid', :'uid', true) AS uid \\gset e2e_
SELECT public.pool_platform_attest_week_final_results_with_source(:'w'::uuid, :'rev'::integer, :'results'::jsonb,
  repeat('a',64), 'Seeded by the e2e runner as an authorized commissioner', nullif(:'reason',''))::text;
COMMIT;`,{uid:subject,w:weekId,rev:String(expected),results:JSON.stringify(results),reason:reason??''}));
}

resetDatabase();
const server=await startE2eServer({dir:path.join(work,'dist'),port,database,
  key:fs.readFileSync(path.join(work,'key.pem')),cert:fs.readFileSync(path.join(work,'cert.pem'))});
if(evidenceDir)fs.mkdirSync(evidenceDir,{recursive:true});
test.after(async()=>{await server.close();fs.rmSync(work,{recursive:true,force:true})});

// ---- page helpers --------------------------------------------------------------------------------------------
const TIMEOUT=8000;
async function signIn(page,email,pagePath='/commissioner.html'){
  await page.goto(`${origin}${pagePath}`);
  await page.locator('#email').fill(email);
  await page.locator('#sendCode').click();
  await page.locator('#otp').fill(E2E_OTP);
  await page.locator('#verifyCode').click();
  await page.locator('#signOut').waitFor({state:'visible'});
}
const openWeek=(page,weekId,pool=ALPHA)=>panel.openWeek(page,weekId,pool);
const {openPanel,fillScores,reviewAndRecord,scoreInput,press,quiet}=panel;
const shown=(page,id,pattern)=>panel.shown(page,id,pattern,TIMEOUT);
const rpc=(page,name,args,options)=>panel.rpc(page,DATA_API_PATH,name,args,options);
const attestArgs=(weekId,expected,results,reason=null)=>({p_week_id:weekId,p_expected_revision:expected,p_results:results,
  p_source_sha256:'b'.repeat(64),p_source_reference:'Direct call made by the e2e runner',p_correction_reason:reason});
const fingerprint=(reference,results)=>crypto.createHash('sha256').update(JSON.stringify({reference,results})).digest('hex');

// ---- standings ---------------------------------------------------------------------------------------------
// Turns the Pick'em fixture into a season with three consecutive played weeks (9, 10, 11): week 10's deadline and
// kickoffs move into the past, and Alice and Bob get picks for weeks 10 and 11. Week 12 stays unplayable.
const playedSeason=()=>sql(`UPDATE public.pool_platform_weeks SET deadline_at=now()-interval '60 hours',
  config=jsonb_set(config,'{games}',(SELECT jsonb_agg(jsonb_set(g,'{kickoff}',
    to_jsonb(to_char((now()-interval '50 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000Z"'))) ORDER BY n)
    FROM jsonb_array_elements(config->'games') WITH ORDINALITY AS t(g,n)))
  WHERE id='${week.w10}';
INSERT INTO public.pool_platform_submissions(week_id,entry_id,source,submitted_by_auth_user_id,payload) VALUES
 ('${week.w10}','e0000000-0000-4000-8000-000000000001','participant','alice','{"picks":{"2026_10_BUF_MIA":"away","2026_10_DAL_NYG":"home"}}'),
 ('${week.w10}','e0000000-0000-4000-8000-000000000002','participant','bob','{"picks":{"2026_10_BUF_MIA":"home","2026_10_DAL_NYG":"home"}}'),
 ('${week.w11}','e0000000-0000-4000-8000-000000000001','participant','alice','{"picks":{"2026_11_DEN_CAR":"away","2026_11_DET_CHI":"away"}}'),
 ('${week.w11}','e0000000-0000-4000-8000-000000000002','participant','bob','{"picks":{"2026_11_DEN_CAR":"home","2026_11_DET_CHI":"away"}}');`);
const FINALS={
  w9:{'2026_09_JAX_BAL':final(20,17),'2026_09_CIN_ATL':final(10,13)},
  w9corrected:{'2026_09_JAX_BAL':final(20,27),'2026_09_CIN_ATL':final(10,13)},
  w10:{'2026_10_BUF_MIA':final(24,20),'2026_10_DAL_NYG':final(14,14)},
  w11:{'2026_11_DEN_CAR':final(7,10),'2026_11_DET_CHI':final(31,3)}
};
const cardRows=(page,card)=>page.locator(`#${card} .standings-row`).evaluateAll(items=>items.map(item=>[...item.children].map(c=>c.textContent)));
const cardStatus=(page,card,attribute,pattern)=>page.locator(`#${card} [${attribute}]`).filter({hasText:pattern}).waitFor({state:'visible',timeout:TIMEOUT});
const weekCard=(page,pattern)=>cardStatus(page,'poolStandingsCard','data-standings-status',pattern);
const seasonCard=(page,pattern)=>cardStatus(page,'seasonStandingsCard','data-season-status',pattern);
const seasonWeeks=(page,pattern)=>cardStatus(page,'seasonStandingsCard','data-season-weeks',pattern);

for(const engine of engines){
  let browser;
  const problems=[];
  // A fresh database and a fresh, isolated browser context for every check.
  const check=(name,body,{viewport={width:1280,height:900},season=true}={})=>test(`[${engine}] ${name}`,async()=>{
    resetDatabase({season});
    browser??=await playwright[engine].launch(launchOptions(engine));
    const contexts=[];
    const watch=page=>{
      page.setDefaultTimeout(TIMEOUT);
      page.on('pageerror',error=>problems.push(`${name}: uncaught ${error.message}`));
      page.on('console',message=>{
        if(message.type()==='error'&&/content security policy|refused to/i.test(message.text()))problems.push(`${name}: ${message.text()}`);
      });
      return page;
    };
    // open(): a new, isolated browser context (another person). tab(page): another tab of the same session.
    const open=async(size=viewport)=>{
      const context=await browser.newContext({viewport:size,ignoreHTTPSErrors:true,serviceWorkers:'block'});
      await context.addInitScript(panel.countRequests);
      contexts.push(context);
      return watch(await context.newPage());
    };
    const tab=async page=>watch(await page.context().newPage());
    try{await body({open,tab,page:await open()})}
    finally{await Promise.all(contexts.map(context=>context.close()))}
  });
  test.after(async()=>{await browser?.close()});

  check('a commissioner issues a link and only the intended verified participant can claim it',async({page,open})=>{
    execFileSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',database,'-f',path.join(here,'email-invitation-fixture.sql')],{stdio:'pipe'});
    const entry='e0000000-0000-4000-8000-000000000003';
    await signIn(page,'commish.alpha@e2e.invalid','/commissioner.html?pool=e2e-alpha-pickem');
    await page.locator('#inviteEntry').selectOption(entry);
    await page.locator('#inviteEmail').fill('alice@e2e.invalid');
    await page.locator('#createInvite').click();
    await page.locator('#inviteLink').waitFor({state:'visible'});
    const link=await page.locator('#inviteLink').inputValue();
    const route='/join/e2e-alpha-pickem/'+entry;
    assert.equal(link,origin+route);
    const other=await open();
    await signIn(other,'outsider@e2e.invalid',route);
    await other.locator('#sessionError').filter({hasText:/invitation.*(expired|available)/i}).waitFor();
    assert.equal(await sql("SELECT count(*) FROM public.pool_platform_entries WHERE id=:'entry' AND owner_auth_user_id IS NULL",{entry}),'1');
    const recipient=await open();
    await signIn(recipient,'alice@e2e.invalid',route);
    await recipient.waitForFunction(id=>document.getElementById('entrySelect')?.value===id,entry);
    assert.ok(!recipient.url().includes(entry));
    assert.equal(await sql("SELECT count(*) FROM public.pool_platform_entries WHERE id=:'entry' AND owner_auth_user_id='alice'",{entry}),'1');
    assert.equal(await sql("SELECT count(*) FROM public.pool_platform_email_invite_grants WHERE entry_id=:'entry' AND claimed_by_auth_user_id='alice' AND claimed_at IS NOT NULL",{entry}),'1');
  });

  check('commissioner records an initial attestation: confirmation visible, evidence stored, picks untouched',async({page})=>{
    const before=await untouched();
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w9);
    await page.locator('#finalResultAdmin').waitFor({state:'visible'});
    assert.equal(await page.locator('#finalResultDetails').evaluate(el=>el.open),false,'the panel starts collapsed');
    await openPanel(page);
    await shown(page,'finalResultStatus',/No previous result attestation/);
    assert.equal(await page.locator('#finalResultCorrectionWrap').isVisible(),false);
    await fillScores(page,{[games.w9[0]]:[21,14],[games.w9[1]]:[17,17]});
    // Two references on two lines, as the placeholder ("URL(s)") invites.
    await page.locator('#finalResultSource').fill('https://example.invalid/gamebook/jax-bal\n  https://example.invalid/gamebook/cin-atl');
    await press(page,'#finalResultPreview');
    await page.locator('#finalResultReview').waitFor({state:'visible'});
    await shown(page,'finalResultSummary',/JAX at BAL: 21–14 · CIN at ATL: 17–17\. Record the initial commissioner attestation/);
    await press(page,'#finalResultConfirm');
    await shown(page,'finalResultError',/independently checked every game/);
    assert.deepEqual(await revisions(week.w9),[],'nothing is written before the confirmation box is ticked');
    await quiet(page);await page.locator('#finalResultConfirmCheck').check();
    await press(page,'#finalResultConfirm');
    await shown(page,'finalResultSuccess',/revision 1 recorded/);
    await shown(page,'finalResultStatus',/Existing commissioner attestation · revision 1/);
    const reference='https://example.invalid/gamebook/jax-bal https://example.invalid/gamebook/cin-atl';
    const results={[games.w9[0]]:final(21,14),[games.w9[1]]:final(17,17)};
    assert.deepEqual(await revisions(week.w9),[{revision:1,results,source_sha256:fingerprint(reference,results),
      by:'commish_alpha',correction_reason:null,source_reference:reference}]);
    assert.equal(await untouched(),before,'picks, weeks, entries and memberships are byte-identical');
  });

  check('correction: prefilled, needs a reason, refuses a no-op, appends revision 2 and keeps revision 1',async({page})=>{
    await attestAs('commish_alpha',week.w9,0,{[games.w9[0]]:final(21,14),[games.w9[1]]:final(17,17)});
    const [first]=await revisions(week.w9);
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w9);
    await openPanel(page);
    await shown(page,'finalResultStatus',/revision 1/);
    assert.equal(await scoreInput(page,games.w9[0],'away').inputValue(),'21');
    assert.equal(await scoreInput(page,games.w9[1],'home').inputValue(),'17');
    await page.locator('#finalResultCorrectionWrap').waitFor({state:'visible'});
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await page.locator('#finalResultCorrection').fill('Home and away were transposed');
    await press(page,'#finalResultPreview');
    await shown(page,'finalResultError',/match the current revision/);
    await scoreInput(page,games.w9[0],'away').fill('14');
    await scoreInput(page,games.w9[0],'home').fill('21');
    await page.locator('#finalResultCorrection').fill('short');
    await press(page,'#finalResultPreview');
    await shown(page,'finalResultError',/Explain the correction/);
    await page.locator('#finalResultCorrection').fill('Home and away were transposed');
    await reviewAndRecord(page);
    await shown(page,'finalResultSuccess',/revision 2 recorded/);
    const stored=await revisions(week.w9);
    assert.equal(stored.length,2);
    assert.deepEqual(stored[0],first,'revision 1 is unchanged');
    assert.deepEqual(stored[1].results,{[games.w9[0]]:final(14,21),[games.w9[1]]:final(17,17)});
    assert.equal(stored[1].correction_reason,'Home and away were transposed');
    assert.equal(stored[1].source_reference,EVIDENCE);
  });

  check('stale revision: the second commissioner is told, sees the newer scores, and nothing is overwritten',async({page,open})=>{
    const other=await open();
    await signIn(page,'commish.alpha@e2e.invalid');
    await signIn(other,'cocommish.alpha@e2e.invalid');
    for(const tab of [page,other]){await openWeek(tab,week.w9);await openPanel(tab);await shown(tab,'finalResultStatus',/No previous/)}
    await fillScores(page,{[games.w9[0]]:[21,14],[games.w9[1]]:[17,17]});
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await reviewAndRecord(page);
    await shown(page,'finalResultSuccess',/revision 1 recorded/);
    // The co-commissioner still holds revision 0 and now submits different scores.
    await fillScores(other,{[games.w9[0]]:[3,0],[games.w9[1]]:[10,7]});
    await other.locator('#finalResultSource').fill(EVIDENCE);
    await reviewAndRecord(other);
    await shown(other,'finalResultError',/recorded by someone else/);
    const stored=await revisions(week.w9);
    assert.equal(stored.length,1,'the stale write stored nothing');
    assert.equal(stored[0].by,'commish_alpha');
    // Without reloading the page, the form now holds the stored revision and asks for a correction reason.
    await shown(other,'finalResultStatus',/revision 1/);
    assert.equal(await scoreInput(other,games.w9[0],'away').inputValue(),'21');
    await other.locator('#finalResultCorrectionWrap').waitFor({state:'visible'});
    // The standings above the panel are replayed from the stored record as well: they show the revision the other
    // commissioner recorded, not what this page had loaded before it.
    await weekCard(other,/Final scores recorded by your commissioner · revision 1/);
    await fillScores(other,{[games.w9[0]]:[24,14]});
    await other.locator('#finalResultSource').fill(EVIDENCE);
    await other.locator('#finalResultCorrection').fill('Late field goal was missing');
    await reviewAndRecord(other);
    await shown(other,'finalResultSuccess',/revision 2 recorded/);
    const after=await revisions(week.w9);
    assert.deepEqual(after.map(r=>[r.revision,r.by]),[[1,'commish_alpha'],[2,'cocommish_alpha']]);
  });

  check('week eligibility: hidden before the deadline, available for an open week once the deadline has passed',async({page})=>{
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w10);
    await page.locator('#weekStatus').filter({hasText:'Week 10'}).waitFor();
    assert.equal(await page.locator('#finalResultAdmin').isVisible(),false,'no panel before the pick deadline');
    assert.equal((await rpc(page,'pool_platform_attest_week_final_results_with_source',
      attestArgs(week.w10,0,{'2026_10_BUF_MIA':final(1,0),'2026_10_DAL_NYG':final(1,0)}))).message,
      'week_not_eligible_for_final_attestation');
    await openWeek(page,week.w11);
    await openPanel(page);
    await fillScores(page,{[games.w11[0]]:[30,27],[games.w11[1]]:[6,9]});
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await reviewAndRecord(page);
    await shown(page,'finalResultSuccess',/revision 1 recorded/);
    assert.equal((await revisions(week.w11)).length,1);
    assert.equal(await sql(`SELECT status FROM public.pool_platform_weeks WHERE id=:'w'`,{w:week.w11}),'open','the week row is not changed');
    assert.deepEqual(await revisions(week.w10),[]);
  });

  check('a game that has not kicked off: review refuses, a forced call is refused, nothing is written',async({page})=>{
    const before=await untouched();
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w12);
    await openPanel(page);
    await fillScores(page,{[games.w12[0]]:[20,10],[games.w12[1]]:[7,3]});
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await press(page,'#finalResultPreview');
    await shown(page,'finalResultError',/not kicked off/);
    assert.equal(await page.locator('#finalResultReview').isVisible(),false);
    const forced=await rpc(page,'pool_platform_attest_week_final_results_with_source',
      attestArgs(week.w12,0,{[games.w12[0]]:final(20,10),[games.w12[1]]:final(7,3)}));
    assert.deepEqual([forced.status,forced.message],[400,'game_not_started_or_schedule_missing']);
    assert.deepEqual(await revisions(week.w12),[]);
    assert.equal(await untouched(),before,'no pick, entry, membership or schedule changed');
  });

  check('a week whose games have no kickoff time: the panel says so and offers no score to type, a forced call is refused, picks are untouched',async({page})=>{
    // The schedule as the live database stores its 2027 weeks: games without a kickoff, in a week past its deadline.
    await sql(`UPDATE public.pool_platform_weeks SET config=jsonb_set(config,'{games}',
      (SELECT jsonb_agg(g-'kickoff' ORDER BY n) FROM jsonb_array_elements(config->'games') WITH ORDINALITY AS t(g,n))) WHERE id=:'w'`,{w:week.w9});
    const before=await untouched();
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w9);
    // openPanel() waits for the score form, which this week must not show: the heading is opened by hand.
    await page.locator('#finalResultAdmin').waitFor({state:'visible'});
    await press(page,'#finalResultHeading');
    await page.locator('#finalResultStatus').filter({hasText:/^Final scores cannot be recorded for this week: 2 of 2 games have no kickoff time\. Its schedule must be verified first\. Picks already made are kept exactly as they are\.$/}).waitFor({state:'visible'});
    assert.equal(await page.locator('#finalResultForm').isVisible(),false,'no score can be typed');
    assert.equal(await page.locator('#finalResultGames input').count(),0);
    assert.equal(await page.locator('#finalResultPreview').isDisabled(),true);
    const forced=await rpc(page,'pool_platform_attest_week_final_results_with_source',
      attestArgs(week.w9,0,{[games.w9[0]]:final(20,10),[games.w9[1]]:final(7,3)}));
    assert.deepEqual([forced.status,forced.message],[400,'game_not_started_or_schedule_missing']);
    assert.deepEqual(await revisions(week.w9),[]);
    assert.equal(await untouched(),before,'no pick, entry or membership changed');
    // Another week of the same pool, with its kickoffs, is not affected.
    await openWeek(page,week.w11);
    await openPanel(page);
    await scoreInput(page,games.w11[0],'away').waitFor({state:'visible'});
  });

  check('one date-only kickoff in an otherwise valid slate blocks the whole score form and the RPC',async({page})=>{
    await sql(`UPDATE public.pool_platform_weeks SET config=jsonb_set(config,'{games,1,kickoff}',
      to_jsonb(left(config#>>'{games,1,kickoff}',10))) WHERE id=:'w'`,{w:week.w9});
    const before=await untouched();
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w9);
    await page.locator('#finalResultAdmin').waitFor({state:'visible'});
    await press(page,'#finalResultHeading');
    await shown(page,'finalResultStatus',/1 of 2 games have no kickoff time/);
    assert.equal(await page.locator('#finalResultForm').isVisible(),false);
    assert.equal(await page.locator('#finalResultGames input').count(),0);
    assert.equal(await page.locator('#finalResultPreview').isDisabled(),true);
    const forced=await rpc(page,'pool_platform_attest_week_final_results_with_source',attestArgs(week.w9,0,FINALS.w9));
    assert.deepEqual([forced.status,forced.message],[400,'invalid_verified_schedule']);
    assert.deepEqual(await revisions(week.w9),[]);
    assert.equal(await untouched(),before,'no pick, entry, membership or schedule changed');
  });

  check('participant-only account: no commissioner access, cannot write, reads only its own pool after the deadline',async({page})=>{
    await attestAs('commish_alpha',week.w9,0,{[games.w9[0]]:final(21,14),[games.w9[1]]:final(17,17)});
    const before=await revisions(week.w9);
    await signIn(page,'alice@e2e.invalid');
    await shown(page,'poolPickerError',/No pools are assigned to this account/);
    assert.equal(await page.locator('#finalResultAdmin').isVisible(),false);
    await page.goto(`${origin}/commissioner.html?pool=e2e-alpha-pickem`);
    await page.locator('#poolPickerCard').waitFor({state:'visible'});
    assert.equal(await page.locator('#consoleCard').isVisible(),false,'a known pool link opens nothing for a participant');
    assert.equal(await page.locator('#finalResultAdmin').isVisible(),false);
    const results={[games.w9[0]]:final(0,99),[games.w9[1]]:final(0,99)};
    const write=await rpc(page,'pool_platform_attest_week_final_results_with_source',attestArgs(week.w9,1,results,'Participant attempted a correction'));
    assert.deepEqual([write.status,write.message],[400,'week_not_found']);
    const missing=await rpc(page,'pool_platform_attest_week_final_results_with_source',
      attestArgs('00000000-0000-4000-8000-000000000000',1,results,'Participant attempted a correction'));
    assert.deepEqual([missing.status,missing.message],[write.status,write.message],'a forbidden week is indistinguishable from a missing one');
    const legacy=await rpc(page,'pool_platform_attest_week_final_results',{p_week_id:week.w9,p_expected_revision:1,
      p_results:results,p_source_sha256:'b'.repeat(64),p_correction_reason:'Participant used the retired RPC'});
    assert.deepEqual([legacy.status,legacy.code],[403,'42501'],'the retired RPC is not executable by a signed-in role');
    assert.equal((await rpc(page,'pool_platform_commissioner_context',{p_pool_slug:'e2e-alpha-pickem'})).message,'commissioner_required');
    const own=await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:week.w9});
    assert.equal(own.status,200);
    assert.deepEqual(Object.keys(own.body).sort(),['results','revision','status','week_id'],'no attester, digest or evidence in the read model');
    assert.equal(own.body.status,'commissioner_attested_not_official');
    assert.deepEqual(own.body.results,before[0].results);
    assert.equal((await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:week.w10})).body.status,'sealed');
    assert.equal((await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:week.beta9})).message,'week_not_found');
    assert.deepEqual(await revisions(week.w9),before,'the participant changed nothing');
  });

  // ---- a page left open while the sign-in changes in another tab ------------------------------------------------
  // The page has three ways to find out (platform-client.js): the other tab tells it, it asks when it is looked at
  // again, and it asks before it writes. To show each one on its own, a tab can be denied the first two: with no
  // BroadcastChannel no other tab can tell it, and while it reports itself hidden it does not ask on its own.
  const untold=page=>page.addInitScript(()=>{
    delete globalThis.BroadcastChannel;
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>globalThis.__e2eNotLooking?'hidden':'visible'});
  });
  const notLooking=page=>page.evaluate(()=>{globalThis.__e2eNotLooking=true});
  const lookAgain=page=>page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'))});
  const rpcsOf=page=>{
    const sent=[];
    page.on('request',request=>{const at=request.url().indexOf('/rpc/');if(at>=0)sent.push(request.url().slice(at+5))});
    return sent;
  };
  // Signs in on the sign-in card a page is already showing, without loading the page again.
  const enterCode=async(page,email)=>{
    await page.locator('#email').fill(email);
    await page.locator('#sendCode').click();
    await page.locator('#otp').fill(E2E_OTP);
    await page.locator('#verifyCode').click();
    await page.locator('#signOut').waitFor({state:'visible'});
  };
  const signOutIn=async page=>{
    await page.locator('#signOut').click();
    await page.locator('#authCard').waitFor({state:'visible'});
  };

  check('participant: once the sign-in changes in another tab, no pick is sent for the account that left and the page starts again as whoever is signed in',async({page,tab})=>{
    // Week 10 is the week still open for picks; week 11 is taken out of the way so the participant page shows it.
    await sql(`UPDATE public.pool_platform_weeks SET status='locked' WHERE id=:'w'`,{w:week.w11});
    const alice='e0000000-0000-4000-8000-000000000001';
    const picks=()=>rows(`SELECT submitted_by_auth_user_id AS by,revision FROM public.pool_platform_submissions WHERE week_id=:'w' AND entry_id=:'e'`,{w:week.w10,e:alice});
    const choose=async()=>{for(const id of ['game-0-away','game-1-home'])await page.locator(`label[for="${id}"]`).click()};
    const previousAccountGone=async target=>{
      for(const id of ['entryCard','pickForm','submittedCard'])assert.equal(await target.locator(`#${id}`).isVisible(),false,`${id} of the previous account is gone`);
      assert.equal(await target.locator('#games input').count(),0,'no pick of the previous account is left in the page');
      assert.equal(new URL(target.url()).search+new URL(target.url()).hash,'','nothing of the previous account, and no mark, is left in the address');
    };
    await untold(page);
    await signIn(page,'alice@e2e.invalid','/participant.html');
    await page.locator('#pickForm').waitFor({state:'visible'});
    assert.deepEqual([await page.locator('#poolName').textContent(),await page.locator('#weekLabel').textContent()],[ALPHA,'Week 10']);
    assert.equal(await page.evaluate(()=>typeof BroadcastChannel),'undefined');
    const sent=rpcsOf(page);

    // 1. Before it writes. In another tab of the same browser Alice signs out and someone else signs in. The first
    //    tab is not told and does not look: it still shows Alice's entry, and a pick is chosen and submitted in it.
    await notLooking(page);
    const other=await tab(page);
    await other.goto(`${origin}/participant.html`);
    await signOutIn(other);
    await enterCode(other,'outsider@e2e.invalid');
    await other.locator('#emptyCard').waitFor({state:'visible'});
    assert.equal(await page.locator('#pickForm').isVisible(),true,'the first tab has not found out');
    await choose();
    await page.locator('#submitBtn').click();
    await page.locator('#sessionError').filter({hasText:SIGN_IN_CHANGED}).waitFor({state:'visible'});
    await page.locator('#emptyCard').filter({hasText:/No active pool entries are linked to this account/}).waitFor({state:'visible'});
    await previousAccountGone(page);
    assert.ok(!sent.includes('pool_platform_submit_entry'),'the pick was not sent, under either account');
    assert.deepEqual(await picks(),[]);

    // 2. When it is looked at again. The other tab signs out; the first tab is still not told, and nothing is
    //    clicked in it.
    await signOutIn(other);
    assert.equal(await page.locator('#signOut').isVisible(),true,'the first tab has not found out');
    await lookAgain(page);
    await page.locator('#authError').filter({hasText:SIGNED_OUT_ELSEWHERE}).waitFor({state:'visible'});
    assert.equal(await page.locator('#authCard').isVisible(),true);
    assert.equal(await page.locator('#emptyCard').isVisible(),false);
    assert.equal(await page.locator('#signOut').isVisible(),false);

    // 3. The ordinary case is untouched: the account the page shows is the one signed in, the page is looked at
    //    again, and its pick is saved under that account.
    await enterCode(page,'alice@e2e.invalid');
    await page.locator('#pickForm').waitFor({state:'visible'});
    assert.equal(await page.locator('#authError').isVisible(),false);
    await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))});
    await quiet(page);
    assert.equal(await page.locator('#pickForm').isVisible(),true);
    assert.equal(await page.locator('#sessionError').isVisible(),false);
    await choose();
    await page.locator('#submitBtn').click();
    await page.locator('#submittedCard').waitFor({state:'visible'});
    assert.deepEqual(await picks(),[{by:'alice',revision:1}]);

    // 4. Told by the other tab. A third tab, with nothing taken away from it, shows Alice's entry. In the second
    //    tab, still on its sign-in card, someone else signs in. The third tab is neither clicked nor looked at and
    //    starts again at once; the first, which cannot be told, has not found out.
    const third=await tab(page);
    await third.goto(`${origin}/participant.html`);
    await third.locator('#pickForm').waitFor({state:'visible'});
    await enterCode(other,'outsider@e2e.invalid');
    await third.locator('#sessionError').filter({hasText:SIGN_IN_CHANGED}).waitFor({state:'visible'});
    await third.locator('#emptyCard').waitFor({state:'visible'});
    await previousAccountGone(third);
    assert.equal(await page.locator('#entryCard').isVisible(),true,'the tab that cannot be told has not found out');
    // And told again when that account signs out.
    await signOutIn(other);
    await third.locator('#authError').filter({hasText:SIGNED_OUT_ELSEWHERE}).waitFor({state:'visible'});
    assert.equal(await third.locator('#emptyCard').isVisible(),false);

    // 5. The first tab still shows Alice's saved pick and nobody is signed in any more. Changing the pick there
    //    sends nothing: the page asks first, and starts again at its sign-in card.
    await page.locator('label[for="game-0-home"]').click();
    await page.locator('#submitBtn').click();
    await page.locator('#authError').filter({hasText:SIGNED_OUT_ELSEWHERE}).waitFor({state:'visible'});
    await previousAccountGone(page);
    assert.equal(sent.filter(name=>name==='pool_platform_submit_entry').length,1,'only the pick of step 3 was ever sent');
    assert.deepEqual(await picks(),[{by:'alice',revision:1}]);
  });

  check('participant: a rejected pick is not retried after signing out in another tab',async({page,tab})=>{
    await sql(`UPDATE public.pool_platform_weeks SET status='locked' WHERE id=:'w'`,{w:week.w11});
    const picks=()=>rows(`SELECT entry_id,revision,payload FROM public.pool_platform_submissions WHERE week_id=:'w'`,{w:week.w10});
    const before=await picks();
    await untold(page);
    await signIn(page,'alice@e2e.invalid','/participant.html');
    await page.locator('#pickForm').waitFor({state:'visible'});
    await notLooking(page);
    const other=await tab(page);
    await other.goto(`${origin}/participant.html`);
    await other.locator('#signOut').waitFor({state:'visible'});

    let attempts=0;
    await page.route('**/rpc/pool_platform_submit_entry',async route=>{
      if(++attempts===1){
        await signOutIn(other);
        await route.fulfill({status:400,json:{code:'P0001',message:'auth_required'}});
      }else await route.continue();
    });
    for(const id of ['game-0-away','game-1-home'])await page.locator(`label[for="${id}"]`).click();
    await page.locator('#submitBtn').click();
    await page.locator('#authError').filter({hasText:SIGNED_OUT_ELSEWHERE}).waitFor({state:'visible'});
    assert.equal(attempts,1,'the first request was refused and no retry was sent');
    assert.deepEqual(await picks(),before);
  });

  check('commissioner: once the sign-in changes in another tab, nothing is written for the account that left and the page starts again',async({page,tab})=>{
    execFileSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-d',database,'-f',path.join(here,'email-invitation-fixture.sql')],{stdio:'pipe'});
    const entry='e0000000-0000-4000-8000-000000000003';
    const invitations=()=>sql('SELECT count(*) FROM public.pool_platform_email_invite_grants');
    const invite=async()=>{
      await page.locator('#inviteEntry').selectOption(entry);
      await page.locator('#inviteEmail').fill('alice@e2e.invalid');
      await page.locator('#createInvite').click();
    };
    await untold(page);
    await signIn(page,'commish.alpha@e2e.invalid','/commissioner.html?pool=e2e-alpha-pickem');
    await page.locator('#inviteCard').waitFor({state:'visible'});
    const sent=rpcsOf(page);

    // The commissioner signs out in another tab and a participant signs in there. The first tab is not told and
    // does not look; it still shows the pool, and an invitation is issued from it.
    await notLooking(page);
    const other=await tab(page);
    await other.goto(`${origin}/commissioner.html`);
    await signOutIn(other);
    await signIn(other,'alice@e2e.invalid','/participant.html');
    assert.equal(await page.locator('#inviteCard').isVisible(),true,'the first tab has not found out');
    await invite();
    await page.locator('#sessionError').filter({hasText:SIGN_IN_CHANGED}).waitFor({state:'visible'});
    await page.locator('#poolPickerError').filter({hasText:/No pools are assigned to this account/}).waitFor({state:'visible'});
    for(const id of ['consoleCard','entriesCard','inviteCard','importCard','finalResultAdmin'])
      assert.equal(await page.locator(`#${id}`).isVisible(),false,`${id} of the previous account is gone`);
    assert.equal(await page.locator('#entriesBody tr').count(),0,'no entry of the previous account is left in the page');
    assert.equal(new URL(page.url()).search+new URL(page.url()).hash,'','the pool of the previous account, and the mark, are out of the address');
    assert.ok(!sent.includes('pool_platform_create_email_invite'),'the invitation was not sent, under either account');
    assert.equal(await invitations(),'0');

    // Signed out in the other tab: found when the first tab is looked at again.
    await signOutIn(other);
    await lookAgain(page);
    await page.locator('#authError').filter({hasText:SIGNED_OUT_ELSEWHERE}).waitFor({state:'visible'});
    assert.equal(await page.locator('#poolPickerCard').isVisible(),false);
    assert.equal(await page.locator('#signOut').isVisible(),false);

    // The ordinary case is untouched: the commissioner signs in again here, the page is looked at, and the
    // invitation is issued.
    await signIn(page,'commish.alpha@e2e.invalid','/commissioner.html?pool=e2e-alpha-pickem');
    await page.locator('#inviteCard').waitFor({state:'visible'});
    await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))});
    await quiet(page);
    await invite();
    await page.locator('#inviteLink').waitFor({state:'visible'});
    assert.equal(await page.locator('#sessionError').isVisible(),false);
    assert.equal(await invitations(),'1');
    assert.equal(sent.filter(name=>name==='pool_platform_create_email_invite').length,1);
  });

  check('browser storage: nothing of a session is kept in it at sign-in, when the token is renewed or at sign-out, and what an earlier version left is removed',async({page})=>{
    await sql(`UPDATE public.pool_platform_weeks SET status='locked' WHERE id=:'w'`,{w:week.w11});
    const stored=()=>page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));
    const EMPTY='{"local":{},"session":{}}';
    const sessionReads=[];
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/auth/get-session')sessionReads.push(request.method())});
    await signIn(page,'alice@e2e.invalid','/participant.html');
    await page.locator('#pickForm').waitFor({state:'visible'});
    assert.equal(await stored(),EMPTY,'after sign-in');

    // Sixteen minutes on, the token the SDK remembers has expired. The read that follows the next pick makes the SDK
    // fetch the session again, which is when the SDK as shipped wrote the token, the address and the name to
    // localStorage, as its notice to other tabs.
    await page.clock.install();
    await page.clock.fastForward(16*60*1000);
    const before=sessionReads.length;
    for(const id of ['game-0-away','game-1-home'])await page.locator(`label[for="${id}"]`).click();
    await page.locator('#submitBtn').click();
    await page.locator('#submittedCard').waitFor({state:'visible'});
    assert.ok(sessionReads.length-before>=2,`the pick asked the server whose sign-in this is, and the SDK then fetched the session again (${sessionReads.length-before} reads)`);
    assert.equal(await stored(),EMPTY,'after the token was renewed');
    await page.locator('#signOut').click();
    await page.locator('#authCard').waitFor({state:'visible'});
    assert.equal(await stored(),EMPTY,'after sign-out');

    // A browser that used the page before this change may still hold the SDK's last notice. The page removes it the
    // next time it loads, and touches nothing else that is stored.
    await page.evaluate(()=>{
      localStorage.setItem('better-auth.message',JSON.stringify({event:'session',data:{trigger:'TOKEN_REFRESHED',sessionData:{session:{token:'left.behind.token'},user:{email:'left@behind.invalid'}}}}));
      localStorage.setItem('not-the-sdk','kept');
    });
    await page.reload();
    await page.locator('#authCard').waitFor({state:'visible'});
    assert.equal(await stored(),'{"local":{"not-the-sdk":"kept"},"session":{}}','what an earlier version left is gone, and only that');
  });

  check('tenant isolation: another tenant’s commissioner can neither open, read nor write this pool',async({page})=>{
    await attestAs('commish_alpha',week.w9,0,{[games.w9[0]]:final(21,14),[games.w9[1]]:final(17,17)});
    const before=await revisions(week.w9);
    await signIn(page,'commish.beta@e2e.invalid');
    await page.locator('#poolName').filter({hasText:BETA}).waitFor({state:'visible'});
    await page.goto(`${origin}/commissioner.html?pool=e2e-alpha-pickem`);
    await page.locator('#poolName').filter({hasText:BETA}).waitFor({state:'visible'});
    assert.equal(await page.getByText(ALPHA).count(),0,'the foreign pool is never named');
    const results={[games.w9[0]]:final(0,99),[games.w9[1]]:final(0,99)};
    const write=await rpc(page,'pool_platform_attest_week_final_results_with_source',attestArgs(week.w9,1,results,'Foreign commissioner correction'));
    assert.deepEqual([write.status,write.message],[400,'week_not_found']);
    assert.equal((await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:week.w9})).message,'week_not_found');
    assert.equal((await rpc(page,'pool_platform_week_projection_snapshot',{p_week_id:week.w9})).message,'week_not_found');
    assert.deepEqual(await revisions(week.w9),before);
    // Positive control: the same account records results for its own pool through the panel.
    await openWeek(page,week.beta9,BETA);
    await openPanel(page);
    await fillScores(page,{[games.beta9[0]]:[13,10],[games.beta9[1]]:[28,3]});
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await reviewAndRecord(page);
    await shown(page,'finalResultSuccess',/revision 1 recorded/);
    assert.equal((await revisions(week.beta9))[0].by,'commish_beta');
    assert.deepEqual(await revisions(week.w9),before);
  });

  check('a pending review is discarded when the week changes, a score is edited, or the commissioner signs out',async({page})=>{
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w9);
    await openPanel(page);
    await fillScores(page,{[games.w9[0]]:[21,14],[games.w9[1]]:[17,17]});
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await press(page,'#finalResultPreview');
    await page.locator('#finalResultReview').waitFor({state:'visible'});
    await scoreInput(page,games.w9[0],'away').fill('22');
    await page.locator('#finalResultReview').waitFor({state:'hidden'});
    await press(page,'#finalResultPreview');
    await page.locator('#finalResultReview').waitFor({state:'visible'});
    await openWeek(page,week.w11);
    await page.locator('#weekStatus').filter({hasText:'Week 11'}).waitFor();
    await openWeek(page,week.w9);
    await openPanel(page);
    assert.equal(await page.locator('#finalResultReview').isVisible(),false);
    assert.equal(await scoreInput(page,games.w9[0],'away').inputValue(),'','the abandoned entry is not carried over');
    await fillScores(page,{[games.w9[0]]:[21,14],[games.w9[1]]:[17,17]});
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await press(page,'#finalResultPreview');
    await page.locator('#finalResultReview').waitFor({state:'visible'});
    await signOutIn(page);
    assert.equal(await page.locator('#finalResultAdmin').isVisible(),false);
    assert.equal(await page.locator('#finalResultGames input').count(),0);
    assert.equal(await page.locator('#finalResultSource').inputValue(),'');
    assert.equal(await page.locator('#finalResultSummary').textContent(),'');
    assert.deepEqual(await revisions(week.w9),[]);
    assert.deepEqual(await revisions(week.w11),[]);
  });

  check('a console re-render for the same week leaves the open panel, the typed scores and a pending review alone',async({page})=>{
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w9);
    await openPanel(page);
    await fillScores(page,{[games.w9[0]]:[21,14],[games.w9[1]]:[17,10]});
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await press(page,'#finalResultPreview');
    await page.locator('#finalResultReview').waitFor({state:'visible'});
    // What every context reload does: the console renders the same week again. The handler runs synchronously.
    for(let i=0;i<3;i++)await page.locator('#weekSelect').dispatchEvent('change');
    assert.equal(await page.locator('#finalResultDetails').evaluate(el=>el.open),true,'the panel stays open');
    assert.deepEqual([await scoreInput(page,games.w9[0],'away').inputValue(),await scoreInput(page,games.w9[1],'home').inputValue(),
      await page.locator('#finalResultSource').inputValue()],['21','10',EVIDENCE],'what was typed is still there');
    assert.equal(await page.locator('#finalResultReview').isVisible(),true,'the pending review is still there');
    await quiet(page);await page.locator('#finalResultConfirmCheck').check();
    await press(page,'#finalResultConfirm');
    await shown(page,'finalResultSuccess',/revision 1 recorded/);
    assert.deepEqual((await revisions(week.w9)).map(r=>r.results),[{[games.w9[0]]:final(21,14),[games.w9[1]]:final(17,10)}]);
    // A different week still gets its own panel, collapsed and empty.
    await openWeek(page,week.w13);
    await page.locator('#finalResultAdmin').waitFor({state:'visible'});
    await page.locator('#finalResultStatus').filter({hasText:/No previous result attestation/}).waitFor({state:'attached'});
    assert.equal(await page.locator('#finalResultDetails').evaluate(el=>el.open),false);
    assert.equal(await page.locator('#finalResultGames input').first().inputValue(),'');
  });

  // Why opening the panel is checked rather than assumed (final-results-page.mjs): what a card filling in above the
  // panel does to a click, reproduced on purpose. Scroll anchoring is switched off so that every engine shows it.
  check('late content above the panel: a press and a release that straddle the move click nothing, and opening the panel is checked',async({page})=>{
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w9);
    await page.locator('#finalResultAdmin').waitFor({state:'visible'});
    await quiet(page);
    const heading=page.locator('#finalResultHeading'),isOpen=()=>page.locator('#finalResultDetails').evaluate(el=>el.open);
    await heading.scrollIntoViewIfNeeded();
    await page.evaluate(()=>{document.documentElement.style.overflowAnchor='none'});
    const before=await heading.boundingBox();
    await page.mouse.move(before.x+before.width/2,before.y+before.height/2);
    await page.mouse.down();
    await page.evaluate(()=>{
      const late=document.createElement('div');
      late.id='e2eLateContent';late.style.height='205px';
      document.getElementById('finalResultAdmin').before(late);
    });
    const after=await heading.boundingBox();
    assert.equal(Math.round(after.y-before.y),205,'the heading moved from under the pointer');
    await page.mouse.up();
    assert.equal(await isOpen(),false,'the release reached another element, so nothing was clicked');
    const said=[];
    await openPanel(page,{log:line=>said.push(line)});
    assert.equal(await isOpen(),true);
    assert.deepEqual(said,[],'with the page at rest the first click opens the panel');
  });

  check('signed out: no panel, and the result RPCs refuse a request without a token',async({page})=>{
    await page.goto(`${origin}/commissioner.html?pool=e2e-alpha-pickem`);
    await page.locator('#authCard').waitFor({state:'visible'});
    assert.equal(await page.locator('#finalResultAdmin').isVisible(),false);
    for(const [name,args] of [['pool_platform_week_result_snapshot',{p_week_id:week.w9}],
      ['pool_platform_attest_week_final_results_with_source',attestArgs(week.w9,0,{[games.w9[0]]:final(1,0),[games.w9[1]]:final(1,0)})]]){
      assert.equal((await rpc(page,name,args,{anonymous:true})).status,401,name);
    }
    await signIn(page,'commish.alpha@e2e.invalid','/commissioner.html?pool=e2e-alpha-pickem');
    await openWeek(page,week.w9);
    await page.locator('#finalResultAdmin').waitFor({state:'visible'});
    await page.locator('#signOut').click();
    await page.locator('#authCard').waitFor({state:'visible'});
    assert.equal(await page.locator('#finalResultAdmin').isVisible(),false,'signing out removes the panel');
    assert.equal((await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:week.w9})).message,'no session token');
    assert.deepEqual(await revisions(week.w9),[]);
  });

  for(const width of WIDTHS){
    check(`${width} CSS px: a full 16-game slate fits, every control is reachable, and recording works`,async({page})=>{
      await signIn(page,'commish.alpha@e2e.invalid');
      await openWeek(page,week.w13);
      await openPanel(page);
      const ids=await panel.gameIds(page);
      assert.equal(ids.length,16);
      const scores=Object.fromEntries(ids.map((id,i)=>[id,[10+i,i===3?13:3+i]]));
      await fillScores(page,scores);
      await page.locator('#finalResultSource').fill(EVIDENCE);
      await press(page,'#finalResultPreview');
      await page.locator('#finalResultReview').waitFor({state:'visible'});
      const layout=await panel.panelLayoutProblems(page,width);
      assert.deepEqual(layout.problems,[]);
      assert.equal(layout.scoreInputs,32);
      await quiet(page);await page.locator('#finalResultConfirmCheck').check();
      await press(page,'#finalResultConfirm');
      await shown(page,'finalResultSuccess',/revision 1 recorded/);
      const notice=await page.locator('#finalResultSuccess').boundingBox();
      assert.ok(notice.x>=0&&notice.x+notice.width<=width+0.5,'the confirmation fits the screen');
      assert.ok(await page.locator('#finalResultSuccess').evaluate(el=>{
        const box=el.getBoundingClientRect();return box.bottom>0&&box.top<innerHeight;
      }),'the confirmation is on screen without scrolling');
      const [stored]=await revisions(week.w13);
      assert.equal(Object.keys(stored.results).length,16);
      assert.deepEqual(stored.results[ids[3]],final(13,13),'a tie is stored as entered');
    },{viewport:{width,height:850}});
  }

  // Written to the log, not judged: what this engine does by itself when a page grows above what is on screen.
  // The checks after it hold either way.
  check('for the record: whether this engine holds the visible content in place when the page grows above it',async({page})=>{
    await page.setContent(`<!doctype html><body style="margin:0"><div style="height:1000px"></div>
      <p id="mark" style="margin:0;height:40px">mark</p><div style="height:5000px"></div></body>`);
    const seen=await page.evaluate(async()=>{
      const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      scrollTo(0,900);
      await frames();
      const before=Math.round(document.getElementById('mark').getBoundingClientRect().top);
      const late=document.createElement('div');
      late.style.height='500px';
      document.body.prepend(late);
      await frames();
      return {supported:CSS.supports('overflow-anchor','auto'),before,after:Math.round(document.getElementById('mark').getBoundingClientRect().top)};
    });
    console.log(`[${engine}] scroll anchoring: overflow-anchor is ${seen.supported?'':'not '}supported; a mark at y=${seen.before} was at y=${seen.after} after 500 px arrived above the screen`);
    assert.ok([seen.before,seen.before+500].includes(seen.after),JSON.stringify(seen));
  });

  // Recording replays the standings cards, which sit above the panel. For a pool of ordinary size the season card
  // grows by more than a screen, and a browser that does not hold the visible content in place while the page
  // grows above it carries the confirmation off screen. Checked as the engine behaves by itself, and again with
  // scroll anchoring switched off, which is how every engine behaves without it.
  for(const anchoring of [true,false]){
    check(`a 15-entry pool on a phone: the confirmation is still on screen after the standings above it were replayed${anchoring?'':', also without scroll anchoring'}`,async({page})=>{
      await sql(`INSERT INTO public.pool_platform_entries(season_id,entry_code,display_name)
        SELECT 'c0000000-0000-4000-8000-000000000001','X'||n,'SYNTHETIC Extra '||n FROM generate_series(1,12) n;
        INSERT INTO public.pool_platform_submissions(week_id,entry_id,source,submitted_by_auth_user_id,payload)
        SELECT '${week.w9}',e.id,'commissioner_manual','commish_alpha',
          '{"picks":{"${games.w9[0]}":"away","${games.w9[1]}":"home"},"tiebreak":40}'
        FROM public.pool_platform_entries e WHERE e.entry_code LIKE 'X%';`);
      if(!anchoring)await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{document.documentElement.style.overflowAnchor='none'}));
      await signIn(page,'commish.alpha@e2e.invalid');
      await openWeek(page,week.w9);
      await openPanel(page);
      await fillScores(page,{[games.w9[0]]:[21,14],[games.w9[1]]:[17,20]});
      await page.locator('#finalResultSource').fill(EVIDENCE);
      const seasonHeight=async()=>(await page.locator('#seasonStandingsCard').boundingBox()).height;
      const before=await seasonHeight();
      await reviewAndRecord(page);
      await shown(page,'finalResultSuccess',/revision 1 recorded/);
      await quiet(page);
      const grown=Math.round(await seasonHeight()-before);
      assert.ok(grown>850,`the season card grew by more than the screen above the panel (${grown} px)`);
      assert.ok(await page.locator('#finalResultSuccess').evaluate(el=>{
        const box=el.getBoundingClientRect();return box.top>=0&&box.bottom<=innerHeight;
      }),'the whole confirmation is on screen');
    },{viewport:{width:390,height:850}});
  }

  // Pictures for a person to look at, kept apart from the checks above on purpose. Playwright's screenshot adds a
  // <style> element to the page; this page's style-src 'self' refuses it, and WebKit reports that refusal on the
  // console. The checks above take no screenshot, so a refusal seen there would be the page's own doing; this
  // page is not watched for console problems.
  if(evidenceDir)test(`[${engine}] evidence only: screenshots of the 16-game panel at ${WIDTHS.join(', ')} CSS px`,async()=>{
    resetDatabase();
    browser??=await playwright[engine].launch(launchOptions(engine));
    const context=await browser.newContext({viewport:{width:WIDTHS[0],height:850},ignoreHTTPSErrors:true,serviceWorkers:'block'});
    try{
      const page=await context.newPage();
      page.setDefaultTimeout(TIMEOUT);
      await signIn(page,'commish.alpha@e2e.invalid');
      await openWeek(page,week.w13);
      await openPanel(page);
      const ids=await panel.gameIds(page);
      await fillScores(page,Object.fromEntries(ids.map((id,i)=>[id,[10+i,i===3?13:3+i]])));
      await page.locator('#finalResultSource').fill(EVIDENCE);
      await press(page,'#finalResultPreview');
      await page.locator('#finalResultReview').waitFor({state:'visible'});
      for(const width of WIDTHS){
        await page.setViewportSize({width,height:850});
        const file=path.join(evidenceDir,`${engine}-${width}px-final-score-panel.png`);
        await page.locator('#finalResultAdmin').screenshot({path:file});
        assert.ok(fs.statSync(file).size>10000,file);
      }
    }finally{await context.close()}
  });

  // The routine the owner runs by hand against the isolated QA backend (signed-in-acceptance.mjs), here with the
  // stand-in backend and automated sign-in: its checks and its bookkeeping are exercised on every push.
  for(const write of [false,true]){
    check(`the owner's signed-in acceptance routine, ${write?'recording one revision':'read-only'}`,async({page,tab})=>{
      const before=await untouched();
      const results=await runSignedInAcceptance({newPage:()=>tab(page),origin,dataApi:DATA_API_PATH,write,standings:true,timeout:TIMEOUT,
        expectedIssuer:'https://e2e-fixture.invalid',runLabel:'ci',evidenceDir:null,
        scenario:{pool:{slug:'e2e-alpha-pickem',name:ALPHA},weekId:week.w9,foreignWeekId:week.beta9,
          commissioner:{email:'commish.alpha@e2e.invalid',foreignSeason:BETA_SEASON},
          participant:{email:'alice@e2e.invalid',commissionerOfNothing:true,readableWeekId:week.w9,foreignWeekId:week.beta9,
            foreignSeason:BETA_SEASON}},
        signIn:(target,account,pagePath)=>signIn(target,account.email,pagePath),
        signOut:async target=>{await target.locator('#signOut').click();await target.locator('#authCard').waitFor({state:'visible'})}});
      assert.deepEqual(results.filter(r=>r.result!=='PASS'),[]);
      assert.ok(summarize(results).pass>=(write?32:30),`${summarize(results).pass} checks`);
      for(const expected of ['the commissioner page shows season standings computed from that input','the participant page shows the season standings',
        'an entry owner reads the same season standings input as the commissioner, nothing more or less',
        'another tenant’s season standings are not found for the commissioner','a season they have no entry in is not found for the second account',
        ...(write?['this week’s card shows the recorded finals at their latest revision']:[])])
        assert.ok(results.some(r=>r.check===expected&&r.result==='PASS'),expected);
      const stored=await revisions(week.w9);
      assert.equal(stored.length,write?1:0,'a read-only run stores nothing; a write run stores exactly one revision');
      if(write){
        assert.equal(stored[0].by,'commish_alpha');
        assert.match(stored[0].source_reference,/^Signed-in acceptance ci synthetic scores, not a real result$/);
      }
      assert.equal(await untouched(),before);
    });
  }
  check('the acceptance routine run again records a correction that turns every winner round, and its recount of the standings follows; late picks are refused for a locked and for an open week',async({page,tab,open})=>{
    const before=await untouched();
    const run=async(target,weekId,write)=>runSignedInAcceptance({newPage:()=>tab(target),origin,dataApi:DATA_API_PATH,write,standings:true,timeout:TIMEOUT,
      expectedIssuer:'https://e2e-fixture.invalid',runLabel:'ci',evidenceDir:null,
      scenario:{pool:{slug:'e2e-alpha-pickem',name:ALPHA},weekId,foreignWeekId:week.beta9,
        commissioner:{email:'commish.alpha@e2e.invalid',foreignSeason:BETA_SEASON},
        participant:{email:'alice@e2e.invalid',commissionerOfNothing:true,readableWeekId:weekId,foreignWeekId:week.beta9,foreignSeason:BETA_SEASON}},
      signIn:(tabPage,account,pagePath)=>signIn(tabPage,account.email,pagePath),
      signOut:async tabPage=>{await tabPage.locator('#signOut').click();await tabPage.locator('#authCard').waitFor({state:'visible'})}});
    const RECOUNT='the season card shows exactly the standings an independent recount of that input gives';
    const detail=(results,check)=>results.find(r=>r.check===check)?.detail;
    const late=results=>results.filter(r=>/after its deadline/.test(r.check)).map(r=>r.detail);
    const winner=r=>r.away_score>r.home_score?'away':r.home_score>r.away_score?'home':'tie';
    // What the entry owner, still signed in after a run, sees on the participant page.
    const seen=async target=>{
      const view=await tab(target);
      await view.goto(`${origin}/participant.html?pool=e2e-alpha-pickem`);
      await seasonCard(view,/^Through week 9 · 1 week counted/);
      return (await cardRows(view,'seasonStandingsCard')).map(cells=>cells.slice(0,2));
    };

    // First run: the initial attestation of week 9, every away side winning.
    const first=await run(page,week.w9,true);
    assert.deepEqual(first.filter(r=>r.result!=='PASS'),[]);
    assert.match(detail(first,RECOUNT),/^3 entries through week 9$/);
    assert.deepEqual(late(first),['week_not_open','400 week_not_open'],'week 9 is locked: no pick by import, none by its owner');
    // Alice had the away side of the first game and the home side of the second; Bob had both home sides.
    assert.deepEqual(await seen(page),[['1. SYNTHETIC Alice','1 correct'],['2. SYNTHETIC Bob','0 correct'],['2. SYNTHETIC Unclaimed','0 correct']]);
    // Second run, another browser session: the same routine finds revision 1 and corrects it.
    const other=await open();
    const second=await run(other,week.w9,true);
    assert.deepEqual(second.filter(r=>r.result!=='PASS'),[]);
    const stored=await revisions(week.w9);
    assert.equal(stored.length,2,'two runs, two revisions, both kept');
    assert.deepEqual(stored.map(r=>games.w9.map(id=>winner(r.results[id]))),[['away','away'],['home','home']]);
    assert.deepEqual([stored[0].correction_reason,stored[1].correction_reason],[null,'Signed-in acceptance ci']);
    assert.match(detail(second,'the stored revision holds exactly the reviewed scores, and no attester or evidence field'),/^correction: the home sides now win$/);
    assert.match(detail(second,RECOUNT),/^3 entries through week 9$/);
    // The correction was replayed, not patched: with every winner turned round Bob leads and nobody shares a place.
    assert.deepEqual(await seen(other),[['1. SYNTHETIC Bob','2 correct'],['2. SYNTHETIC Alice','1 correct'],['3. SYNTHETIC Unclaimed','0 correct']]);
    // Week 11 is open and past its deadline, like the Pick'em week on the QA branch: the refusal is the deadline's.
    const openWeekRun=await run(await open(),week.w11,false);
    assert.deepEqual(openWeekRun.filter(r=>r.result!=='PASS'),[]);
    assert.deepEqual(late(openWeekRun),['deadline_passed','400 deadline_passed']);
    for(const results of [first,second,openWeekRun])for(const width of WIDTHS)for(const who of ['commissioner','participant'])
      assert.ok(results.some(r=>r.check===`${width} CSS px: the ${who}’s standings cards fit the screen`&&r.result==='PASS'),`${who} at ${width}`);
    assert.equal(await untouched(),before,'no pick, week, entry or membership changed in three runs');
  });

  check('the acceptance routine reports the standings as BLOCKED, and everything else as before, on a backend without the season read',async({page,tab})=>{
    const results=await runSignedInAcceptance({newPage:()=>tab(page),origin,dataApi:DATA_API_PATH,write:false,standings:true,timeout:TIMEOUT,
      expectedIssuer:'https://e2e-fixture.invalid',runLabel:'ci',evidenceDir:null,
      scenario:{pool:{slug:'e2e-alpha-pickem',name:ALPHA},weekId:week.w9,foreignWeekId:week.beta9,
        commissioner:{email:'commish.alpha@e2e.invalid',foreignSeason:BETA_SEASON},
        participant:{email:'alice@e2e.invalid',commissionerOfNothing:true,readableWeekId:week.w9,foreignWeekId:week.beta9,foreignSeason:BETA_SEASON}},
      signIn:(target,account,pagePath)=>signIn(target,account.email,pagePath),
      signOut:async target=>{await target.locator('#signOut').click();await target.locator('#authCard').waitFor({state:'visible'})}});
    assert.deepEqual(results.filter(r=>r.result!=='PASS').map(r=>[r.result,r.check]),[['BLOCKED','the backend has the season standings read']]);
    assert.ok(summarize(results).pass>=23,`${summarize(results).pass} checks`);
  },{season:false});

  check('the acceptance routine reports BLOCKED, not PASS, when the backend rejects every token',async({page,tab})=>{
    // What a wrong issuer pin looks like from the browser: the identity function resolves no subject.
    await sql(`CREATE OR REPLACE FUNCTION public.pool_platform_current_user_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$`);
    const logged=[];
    const scenario={pool:{slug:'e2e-alpha-pickem',name:ALPHA},weekId:week.w9,foreignWeekId:week.beta9,
      commissioner:{email:'commish.alpha@e2e.invalid'},
      participant:{email:'alice@e2e.invalid',commissionerOfNothing:true,readableWeekId:week.w9,foreignWeekId:week.beta9}};
    const results=await runSignedInAcceptance({newPage:()=>tab(page),origin,dataApi:DATA_API_PATH,write:true,timeout:TIMEOUT,scenario,log:line=>logged.push(line),
      // The page itself cannot finish signing in against such a backend, so only the session is established.
      signIn:async(target,account,pagePath)=>{
        await target.goto(`${origin}${pagePath}`);
        await target.locator('#email').fill(account.email);
        await target.locator('#sendCode').click();
        await target.locator('#otp').fill(E2E_OTP);
        await target.locator('#verifyCode').click();
        await target.locator('#signOut').waitFor({state:'visible'});
      },
      signOut:async()=>{}});
    assert.deepEqual(summarize(results),{pass:2,fail:0,blocked:1});
    assert.match(results.at(-1).detail,/auth_required.*issuer is https:\/\/e2e-fixture\.invalid/);
    assert.equal(logged.length,results.length);
    assert.deepEqual(await revisions(week.w9),[]);
  });

  check('standings: recorded finals rank the week and the season on the commissioner page, and a correction is replayed through both',async({page})=>{
    await playedSeason();
    const before=await untouched();
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w9);
    await weekCard(page,/NFL scores unavailable/);
    await seasonCard(page,/^No final scores have been recorded for this season yet\.$/);
    assert.deepEqual(await cardRows(page,'seasonStandingsCard'),[],'no ranking before a week is counted');

    await openPanel(page);
    await fillScores(page,{[games.w9[0]]:[20,17],[games.w9[1]]:[10,13]});
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await reviewAndRecord(page);
    await shown(page,'finalResultSuccess',/revision 1 recorded/);
    await weekCard(page,/^Final scores recorded by your commissioner · revision 1 · not official NFL results\.$/);
    assert.deepEqual(await cardRows(page,'poolStandingsCard'),[
      ['1. SYNTHETIC Alice','2 correct','A1 · 0 incorrect'],
      ['2. SYNTHETIC Bob','1 correct','A2 · 1 incorrect'],
      ['— SYNTHETIC Unclaimed','Not submitted','A3']]);
    await seasonCard(page,/^Through week 9 · 1 week counted · final scores recorded by your commissioner, not official NFL results\. Week 10: final scores have not been recorded yet\.$/);
    assert.deepEqual(await cardRows(page,'seasonStandingsCard'),[
      ['1. SYNTHETIC Alice','2 correct','A1 · 0 incorrect'],
      ['2. SYNTHETIC Bob','1 correct','A2 · 1 incorrect'],
      ['3. SYNTHETIC Unclaimed','0 correct','A3 · 0 incorrect · 1 week without picks']]);
    await seasonWeeks(page,/^Week 9 · revision 1; Week 10 · awaiting final scores; Week 11 · not counted; Week 12 · not counted; Week 13 · not counted$/);

    // The commissioner corrects week 9: the other team won. Both cards are replayed from the new record.
    await scoreInput(page,games.w9[0],'home').fill('27');
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await page.locator('#finalResultCorrection').fill('Home and away scores were swapped in the first entry');
    await reviewAndRecord(page);
    await shown(page,'finalResultSuccess',/revision 2 recorded/);
    await weekCard(page,/revision 2 \(corrected\)/);
    await seasonWeeks(page,/^Week 9 · revision 2 \(corrected\); /);
    assert.deepEqual(await cardRows(page,'seasonStandingsCard'),[
      ['1. SYNTHETIC Bob','2 correct','A2 · 0 incorrect'],
      ['2. SYNTHETIC Alice','1 correct','A1 · 1 incorrect'],
      ['3. SYNTHETIC Unclaimed','0 correct','A3 · 0 incorrect · 1 week without picks']]);
    assert.deepEqual((await revisions(week.w9)).map(r=>[r.revision,r.results[games.w9[0]].home_score]),[[1,17],[2,27]],'the first record is kept');

    // Two more weeks are recorded elsewhere; the next load replays all three from the first week.
    await attestAs('commish_alpha',week.w10,0,FINALS.w10);
    await attestAs('cocommish_alpha',week.w11,0,FINALS.w11);
    await page.reload();
    await openWeek(page,week.w11);
    await seasonCard(page,/^Through week 11 · 3 weeks counted · .* Week 12: final scores have not been recorded yet\.$/);
    assert.deepEqual(await cardRows(page,'seasonStandingsCard'),[
      ['1. SYNTHETIC Bob','4 correct','A2 · 2 incorrect'],
      ['2. SYNTHETIC Alice','3 correct','A1 · 3 incorrect'],
      ['3. SYNTHETIC Unclaimed','0 correct','A3 · 0 incorrect · 3 weeks without picks']]);
    await weekCard(page,/revision 1 · not official/);
    assert.deepEqual(await cardRows(page,'poolStandingsCard'),[
      ['1. SYNTHETIC Bob','2 correct','A2 · 0 incorrect'],
      ['2. SYNTHETIC Alice','1 correct','A1 · 1 incorrect'],
      ['— SYNTHETIC Unclaimed','Not submitted','A3']]);
    assert.equal(await untouched(),before,'showing standings stores nothing and changes no pick, week, entry or membership');
  });

  check('standings: an entry owner sees the same season and week standings on the participant page, with nothing about who recorded them',async({page})=>{
    await playedSeason();
    await attestAs('commish_alpha',week.w9,0,FINALS.w9);
    await attestAs('commish_alpha',week.w10,0,FINALS.w10);
    await attestAs('commish_alpha',week.w11,0,FINALS.w11);
    await attestAs('commish_alpha',week.w11,1,{...FINALS.w11,'2026_11_DET_CHI':final(31,13)},'Final score of the second game was misread');
    const before=await untouched();
    await signIn(page,'alice@e2e.invalid','/participant.html');
    await seasonCard(page,/^Through week 11 · 3 weeks counted · final scores recorded by your commissioner, not official NFL results\. Week 12: final scores have not been recorded yet\.$/);
    assert.deepEqual(await cardRows(page,'seasonStandingsCard'),[
      ['1. SYNTHETIC Alice','4 correct','A1 · 2 incorrect'],
      ['2. SYNTHETIC Bob','3 correct','A2 · 3 incorrect'],
      ['3. SYNTHETIC Unclaimed','0 correct','A3 · 0 incorrect · 3 weeks without picks']]);
    await seasonWeeks(page,/^Week 9 · revision 1; Week 10 · revision 1; Week 11 · revision 2 \(corrected\); Week 12 · awaiting final scores; Week 13 · not counted$/);
    // Her current week is 11: the week card shows its recorded finals.
    await weekCard(page,/^Final scores recorded by your commissioner · revision 2 \(corrected\) · not official NFL results\.$/);
    assert.deepEqual(await cardRows(page,'poolStandingsCard'),[
      ['1. SYNTHETIC Bob','2 correct','A2 · 0 incorrect'],
      ['2. SYNTHETIC Alice','1 correct','A1 · 1 incorrect'],
      ['— SYNTHETIC Unclaimed','Not submitted','A3']]);
    const text=await page.locator('body').innerText();
    assert.doesNotMatch(text,/commish_alpha|Seeded by the e2e runner|misread|aaaaaaaa/,'no attester, evidence or correction reason on the page');
    // What the page was given: the season read itself carries none of it either, and she cannot write.
    const snapshot=await rpc(page,'pool_platform_season_standings_snapshot',{p_pool_id:'b0000000-0000-4000-8000-000000000001',p_season:2026});
    assert.equal(snapshot.status,200);
    assert.doesNotMatch(JSON.stringify(snapshot.body),/commish_alpha|Seeded|misread|aaaaaaaa|owner|tiebreak/);
    const foreign=await rpc(page,'pool_platform_season_standings_snapshot',{p_pool_id:'b0000000-0000-4000-8000-000000000002',p_season:2026});
    assert.deepEqual([foreign.status,foreign.message],[400,'season_not_found'],'another tenant’s season is not found');
    const write=await rpc(page,'pool_platform_attest_week_final_results_with_source',attestArgs(week.w11,2,FINALS.w11,'A participant tries to correct the week'));
    assert.equal(write.message,'week_not_found');
    assert.equal(await untouched(),before);
  });

  check('standings: Survivor entries advance or go out from recorded finals, a correction brings an entry back, and an entry without a pick is out',async({page})=>{
    await sql(`INSERT INTO public.pool_platform_entries(id,season_id,entry_code,display_name,owner_auth_user_id) VALUES
      ('e0000000-0000-4000-8000-000000000102','c0000000-0000-4000-8000-000000000002','B2','SYNTHETIC Dan','dan');
      INSERT INTO public.pool_platform_submissions(week_id,entry_id,source,submitted_by_auth_user_id,payload) VALUES
      ('${week.beta9}','e0000000-0000-4000-8000-000000000102','participant','dan','{"team":"SF"}');`);
    await signIn(page,'commish.beta@e2e.invalid');
    await openWeek(page,week.beta9,BETA);
    await seasonCard(page,/^No final scores have been recorded for this season yet\.$/);
    await openPanel(page);
    await fillScores(page,{[games.beta9[0]]:[17,20],[games.beta9[1]]:[10,24]});
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await reviewAndRecord(page);
    await shown(page,'finalResultSuccess',/revision 1 recorded/);
    await seasonCard(page,/^Through week 9 · 1 week counted · final scores recorded by your commissioner, not official NFL results\. An entry with no pick for a week is out from that week\.$/);
    assert.deepEqual(await cardRows(page,'seasonStandingsCard'),[
      ['SYNTHETIC Dan','Still in','B2 · 1 week survived · picked SF'],
      ['SYNTHETIC Carol','Out in week 9 (lost)','B1 · 0 weeks survived · picked KC']]);
    // This week's card is reloaded on its own after a result is recorded: wait for it before reading its rows.
    await weekCard(page,/^Final scores recorded by your commissioner · revision 1 · not official NFL results\.$/);
    assert.deepEqual(await cardRows(page,'poolStandingsCard'),[
      ['— SYNTHETIC Carol','Eliminated','B1'],['— SYNTHETIC Dan','Advanced','B2']]);

    await scoreInput(page,games.beta9[0],'away').fill('23');
    await page.locator('#finalResultSource').fill(EVIDENCE);
    await page.locator('#finalResultCorrection').fill('Kansas City won; the first entry had the wrong score');
    await reviewAndRecord(page);
    await shown(page,'finalResultSuccess',/revision 2 recorded/);
    await seasonWeeks(page,/^Week 9 · revision 2 \(corrected\)$/);
    assert.deepEqual(await cardRows(page,'seasonStandingsCard'),[
      ['SYNTHETIC Carol','Still in','B1 · 1 week survived · picked KC'],
      ['SYNTHETIC Dan','Still in','B2 · 1 week survived · picked SF']]);

    // A third entry never picked. This pool states no rule of its own for that (as pool_platform_create_pool
    // leaves it), so the default applies: a week without a pick is a loss, and the card says so.
    assert.equal(await sql(`SELECT rules ? 'missingSurvivorPick' FROM public.pool_platform_pools WHERE id='b0000000-0000-4000-8000-000000000002'`),'f');
    await sql(`INSERT INTO public.pool_platform_entries(season_id,entry_code,display_name) VALUES
      ('c0000000-0000-4000-8000-000000000002','B3','SYNTHETIC No Pick')`);
    await page.reload();
    await openWeek(page,week.beta9,BETA);
    await seasonCard(page,/^Through week 9 · 1 week counted · final scores recorded by your commissioner, not official NFL results\. An entry with no pick for a week is out from that week\.$/);
    assert.deepEqual(await cardRows(page,'seasonStandingsCard'),[
      ['SYNTHETIC Carol','Still in','B1 · 1 week survived · picked KC'],
      ['SYNTHETIC Dan','Still in','B2 · 1 week survived · picked SF'],
      ['SYNTHETIC No Pick','Out in week 9 (no pick)','B3 · 0 weeks survived']]);
    await seasonWeeks(page,/^Week 9 · revision 2 \(corrected\)$/);
    // This week’s card states the same fact for the week and removes nobody on its own.
    await weekCard(page,/revision 2 \(corrected\)/);
    assert.deepEqual((await cardRows(page,'poolStandingsCard')).find(row=>/No Pick/.test(row[0]))?.slice(1),['No Survivor pick','B3']);

    // A pool that states a different rule of its own is not overridden: nothing is computed under the default.
    await sql(`UPDATE public.pool_platform_pools SET rules=rules||'{"missingSurvivorPick":"advance"}' WHERE id='b0000000-0000-4000-8000-000000000002'`);
    await page.reload();
    await openWeek(page,week.beta9,BETA);
    await seasonCard(page,/^This pool’s rules are not ones season standings can be computed for, so none are shown\. Picks are not affected\.$/);
    assert.deepEqual(await cardRows(page,'seasonStandingsCard'),[]);
    // And one that states the same rule itself shows the same standings.
    await sql(`UPDATE public.pool_platform_pools SET rules=rules||'{"missingSurvivorPick":"eliminate"}' WHERE id='b0000000-0000-4000-8000-000000000002'`);
    await page.reload();
    await openWeek(page,week.beta9,BETA);
    await seasonCard(page,/^Through week 9 · 1 week counted · .* An entry with no pick for a week is out from that week\.$/);
    assert.equal((await cardRows(page,'seasonStandingsCard')).length,3);
  });

  // Like the panel screenshots above: evidence for a person to look at, kept apart from the checks that watch the
  // console. Phone width, both pages.
  if(evidenceDir)test(`[${engine}] evidence only: screenshots of the standings cards at 390 CSS px`,async()=>{
    resetDatabase();
    await playedSeason();
    await attestAs('commish_alpha',week.w9,0,FINALS.w9);
    await attestAs('commish_alpha',week.w10,0,FINALS.w10);
    await attestAs('commish_alpha',week.w11,0,FINALS.w11);
    await attestAs('commish_alpha',week.w11,1,{...FINALS.w11,'2026_11_DET_CHI':final(31,13)},'Final score of the second game was misread');
    browser??=await playwright[engine].launch(launchOptions(engine));
    for(const [who,email,pagePath] of [['participant','alice@e2e.invalid','/participant.html'],['commissioner','commish.alpha@e2e.invalid','/commissioner.html']]){
      const context=await browser.newContext({viewport:{width:390,height:850},ignoreHTTPSErrors:true,serviceWorkers:'block'});
      try{
        const page=await context.newPage();
        page.setDefaultTimeout(TIMEOUT);
        await signIn(page,email,pagePath);
        if(who==='commissioner')await openWeek(page,week.w11);
        await seasonCard(page,/Through week 11/);
        await weekCard(page,/revision 2/);
        for(const card of ['seasonStandingsCard','poolStandingsCard']){
          const file=path.join(evidenceDir,`${engine}-390px-${who}-${card}.png`);
          await page.locator(`#${card}`).screenshot({path:file});
          assert.ok(fs.statSync(file).size>5000,file);
        }
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
        assert.ok(overflow<=0,`the ${who} page scrolls sideways by ${overflow}px at 390px`);
      }finally{await context.close()}
    }
  });

  check('standings: on a backend without the season read the season card stays away and the week card still shows recorded finals',async({page})=>{
    await attestAs('commish_alpha',week.w9,0,FINALS.w9);
    await signIn(page,'commish.alpha@e2e.invalid');
    await openWeek(page,week.w9);
    await weekCard(page,/^Final scores recorded by your commissioner · revision 1 · not official NFL results\.$/);
    assert.deepEqual((await cardRows(page,'poolStandingsCard')).map(r=>r[1]),['2 correct','1 correct','Not submitted']);
    const missing=await rpc(page,'pool_platform_season_standings_snapshot',{p_pool_id:'b0000000-0000-4000-8000-000000000001',p_season:2026});
    assert.deepEqual([missing.status,missing.code],[404,'PGRST202']);
    assert.equal(await page.locator('#seasonStandingsCard').isVisible(),false);
  },{season:false});

  check('the issuer check reports the issuer and audience of the token, never the token, whatever the backend accepts',async({page,tab})=>{
    const logged=[];
    const signOut=async target=>{await target.locator('#signOut').click();await target.locator('#authCard').waitFor({state:'visible'})};
    const run=(expectedAuthOrigin,signInWith)=>runIssuerCheck({newPage:()=>tab(page),origin,dataApi:DATA_API_PATH,expectedAuthOrigin,
      log:line=>logged.push(line),account:{email:'commish.alpha@e2e.invalid'},signIn:signInWith,signOut});
    const accepted=await run('https://e2e-fixture.invalid',(target,account,pagePath)=>signIn(target,account.email,pagePath));
    assert.deepEqual(accepted.results.filter(r=>r.result!=='PASS'),[]);
    assert.deepEqual([accepted.iss,accepted.aud,accepted.valueToStore,accepted.backendAccepts],
      ['https://e2e-fixture.invalid','https://e2e-fixture.invalid','https://e2e-fixture.invalid',true]);
    // A token from some other Auth is a failure of the check, not a value to store.
    const foreign=await run('https://another-auth.invalid',(target,account,pagePath)=>signIn(target,account.email,pagePath));
    assert.deepEqual(foreign.results.filter(r=>r.result==='FAIL').map(r=>r.check),['the token was issued by this backend’s own Auth']);
    // The state the QA branch is in before its correction: the backend resolves no subject, and the check still
    // reports what the row must hold.
    await sql(`CREATE OR REPLACE FUNCTION public.pool_platform_current_user_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$`);
    const refused=await run('https://e2e-fixture.invalid',async(target,account,pagePath)=>{
      await target.goto(`${origin}${pagePath}`);
      await target.locator('#email').fill(account.email);
      await target.locator('#sendCode').click();
      await target.locator('#otp').fill(E2E_OTP);
      await target.locator('#verifyCode').click();
      await target.locator('#signOut').waitFor({state:'visible'});
    });
    assert.deepEqual(refused.results.filter(r=>r.result!=='PASS'),[]);
    assert.deepEqual([refused.valueToStore,refused.backendAccepts],['https://e2e-fixture.invalid',false]);
    assert.doesNotMatch(JSON.stringify([accepted,foreign,refused,logged]),/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}/,'no token in any output');
    assert.deepEqual(await revisions(week.w9),[]);
  });

  // ---- acceptance findings of 2026-11-23: F-02 (a long option widens the page), touch targets, F-03 (score gateway) --
  // Production's entry names are long ("Synthetic Survivor Participant-1 Entry 01 · SV-D01", 51 characters) and this
  // fixture's are short. In WebKit the invitation card's entry selector let its selected option spill out of its field,
  // and the commissioner page scrolled sideways on a phone. These checks lengthen every name first, and give Alice a
  // second entry so that her page shows its entry selector too.
  const LONG_NAMES=`UPDATE public.pool_platform_entries
    SET display_name='Synthetic Survivor Participant-1 Entry '||entry_code||' with a long name';
    UPDATE public.pool_platform_entries SET owner_auth_user_id='alice' WHERE id='e0000000-0000-4000-8000-000000000003';`;
  const ALL_WIDTHS=[...WIDTHS,1280];
  const SIGNED_IN=[['commissioner-pickem','commish.alpha@e2e.invalid','/commissioner.html?pool=e2e-alpha-pickem','#inviteEntry'],
    ['commissioner-survivor','commish.beta@e2e.invalid','/commissioner.html?pool=e2e-beta-survivor','#inviteEntry'],
    ['participant','alice@e2e.invalid','/participant.html?pool=e2e-alpha-pickem','#entrySelect']];
  const openAllSections=page=>page.evaluate(()=>{for(const details of document.querySelectorAll('details'))if(details.getClientRects().length)details.open=true});

  check('long entry names: no signed-in page is wider than the screen at 375, 390, 430 or 1280 px',async({open})=>{
    await sql(LONG_NAMES);
    for(const [name,email,address,selector] of SIGNED_IN){
      const page=await open();
      await signIn(page,email,address);
      await page.locator(selector).waitFor({state:'visible'});
      await quiet(page);
      const shownOption=await page.locator(selector).evaluate(select=>select.selectedOptions[0].textContent);
      assert.ok(shownOption.length>=51,`${name}: the selector shows a long option (${shownOption.length} characters)`);
      for(const width of ALL_WIDTHS){
        await page.setViewportSize({width,height:850});
        await quiet(page);
        assert.deepEqual(await panel.pageLayoutProblems(page,width),[],`${name} at ${width} CSS px`);
        const box=await page.locator(selector).evaluate(select=>{const b=select.getBoundingClientRect(),field=select.closest('.field').getBoundingClientRect();
          return{inside:b.left>=field.left-0.5&&b.right<=field.right+0.5,height:b.height}});
        assert.ok(box.inside,`${name} at ${width} CSS px: the selector stays inside its field`);
      }
      // Every section open as well: the selectors and fields inside them obey the same rule.
      if(name!=='participant'){
        await openAllSections(page);
        for(const width of ALL_WIDTHS){
          await page.setViewportSize({width,height:850});
          await quiet(page);
          assert.deepEqual(await panel.pageLayoutProblems(page,width),[],`${name}, every section open, at ${width} CSS px`);
        }
      }
    }
  });

  check('every control a person can see is at least 44 CSS px tall and wide, signed out and signed in',async({page,open})=>{
    await sql(LONG_NAMES);
    // A draft week as well, so that the schedule editors and their controls are on the page.
    await sql(`UPDATE public.pool_platform_weeks SET status='draft' WHERE id='${week.w10}' AND NOT EXISTS
      (SELECT 1 FROM public.pool_platform_submissions s WHERE s.week_id='${week.w10}')`);
    for(const address of ['/','/participant.html','/commissioner.html']){
      await page.goto(`${origin}${address}`);
      await page.locator(address==='/'?'main.shell':'#authCard').first().waitFor({state:'visible'});
      for(const width of ALL_WIDTHS){
        await page.setViewportSize({width,height:850});
        assert.deepEqual(await panel.touchTargetProblems(page),[],`${address} signed out at ${width} CSS px`);
      }
      if(address!=='/'){
        // The code field appears once a code was asked for.
        await page.setViewportSize({width:375,height:850});
        await page.locator('#email').fill('alice@e2e.invalid');
        await page.locator('#sendCode').click();
        await page.locator('#otp').waitFor({state:'visible'});
        assert.deepEqual(await panel.touchTargetProblems(page),[],`${address} with the code field at 375 CSS px`);
      }
    }
    for(const [name,email,address,selector] of SIGNED_IN){
      const signedIn=await open();
      await signIn(signedIn,email,address);
      await signedIn.locator(selector).waitFor({state:'visible'});
      await quiet(signedIn);
      const states=[['as opened',async()=>{}]];
      if(name==='commissioner-pickem'){
        states.push(['draft week, every section open',async()=>{
          await signedIn.locator('#weekSelect').selectOption(week.w10);await quiet(signedIn);await openAllSections(signedIn);
          // The draft-only panels are really there, with a schedule row of selectors and a date field to measure.
          for(const id of ['verifiedScheduleSetup','scheduleSetup','weekSetup'])await signedIn.locator(`#${id}`).waitFor({state:'visible'});
          if(!await signedIn.locator('#scheduleGames .schedule-row').count())await signedIn.locator('#addScheduleGame').click();
          assert.ok(await signedIn.locator('#scheduleGames select').count()>=2&&await signedIn.locator('#scheduleGames input[type=datetime-local]').count()>=1);
        }]);
        states.push(['new-entry review open',async()=>{
          await signedIn.locator('#newEntryCode').fill('ZZ-44');await signedIn.locator('#newEntryName').fill('Touch target check');
          await signedIn.locator('#previewNewEntry').click();await signedIn.locator('#newEntryReview').waitFor({state:'visible'})}]);
        states.push(['pool chooser',async()=>{await signedIn.locator('#switchPool').click();await signedIn.locator('#poolPickerCard').waitFor({state:'visible'})}]);
      }
      if(name==='commissioner-survivor')states.push(['every section open',()=>openAllSections(signedIn)]);
      for(const [state,enter] of states){
        await enter();
        for(const width of ALL_WIDTHS){
          await signedIn.setViewportSize({width,height:850});
          await quiet(signedIn);
          assert.deepEqual(await panel.touchTargetProblems(signedIn),[],`${name}, ${state}, at ${width} CSS px`);
        }
      }
    }
  });

  // F-03. This release installs no live-score gateway: nothing serves /api/nfl-scores. The pages used to ask for it on
  // every load and every week change and log a 404 each time.
  check('score gateway not installed: both pages say so, offer no refresh, and never ask for it',async({page,open})=>{
    const asked=[],errors=[];
    const listen=target=>{
      target.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/nfl-scores'))asked.push(request.url())});
      target.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
    };
    const card=async(target,name)=>{
      await target.locator('#scoreboardCard').waitFor({state:'visible'});
      await target.locator('#scoreboardCard [data-score-status]').filter({hasText:/Live NFL scores are not installed/}).waitFor({state:'visible'});
      assert.equal(await target.locator('#scoreboardCard [data-score-refresh]').isVisible(),false,`${name}: no refresh is offered for a gateway that is not there`);
      assert.equal(await target.locator('#scoreboardCard [data-score-refresh]').isDisabled(),true,name);
      assert.equal(await target.locator('#scoreboardCard [data-score-list] > *').count(),0,`${name}: no score row`);
    };
    listen(page);
    await signIn(page,'commish.alpha@e2e.invalid','/commissioner.html?pool=e2e-alpha-pickem');
    await page.locator('#poolName').filter({hasText:ALPHA}).waitFor({state:'visible'});
    await card(page,'commissioner');
    // Week after week, a tab hidden and shown again, and a reload: still nothing is asked.
    for(const id of [week.w9,week.w10,week.w11,week.w12,week.w9]){await openWeek(page,id);await quiet(page);await card(page,'commissioner')}
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.reload();
    await card(page,'commissioner after a reload');
    // Standings are untouched: a week past its deadline still lists the pool's entries without rankings.
    await openWeek(page,week.w9);
    await weekCard(page,/NFL scores unavailable\. Showing only this pool’s entries; rankings are not calculated\./);
    assert.equal((await cardRows(page,'poolStandingsCard')).length,3);
    const participant=await open();
    listen(participant);
    await signIn(participant,'alice@e2e.invalid','/participant.html?pool=e2e-alpha-pickem');
    await card(participant,'participant');
    await quiet(participant);
    // The card with its longer status, and without its button, fits every width on both pages.
    for(const [name,target] of [['commissioner',page],['participant',participant]]){
      for(const width of ALL_WIDTHS){
        await target.setViewportSize({width,height:850});
        await quiet(target);
        await card(target,`${name} at ${width} CSS px`);
        assert.deepEqual(await panel.pageLayoutProblems(target,width),[],`${name} at ${width} CSS px`);
      }
    }
    assert.deepEqual(asked,[],'no request for the score gateway');
    assert.deepEqual(errors.filter(text=>/404|nfl-scores|Failed to load resource/i.test(text)),[],'no failed request in the console');
  });

  if(evidenceDir)test(`[${engine}] evidence only: screenshots of the selectors with long names and of the score card at ${WIDTHS.join(', ')} CSS px`,async()=>{
    resetDatabase();
    await sql(LONG_NAMES);
    browser??=await playwright[engine].launch(launchOptions(engine));
    for(const [name,email,address,selector] of SIGNED_IN){
      const context=await browser.newContext({viewport:{width:WIDTHS[0],height:850},ignoreHTTPSErrors:true,serviceWorkers:'block'});
      try{
        const page=await context.newPage();
        page.setDefaultTimeout(TIMEOUT);
        await signIn(page,email,address);
        await page.locator(selector).waitFor({state:'visible'});
        for(const width of WIDTHS){
          await page.setViewportSize({width,height:850});
          for(const [what,card] of [['long-names',selector==='#inviteEntry'?'#inviteCard':'#entryCard'],['score-card','#scoreboardCard']]){
            const file=path.join(evidenceDir,`${engine}-${width}px-${what}-${name}.png`);
            await page.locator(card).screenshot({path:file});
            assert.ok(fs.statSync(file).size>3000,file);
          }
        }
      }finally{await context.close()}
    }
  });

  // Every check above blocks service workers. This one allows them, in Chromium only, and opens the page the way an
  // invited participant first does: at /join/<pool>/<entry>, which is not where the worker file is. It then cuts the
  // network: each cached role page explains why it cannot continue and recovers when it can reach configuration again.
  if(engine==='chromium')test(`[${engine}] service worker: invitation scope, static-only cache, offline error and online recovery`,{timeout:90000},async()=>{
    resetDatabase();
    // A browser of its own: Chromium fetches a worker script from this self-signed origin only when started with
    // this switch (ignoreHTTPSErrors covers pages, not worker scripts). No other check runs in it.
    const workerBrowser=await playwright[engine].launch({...launchOptions(engine),args:['--ignore-certificate-errors']});
    const context=await workerBrowser.newContext({viewport:{width:390,height:850},ignoreHTTPSErrors:true});
    try{
      const page=await context.newPage();
      page.setDefaultTimeout(TIMEOUT);
      const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`${origin}/join/e2e-alpha-pickem/e0000000-0000-4000-8000-000000000003`);
      await page.locator('#authCard').waitFor({state:'visible'});
      // serviceWorker.ready never settles when registration failed, so the wait is bounded here.
      const registration=await page.evaluate(limit=>Promise.race([
        navigator.serviceWorker.ready.then(ready=>({scope:ready.scope,script:ready.active.scriptURL,updateViaCache:ready.updateViaCache})),
        new Promise(resolve=>setTimeout(()=>resolve(null),limit))]),TIMEOUT);
      assert.deepEqual(registration,{scope:`${origin}/`,script:`${origin}/service-worker.js`,updateViaCache:'none'},
        'the worker was not registered from the invitation address');
      await page.waitForFunction(script=>navigator.serviceWorker.controller?.scriptURL===script,registration.script);
      const cached=await page.evaluate(async()=>{
        const paths=[];
        for(const name of await caches.keys())for(const request of await (await caches.open(name)).keys())paths.push(new URL(request.url).pathname);
        return paths;
      });
      for(const never of ['/platform-config.js','/vendor/neon-js.js'])assert.ok(!cached.includes(never),`${never} is never cached`);
      assert.ok(!cached.some(entry=>entry.startsWith('/join/')||entry.startsWith('/api/')||entry.startsWith('/rest/')),'no invitation, Auth or Data API address is cached');
      const expected=['/',...STATIC_FILES.filter(name=>name!=='service-worker.js').map(name=>`/${name}`)];
      assert.deepEqual(cached.sort(),expected.sort(),'only the app shell and all its modules were cached');
      assert.deepEqual(errors,[],'no uncaught error while the network is up');
      await context.setOffline(true);
      for(const [pagePath,pill] of [['/participant.html','UNAVAILABLE'],['/commissioner.html','Unavailable']]){
        await page.goto(`${origin}${pagePath}`);
        await page.locator('#sessionError').filter({hasText:CONFIG_UNAVAILABLE}).waitFor({state:'visible'});
        assert.equal(await page.locator('#modePill').textContent(),pill,pagePath);
        assert.equal(await page.locator('#authCard').isVisible(),false,`${pagePath}: no sign-in is offered without a configuration`);
      }
      // Each page stops on purpose once it has said so: the one error is the configuration it could not load, and it
      // is raised only after every other module was read from the cache.
      assert.equal(errors.length,2);
      for(const message of errors)assert.match(message,/platform-config\.js/);
      await context.setOffline(false);
      for(const pagePath of ['/participant.html','/commissioner.html']){
        await page.goto(`${origin}${pagePath}`);
        await page.locator('#authCard').waitFor({state:'visible'});
        assert.equal(await page.locator('#sessionError').isVisible(),false,pagePath);
      }
      assert.equal(errors.length,2,'no uncaught error after the network returns');
    }finally{await context.setOffline(false).catch(()=>{});await context.close();await workerBrowser.close()}
  });

  test(`[${engine}] no uncaught page error and no Content-Security-Policy refusal in any check above`,()=>{
    assert.deepEqual(problems,[]);
  });
}

test('two simultaneous writers on one week: exactly one revision is stored and the other is told it is stale',async()=>{
  resetDatabase();
  const call=(subject,away,hold)=>runPsql(`\\set VERBOSITY terse
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('test.uid', :'uid', true) AS uid \\gset e2e_
SELECT (public.pool_platform_attest_week_final_results_with_source(:'w'::uuid,0,:'results'::jsonb,repeat('c',64),
  'Concurrent writer in the e2e runner',NULL))->>'revision';
SELECT pg_sleep(:'hold'::numeric);
COMMIT;`,{vars:{uid:subject,w:week.w9,hold:String(hold),
    results:JSON.stringify({[games.w9[0]]:final(away,0),[games.w9[1]]:final(7,7)})},database});
  const first=call('commish_alpha',21,1.5);
  await new Promise(resolve=>setTimeout(resolve,400));
  const second=await call('cocommish_alpha',35,0);
  assert.equal((await first).code,0);
  assert.notEqual(second.code,0,'the second writer must not succeed');
  assert.match(second.stderr,/stale_result_revision/);
  const stored=await revisions(week.w9);
  assert.deepEqual(stored.map(r=>[r.revision,r.by,r.results[games.w9[0]].away_score]),[[1,'commish_alpha',21]]);
});
