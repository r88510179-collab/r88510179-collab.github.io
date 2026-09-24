import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeEmail,validEmail,validOtp,normalizeInviteToken,extractAccessToken,authErrorMessage} from './auth-core.js';

test('email normalization and validation',()=>{
  assert.equal(normalizeEmail('  User@Example.COM '),'user@example.com');
  assert.equal(validEmail('user@example.com'),true);
  assert.equal(validEmail('bad@'),false);
});

test('OTP and invite validation are strict',()=>{
  assert.equal(validOtp('123456'),true);
  assert.equal(validOtp('12a456'),false);
  assert.equal(normalizeInviteToken('A'.repeat(64)),'a'.repeat(64));
  assert.equal(normalizeInviteToken('z'.repeat(64)),null);
});

// Shape-only fixtures (base64url header.payload.signature); neither is a real credential.
const JWT='eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c2hhcGUtb25seS1zaWduYXR1cmU';
const OTHER_JWT='eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJvdGhlci11c2VyIn0.b3RoZXItc2hhcGUtb25seQ';

test('pinned Neon SDK session: the JWT is read from data.session.token',()=>{
  // @neondatabase/neon-js 0.7.0-beta getSession(): {data:{session:{...,token:<set-auth-jwt>},user},error}
  assert.equal(extractAccessToken({data:{session:{id:'s1',userId:'u1',expiresAt:'2027-01-01T00:00:00Z',token:JWT},user:{id:'u1'}},error:null}),JWT);
  assert.equal(extractAccessToken({session:{token:JWT}}),JWT);
});

test('access_token and accessToken session shapes remain supported',()=>{
  assert.equal(extractAccessToken({data:{session:{access_token:JWT}}}),JWT);
  assert.equal(extractAccessToken({session:{accessToken:JWT}}),JWT);
  assert.equal(extractAccessToken({access_token:JWT}),JWT);
});

test('session.token wins over other shapes; an opaque (non-JWT) session token is never used as a bearer',()=>{
  assert.equal(extractAccessToken({data:{session:{token:JWT,access_token:OTHER_JWT,accessToken:OTHER_JWT}}}),JWT);
  assert.equal(extractAccessToken({data:{session:{token:'o'.repeat(32),access_token:OTHER_JWT}}}),OTHER_JWT);
  assert.equal(extractAccessToken({data:{session:{token:'o'.repeat(32)}}}),null);
});

test('missing, short or invalid tokens yield null',()=>{
  for(const result of [null,undefined,'',JWT,{},{data:null,error:null},{data:{session:null}},{data:{session:{}}},{data:{session:{token:null}}}]){
    assert.equal(extractAccessToken(result),null,JSON.stringify(result));
  }
  const invalid=['a.b.c','abc.def.ghi','x'.repeat(40),`${JWT}.extra`,JWT.replace('.','..'),`${JWT} `,` ${JWT}`,
    JWT.replace(/\.[^.]+$/,'.'),JWT.replace('.','+.'),12345678901234567890,{toString:()=>JWT},[JWT]];
  for(const token of invalid){
    assert.equal(extractAccessToken({data:{session:{token}}}),null,String(token));
    assert.equal(extractAccessToken({data:{session:{access_token:token}}}),null,String(token));
  }
});

test('backend conflicts become clear user copy',()=>{
  assert.match(authErrorMessage('source_conflict:participant'),/participant/i);
  assert.match(authErrorMessage('source_conflict:commissioner_import'),/commissioner/i);
  assert.match(authErrorMessage('invite_email_mismatch'),/different email/i);
});


test('backend validation errors remain actionable',()=>{
  assert.match(authErrorMessage('invalid_payload'),/configured games|Survivor rules/i);
  assert.match(authErrorMessage('invalid_entry_week'),/selected week/i);
});

test('verification, Survivor reuse and entry-status rejections have their own copy',()=>{
  assert.match(authErrorMessage('invite_email_unverified'),/verified email/i);
  assert.doesNotMatch(authErrorMessage('invite_email_unverified'),/different email/i);
  assert.match(authErrorMessage('team_already_used'),/already been used by this entry/i);
  assert.match(authErrorMessage('entry_not_active'),/not active/i);
  assert.doesNotMatch(authErrorMessage('entry_not_active'),/do not own/i);
});
