import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chooseParticipantPool} from '../participant-core.js';
const root=path.resolve(import.meta.dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const alpha={id:'11111111-1111-4111-8111-111111111111',slug:'alpha-pickem',display_name:'Alpha picks',pool_type:'pickem',season:2026};
const beta={id:'22222222-2222-4222-8222-222222222222',slug:'beta-survivor',display_name:'Beta Survivor',pool_type:'survivor',season:2026};

test('one authorized participant pool opens from the generic homepage',()=>{
  const choice=chooseParticipantPool([alpha]);
  assert.equal(choice.selected,alpha.slug);
  assert.equal(choice.automatic,true);
});
test('two authorized participant pools require an explicit selector',()=>{
  const choice=chooseParticipantPool([alpha,beta]);
  assert.equal(choice.selected,null);
  assert.equal(choice.available.length,2);
});
test('private entry link selects only a server-returned authorized pool',()=>{
  assert.equal(chooseParticipantPool([alpha,beta],beta.slug).selected,beta.slug);
  assert.equal(chooseParticipantPool([alpha,beta],'unowned-pool').selected,null);
  assert.equal(chooseParticipantPool([alpha],'unowned-pool').selected,null);
});
test('malformed entries, traversal-style slugs and identical repeated rows are ignored',()=>{
  const choice=chooseParticipantPool([alpha,alpha,{...beta,slug:'../../admin'},{...beta,id:'not-uuid'},null]);
  assert.deepEqual(choice.available.map(p=>p.slug),[alpha.slug]);
});
test('tenant-local duplicate slugs are never used to select a different pool',()=>{
  const collision={...alpha,id:'99999999-9999-4999-8999-999999999999'};
  const choice=chooseParticipantPool([alpha,collision,beta],alpha.slug);
  assert.deepEqual(choice.ambiguous,[alpha.slug]);
  assert.deepEqual(choice.available.map(p=>p.slug),[beta.slug]);
  assert.equal(choice.selected,null);
});
test('read-only discovery checks verified identity and claimed entry ownership',()=>{
  const sql=read('migrations/20261103_participant_pool_discovery.sql');
  assert.match(sql,/SECURITY DEFINER/);
  assert.match(sql,/SET search_path TO 'public', 'neon_auth', 'pg_temp'/);
  assert.ok(sql.indexOf("IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'")<sql.indexOf('FROM public.pool_platform_pools'));
  assert.match(sql,/e.owner_auth_user_id=v_uid/);
  assert.match(sql,/e.status='active'/);
  assert.match(sql,/s.status IN \('setup','active'\)/);
  assert.match(sql,/max\(s.season\) AS season/);
  assert.match(sql,/REVOKE ALL ON FUNCTION .* FROM PUBLIC/);
  assert.match(sql,/GRANT EXECUTE ON FUNCTION .* TO authenticated/);
  assert.doesNotMatch(sql,/\b(INSERT INTO|UPDATE public|DELETE FROM|TRUNCATE)\b/i);
});
test('generic signed participant path discovers pools; DOM and client RPC exist',()=>{
  const js=read('participant.js'),client=read('platform-client.js'),html=read('participant.html');
  assert.match(js,/client\.listParticipantPools\(\)/);
  assert.match(js,/if\(state\.session!==session\)return/);
  assert.match(js,/!client\.live\?PLATFORM_CONFIG\.defaultPoolSlug:''/);
  assert.match(client,/pool_platform_list_participant_pools/);
  assert.match(js,/ownedPool\?\.season\?\?null/);
  for(const id of ['poolPickerCard','authorizedPoolSelect','openAuthorizedPool','poolPickerError','switchPool'])
    assert.ok(html.includes('id="'+id+'"'),id);
});
