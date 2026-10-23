import test from "node:test";
import assert from "node:assert/strict";
import {validateDuesEntry,DUES_KINDS} from "./dues.mjs";
const ID="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
test("supports explicit external bookkeeping entries without payment processor fields",()=>{
  for(const item of DUES_KINDS){
    const event=validateDuesEntry({entryId:ID,kind:item.id,amount:"12.34",note:"Handed to organizer"});
    assert.deepEqual(event,{entryId:ID,kind:item.id,amountCents:1234,note:"Handed to organizer"});
    assert.equal(Object.hasOwn(event,"processor"),false);
  }
});
test("rejects negative, zero, exponent, unbounded, fractional-cent and malformed amounts",()=>{
  for(const amount of ["0","0.00","-1","1e3","1.234","1000000.01","nope",""]){
    assert.throws(()=>validateDuesEntry({entryId:ID,kind:"charge",amount}),/amount/i,amount);
  }
});
test("accepts exact boundary cents and normalizes notes",()=>{
  assert.equal(validateDuesEntry({entryId:ID,kind:"payment",amount:"0.01"}).amountCents,1);
  assert.equal(validateDuesEntry({entryId:ID,kind:"refund",amount:"1000000"}).amountCents,100000000);
  assert.equal(validateDuesEntry({entryId:ID,kind:"credit",amount:"1",note:"  adjustment  "}).note,"adjustment");
  assert.throws(()=>validateDuesEntry({entryId:ID,kind:"payment",amount:"2",note:"x".repeat(251)}),/250/);
});
test("rejects unrecognized ledger actions or foreign-looking identifiers",()=>{
  assert.throws(()=>validateDuesEntry({entryId:ID,kind:"capture",amount:"2"}),/type/);
  assert.throws(()=>validateDuesEntry({entryId:"fake",kind:"charge",amount:"2"}),/entry/);
});
