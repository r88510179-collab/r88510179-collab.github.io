// Release rehearsal on a disposable PostgreSQL: the scripts in ops/release, run with psql exactly as the operator
// runs them, against a database whose schema is fingerprint-identical to the live Commercial database before this
// release and whose rows have the same shape (tests/release/production-replica-*.sql). It covers what must hold on
// the day: the right target or nothing, every existing row unchanged, privileges as reviewed or a full rollback,
// tenant isolation and identity rules after the migration, every production-shaped week closed to final scores,
// invitation retirement without losing a claim, and a rollback that returns the exact starting schema.
//
// Opt-in, like migration-integration.test.mjs:
//   POOL_PLATFORM_TEST_PG_CLUSTER=postgresql://postgres@127.0.0.1:5432/postgres node --test tests/release-rehearsal.test.mjs
// The cluster must be a loopback server that can be thrown away: the database neondb is DROPPED and re-created.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const CLUSTER=process.env.POOL_PLATFORM_TEST_PG_CLUSTER||'';
const SKIP=CLUSTER?false:'set POOL_PLATFORM_TEST_PG_CLUSTER to a disposable local superuser URL';
const appDir=path.resolve(import.meta.dirname,'..');
// The whole application schema of the live Commercial database before this release, as one MD5 of
// tests/release/catalog-snapshot.sql, read from its catalog (read-only) on 2026-11-18.
const LIVE_SCHEMA_MD5='3c180188e88e4d753c1e06260f0b5712';
const TARGET=['-v','expected_project=rehearsal-project','-v','expected_branch=br-rehearsal'];
const ISSUER='https://rehearsal-auth.invalid';
const ID=Object.freeze({
  commissioner:'a0000000-0000-4000-8000-000000000001',passwordCommissioner:'a0000000-0000-4000-8000-000000000002',
  one:'a0000000-0000-4000-8000-000000000004',two:'a0000000-0000-4000-8000-000000000005',
  unverified:'a0000000-0000-4000-8000-000000000007',three:'a0000000-0000-4000-8000-000000000008',
  newcomer:'a0000000-0000-4000-8000-000000000011'});

function neondbUrl(){
  const url=new URL(CLUSTER);
  if(!['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname))throw new Error('the rehearsal only uses a loopback PostgreSQL');
  url.pathname='/neondb';
  return url.href;
}
function psql(url,args,{input,role}={}){
  const run=spawnSync('psql',[url,'-X','-q','-A','-t',...args],{cwd:appDir,input,encoding:'utf8',
    env:{...process.env,...(role?{PGOPTIONS:`-c role=${role}`}:{})}});
  return {code:run.status,out:run.stdout.trim(),err:run.stderr.trim()};
}
// As a superuser of the disposable cluster: setup and readback only.
function admin(sql,url=neondbUrl()){
  const run=psql(url,['-v','ON_ERROR_STOP=1'],{input:sql});
  assert.equal(run.code,0,run.err);
  return run.out;
}
// A release script, as the operator runs it: psql -f, as the role that owns the application.
const release=(file,extra=[])=>psql(neondbUrl(),[...TARGET,...extra,'-f',`ops/release/${file}`],{role:'neondb_owner'});
const schemaSnapshot=()=>admin(fs.readFileSync(path.join(appDir,'tests/release/catalog-snapshot.sql'),'utf8'));
const md5=text=>crypto.createHash('md5').update(text).digest('hex');
const schemaMd5=()=>admin(`WITH s AS (${fs.readFileSync(path.join(appDir,'tests/release/catalog-snapshot.sql'),'utf8')}) SELECT md5(snapshot::text) FROM s`);
// What ops/release/baseline.sql prints for the ten original tables, as the operator would compare it.
function baseline(){
  const run=release('baseline.sql');
  assert.equal(run.code,0,run.err);
  const values=Object.fromEntries(run.out.split('\n').filter(line=>line.includes('|')).map(line=>{const at=line.indexOf('|');return [line.slice(0,at),line.slice(at+1)]}));
  const tables=['tenants','memberships','pools','seasons','entries','weeks','submissions','audit','invites','auth_issuer'];
  for(const name of tables)assert.match(values[name]??'',/^\d+:[0-9a-f]{32}$/,name);
  return {values,tables:Object.fromEntries(tables.map(name=>[name,values[name]]))};
}
const claims=(sub,{verified=true,iss=ISSUER,aud=ISSUER}={})=>JSON.stringify({sub,emailVerified:verified,iss,aud,role:'authenticated'});
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
// Requests as the Data API makes them: role authenticated (or anonymous) with the token's claims, one statement
// each. All steps share one transaction that is rolled back unless commit is set, so a scenario can write and leave
// nothing behind. A step is {as, sql} (a browser request), or {owner: sql} (the scenario's own setup).
function requests(steps,{commit=false}={}){
  const script=['\\set ON_ERROR_ROLLBACK on','\\set VERBOSITY terse','BEGIN;'];
  steps.forEach((step,i)=>{
    script.push(`\\echo @@${i}`);
    if(step.owner){script.push('RESET ROLE;',step.owner.trim().replace(/;?$/,';'));return}
    // sql is an expression whose value is returned; statement is sent as it is (a direct table write, say).
    script.push(`SET LOCAL ROLE ${step.as===null?'anonymous':'authenticated'};`,
      `SELECT set_config('request.jwt.claims',${quote(step.as===null?'':step.as)},true) \\gset discard_`,
      step.statement?step.statement.trim().replace(/;?$/,';'):`SELECT (${step.sql})::text;`);
  });
  script.push('\\echo @@end',commit?'COMMIT;':'ROLLBACK;');
  // Both streams merged, so an error message lands between the markers of the step that raised it.
  const merged=spawnSync('bash',['-c','psql "$0" -X -q -A -t -f - 2>&1',neondbUrl()],{cwd:appDir,input:script.join('\n'),encoding:'utf8'});
  const chunks=merged.stdout.split(/^@@(?:\d+|end)$/m).slice(1,-1);
  assert.equal(chunks.length,steps.length,merged.stdout);
  return chunks.map(chunk=>{
    const error=/ERROR:\s+(.*)/.exec(chunk);
    return error?{ok:false,error:error[1].trim()}:{ok:true,value:chunk.trim()};
  });
}
const json=result=>{assert.ok(result.ok,result.error);return JSON.parse(result.value)};
const refused=(result,pattern)=>{assert.equal(result.ok,false,`expected a refusal, got ${result.value}`);assert.match(result.error,pattern)};
const weekId=(pool,week)=>admin(`SELECT w.id FROM public.pool_platform_weeks w JOIN public.pool_platform_seasons s ON s.id=w.season_id
  JOIN public.pool_platform_pools p ON p.id=s.pool_id WHERE p.slug=${quote(pool)} AND w.week=${week}`);
const count=sql=>Number(admin(`SELECT count(*) FROM ${sql}`));

test('release rehearsal on a database shaped like the live Commercial database',{skip:SKIP},async t=>{
  // ---- a fresh replica ---------------------------------------------------------------------------------------
  neondbUrl();
  assert.equal(admin("SELECT COALESCE(current_setting('neon.project_id',true),'')",CLUSTER),'','the cluster must not be a Neon compute');
  admin('DROP DATABASE IF EXISTS neondb WITH (FORCE)',CLUSTER);
  admin('CREATE DATABASE neondb',CLUSTER);
  for(const file of ['production-replica-schema.sql','production-replica-data.sql']){
    const run=psql(neondbUrl(),['-v','ON_ERROR_STOP=1','--single-transaction','-f',`tests/release/${file}`]);
    assert.equal(run.code,0,run.err);
  }
  const startingSchema=schemaSnapshot();
  let before;

  await t.test('the replica is the live schema, and holds 267 rows and 12 identities as production does',()=>{
    assert.equal(schemaMd5(),LIVE_SCHEMA_MD5,'the replica schema differs from the schema recorded from the live catalog');
    before=baseline();
    assert.equal(before.values.application_rows,'267');
    assert.match(before.values.identities,/^12:/);
    assert.equal(before.values.identities_the_app_accepts,'5');
    assert.deepEqual([before.values.memberships_without_identity,before.values.claimed_entries_without_identity,before.values.claimed_entries],['0','0','42']);
    assert.deepEqual([before.values.outstanding_legacy_invitations,before.values.release_schema_installed,before.values.legacy_invitations_callable,
      before.values.pool_platform_functions,before.values.functions_callable_without_sign_in],['0','f','t','14','0']);
  });

  await t.test('the wrong project or branch is refused before anything changes',()=>{
    for(const args of [['-v','expected_project=fancy-brook-65396623','-v','expected_branch=br-rehearsal'],
      ['-v','expected_project=rehearsal-project','-v','expected_branch=br-other'],
      ['-v','expected_project=','-v','expected_branch=']]){
      const run=psql(neondbUrl(),[...args,'-f','ops/release/predeploy.sql'],{role:'neondb_owner'});
      assert.notEqual(run.code,0);assert.match(run.err,/commercial_release_target_mismatch/);
    }
    assert.equal(schemaSnapshot(),startingSchema);
  });

  await t.test('a privilege the review did not see stops the release and rolls all of it back',()=>{
    // Default privileges like these exist on some Neon databases. The migrations revoke from PUBLIC only, so a
    // function or table created under them would be reachable by a role nobody reviewed.
    const hazards=[
      ['GRANT EXECUTE ON FUNCTIONS TO anonymous','REVOKE EXECUTE ON FUNCTIONS FROM anonymous',/is callable without signing in/],
      ['GRANT SELECT,INSERT ON TABLES TO authenticated','REVOKE SELECT,INSERT ON TABLES FROM authenticated',/a signed-in browser can write public\.pool_platform_week_result_/],
      ['GRANT SELECT ON TABLES TO anonymous','REVOKE SELECT ON TABLES FROM anonymous',/is reachable without signing in/]];
    for(const [grant,revoke,message] of hazards){
      admin(`ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public ${grant}`);
      const run=release('predeploy.sql');
      admin(`ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public ${revoke}`);
      assert.notEqual(run.code,0,grant);
      assert.match(run.err,/commercial_release_postcondition_failed/);assert.match(run.err,message);
      assert.equal(schemaSnapshot(),startingSchema,`${grant}: nothing of the failed release is left`);
      assert.deepEqual(baseline().tables,before.tables);
    }
  });

  await t.test('a database that is not the rehearsed baseline is refused',()=>{
    admin(`CREATE OR REPLACE FUNCTION public.pool_platform_can_read_pool(p_pool_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path TO 'public','neon_auth','pg_temp' AS $$ SELECT true $$`);
    const run=release('predeploy.sql');
    assert.notEqual(run.code,0);
    assert.match(run.err,/commercial_release_baseline_mismatch: pool_platform_can_read_pool\(p_pool_id uuid\) has another body/);
    // Put the reviewed definition back: the one migration 002 holds.
    const source=fs.readFileSync(path.join(appDir,'migrations/002_identity_submission_rls.sql'),'utf8');
    const definition=/CREATE OR REPLACE FUNCTION public\.pool_platform_can_read_pool\(p_pool_id uuid\)[\s\S]*?\n\$\$;/.exec(source);
    admin(`SET ROLE neondb_owner;\n${definition[0]}`);
    assert.equal(schemaSnapshot(),startingSchema);
  });

  await t.test('before the release, every production-shaped week is closed to final scores and the audit says why',()=>{
    const run=release('kickoff-audit.sql');
    assert.equal(run.code,0,run.err);
    const lines=run.out.split('\n');
    assert.equal(lines.filter(line=>/\|BLOCKED: /.test(line)).length,28);
    assert.equal(lines.filter(line=>line.endsWith('|final scores can be recorded')).length,0);
    assert.equal(lines.filter(line=>/\|no kickoff recorded\|\d+$/.test(line)).length,142);
    assert.ok(lines.includes('28|20|28|20|20|142|142|61'),'weeks, with picks, blocked, with picks and blocked, with picks and no kickoffs, games, games without kickoff, picks');
    assert.deepEqual(baseline().tables,before.tables,'the audit changes nothing');
  });

  await t.test('predeployment: applied once, in one transaction, with every existing row unchanged',()=>{
    const run=release('predeploy.sql');
    assert.equal(run.code,0,run.err);
    assert.match(run.err,/schema and privileges are as reviewed: 26 browser functions, 6 private functions, 9 readable tables, 5 closed tables/);
    assert.match(run.err,/existing application rows unchanged/);
    const after=baseline();
    assert.deepEqual(after.tables,before.tables);
    assert.equal(after.values.identities,before.values.identities);
    assert.deepEqual([after.values.release_schema_installed,after.values.legacy_invitations_callable,after.values.pool_platform_functions,
      after.values.functions_callable_without_sign_in],['t','t','32','0']);
    const again=release('predeploy.sql');
    assert.notEqual(again.code,0);assert.match(again.err,/commercial_release_baseline_mismatch: .* exists but is not part of the baseline/);
    assert.deepEqual(baseline().tables,before.tables);
  });

  await t.test('after predeployment the previous frontend still works: its functions answer as before',()=>{
    const [context,legacy]=requests([
      {as:claims(ID.commissioner),sql:"public.pool_platform_commissioner_context('neighborhood-pickem')"},
      {as:claims(ID.commissioner),sql:`public.pool_platform_create_entry_invite((SELECT e.id FROM public.pool_platform_entries e WHERE e.entry_code='PK-INV-UNB'),NULL,168)`}]);
    assert.equal(json(context).pool.slug,'neighborhood-pickem');
    assert.match(json(legacy).invite_token,/^[0-9a-f]{64}$/);
  });

  await t.test('identity and tenant isolation hold for every new function',()=>{
    const pickemWeek=weekId('neighborhood-pickem',5),otherWeek=weekId('second-demo-pickem',1);
    const otherPool=admin("SELECT id FROM public.pool_platform_pools WHERE slug='second-demo-pickem'");
    const ownPool=admin("SELECT id FROM public.pool_platform_pools WHERE slug='neighborhood-pickem'");
    const anonymous=requests([
      {as:null,sql:'public.pool_platform_list_commissioner_pools()'},
      {as:null,sql:'public.pool_platform_list_participant_pools()'},
      {as:null,sql:`public.pool_platform_week_result_snapshot('${pickemWeek}')`},
      {as:null,sql:'(SELECT count(*) FROM public.pool_platform_pools)'},
      {as:null,sql:'(SELECT count(*) FROM public.pool_platform_email_invite_grants)'}]);
    for(const result of anonymous)refused(result,/permission denied/);
    // A token that is not this backend's, an unverified claim, and an account with a password: no identity.
    const noIdentity=requests([
      {as:claims(ID.commissioner,{iss:'https://another-auth.invalid'}),sql:'public.pool_platform_list_commissioner_pools()'},
      {as:claims(ID.commissioner,{aud:'https://another-auth.invalid'}),sql:'public.pool_platform_list_commissioner_pools()'},
      {as:claims(ID.commissioner,{verified:false}),sql:'public.pool_platform_list_commissioner_pools()'},
      {as:claims(ID.passwordCommissioner,{verified:false}),sql:'public.pool_platform_list_commissioner_pools()'},
      {as:claims('00000000-0000-4000-8000-000000000000'),sql:'public.pool_platform_list_participant_pools()'}]);
    for(const result of noIdentity)refused(result,/auth_required/);
    const [pools,foreignContext,foreignSeason,foreignWeek,foreignProjection,foreignEntry,foreignDraftWeek,foreignPool,
      participantPools,participantAsCommissioner,participantSeason,directTable,directClosed,directWrite]=requests([
      {as:claims(ID.commissioner),sql:'public.pool_platform_list_commissioner_pools()'},
      {as:claims(ID.commissioner),sql:"public.pool_platform_commissioner_context('second-demo-pickem')"},
      {as:claims(ID.commissioner),sql:`public.pool_platform_season_standings_snapshot('${otherPool}',2027)`},
      {as:claims(ID.commissioner),sql:`public.pool_platform_week_result_snapshot('${otherWeek}')`},
      {as:claims(ID.commissioner),sql:`public.pool_platform_week_projection_snapshot('${otherWeek}')`},
      {as:claims(ID.commissioner),sql:`public.pool_platform_create_entry((SELECT s.id FROM public.pool_platform_seasons s WHERE s.pool_id='${otherPool}'),'X-1','Intruder')`},
      {as:claims(ID.commissioner),sql:`public.pool_platform_create_draft_week((SELECT s.id FROM public.pool_platform_seasons s WHERE s.pool_id='${otherPool}'),9,now()+interval '7 days')`},
      {as:claims(ID.commissioner),sql:`public.pool_platform_create_pool((SELECT tenant_id FROM public.pool_platform_pools WHERE id='${otherPool}'),'Intruder Pool','pickem')`},
      {as:claims(ID.one),sql:'public.pool_platform_list_participant_pools()'},
      {as:claims(ID.one),sql:'public.pool_platform_list_commissioner_pools()'},
      {as:claims(ID.newcomer),sql:`public.pool_platform_season_standings_snapshot('${ownPool}',2027)`},
      {as:claims(ID.commissioner),sql:'(SELECT count(*) FROM public.pool_platform_pools)'},
      {as:claims(ID.commissioner),sql:'(SELECT count(*) FROM public.pool_platform_week_result_revisions)'},
      {as:claims(ID.commissioner),statement:"UPDATE public.pool_platform_weeks SET status='final'"}]);
    assert.deepEqual(json(pools).map(pool=>pool.slug).sort(),['neighborhood-pickem','neighborhood-survivor'],'only the pools of the commissioner\'s own group');
    refused(foreignContext,/commissioner_required/);refused(foreignSeason,/season_not_found/);
    // The other group's rows are not visible at all, so the subselects find nothing to act on.
    refused(foreignWeek,/week_not_found/);refused(foreignProjection,/week_not_found/);
    refused(foreignEntry,/commissioner_required/);refused(foreignDraftWeek,/commissioner_required/);refused(foreignPool,/commissioner_required/);
    assert.ok(json(participantPools).length>=1);
    assert.deepEqual(json(participantAsCommissioner),[]);
    refused(participantSeason,/season_not_found/);
    assert.equal(json(directTable),2,'row-level security shows a commissioner the two pools of the group and no other');
    refused(directClosed,/permission denied/);refused(directWrite,/permission denied/);
  });

  await t.test('final scores are refused for all 28 production-shaped weeks, and it is the missing kickoff that refuses them',()=>{
    const weeks=JSON.parse(admin(`SELECT jsonb_agg(jsonb_build_object('id',w.id,'pool',p.slug,'week',w.week,'status',w.status,'past',w.deadline_at<=now(),
      'games',(SELECT jsonb_agg(g->>'id') FROM jsonb_array_elements(w.config->'games') g)) ORDER BY p.slug,w.week)
      FROM public.pool_platform_weeks w JOIN public.pool_platform_seasons s ON s.id=w.season_id JOIN public.pool_platform_pools p ON p.id=s.pool_id`));
    assert.equal(weeks.length,28);
    const finals=games=>JSON.stringify(Object.fromEntries(games.map((id,i)=>[id,{status:'final',away_score:20+i,home_score:10}])));
    const attempt=week=>({as:claims(ID.commissioner),sql:`public.pool_platform_attest_week_final_results_with_source('${week.id}',0,${quote(finals(week.games))}::jsonb,repeat('a',64),'Rehearsal: no real result is recorded')`});
    // The commissioner is also made a commissioner of the second group here, so those two weeks are refused for
    // their schedule and deadline, not merely for belonging to another group. Rolled back with the scenario.
    const results=requests([{owner:`INSERT INTO public.pool_platform_memberships(tenant_id,auth_user_id,role)
      SELECT id,'${ID.commissioner}','commissioner' FROM public.pool_platform_tenants WHERE slug='second-demo-group'`},...weeks.map(attempt)]).slice(1);
    weeks.forEach((week,i)=>{
      const expected=week.past&&week.status!=='draft'?/game_not_started_or_schedule_missing/:/week_not_eligible_for_final_attestation/;
      refused(results[i],expected);
    });
    assert.equal(weeks.filter(week=>week.past&&week.status!=='draft').length,3,'three weeks have a passed deadline: only the kickoff stands between them and a recorded final');
    assert.equal(count('public.pool_platform_week_result_revisions'),0);
    // The same week with kickoff times, in a scenario that is rolled back: accepted. So the refusal above is the
    // missing kickoff and nothing else, and no real week would be closed by mistake.
    const target=weeks.find(week=>week.pool==='neighborhood-pickem'&&week.week===5);
    const [,recorded,standings,correction,participantView]=requests([
      {owner:`UPDATE public.pool_platform_weeks SET config=jsonb_set(config,'{games}',(SELECT jsonb_agg(g||'{"kickoff":"2026-09-27T17:00:00.000Z"}'::jsonb) FROM jsonb_array_elements(config->'games') g)) WHERE id='${target.id}'`},
      attempt(target),
      {as:claims(ID.commissioner),sql:`public.pool_platform_season_standings_snapshot((SELECT id FROM public.pool_platform_pools WHERE slug='neighborhood-pickem'),2027)`},
      {as:claims(ID.commissioner),sql:`public.pool_platform_attest_week_final_results_with_source('${target.id}',1,${quote(finals(target.games).replace('"away_score":20','"away_score":3'))}::jsonb,repeat('b',64),'Rehearsal: corrected against the same record','Rehearsal correction of game one')`},
      {as:claims(ID.one),sql:`public.pool_platform_week_result_snapshot('${target.id}')`}]);
    assert.deepEqual([json(recorded).revision,json(recorded).status],[1,'commissioner_attested_not_official']);
    assert.equal(json(standings).status,'commissioner_attested_not_official');
    assert.equal(json(correction).revision,2);
    assert.deepEqual([json(participantView).revision,json(participantView).status],[2,'commissioner_attested_not_official']);
    assert.equal(count('public.pool_platform_week_result_revisions'),0,'the scenario left nothing behind');
    assert.deepEqual(baseline().tables,before.tables);
  });

  await t.test('picks stay closed after a deadline and private before one',()=>{
    const past=weekId('neighborhood-pickem',5),future=weekId('neighborhood-pickem',7);
    const entry=admin(`SELECT e.id FROM public.pool_platform_entries e JOIN public.pool_platform_seasons s ON s.id=e.season_id
      JOIN public.pool_platform_pools p ON p.id=s.pool_id WHERE p.slug='neighborhood-pickem' AND e.owner_auth_user_id='${ID.one}' AND e.status='active'
        AND NOT EXISTS (SELECT 1 FROM public.pool_platform_submissions sub WHERE sub.entry_id=e.id) ORDER BY e.entry_code LIMIT 1`);
    const picks=`'{"picks":{"g1":"away","g2":"home","g3":"away","g4":"home","g5":"away"},"tiebreak":41}'::jsonb`;
    const [late,lateByCommissioner,onTime,sealed,sealedSeason,strangerWeek,strangerSeason]=requests([
      {as:claims(ID.one),sql:`public.pool_platform_submit_entry('${past}','${entry}','participant',${picks})`},
      {as:claims(ID.commissioner),sql:`public.pool_platform_submit_entry('${past}','${entry}','commissioner_manual',${picks})`},
      {as:claims(ID.one),sql:`public.pool_platform_submit_entry('${future}','${entry}','participant',${picks})`},
      {as:claims(ID.one),sql:`public.pool_platform_week_projection_snapshot('${future}')`},
      {as:claims(ID.one),sql:`public.pool_platform_season_standings_snapshot((SELECT id FROM public.pool_platform_pools WHERE slug='neighborhood-pickem'),2027)`},
      // Participant two has no entry in this pool: the week and the season do not exist for them.
      {as:claims(ID.two),sql:`public.pool_platform_week_projection_snapshot('${future}')`},
      {as:claims(ID.two),sql:`public.pool_platform_season_standings_snapshot((SELECT id FROM public.pool_platform_pools WHERE slug='neighborhood-pickem'),2027)`}]);
    refused(late,/deadline_passed/);refused(lateByCommissioner,/deadline_passed/);
    assert.equal(json(onTime).code,'created');
    assert.deepEqual([json(sealed).visibility,json(sealed).entries],['sealed',[]],'nobody else\'s pick is shown before the deadline');
    const season=json(sealedSeason).weeks.find(w=>w.week===7);
    assert.deepEqual([season.visibility,season.submissions,season.games],['sealed',null,null]);
    refused(strangerWeek,/week_not_found/);refused(strangerSeason,/season_not_found/);
  });

  await t.test('verified-email invitations: only the invited, verified person can claim, and a claim is never taken over',()=>{
    const entry=admin("SELECT id FROM public.pool_platform_entries WHERE entry_code='PK-INV-RACE1'");
    const [refusedParticipant,issued,wrongPerson,unverified,claimed,again,reissue,owned]=requests([
      {as:claims(ID.one),sql:`public.pool_platform_create_email_invite('${entry}','newcomer@example.test',168)`},
      {as:claims(ID.commissioner),sql:`public.pool_platform_create_email_invite('${entry}','  Newcomer@Example.Test ',168)`},
      {as:claims(ID.three),sql:`public.pool_platform_claim_email_invite('${entry}')`},
      {as:claims(ID.unverified,{verified:false}),sql:`public.pool_platform_claim_email_invite('${entry}')`},
      {as:claims(ID.newcomer),sql:`public.pool_platform_claim_email_invite('${entry}')`},
      {as:claims(ID.newcomer),sql:`public.pool_platform_claim_email_invite('${entry}')`},
      {as:claims(ID.commissioner),sql:`public.pool_platform_create_email_invite('${entry}','participant.three@example.test',168)`},
      {as:claims(ID.newcomer),sql:'public.pool_platform_list_participant_pools()'}]);
    refused(refusedParticipant,/commissioner_required/);
    assert.equal(json(issued).delivery,'verified_email');
    refused(wrongPerson,/invite_unavailable/);refused(unverified,/auth_required/);
    assert.deepEqual(json(claimed),{entry_id:entry,claimed:true});
    refused(again,/invite_unavailable/);refused(reissue,/entry_unavailable/);
    assert.deepEqual(json(owned).map(pool=>pool.slug),['neighborhood-pickem']);
    assert.equal(admin(`SELECT COALESCE(owner_auth_user_id,'unclaimed') FROM public.pool_platform_entries WHERE id='${entry}'`),'unclaimed','the scenario was rolled back');
  });

  await t.test('legacy invitations are retired only when none is outstanding, and no claim is lost',()=>{
    const ownership=()=>admin("SELECT md5(string_agg(id::text||':'||COALESCE(owner_auth_user_id,''),',' ORDER BY id::text)) FROM public.pool_platform_entries");
    const owners=ownership();
    // A commissioner on the frontend still published issues a legacy link: it must be reviewed before retirement.
    const [outstanding]=requests([{as:claims(ID.commissioner),sql:`public.pool_platform_create_entry_invite((SELECT e.id FROM public.pool_platform_entries e WHERE e.entry_code='PK-INV-UNB'),NULL,168)`}],{commit:true});
    assert.match(json(outstanding).invite_token,/^[0-9a-f]{64}$/);
    const withOutstanding=baseline();
    assert.equal(withOutstanding.values.outstanding_legacy_invitations,'1');
    const blocked=release('retire-legacy-invites.sql');
    assert.notEqual(blocked.code,0);assert.match(blocked.err,/outstanding_legacy_invitations_require_review/);
    assert.equal(baseline().values.legacy_invitations_callable,'t','a refused retirement retires nothing');
    // The commissioner replaced that link with a verified-email invitation; the legacy one is revoked.
    admin("UPDATE public.pool_platform_entry_invites SET revoked_at=now() WHERE claimed_at IS NULL AND revoked_at IS NULL AND expires_at>now()");
    const ready=baseline();
    const retired=release('retire-legacy-invites.sql');
    assert.equal(retired.code,0,retired.err);
    const after=baseline();
    assert.deepEqual(after.tables,ready.tables,'every invitation and every claimed entry is exactly as it was');
    assert.deepEqual([after.values.legacy_invitations_callable,after.values.claimed_entries,after.values.functions_callable_without_sign_in],['f','42','0']);
    assert.equal(ownership(),owners);
    const [legacyIssue,legacyClaim,stillMine,newFlow]=requests([
      {as:claims(ID.commissioner),sql:`public.pool_platform_create_entry_invite((SELECT e.id FROM public.pool_platform_entries e WHERE e.entry_code='PK-INV-UNB'),NULL,168)`},
      {as:claims(ID.one),sql:`public.pool_platform_claim_entry_invite(repeat('a',64))`},
      {as:claims(ID.one),sql:"public.pool_platform_participant_context('neighborhood-pickem',2027,7)"},
      {as:claims(ID.commissioner),sql:`public.pool_platform_create_email_invite((SELECT e.id FROM public.pool_platform_entries e WHERE e.entry_code='PK-INV-UNB'),'newcomer@example.test',168)`}]);
    refused(legacyIssue,/permission denied/);refused(legacyClaim,/permission denied/);
    assert.ok(json(stillMine).entries.length>=1,'an entry claimed through a legacy invitation is still its owner\'s');
    assert.equal(json(newFlow).delivery,'verified_email');
  });

  await t.test('rollback: refused while it would strand or destroy something, then exact',()=>{
    const stranded=release('rollback-predeploy.sql');
    assert.notEqual(stranded.code,0);assert.match(stranded.err,/commercial_release_rollback_refused: run restore-legacy-invites\.sql first/);
    const restored=release('restore-legacy-invites.sql');
    assert.equal(restored.code,0,restored.err);
    assert.equal(baseline().values.legacy_invitations_callable,'t');
    // Rows made since the release would be destroyed with their tables.
    admin(`INSERT INTO public.pool_platform_email_invite_grants(entry_id,email_normalized,expires_at,created_by_auth_user_id)
      SELECT id,'kept@example.test',now()+interval '1 day','${ID.commissioner}' FROM public.pool_platform_entries WHERE entry_code='PK-INV-UNB'`);
    const destructive=release('rollback-predeploy.sql');
    assert.notEqual(destructive.code,0);assert.match(destructive.err,/commercial_release_rollback_refused: rows would be destroyed \(pool_platform_email_invite_grants 1\)/);
    admin('DELETE FROM public.pool_platform_email_invite_grants');
    const data=baseline();
    const rolledBack=release('rollback-predeploy.sql');
    assert.equal(rolledBack.code,0,rolledBack.err);
    assert.equal(schemaSnapshot(),startingSchema,'the schema is exactly the one the release started from');
    assert.equal(schemaMd5(),LIVE_SCHEMA_MD5);
    assert.deepEqual(baseline().tables,data.tables);
    const absent=release('rollback-predeploy.sql');
    assert.notEqual(absent.code,0);assert.match(absent.err,/commercial_release_rollback_refused: the release is not installed/);
  });

  await t.test('kickoff repair: only from a verified schedule that is this slate, a dry run by default, picks untouched',()=>{
    const week=weekId('neighborhood-pickem',5),repair=(extra=[])=>release('kickoff-repair.sql',['-v',`week_id=${week}`,...extra]);
    // Rolled back, the database has no schedule catalog. The repair says so, instead of failing on a missing table.
    const uninstalled=repair(['-v','apply=yes']);
    assert.notEqual(uninstalled.code,0);
    assert.match(uninstalled.err,/kickoff_repair_refused: the release is not installed on this database/);
    assert.doesNotMatch(uninstalled.err,/does not exist/);
    assert.equal(release('predeploy.sql').code,0,'the release installs again after a rollback');
    const picks=()=>admin("SELECT md5(string_agg(to_jsonb(s)::text,'|' ORDER BY s.id::text))||':'||(SELECT md5(string_agg(to_jsonb(a)::text,'|' ORDER BY a.id)) FROM public.pool_platform_submission_audit a) FROM public.pool_platform_submissions s");
    const picksBefore=picks(),weekBefore=admin(`SELECT md5(to_jsonb(w)::text) FROM public.pool_platform_weeks w WHERE id='${week}'`);
    const refusal=(run,pattern)=>{assert.notEqual(run.code,0);assert.match(run.err,pattern);assert.equal(admin(`SELECT md5(to_jsonb(w)::text) FROM public.pool_platform_weeks w WHERE id='${week}'`),weekBefore)};
    refusal(release('kickoff-repair.sql'),/kickoff_repair_refused: pass -v week_id=<uuid>/);
    refusal(repair(['-v','apply=yes']),/kickoff_repair_refused: no verified schedule is loaded for season 2027 week 5/);
    const catalog=(games,verifiedAt='now()')=>admin(`INSERT INTO public.pool_platform_verified_schedule_catalog
      (season,week,source,source_url,source_sha256,raw_source_sha256,source_fetched_at,verified_at,games,bye_teams)
      VALUES (2027,5,'nflverse_schedules','https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv',
        repeat('c',64),repeat('d',64),now(),${verifiedAt},${quote(JSON.stringify(games))}::jsonb,'[]'::jsonb)
      ON CONFLICT (season,week) DO UPDATE SET games=EXCLUDED.games,verified_at=EXCLUDED.verified_at`);
    const slate=[['NYG','DAL'],['NYJ','BUF'],['PHI','WAS'],['KC','DEN'],['SF','SEA']];
    const verified=(pairs,kickoff='2026-09-27T17:00:00.000Z')=>pairs.map(([away,home])=>({id:`2027_05_${away}_${home}`,away:{key:away},home:{key:home},kickoff}));
    // Synthetic rows that stand in for a verified schedule: this test never claims they are one.
    catalog(verified([...slate.slice(0,4),['SF','LAR']]));
    refusal(repair(['-v','apply=yes']),/the stored slate is not the verified slate for season 2027 week 5 \(5 stored games, 5 verified games, 4 with the same teams\)/);
    catalog(verified(slate.slice(0,4)));
    refusal(repair(['-v','apply=yes']),/the stored slate is not the verified slate/);
    catalog(verified(slate,'2026-09-20T17:00:00.000Z'));
    refusal(repair(['-v','apply=yes']),/a verified kickoff is earlier than the pick deadline/);
    for(const invalid of ['2026-09-27T24:00:00Z','2026-09-27T23:59:60Z','2026-02-30T17:00:00Z']){
      catalog(verified(slate,invalid));
      refusal(repair(['-v','apply=yes']),/the verified schedule holds a kickoff that is not a UTC timestamp/);
    }
    catalog(verified(slate),"now()-interval '49 hours'");
    refusal(repair(['-v','apply=yes']),/not within the last 48 hours/);
    catalog(verified(slate));
    const dry=repair();
    assert.equal(dry.code,0,dry.err);assert.match(dry.out,/DRY RUN: nothing was changed/);
    assert.equal(admin(`SELECT md5(to_jsonb(w)::text) FROM public.pool_platform_weeks w WHERE id='${week}'`),weekBefore);
    assert.equal(count('public.pool_platform_week_operations_audit'),0);
    const applied=repair(['-v','apply=yes']);
    assert.equal(applied.code,0,applied.err);assert.match(applied.out,/APPLIED/);
    const stored=JSON.parse(admin(`SELECT config::text FROM public.pool_platform_weeks WHERE id='${week}'`));
    assert.deepEqual(stored.games.map(game=>[game.id,game.away.key,game.home.key,game.kickoff]),
      slate.map(([away,home],i)=>[`g${i+1}`,away,home,'2026-09-27T17:00:00.000Z']),'ids and teams as stored; only the kickoff is new');
    assert.deepEqual([stored.kickoffSource,stored.kickoffDigest,stored.tiebreakRequired],['nflverse_schedules','c'.repeat(64),true]);
    assert.equal(picks(),picksBefore,'every pick and its audit trail are byte for byte the same');
    assert.equal(admin("SELECT action||':'||actor_auth_user_id||':'||previous_status||':'||next_status FROM public.pool_platform_week_operations_audit"),
      'verified_schedule_import:operator:postgres:open:open');
    assert.equal(count(`public.pool_platform_weeks w WHERE w.id<>'${week}' AND EXISTS (SELECT 1 FROM jsonb_array_elements(w.config->'games') g WHERE g ? 'kickoff')`),0,'no other week was touched');
    const audit=release('kickoff-audit.sql');
    assert.equal(audit.code,0,audit.err);
    assert.equal(audit.out.split('\n').filter(line=>line.endsWith('|final scores can be recorded')).length,1);
    assert.ok(audit.out.split('\n').includes('28|20|27|19|19|142|137|61'));

    // Corrupt only the disposable week to verify the audit reports invalid timestamps without casting them.
    admin(`UPDATE public.pool_platform_weeks SET config=jsonb_set(jsonb_set(jsonb_set(config,
      '{games,0,kickoff}','"2026-09-27T24:00:00Z"'),'{games,1,kickoff}','"2026-09-27T23:59:60Z"'),
      '{games,2,kickoff}','"2026-02-30T17:00:00Z"') WHERE id='${week}'`);
    const corrupt=baseline();
    const blocked=release('kickoff-audit.sql');
    assert.equal(blocked.code,0,blocked.err);
    assert.equal(blocked.out.split('\n').filter(line=>line.includes('kickoff is not a stored UTC timestamp')).length,3);
    assert.ok(blocked.out.split('\n').includes('28|20|28|20|20|142|140|61'));
    assert.deepEqual(baseline().tables,corrupt.tables,'the audit is read-only even on malformed data');
  });
});
