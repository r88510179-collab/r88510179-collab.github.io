import test from "node:test";
import assert from "node:assert/strict";
import {normalizeAssistants,prepareAssistantRequest} from "./staff.mjs";
const T="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",A="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",B="cccccccc-cccc-cccc-cccc-cccccccccccc";

test("normalize existing assistant grants, including records awaiting email verification",()=>{
  const people=normalizeAssistants([{id:"member-1",name:"Existing assistant",email:"",scope:"selected",pool_ids:[A],capabilities:["view_pool"]}], [A,B]);
  assert.equal(people[0].email,"");assert.deepEqual(people[0].poolIds,[A]);
});
test("reject duplicate staff, injected pool IDs and unknown scope",()=>{
  const item={id:"member-1",scope:"all",pool_ids:[],capabilities:["view_pool"]};
  assert.throws(()=>normalizeAssistants([item,item],[A,B]),/Invalid assistant identity/);
  assert.throws(()=>normalizeAssistants([{...item,pool_ids:[T]}],[A,B]),/unknown pool/);
  assert.throws(()=>normalizeAssistants([{...item,scope:"foreign"}],[A,B]),/scope/);
});
test("prepare sanitized enrollment only for verified address and tenant pool IDs",()=>{
  const params={tenantId:T,email:"  HELP@example.com  ",scope:"selected",poolIds:[A],capabilities:["view_pool"],tenantPoolIds:[A,B]};
  const req=prepareAssistantRequest(params);
  assert.equal(req.kind,"add");assert.equal(req.email,"help@example.com");
  assert.deepEqual(req.poolIds,[A]);
  assert.throws(()=>prepareAssistantRequest({...params,poolIds:[T]}),/outside/);
  assert.throws(()=>prepareAssistantRequest({...params,email:"not-an-email"}),/verified email/);
});
test("deny delegated writes without view right",()=>{
  assert.throws(()=>prepareAssistantRequest({tenantId:T,userId:"member-1",scope:"all",poolIds:[],capabilities:["record_dues"],tenantPoolIds:[A,B]}),/View dashboard/);
});
test("allow all-pool assistant update with no capabilities to revoke access",()=>{
  const req=prepareAssistantRequest({tenantId:T,userId:"member-1",scope:"all",poolIds:[],capabilities:[],tenantPoolIds:[A,B]});
  assert.equal(req.kind,"update");assert.deepEqual(req.capabilities,[]);
});
