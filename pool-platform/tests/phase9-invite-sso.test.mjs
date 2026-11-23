import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {participantInviteUrl,readInviteFromUrl,authErrorMessage}
  from '../auth-core.js';

const root=path.resolve(import.meta.dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const entry='12345678-1234-4234-8234-123456789abc';
const page='https://pool.example.test/participant.html';
const pool='sample-pickem';
const token='a'.repeat(64);

test('new invitation URL puts nonsecret pool and entry in the PATH, no query or fragment',()=>{
  const href=participantInviteUrl(page,pool,entry),url=new URL(href);
  assert.equal(url.pathname,'/join/'+pool+'/'+entry);
  assert.equal(url.search,'');
  assert.equal(url.hash,'');
  assert.equal(href.includes(token),false);
});
test('existing query and fragment cannot contaminate the new generated route',()=>{
  const href=participantInviteUrl(page+'?invite='+token+'#invite='+token,pool,entry);
  assert.equal(href.includes(token),false);
  assert.equal(new URL(href).search,'');
  assert.equal(new URL(href).hash,'');
});
test('SSO requested_path needs no query to retain the invitation target',()=>{
  const href=participantInviteUrl(page,pool,entry);
  const requestedPath=new URL(href).pathname;
  const handoff=new URL('https://example.invalid/netlify-sso?requested_path='+
    encodeURIComponent(requestedPath));
  const restored='https://pool.example.test'+
    handoff.searchParams.get('requested_path');
  assert.equal(readInviteFromUrl(restored).entryId,entry);
  assert.equal(handoff.href.includes(token),false);
  assert.equal(new URL(restored).search,'');
  assert.equal(new URL(restored).hash,'');
});
test('path invitation parser restores pool in cleaned participant URL',()=>{
  const decoded=readInviteFromUrl(participantInviteUrl(page,pool,entry));
  assert.deepEqual(decoded,{found:true,entryId:entry,cleanUrl:'/participant.html?pool='+pool,error:''});
});
test('path invite accepts matching nonsecret pool query but refuses ambiguity',()=>{
  const target=participantInviteUrl(page,pool,entry);
  assert.equal(readInviteFromUrl(target+'?pool='+pool).entryId,entry);
  for(const href of [
    target+'?pool=unrelated-pool',
    target+'?pool='+pool+'&pool='+pool,
    target+'?entry='+entry,
    target+'#example',
    target+'?pool='+pool+'#invite='+token
  ]){
    assert.equal(readInviteFromUrl(href).entryId,'');
    assert.notEqual(readInviteFromUrl(href).error,'');
  }
});
test('legacy fragment bearer token is rejected, never returned or preserved',()=>{
  const read=readInviteFromUrl(page+'?pool='+pool+'#invite='+token);
  assert.equal(read.found,true);assert.equal(read.entryId,'');
  assert.equal(read.error,'invite_link_retired');
  assert.equal(JSON.stringify(read).includes(token),false);
  assert.equal(read.cleanUrl,'/participant.html?pool='+pool);
});
test('legacy query bearer token is rejected, never returned or preserved',()=>{
  const read=readInviteFromUrl(page+'?pool='+pool+'&invite='+token);
  assert.equal(read.error,'invite_link_retired');
  assert.equal(JSON.stringify(read).includes(token),false);
  assert.equal(read.cleanUrl,'/participant.html?pool='+pool);
});
test('a retired bearer token cannot be combined with a new path invitation',()=>{
  const read=readInviteFromUrl(participantInviteUrl(page,pool,entry)+'?invite='+token);
  assert.equal(read.error,'invite_link_retired');
  assert.equal(read.entryId,'');
});
test('old token-free query entry links still work during transition',()=>{
  const old=readInviteFromUrl(page+'?pool='+pool+'&entry='+entry);
  assert.deepEqual(old,{found:true,entryId:entry,cleanUrl:'/participant.html?pool='+pool,error:''});
});
test('duplicate or invalid query entry IDs and malformed path IDs are rejected',()=>{
  for(const href of [
    page+'?entry='+entry+'&entry='+entry,
    page+'?entry=bad',page+'?entry='+token,page+'?entry=',
    '/join/'+pool+'/invalid',
    '/join/'+pool+'/'+entry+'/extra',
    '/join/invalid_pool/'+entry
  ]){
    const result=readInviteFromUrl(new URL(href,page));
    assert.notEqual(result.error,'');
    assert.equal(result.entryId,'');
  }
  assert.throws(()=>participantInviteUrl(page,pool,token),/Invalid entry/);
  assert.throws(()=>participantInviteUrl(page,'not valid',entry),/Invalid pool/);
});
test('plain participant page navigation has no pending invitation or error',()=>{
  assert.deepEqual(readInviteFromUrl(page+'?pool='+pool),
    {found:false,entryId:'',cleanUrl:'/participant.html?pool='+pool,error:''});
});
test('Netlify join rewrite bootstraps root-relative resources under base-uri none CSP',()=>{
  const toml=read('netlify.toml'),html=read('participant.html');
  const generatedCsp=read('scripts/runtime-config.mjs');
  assert.match(toml,/from = "\/join\/:pool\/:entry"/);
  assert.match(toml,/to = "\/participant\.html"/);
  assert.match(toml,/status = 200/);
  assert.match(generatedCsp,/"base-uri 'none'"/);
  // A base element cannot be relied upon: the emitted CSP disallows one.
  assert.doesNotMatch(html,/<base\b/i);
  const join=participantInviteUrl(page,pool,entry);
  const required=['/manifest.webmanifest','/styles.css','/','/participant.js'];
  const urls=[...html.matchAll(/<(?:a|link|script)\b[^>]*\b(?:href|src)="([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(urls.sort(),required.sort());
  for(const url of urls){
    assert.ok(url.startsWith('/')&&!url.startsWith('//'),'Resource must be same-origin root-relative: '+url);
    assert.equal(new URL(url,join).pathname,url,'No /join/... asset fetches');
    assert.equal(new URL(url,join).origin,new URL(join).origin,'No cross-origin asset fetches');
  }
});
test('new claim is single flight and selects the newly claimed entry after pool discovery',()=>{
  const participant=read('participant.js');
  assert.match(participant,/let claimInFlight=null/);
  assert.match(participant,/if\(claimInFlight\)return claimInFlight/);
  assert.match(participant,/state\.preferredEntryId=target/);
  assert.match(participant,/const selectedId=state\.preferredEntryId\|\|state\.entry\?\.id/);
  assert.match(participant,/context\.entries\.some\(e=>e\.id===state\.preferredEntryId\)/);
});
test('commissioner only shares entry identifier; never returns a bearer token link',()=>{
  const commissioner=read('commissioner.js'),client=read('platform-client.js');
  assert.match(commissioner,/participantInviteUrl\([^;]*result\.entry_id\)/);
  assert.doesNotMatch(commissioner,/invite_token/);
  assert.match(client,/pool_platform_create_email_invite/);
  assert.match(client,/pool_platform_claim_email_invite/);
  assert.doesNotMatch(client,/pool_platform_(?:create_entry_invite|claim_entry_invite)/);
  assert.doesNotMatch(client,/normalizeInviteToken/);
});
test('participant only claims recipient-bound email invitation after session',()=>{
  const participant=read('participant.js');
  assert.match(participant,/if\(!state\.session\)return/);
  assert.match(participant,/client\.claimEmailInvite\(target\)/);
  assert.doesNotMatch(participant,/client\.claimInvite\(/);
  assert.doesNotMatch(participant,/inviteToken/);
});
test('migration requires verified recipient, hides raw token and revokes old RPCs',()=>{
  const sql=read('migrations/20261104_phase9_sso_safe_email_invites.sql');
  assert.match(sql,/pool_platform_current_user_has_verified_email\(v_email\)/);
  assert.match(sql,/email_normalized=v_email/);
  assert.match(sql,/claimed_at IS NULL AND expires_at>now\(\)/);
  assert.match(sql,/FOR UPDATE/);
  const cutover=read('migrations/20261104_phase9_sso_safe_email_invites_cutover.sql');
  assert.doesNotMatch(sql,/REVOKE ALL ON FUNCTION public\.pool_platform_(?:claim_entry_invite|create_entry_invite)/);
  assert.match(cutover,/REVOKE ALL ON FUNCTION public\.pool_platform_claim_entry_invite\(text\) FROM authenticated/);
  assert.match(cutover,/REVOKE ALL ON FUNCTION public\.pool_platform_create_entry_invite\(uuid,text,integer\) FROM authenticated/);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS public\.pool_platform_email_invite_grants/);
  assert.match(sql,/INSERT INTO public\.pool_platform_email_invite_grants/);
  assert.match(sql,/UPDATE public\.pool_platform_email_invite_grants/);
  assert.doesNotMatch(sql,/FROM public\.pool_platform_entry_invites/);
  assert.match(sql,/GRANT EXECUTE ON FUNCTION public\.pool_platform_claim_email_invite\(uuid\) TO authenticated/);
  assert.doesNotMatch(sql,/jsonb_build_object\([^;]*'invite_token'/);
  assert.equal((sql.match(/SECURITY DEFINER/g)||[]).length,2);
  assert.equal((sql.match(/SET search_path TO 'public', 'neon_auth', 'pg_temp'/g)||[]).length,2);
});
test('first branch in each new RPC refuses absent authentication before reads',()=>{
  const sql=read('migrations/20261104_phase9_sso_safe_email_invites.sql');
  for(const label of ['pool_platform_create_email_invite','pool_platform_claim_email_invite']){
    const fn=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.'+label));
    assert.ok(fn.indexOf("IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'")>0);
    assert.ok(fn.indexOf("IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'")<fn.indexOf('SELECT * INTO'));
  }
});
test('permission guidance preserves server code rather than raw database error',()=>{
  const js=read('commissioner.js');
  assert.match(js,/authErrorMessage\(e\?\.code\|\|e\?\.message\)/);
  assert.match(authErrorMessage('commissioner_required'),/do not have access/i);
  assert.doesNotMatch(authErrorMessage('stack trace from role'),/stack trace/i);
});

test('cutover is separate from compatible predeploy and refuses missing prerequisites',()=>{
  const prep=read('migrations/20261104_phase9_sso_safe_email_invites.sql');
  const cutover=read('migrations/20261104_phase9_sso_safe_email_invites_cutover.sql');
  assert.doesNotMatch(prep,/REVOKE ALL ON FUNCTION public\.pool_platform_claim_entry_invite/);
  assert.match(cutover,/invite_predeploy_missing/);
  assert.match(cutover,/pool_platform_email_invite_grants/);
  assert.match(cutover,/GRANT EXECUTE|email_invite_grants_missing/);
  assert.match(cutover,/REVOKE ALL ON FUNCTION public\.pool_platform_claim_entry_invite/);
});
test('new-email grant issuance rotates prior unclaimed recipients and claim shares entry-first lock ordering',()=>{
  const sql=read('migrations/20261104_phase9_sso_safe_email_invites.sql');
  const create=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.pool_platform_create_email_invite'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.pool_platform_claim_email_invite'));
  const claim=sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.pool_platform_claim_email_invite'));
  assert.ok(create.indexOf('FOR UPDATE OF e')<create.indexOf('UPDATE public.pool_platform_email_invite_grants'));
  assert.ok(claim.indexOf('FOR UPDATE OF e')<claim.indexOf('LIMIT 1 FOR UPDATE'));
  assert.match(create,/SET revoked_at=now\(\)/);
  assert.match(claim,/public\.pool_platform_current_user_has_verified_email\(v_email\)/);
});
