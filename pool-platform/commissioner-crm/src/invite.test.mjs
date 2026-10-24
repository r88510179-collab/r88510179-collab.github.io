import test from "node:test";
import assert from "node:assert/strict";
import {participantInvitationLink,validateInviteRequest} from "./invite.mjs";
const E="33333333-3333-3333-3333-333333333333",TOKEN="a".repeat(64);
test("creates fragment-only participant invite, never a query token",()=>{
 const url=participantInvitationLink({origin:"https://pool.example.test",poolSlug:"my-pool",token:TOKEN});
 const parsed=new URL(url);
 assert.equal(parsed.pathname,"/participant.html");
 assert.equal(parsed.searchParams.get("pool"),"my-pool");
 assert.equal(parsed.searchParams.has("invite"),false);
 assert.equal(new URLSearchParams(parsed.hash.slice(1)).get("invite"),TOKEN);
 assert.equal(parsed.origin,"https://pool.example.test");
});
test("rejects insecure or malformed invite configuration",()=>{
 for(const origin of ["http://pool.example.test","https://pool.example.test/other","https://a@pool.example.test"]){
  assert.throws(()=>participantInvitationLink({origin,poolSlug:"p",token:TOKEN}),/origin/i);
 }
 assert.throws(()=>participantInvitationLink({origin:"https://pool.example.test",poolSlug:"p",token:"bad"}),/token/);
});
test("only allows valid entries and optional normalized recipient emails",()=>{
 assert.deepEqual(validateInviteRequest({entryId:E,email:"  USER@example.com  "}),{entryId:E,email:"user@example.com",expiresHours:168});
 assert.deepEqual(validateInviteRequest({entryId:E,email:""}),{entryId:E,email:null,expiresHours:168});
 assert.throws(()=>validateInviteRequest({entryId:"wrong",email:"hi@example.com"}),/entry/);
});
