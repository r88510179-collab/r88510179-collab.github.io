import test from "node:test";
import assert from "node:assert/strict";
import {createCrmGateway} from "./crm-data.mjs";
import {validateDuesEntry} from "./dues.mjs";

const P="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const E="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

test("toggle uses the protected settings RPC only",async()=>{
  const calls=[];const client={
    rpc:async(name,args)=>{calls.push({name,args});return true},
    commissionerContext:async()=>({})
  };
  const gateway=createCrmGateway(client);
  assert.equal(await gateway.setDuesEnabled(P,true),true);
  assert.deepEqual(calls,[{name:"pool_platform_set_dues_enabled",args:{p_pool_id:P,p_enabled:true}}]);
});
test("manual record uses append-only server RPC with exact validated cents",async()=>{
  const calls=[];const client={
    rpc:async(name,args)=>{calls.push({name,args});return E},
    commissionerContext:async()=>({})
  };
  const gateway=createCrmGateway(client);
  const row=validateDuesEntry({entryId:E,kind:"payment",amount:"12.34",note:"Paid in person"});
  assert.equal(await gateway.recordDuesEvent(row),E);
  assert.deepEqual(calls,[{name:"pool_platform_record_dues_event",args:{
    p_entry_id:E,p_kind:"payment",p_amount_cents:1234,p_note:"Paid in person"
  }}]);
});
test("write rejection is surfaced instead of assuming money or a ledger event was recorded",async()=>{
  const client={
    rpc:async()=>{throw new Error("dues_tracking_disabled")},
    commissionerContext:async()=>({})
  };
  await assert.rejects(createCrmGateway(client).recordDuesEvent(
    validateDuesEntry({entryId:E,kind:"charge",amount:"5"})
  ),/dues_tracking_disabled/);
});
