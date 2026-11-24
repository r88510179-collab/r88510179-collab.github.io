import test from "node:test";
import assert from "node:assert/strict";
import {normalizePoolList,normalizeCommissionerContext,normalizeDuesRows,createCrmGateway,createCrmSessionStore} from "./crm-data.mjs";

const A="11111111-1111-1111-1111-111111111111";
const B="22222222-2222-2222-2222-222222222222";
const E="33333333-3333-3333-3333-333333333333";
const raws=[
  {id:A,tenant_id:E,slug:"alpha",display_name:"Alpha",pool_type:"pickem",dues_tracking_enabled:true,permissions:{view_pool:true,record_dues:true}},
  {id:B,tenant_id:E,slug:"beta",display_name:"Beta",pool_type:"survivor",dues_tracking_enabled:false,permissions:{view_pool:true,record_dues:false}}
];
const context=pool=>({pool:{id:pool.id,slug:pool.slug},seasons:[{status:"active",season:2026,weeks:[{week:7,status:"open"}],entries:[
  {id:E,display_name:"Entry 1",entry_code:"A1",status:"active",submissions:[{week:7,status:"submitted"}]},
  {id:"44444444-4444-4444-4444-444444444444",entry_code:"A2",display_name:"Entry 2",status:"active",submissions:[]}
]}]});

test("validates server-returned pool identities and maps role capabilities",()=>{
  const pools=normalizePoolList(raws);
  assert.equal(pools.length,2);
  assert.equal(pools[0].type,"Pick'em");
  assert.equal(pools[1].type,"Survivor");
  assert.equal(pools[1].permissions.record_dues,false);
  assert.throws(()=>normalizePoolList([raws[0],raws[0]]),/Duplicate/);
  assert.throws(()=>normalizePoolList([{id:"other",slug:"alpha"}]),/Invalid/);
});
test("counts only submitted ACTIVE entries in the selected open week",()=>{
  const p=normalizePoolList(raws)[0],model=normalizeCommissionerContext(context(p),p);
  assert.equal(model.entries,2);
  assert.equal(model.submitted,1);
  assert.equal(model.week,7);
  assert.equal(model.roster[1].submitted,false);
  assert.throws(()=>normalizeCommissionerContext(context({...p,id:B}),p),/did not match/);
});
test("read API only uses fixed permitted authenticated RPC names",async()=>{
  const calls=[];
  const client={
    rpc:async(name,args)=>{calls.push({name,args});return [];},
    commissionerContext:async(slug)=>{calls.push({name:"context",slug});return context(raws[0]);}
  };
  const gateway=createCrmGateway(client);
  await gateway.listPools();await gateway.readContext({slug:"alpha"});await gateway.readDues({id:A});
  assert.deepEqual(calls.map(c=>c.name),["pool_platform_crm_pools","context","pool_platform_crm_dues_summary"]);
  assert.deepEqual(calls[2].args,{p_pool_id:A});
});
test("per-session cache avoids repeated requests on pool switching and can invalidate",async()=>{
  const pools=normalizePoolList(raws);let list=0,reads=0;
  const store=createCrmSessionStore({listPools:async()=>{list++;return raws},readContext:async p=>{reads++;return context(p)},readDues:async()=>[]});
  await store.listPools();await store.listPools();assert.equal(list,1);
  await store.readContext(pools[0]);await store.readContext(pools[1]);await store.readContext(pools[0]);assert.equal(reads,2);
  store.invalidate(A);await store.readContext(pools[0]);assert.equal(reads,3);
  store.clear();await store.listPools();assert.equal(list,2);
});
test("rejected context request is not cached",async()=>{
  const p=normalizePoolList(raws)[0];let attempts=0;
  const store=createCrmSessionStore({listPools:async()=>raws,readContext:async()=>{
    attempts++;if(attempts===1)throw new Error("auth_required");return context(p);
  }});
  await assert.rejects(store.readContext(p),/auth_required/);
  assert.equal((await store.readContext(p)).id,A);
  assert.equal(attempts,2);
});
test("dues are never read without an explicit pool-specific grant and enabled toggle",async()=>{
  const pools=normalizePoolList(raws);let reads=0;
  const store=createCrmSessionStore({listPools:async()=>raws,readContext:async()=>null,readDues:async()=>{reads++;return [
    {id:E,entry_code:"A1",display_name:"Entry 1",charged_cents:5000,paid_cents:2500,balance_cents:2500}
  ]}});
  assert.throws(()=>store.readDues(pools[1]),/unavailable/);
  const row=(await store.readDues(pools[0]))[0];
  assert.equal(row.balanceOverride,2500);
  assert.equal(row.charge,5000);
  assert.equal(reads,1);
  assert.throws(()=>normalizeDuesRows([{id:E,charged_cents:"not money",paid_cents:0,balance_cents:0}],A),/Invalid ledger/);
});
