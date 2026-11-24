import test from "node:test";
import assert from "node:assert/strict";
import {CAPABILITIES,PRESETS,canUseDelegation,validateDelegation} from "./permissions.mjs";

const tenantPoolIds=["pickem","survivor"];
test("presets contain only delegable capabilities",()=>{
  const allowed=new Set(CAPABILITIES.map(x=>x.id));
  for(const permissions of Object.values(PRESETS)) {
    for(const p of permissions) assert.ok(allowed.has(p),p);
  }
  assert.equal(allowed.has("manage_staff"),false);
});
test("selected-pool assistant cannot read or mutate the other pool",()=>{
  const delegation=validateDelegation({tenantPoolIds,scope:"selected",selectedPoolIds:["pickem"],capabilities:PRESETS.assistant});
  assert.equal(canUseDelegation(delegation,{poolId:"pickem",capability:"manage_players",tenantPoolIds}),true);
  assert.equal(canUseDelegation(delegation,{poolId:"survivor",capability:"manage_players",tenantPoolIds}),false);
  assert.equal(canUseDelegation(delegation,{poolId:"pickem",capability:"record_dues",tenantPoolIds}),false);
});
test("all-pool scope still forbids foreign pools and nondelegable rights",()=>{
  const delegation=validateDelegation({tenantPoolIds,scope:"all",capabilities:CAPABILITIES.map(x=>x.id)});
  assert.equal(canUseDelegation(delegation,{poolId:"survivor",capability:"record_dues",tenantPoolIds}),true);
  assert.equal(canUseDelegation(delegation,{poolId:"foreign",capability:"record_dues",tenantPoolIds}),false);
  assert.equal(canUseDelegation(delegation,{poolId:"pickem",capability:"manage_staff",tenantPoolIds}),false);
});
test("reject empty selected scope, unknown pool and permission injection",()=>{
  const base={tenantPoolIds,scope:"selected"};
  assert.throws(()=>validateDelegation({...base,selectedPoolIds:[],capabilities:[]}),/at least one/);
  assert.throws(()=>validateDelegation({...base,selectedPoolIds:["foreign"],capabilities:[]}),/outside/);
  assert.throws(()=>validateDelegation({...base,selectedPoolIds:["pickem"],capabilities:["manage_staff"]}),/Unsupported/);
});
test("deduplicates inputs without mutating them",()=>{
  const source=["pickem","pickem"],capabilities=["view_pool","view_pool"];
  const d=validateDelegation({tenantPoolIds,scope:"selected",selectedPoolIds:source,capabilities});
  assert.deepEqual(d.poolIds,["pickem"]);
  assert.deepEqual(d.capabilities,["view_pool"]);
  assert.deepEqual(source,["pickem","pickem"]);
  assert.ok(Object.isFrozen(d));
});
