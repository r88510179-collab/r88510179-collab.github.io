import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeEmail,validEmail,validOtp,normalizeInviteToken,extractAccessToken,authErrorMessage,participantInviteUrl,readInviteFromUrl} from './auth-core.js';

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

// Synthetic invite tokens only. A browser never sends a URL's fragment in an HTTP request, so the request target a
// link produces is its path and query: that is all a host, proxy or request log can see.
const INVITE_TOKEN='ab'.repeat(32);
const COMMISSIONER_PAGE='https://pools.example.test/pool-platform/commissioner.html?pool=old-pool#console';
const requestTarget=href=>{const url=new URL(href);return url.pathname+url.search};

test('a commissioner invite link keeps the pool in the query string and carries the token only in the fragment',()=>{
  const href=participantInviteUrl(new URL('./participant.html',COMMISSIONER_PAGE),'it-pool',INVITE_TOKEN);
  assert.equal(href,`https://pools.example.test/pool-platform/participant.html?pool=it-pool#invite=${INVITE_TOKEN}`);
  const url=new URL(href);
  assert.equal(url.pathname,'/pool-platform/participant.html');
  assert.deepEqual([...url.searchParams],[['pool','it-pool']]);
  assert.equal(url.search.includes(INVITE_TOKEN),false);
  assert.equal(requestTarget(href),'/pool-platform/participant.html?pool=it-pool');
  assert.deepEqual([...new URLSearchParams(url.hash.slice(1))],[['invite',INVITE_TOKEN]]);
  // A query or fragment already on the page URL given is replaced, never carried into the link.
  assert.equal(participantInviteUrl(COMMISSIONER_PAGE,'it-pool',INVITE_TOKEN),`https://pools.example.test/pool-platform/commissioner.html?pool=it-pool#invite=${INVITE_TOKEN}`);
  // Hostile values stay inside their own component: none adds a parameter, ends the query or reaches the request.
  const token='a&invite=b#c d+e/?f%25g',slug='pool&invite=x#y';
  const odd=new URL(participantInviteUrl('https://pools.example.test/pool-platform/participant.html',slug,token));
  assert.deepEqual([...odd.searchParams],[['pool',slug]]);
  assert.deepEqual([...new URLSearchParams(odd.hash.slice(1))],[['invite',token]]);
  assert.equal(requestTarget(odd.href).includes('invite=b'),false);
  assert.equal(odd.hash.split('#').length,2,'the token cannot open a second fragment');
});

test('a participant page reads a #invite fragment once, and the URL it leaves behind holds no invite',()=>{
  const href=participantInviteUrl('https://pools.example.test/pool-platform/participant.html','it-pool',INVITE_TOKEN);
  assert.deepEqual(readInviteFromUrl(href),{found:true,cleanUrl:'/pool-platform/participant.html?pool=it-pool',token:INVITE_TOKEN,error:''});
  // Every hostile token round-trips exactly through the link the commissioner page builds.
  for(const token of ['a&invite=b#c d+e/?f%25g','CD'.repeat(32),' padded ']){
    const link=participantInviteUrl('https://pools.example.test/pool-platform/participant.html','it-pool',token);
    assert.equal(readInviteFromUrl(link).token,token,token);
  }
  assert.deepEqual(readInviteFromUrl(`https://pools.example.test/pool-platform/participant.html#invite=${INVITE_TOKEN}`),
    {found:true,cleanUrl:'/pool-platform/participant.html',token:INVITE_TOKEN,error:''});
  // The whole fragment goes, whatever else it held; the query is left exactly as it was.
  assert.deepEqual(readInviteFromUrl(`https://pools.example.test/pool-platform/participant.html?pool=it-pool&type=survivor#x=1&invite=${INVITE_TOKEN}`),
    {found:true,cleanUrl:'/pool-platform/participant.html?pool=it-pool&type=survivor',token:INVITE_TOKEN,error:''});
  // An empty fragment invite is removed and is not a token.
  for(const fragment of ['#invite=','#invite'])assert.deepEqual(readInviteFromUrl(`https://pools.example.test/pool-platform/participant.html?pool=it-pool${fragment}`),
    {found:true,cleanUrl:'/pool-platform/participant.html?pool=it-pool',token:'',error:''},fragment);
  // No invite: nothing to scrub, and an unrelated fragment is left alone.
  for(const [href,cleanUrl] of [['https://pools.example.test/pool-platform/participant.html?pool=it-pool','/pool-platform/participant.html?pool=it-pool'],
    ['https://pools.example.test/pool-platform/participant.html#top','/pool-platform/participant.html#top'],
    ['https://pools.example.test/pool-platform/participant.html?pool=it-pool&invited=1#invites=2','/pool-platform/participant.html?pool=it-pool&invited=1#invites=2']]){
    assert.deepEqual(readInviteFromUrl(href),{found:false,cleanUrl,token:'',error:''},href);
  }
});

test('a ?invite in the query string is never a token: it is refused, and a link that also carries #invite or repeats it fails closed',()=>{
  const page='https://pools.example.test/pool-platform/participant.html';
  const QUERY_TOKEN='cd'.repeat(32);
  // The retired format: whatever its value, it is refused and removed; the pool and other parameters stay.
  for(const query of [`?pool=it-pool&invite=${QUERY_TOKEN}`,`?invite=${QUERY_TOKEN}&pool=it-pool`,'?pool=it-pool&invite=','?pool=it-pool&invite',`?pool=it-pool&invite=${QUERY_TOKEN}&invite=${INVITE_TOKEN}`]){
    const read=readInviteFromUrl(page+query);
    assert.deepEqual(read,{found:true,cleanUrl:'/pool-platform/participant.html?pool=it-pool',token:'',error:'invite_link_retired'},query);
  }
  // Query and fragment together: neither is chosen, and both leave the URL.
  for(const href of [`${page}?pool=it-pool&invite=${QUERY_TOKEN}#invite=${INVITE_TOKEN}`,`${page}?invite=${INVITE_TOKEN}&pool=it-pool#invite=${INVITE_TOKEN}`]){
    assert.deepEqual(readInviteFromUrl(href),{found:true,cleanUrl:'/pool-platform/participant.html?pool=it-pool',token:'',error:'invite_link_ambiguous'},href);
  }
  // The fragment invite twice, even with the same value: refused.
  for(const fragment of [`#invite=${INVITE_TOKEN}&invite=${QUERY_TOKEN}`,`#invite=${INVITE_TOKEN}&invite=${INVITE_TOKEN}`]){
    assert.deepEqual(readInviteFromUrl(`${page}?pool=it-pool${fragment}`),{found:true,cleanUrl:'/pool-platform/participant.html?pool=it-pool',token:'',error:'invite_link_ambiguous'},fragment);
  }
  // The participant sees why, and that a new link is needed; no token or code is shown.
  for(const code of ['invite_link_retired','invite_link_ambiguous']){
    const copy=authErrorMessage(code);
    assert.match(copy,/new invitation link/i,code);
    assert.doesNotMatch(copy,/invite_link|[0-9a-f]{64}/,code);
  }
  assert.match(authErrorMessage('invite_link_retired'),/retired format/i);
  assert.doesNotMatch(authErrorMessage('invite_link_retired'),/different email|already used/i);
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
