// The signed-in acceptance routine for the commissioner final-score panel: one commissioner, then one account that
// is NOT a commissioner of that pool, against whatever backend the page under test is configured for.
//
// It is run two ways with the same code:
//   - by CI against the disposable stand-in backend (final-results.e2e.test.mjs), where sign-in is automated;
//   - by the owner against the isolated QA backend (signed-in-acceptance.mjs), where a person signs in.
// It never reads, returns or logs a token, a cookie or a sign-in code: every call that needs the session token is
// made inside the page (final-results-page.mjs), and only outcomes come back.
//
// Writes: none unless `write` is true. With `write`, exactly ONE result revision is appended to scenario.weekId
// (the initial attestation, or a correction if one exists). Result revisions are append-only and cannot be removed,
// so `write` is for synthetic QA weeks only.
import path from 'node:path';
import * as panel from './final-results-page.mjs';
import {recount} from '../season-recount.mjs';

const MISSING_WEEK='00000000-0000-4000-8000-000000000000';
const NEVER_A_REVISION=2147483647;
const RESULT_KEYS=['results','revision','status','week_id'];
const SEASON_KEYS=['entries','pool_id','pool_type','rules','season','status','weeks'];
const SEASON_CARD_RENDERED=/recorded by your commissioner|No final scores have been recorded|No week can be counted/;
// A pick sent for a week that is past its deadline (or is no longer open) is refused with one of these, before the
// payload is looked at.
const LATE=['deadline_passed','week_not_open'];
// Not a valid pick, on purpose: whatever a late-pick probe is answered, nothing can be stored by it.
const NOT_A_PICK=Object.freeze({acceptance_probe:true});
const OUT_REASON={loss:'lost',tie:'tied game',no_pick:'no pick'};
// What the season card must show for a season input, counted again by tests/season-recount.mjs (no code shared with
// the page): the first two cells of every row, in order. No row at all before a week is counted.
function recountedRows(seasonInput){
  const counted=recount(seasonInput);
  const rows=!counted.countedWeeks?[]:counted.rows.map(r=>counted.kind==='pickem'
    ?[`${r.rank}. ${r.name}`,`${r.correct} correct`]
    :[r.name,r.status==='active'?'Still in':`Out in week ${r.eliminated_week} (${OUT_REASON[r.elimination_reason]})`]);
  return{rows,through:counted.throughWeek,weeks:counted.countedWeeks,
    outForNoPick:counted.kind==='survivor'?counted.rows.filter(r=>r.elimination_reason==='no_pick').length:null};
}
const final=(away,home)=>({status:'final',away_score:away,home_score:home});
const refused=outcome=>`${outcome.status} ${outcome.message??outcome.code??''}`.trim();

export async function runSignedInAcceptance({newPage,origin,dataApi,scenario,signIn,signOut,write=false,standings=false,expectedIssuer=null,
  evidenceDir=null,runLabel=new Date().toISOString(),widths=[375,390,430],timeout=15000,log=()=>{}}){
  const results=[];
  const record=(result,check,detail='')=>{results.push({result,check,detail});log(`${result.padEnd(7)} ${check}${detail?` — ${detail}`:''}`)};
  const expect=(ok,check,detail='')=>{record(ok?'PASS':'FAIL',check,detail);return ok};
  const rpc=(page,name,args,options)=>panel.rpc(page,dataApi,name,args,options);
  const attest=(weekId,expected,gameResults,reason=null)=>({p_week_id:weekId,p_expected_revision:expected,p_results:gameResults,
    p_source_sha256:'b'.repeat(64),p_source_reference:`Signed-in acceptance negative check ${runLabel}`,p_correction_reason:reason});
  const retired=(weekId,gameResults)=>({p_week_id:weekId,p_expected_revision:NEVER_A_REVISION,p_results:gameResults,
    p_source_sha256:'b'.repeat(64),p_correction_reason:`Retired RPC check ${runLabel}`});
  const anonymous=await newPage();
  await anonymous.goto(`${origin}/commissioner.html`);
  const withoutToken=await rpc(anonymous,'pool_platform_week_result_snapshot',{p_week_id:scenario.weekId},{anonymous:true});
  expect(withoutToken.status===401,'a request without a token is refused with 401',refused(withoutToken));
  await anonymous.close();

  // ---- the commissioner ------------------------------------------------------------------------------------
  const page=await newPage();
  await signIn(page,scenario.commissioner,`/commissioner.html?pool=${scenario.pool.slug}`);
  const facts=await panel.tokenFacts(page);
  if(!expect(Boolean(facts),'the signed-in page holds a session token'))return results;
  // Compared by origin: whether the issuer claim carries a path is the provider's choice and is not assumed here.
  const originOf=value=>{try{return new URL(value).origin}catch{return null}};
  if(expectedIssuer)expect(originOf(facts.iss)!==null&&originOf(facts.iss)===originOf(expectedIssuer),
    'the token was issued by this backend’s own Auth',`iss ${facts.iss}`);
  const pools=await rpc(page,'pool_platform_list_commissioner_pools',{});
  if(pools.message==='auth_required'){
    // Not a failure of the page: this database does not accept this Auth as its issuer.
    record('BLOCKED','the backend accepts its own Auth’s token',
      `every RPC answers auth_required. The token's issuer is ${facts.iss}; pool_platform_private.auth_issuer must hold exactly that value without a trailing slash (the audience claim must equal it too), and the account must not be banned and must have no row in neon_auth.account`);
    return results;
  }
  if(!expect(pools.status===200&&Array.isArray(pools.body)&&pools.body.some(p=>p.slug===scenario.pool.slug),
    'the commissioner’s token lists the pool under test',refused(pools)))return results;
  const context=await rpc(page,'pool_platform_commissioner_context',{p_pool_slug:scenario.pool.slug});
  const week=context.body?.seasons?.flatMap(s=>s.weeks??[]).find(w=>w.id===scenario.weekId);
  if(!expect(Boolean(week?.config?.games?.length),'the week under test belongs to that pool',refused(context)))return results;
  const ids=week.config.games.map(g=>g.id);
  const seasonOfWeek=context.body.seasons.find(s=>(s.weeks??[]).some(w=>w.id===scenario.weekId));
  const seasonNumber=seasonOfWeek.season;
  // Synthetic scores. The away side wins every game, or with `flipped` the home side does, so that a correction
  // changes who won and the standings have something to replay. The third game, where a week has one, is a tie
  // either way.
  const scores=(offset,flipped=false)=>Object.fromEntries(ids.map((id,i)=>[id,
    i===2?final(10+i+offset,10+i+offset):flipped?final(3+i,10+i+offset):final(10+i+offset,3+i)]));

  const foreign=await rpc(page,'pool_platform_attest_week_final_results_with_source',attest(scenario.foreignWeekId,NEVER_A_REVISION,scores(0)));
  const missing=await rpc(page,'pool_platform_attest_week_final_results_with_source',attest(MISSING_WEEK,NEVER_A_REVISION,scores(0)));
  expect(foreign.message==='week_not_found'&&foreign.status===missing.status&&foreign.message===missing.message,
    'another tenant’s week cannot be written and looks exactly like a missing week',`${refused(foreign)} / ${refused(missing)}`);
  const foreignRead=await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:scenario.foreignWeekId});
  expect(foreignRead.message==='week_not_found','another tenant’s results cannot be read',refused(foreignRead));
  // An impossible expected revision: whichever way validation goes, nothing can be stored by these two calls.
  const malformed=Object.fromEntries(ids.map((id,i)=>[id,{away_score:1+i,home_score:0,note:'no status'}]));
  const hardened=await rpc(page,'pool_platform_attest_week_final_results_with_source',attest(scenario.weekId,NEVER_A_REVISION,malformed,'Malformed result probe'));
  expect(hardened.message==='invalid_final_results','a result without status "final" is refused (hardening migration installed)',
    hardened.message==='stale_result_revision'?'NOT INSTALLED: validation passed and only the revision check refused it':refused(hardened));
  const old=await rpc(page,'pool_platform_attest_week_final_results',retired(scenario.weekId,scores(0)));
  expect(old.status>=400,'the retired attestation RPC is not callable with a signed-in token',refused(old));
  for(const table of ['pool_platform_week_result_revisions','pool_platform_week_result_evidence']){
    const read=await panel.readTable(page,dataApi,table);
    expect(!(read.rows>0),`a signed-in token reads no row of ${table}`,`${read.status}${read.code?` ${read.code}`:''}${read.rows===null?'':` rows=${read.rows}`}`);
  }
  // A pick entered by the commissioner for this week, now that its deadline has passed. The import answers per
  // item, so the refusal is in the item, not in the HTTP status.
  const anEntry=(seasonOfWeek.entries??[]).find(e=>e.status==='active');
  if(anEntry){
    const lateImport=await rpc(page,'pool_platform_submit_batch',{p_week_id:scenario.weekId,p_source:'commissioner_import',
      p_items:[{entry_id:anEntry.id,payload:NOT_A_PICK}]});
    const item=Array.isArray(lateImport.body)?lateImport.body[0]:null;
    expect(lateImport.status===200&&item?.ok===false&&LATE.includes(item.code),
      'a commissioner cannot enter or change a pick for the week after its deadline',item?String(item.code):refused(lateImport));
  }

  await panel.openWeek(page,scenario.weekId,scenario.pool.name);
  const eligible=await page.locator('#finalResultAdmin').waitFor({state:'visible',timeout}).then(()=>true,()=>false);
  if(!expect(eligible,'the final-score panel is offered for the week under test',eligible?'':'not offered: its deadline has not passed, or the page is older than the hardening change'))return results;
  await panel.openPanel(page,{log});
  const before=await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:scenario.weekId});
  if(!expect(before.status===200&&['unpublished','commissioner_attested_not_official'].includes(before.body?.status),
    'the commissioner reads the week’s result state',refused(before)))return results;
  const revision=before.body.revision??0;
  // Every correction turns the winners round: the stored revision's first game says which way they stand now.
  const stored=revision?before.body.results[ids[0]]:null;
  const flipped=revision?stored.away_score>stored.home_score:false;
  const offset=revision?(Math.max(stored.away_score,stored.home_score)+1)%40:0;
  const slate=delta=>scores(offset+delta,flipped);
  const enter=async(target,delta)=>{
    await panel.fillScores(target,Object.fromEntries(Object.entries(slate(delta)).map(([id,r])=>[id,[r.away_score,r.home_score]])));
    await target.locator('#finalResultSource').fill(`Signed-in acceptance ${runLabel}\nsynthetic scores, not a real result`);
    if(revision)await target.locator('#finalResultCorrection').fill(`Signed-in acceptance ${runLabel}`);
  };
  for(const width of widths){
    await page.setViewportSize({width,height:850});
    await enter(page,0);
    const layout=await panel.panelLayoutProblems(page,width);
    if(evidenceDir)await page.locator('#finalResultAdmin').screenshot({caret:'initial',path:path.join(evidenceDir,`signed-in-${width}px.png`)});
    expect(layout.problems.length===0&&layout.scoreInputs===ids.length*2,`${width} CSS px: the panel fits and every control is reachable`,layout.problems.join('; '));
  }
  await panel.press(page,'#finalResultPreview');
  const reviewed=await page.locator('#finalResultReview').waitFor({state:'visible',timeout}).then(()=>true,()=>false);
  const reviewError=reviewed?'':await page.locator('#finalResultError').textContent();
  if(!expect(reviewed,'the review step accepts a complete slate',reviewError))return results;
  if(!write){
    await panel.press(page,'#finalResultCancel');
    const untouched=await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:scenario.weekId});
    expect((untouched.body?.revision??0)===revision,'nothing was recorded (read-only run)',`revision ${revision}`);
  }else{
    // A second tab of the same session opens the same week at the same revision, then loses the race.
    const second=await newPage();
    await second.goto(`${origin}/commissioner.html?pool=${scenario.pool.slug}`);
    await panel.openWeek(second,scenario.weekId,scenario.pool.name);
    await panel.openPanel(second,{log});
    await panel.quiet(page);
    await page.locator('#finalResultConfirmCheck').check();
    await panel.press(page,'#finalResultConfirm');
    const recorded=await panel.shown(page,'finalResultSuccess',new RegExp(`revision ${revision+1} recorded`),timeout).then(()=>true,()=>false);
    if(!expect(recorded,`revision ${revision+1} is recorded and the confirmation is visible`,recorded?'':await page.locator('#finalResultError').textContent()))return results;
    const after=await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:scenario.weekId});
    expect(after.body?.revision===revision+1&&JSON.stringify(Object.keys(after.body).sort())===JSON.stringify(RESULT_KEYS)&&
      ids.every(id=>after.body.results[id]?.away_score===slate(0)[id].away_score&&after.body.results[id]?.home_score===slate(0)[id].home_score
        &&after.body.results[id]?.status==='final'),
      'the stored revision holds exactly the reviewed scores, and no attester or evidence field',
      revision?`correction: the ${flipped?'home':'away'} sides now win`:'initial attestation: the away sides win');
    await enter(second,5);
    if(!revision)await second.locator('#finalResultCorrection').waitFor({state:'hidden'});
    await panel.reviewAndRecord(second);
    const told=await panel.shown(second,'finalResultError',/recorded by someone else/,timeout).then(()=>true,()=>false);
    const reloaded=await panel.shown(second,'finalResultStatus',new RegExp(`revision ${revision+1}`),timeout).then(()=>true,()=>false);
    const final2=await rpc(second,'pool_platform_week_result_snapshot',{p_week_id:scenario.weekId});
    expect(told&&reloaded&&final2.body?.revision===revision+1,'a stale second tab is told, shown the stored revision, and stores nothing',
      `stored revision ${final2.body?.revision}`);
    await second.close();
  }
  await page.setViewportSize({width:1280,height:900});

  // ---- standings from the recorded finals (asked for with `standings`; needs the season read on the backend) ----
  const seasonStatus=target=>target.locator('#seasonStandingsCard [data-season-status]');
  let seasonSeen=null;
  if(standings){
    const poolId=context.body.pool.id;
    const season=await rpc(page,'pool_platform_season_standings_snapshot',{p_pool_id:poolId,p_season:seasonNumber});
    if(season.status===404){
      record('BLOCKED','the backend has the season standings read',
        'not found: migration 20261112_season_standings_snapshot.sql is not installed on this backend, or the Data API’s schema cache was not refreshed after it was installed');
    }else if(expect(season.status===200&&JSON.stringify(Object.keys(season.body??{}).sort())===JSON.stringify(SEASON_KEYS),
      'the commissioner reads the season standings input',refused(season))){
      seasonSeen={poolId,seasonNumber,text:JSON.stringify(season.body),expected:recountedRows(season.body)};
      const now=await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:scenario.weekId});
      const stored=now.body?.revision??0,inSeason=season.body.weeks.find(w=>w.week_id===scenario.weekId);
      expect(inSeason?.visibility==='after_deadline'&&(inSeason.result?.revision??0)===stored,
        'the season input carries the latest revision of the week under test',`revision ${inSeason?.result?.revision??0}`);
      expect(!/attested_by|source_sha256|source_reference|correction_reason|owner_auth_user_id|email/.test(seasonSeen.text)
        &&season.body.weeks.every(w=>w.visibility==='after_deadline'||(w.games===null&&w.result===null&&w.submissions===null)),
        'the season input names no attester, evidence or owner, and seals every week before its deadline');
      await page.goto(`${origin}/commissioner.html?pool=${scenario.pool.slug}`);
      await panel.openWeek(page,scenario.weekId,scenario.pool.name);
      const rendered=await seasonStatus(page).filter({hasText:SEASON_CARD_RENDERED}).waitFor({state:'visible',timeout}).then(()=>true,()=>false);
      expect(rendered,'the commissioner page shows season standings computed from that input',
        (await seasonStatus(page).textContent().catch(()=>''))??'');
      const shownRows=(await panel.cardRows(page,'seasonStandingsCard')).map(cells=>cells.slice(0,2));
      expect(JSON.stringify(shownRows)===JSON.stringify(seasonSeen.expected.rows),
        'the season card shows exactly the standings an independent recount of that input gives',
        seasonSeen.expected.weeks?`${seasonSeen.expected.rows.length} entries through week ${seasonSeen.expected.through}`
          +(seasonSeen.expected.outForNoPick===null?'':`, ${seasonSeen.expected.outForNoPick} out for a week without a pick`):'no week counted yet');
      for(const width of widths){
        await page.setViewportSize({width,height:850});
        const problems=await panel.cardLayoutProblems(page,width,['seasonStandingsCard','poolStandingsCard'],['seasonStandingsCard']);
        if(evidenceDir)await page.locator('#seasonStandingsCard').screenshot({path:path.join(evidenceDir,`signed-in-standings-commissioner-${width}px.png`)});
        expect(problems.length===0,`${width} CSS px: the commissioner’s standings cards fit the screen`,problems.join('; '));
      }
      await page.setViewportSize({width:1280,height:900});
      if(stored>0){
        const weekCard=await page.locator('#poolStandingsCard [data-standings-status]')
          .filter({hasText:new RegExp(`recorded by your commissioner · revision ${stored}( |$)`)}).waitFor({state:'visible',timeout}).then(()=>true,()=>false);
        expect(weekCard,'this week’s card shows the recorded finals at their latest revision',`revision ${stored}`);
      }
      if(scenario.commissioner.foreignSeason){
        const foreign=await rpc(page,'pool_platform_season_standings_snapshot',
          {p_pool_id:scenario.commissioner.foreignSeason.poolId,p_season:scenario.commissioner.foreignSeason.season});
        expect(foreign.message==='season_not_found','another tenant’s season standings are not found for the commissioner',refused(foreign));
      }
    }
  }
  await signOut(page);

  // ---- an account that is not a commissioner of this pool -----------------------------------------------------
  await signIn(page,scenario.participant,'/commissioner.html');
  const theirs=await rpc(page,'pool_platform_list_commissioner_pools',{});
  if(theirs.message==='auth_required'){
    record('BLOCKED','the backend accepts the second account’s token',
      'auth_required: pool_platform_current_user_id() resolves no subject for this account (a row in neon_auth.account, a ban, or a verified-email claim that differs from the stored flag)');
    return results;
  }
  expect(theirs.status===200&&Array.isArray(theirs.body)&&!theirs.body.some(p=>p.slug===scenario.pool.slug),
    'the second account is not offered the pool as a commissioner',refused(theirs));
  if(scenario.participant.commissionerOfNothing){
    const none=await panel.shown(page,'poolPickerError',/No pools are assigned to this account/,timeout).then(()=>true,()=>false);
    expect(none&&Array.isArray(theirs.body)&&theirs.body.length===0,'a participant-only account has no commissioner pool at all');
  }
  await page.goto(`${origin}/commissioner.html?pool=${scenario.pool.slug}`);
  await page.locator('#signOut').waitFor({state:'visible',timeout});
  // The page settles on the pool chooser, or on a pool of the account's own (a commissioner elsewhere).
  await page.waitForFunction(()=>['poolPickerCard','consoleCard'].some(id=>document.getElementById(id)?.getClientRects().length),null,{timeout});
  const opened=await page.locator('#consoleCard').isVisible()?await page.locator('#poolName').textContent():'';
  expect(!opened.includes(scenario.pool.name)&&(!scenario.participant.commissionerOfNothing||!await page.locator('#finalResultAdmin').isVisible()),
    'the pool’s link does not open the pool or its final-score panel',opened?`opened their own pool instead`:'pool chooser shown');
  const denied=await rpc(page,'pool_platform_commissioner_context',{p_pool_slug:scenario.pool.slug});
  expect(denied.message==='commissioner_required','the commissioner context is refused',refused(denied));
  const theirWrite=await rpc(page,'pool_platform_attest_week_final_results_with_source',attest(scenario.weekId,NEVER_A_REVISION,scores(0),'Non-commissioner write probe'));
  expect(theirWrite.message==='week_not_found','the second account cannot write results for the week',refused(theirWrite));
  const theirOld=await rpc(page,'pool_platform_attest_week_final_results',retired(scenario.weekId,scores(0)));
  expect(theirOld.status>=400,'the retired RPC is refused for the second account as well',refused(theirOld));
  const readable=await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:scenario.participant.readableWeekId});
  expect(readable.status===200&&Object.keys(readable.body??{}).every(key=>RESULT_KEYS.includes(key))&&
    (!write||scenario.participant.readableWeekId!==scenario.weekId||readable.body.revision===revision+1),
    'an entry owner reads the attested result of their own pool, without attester or evidence',
    `${readable.body?.status??refused(readable)}${readable.body?.revision?` revision ${readable.body.revision}`:''}`);
  const unreadable=await rpc(page,'pool_platform_week_result_snapshot',{p_week_id:scenario.participant.foreignWeekId});
  expect(unreadable.message==='week_not_found','a pool they have no entry in cannot be read',refused(unreadable));
  const evidence=await panel.readTable(page,dataApi,'pool_platform_week_result_evidence');
  expect(!(evidence.rows>0),'the second account reads no evidence row',`${evidence.status}`);
  // Their own entry in this pool, and a pick for the week under test now that its deadline has passed.
  const own=await rpc(page,'pool_platform_participant_context',{p_pool_slug:scenario.pool.slug,p_season:seasonNumber,p_week:week.week});
  const ownEntry=(own.body?.entries??[]).find(e=>e.status==='active');
  if(expect(own.status===200&&Boolean(ownEntry),'the second account reads its own entry in this pool, and only its own',
    own.status===200?`${own.body.entries.length} of its own`:refused(own))){
    const latePick=await rpc(page,'pool_platform_submit_entry',{p_week_id:scenario.weekId,p_entry_id:ownEntry.id,p_source:'participant',p_payload:NOT_A_PICK});
    expect(LATE.includes(latePick.message),'a pick for the week under test is refused after its deadline',refused(latePick));
    const asCommissioner=await rpc(page,'pool_platform_submit_entry',{p_week_id:scenario.weekId,p_entry_id:ownEntry.id,p_source:'commissioner_manual',p_payload:NOT_A_PICK});
    expect(asCommissioner.message==='commissioner_required','the second account cannot enter a pick the way a commissioner does',refused(asCommissioner));
    const theirImport=await rpc(page,'pool_platform_submit_batch',{p_week_id:scenario.weekId,p_source:'commissioner_import',p_items:[{entry_id:ownEntry.id,payload:NOT_A_PICK}]});
    expect(theirImport.message==='commissioner_required','the second account cannot import picks',refused(theirImport));
  }
  if(standings&&seasonSeen){
    const theirSeason=await rpc(page,'pool_platform_season_standings_snapshot',{p_pool_id:seasonSeen.poolId,p_season:seasonSeen.seasonNumber});
    expect(theirSeason.status===200&&JSON.stringify(theirSeason.body)===seasonSeen.text,
      'an entry owner reads the same season standings input as the commissioner, nothing more or less',refused(theirSeason));
    if(scenario.participant.foreignSeason){
      const foreign=await rpc(page,'pool_platform_season_standings_snapshot',
        {p_pool_id:scenario.participant.foreignSeason.poolId,p_season:scenario.participant.foreignSeason.season});
      expect(foreign.message==='season_not_found','a season they have no entry in is not found for the second account',refused(foreign));
    }
    await page.goto(`${origin}/participant.html?pool=${scenario.pool.slug}`);
    const theirCard=await seasonStatus(page).filter({hasText:SEASON_CARD_RENDERED}).waitFor({state:'visible',timeout}).then(()=>true,()=>false);
    expect(theirCard,'the participant page shows the season standings',(await seasonStatus(page).textContent().catch(()=>''))??'');
    if(theirCard){
      const theirRows=(await panel.cardRows(page,'seasonStandingsCard')).map(cells=>cells.slice(0,2));
      expect(JSON.stringify(theirRows)===JSON.stringify(seasonSeen.expected.rows),
        'the participant page shows the same standings as the independent recount',`${seasonSeen.expected.rows.length} entries`);
      for(const width of widths){
        await page.setViewportSize({width,height:850});
        const problems=await panel.cardLayoutProblems(page,width,['seasonStandingsCard','poolStandingsCard'],['seasonStandingsCard']);
        if(evidenceDir)await page.locator('#seasonStandingsCard').screenshot({path:path.join(evidenceDir,`signed-in-standings-participant-${width}px.png`)});
        expect(problems.length===0,`${width} CSS px: the participant’s standings cards fit the screen`,problems.join('; '));
      }
      await page.setViewportSize({width:1280,height:900});
    }
  }
  return results;
}

// The check to run BEFORE the issuer row of a backend is changed: one sign-in, and only the issuer and audience
// claims of the real token come back, never the token. pool_platform_current_user_id() compares both claims, with
// trailing slashes removed, to pool_platform_private.auth_issuer, so `valueToStore` is exactly what that row must
// hold. `backendAccepts` says whether the row already does.
export async function runIssuerCheck({newPage,origin,dataApi,account,signIn,signOut,expectedAuthOrigin,log=()=>{}}){
  const results=[];
  const record=(result,check,detail='')=>{results.push({result,check,detail});log(`${result.padEnd(7)} ${check}${detail?` — ${detail}`:''}`)};
  const expect=(ok,check,detail='')=>{record(ok?'PASS':'FAIL',check,detail);return ok};
  const withoutTrailingSlash=value=>typeof value==='string'?value.replace(/\/+$/,''):null;
  const urlOf=value=>{try{return new URL(value)}catch{return null}};
  const page=await newPage();
  await signIn(page,account,'/commissioner.html');
  const facts=await panel.tokenFacts(page);
  if(!expect(Boolean(facts),'the signed-in page holds a session token'))return{results,iss:null,aud:null,valueToStore:null,backendAccepts:null};
  const valueToStore=withoutTrailingSlash(facts.iss);
  expect(urlOf(facts.iss)?.protocol==='https:','the issuer claim is an https URL',`iss ${facts.iss}`);
  expect(urlOf(facts.iss)!==null&&urlOf(facts.iss).origin===urlOf(expectedAuthOrigin)?.origin,
    'the token was issued by this backend’s own Auth',`expected origin ${urlOf(expectedAuthOrigin)?.origin}`);
  expect(withoutTrailingSlash(facts.aud)!==null&&withoutTrailingSlash(facts.aud)===valueToStore,
    'the audience claim equals the issuer claim',`aud ${facts.aud}`);
  const probe=await panel.rpc(page,dataApi,'pool_platform_list_commissioner_pools',{});
  const backendAccepts=probe.status===200?true:probe.message==='auth_required'?false:null;
  if(backendAccepts===null)record('FAIL','the backend answers the identity probe',refused(probe));
  await signOut(page);
  await page.close();
  return{results,iss:facts.iss,aud:facts.aud,valueToStore,backendAccepts};
}

export const summarize=results=>({pass:results.filter(r=>r.result==='PASS').length,fail:results.filter(r=>r.result==='FAIL').length,
  blocked:results.filter(r=>r.result==='BLOCKED').length});
