import test from "node:test";
import assert from "node:assert/strict";
import {createCrmGateway} from "./crm-data.mjs";
const T="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const A="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

test("assistant roster is cached per tenant and uses a fixed authenticated RPC",async()=>{
  const calls=[];
  const client={rpc:async(name,args)=>{calls.push({name,args});return []},
    commissionerContext:async()=>({})};
  const gateway=createCrmGateway(client);
  await gateway.listAssistants(T);
  await gateway.listAssistants(T);
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,"pool_platform_crm_assistants");
  assert.deepEqual(calls[0].args,{p_tenant_id:T});
});
test("add-assistant uses only audited enrollment RPC then expires staff roster cache",async()=>{
  const calls=[];const client={rpc:async(name,args)=>{calls.push({name,args});return []},
    commissionerContext:async()=>({})};
  const gateway=createCrmGateway(client);
  await gateway.listAssistants(T);
  await gateway.addAssistant({tenantId:T,email:"helper@example.com",scope:"selected",poolIds:[A],capabilities:["view_pool"]});
  await gateway.listAssistants(T);
  assert.deepEqual(calls.map(x=>x.name),[
    "pool_platform_crm_assistants",
    "pool_platform_crm_add_assistant",
    "pool_platform_crm_assistants"
  ]);
  assert.deepEqual(calls[1].args,{p_tenant_id:T,p_email:"helper@example.com",p_scope:"selected",
    p_pool_ids:[A],p_capabilities:["view_pool"]});
});
test("update-assistant uses audited update RPC, not direct grant writer",async()=>{
  const calls=[];const client={rpc:async(name,args)=>{calls.push({name,args});return 1},
    commissionerContext:async()=>({})};
  const gateway=createCrmGateway(client);
  await gateway.updateAssistant({tenantId:T,userId:"staff-1",scope:"all",poolIds:[],capabilities:[]});
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,"pool_platform_crm_update_assistant");
  assert.deepEqual(calls[0].args,{p_tenant_id:T,p_staff_user_id:"staff-1",p_scope:"all",
    p_pool_ids:[],p_capabilities:[]});
});
test("a failed assistant write cannot imply success",async()=>{
  const client={rpc:async()=>{throw new Error("commissioner_required")},
    commissionerContext:async()=>({})};
  await assert.rejects(createCrmGateway(client).addAssistant({tenantId:T,email:"x@example.com",scope:"all",poolIds:[],capabilities:["view_pool"]}),/commissioner_required/);
});
