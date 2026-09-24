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

test('access token extraction supports Neon session shapes',()=>{
  const token='x'.repeat(32);
  assert.equal(extractAccessToken({data:{session:{access_token:token}}}),token);
  assert.equal(extractAccessToken({session:{accessToken:token}}),token);
  assert.equal(extractAccessToken({data:{session:null}}),null);
});

test('backend conflicts become clear user copy',()=>{
  assert.match(authErrorMessage('source_conflict:participant'),/participant/i);
  assert.match(authErrorMessage('source_conflict:commissioner_import'),/commissioner/i);
  assert.match(authErrorMessage('invite_email_mismatch'),/different email/i);
});
