import assert from 'node:assert/strict';
import fs from 'node:fs';
import test,{afterEach} from 'node:test';
import {authErrorMessage} from './auth-core.js';
import {PlatformClient,SIGN_IN_NOT_CONFIRMED} from './platform-client.js';

// Shape-only fixture (base64url header.payload.signature); not a real credential.
const JWT='eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c2hhcGUtb25seS1zaWduYXR1cmU';
const DATA_URL='https://data.example.test/neondb/rest/v1/';
const SESSION={data:{session:{token:JWT},user:{id:'test-user'}},error:null};
const realFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=realFetch});

// A live client whose Neon Auth session is `session`, in front of a Data API that answers request n with replies[n-1]
// ([status, body] sent as JSON, or [status, text, 'raw']; the last reply repeats). No network: every request is
// recorded instead.
function live(replies,session=SESSION){
  const requests=[];
  globalThis.fetch=async(url,init)=>{
    requests.push({url,init,at:Date.now()});
    const reply=replies[Math.min(requests.length,replies.length)-1];
    if(reply instanceof Error)throw reply;
    const [status,body,raw]=reply;
    return new Response(raw?body:JSON.stringify(body),{status,headers:{'content-type':raw?'text/plain':'application/json'}});
  };
  const client=new PlatformClient({mode:'live',authUrl:'https://auth.example.test/neondb/auth',dataUrl:DATA_URL});
  client.neon={auth:{getSession:async()=>session}};
  return {client,requests};
}
const raised=message=>[400,{code:'P0001',message,details:null,hint:null}];
const AUTH_REQUIRED=raised('auth_required');
const PICKS={picks:{g1:'away',g2:'home'},tiebreak:10};
const submitEntry=client=>client.submitEntry({weekId:'week-1',entryId:'entry-1',source:'participant',payload:PICKS});

test('auth_required then success: the same request is sent exactly twice, about 200 ms apart, and the result returned',async()=>{
  const {client,requests}=live([AUTH_REQUIRED,[200,{code:'created',revision:1}]]);
  assert.deepEqual(await submitEntry(client),{code:'created',revision:1});
  assert.equal(requests.length,2);
  const [first,second]=requests;
  assert.equal(first.url,`${DATA_URL}rpc/pool_platform_submit_entry`);
  assert.deepEqual(second.url,first.url);
  assert.deepEqual(second.init,first.init,'same method, headers, bearer token and body');
  assert.equal(first.init.headers.Authorization,`Bearer ${JWT}`);
  assert.deepEqual(JSON.parse(first.init.body),{p_week_id:'week-1',p_entry_id:'entry-1',p_source:'participant',p_payload:PICKS});
  const gap=second.at-first.at;
  assert.ok(gap>=190&&gap<1000,`retried after ${gap} ms`);
});

test('an unrelated application error is not retried: one request, and the existing mapping',async()=>{
  for(const code of ['entry_not_owned','commissioner_required','invalid_entry_week','deadline_passed','source_conflict:participant','invalid_payload','pool_not_found','invalid_source']){
    const {client,requests}=live([raised(code),[200,{code:'created'}]]);
    await assert.rejects(submitEntry(client),{message:authErrorMessage(code)},code);
    assert.equal(requests.length,1,code);
  }
});

test('auth_required twice: exactly two requests, then the friendly sign-in message instead of the raw code',async()=>{
  const {client,requests}=live([AUTH_REQUIRED,AUTH_REQUIRED,[200,{code:'created'}]]);
  const error=await submitEntry(client).catch(e=>e);
  assert.equal(error.message,SIGN_IN_NOT_CONFIRMED);
  assert.doesNotMatch(error.message,/auth_required/);
  assert.match(error.message,/sign in again/);
  assert.equal(requests.length,2,'no third request even though it would have succeeded');
});

test('without a valid session token no Data API request is made',async()=>{
  for(const session of [null,{data:null,error:{message:'session lookup failed'}},{data:{session:null,user:null},error:null},
    {data:{session:{token:'o'.repeat(40)},user:{id:'u'}},error:null},{data:{session:{token:'a.b.c'},user:{id:'u'}},error:null}]){
    const {client,requests}=live([[200,{code:'created'}]],session);
    await assert.rejects(submitEntry(client),/Authentication required/,JSON.stringify(session));
    assert.equal(requests.length,0,JSON.stringify(session));
  }
});

test('a successful RPC is sent exactly once, whatever it returns',async()=>{
  for(const body of [{code:'created'},[],null,'8f1c2d3e-0000-4000-8000-000000000001']){
    const {client,requests}=live([[200,body]]);
    assert.deepEqual(await client.rpc('pool_platform_current_user_id'),body);
    assert.equal(requests.length,1,JSON.stringify(body));
  }
});

test('only the exact auth_required error is retried',async()=>{
  const nearMisses=[raised('auth_required '),raised('AUTH_REQUIRED'),raised('auth_required: session'),raised('not auth_required'),
    [400,{code:'P0001',message:'invalid_payload',details:'auth_required',hint:'auth_required'}],[400,'auth_required','raw'],[401,{code:'PGRST301',message:'JWT invalid'}],
    [500,{message:'upstream error'}]];
  for(const reply of nearMisses){
    const {client,requests}=live([reply,[200,{code:'created'}]]);
    await assert.rejects(submitEntry(client),JSON.stringify(reply));
    assert.equal(requests.length,1,JSON.stringify(reply));
  }
  // A batch reports per-item failures inside a successful response; that response is never resent.
  const items=[{entry_id:'entry-1',ok:false,code:'auth_required'}];
  const {client,requests}=live([[200,items],[200,[]]]);
  assert.deepEqual(await client.submitBatch({weekId:'week-1',source:'commissioner_import',items:[{entry_id:'entry-1',payload:PICKS}]}),items);
  assert.equal(requests.length,1);
});

test('auth_required followed by another error: two requests, and that error keeps its usual mapping',async()=>{
  const {client,requests}=live([AUTH_REQUIRED,raised('entry_not_owned')]);
  await assert.rejects(submitEntry(client),{message:authErrorMessage('entry_not_owned')});
  assert.equal(requests.length,2);
});

test('a network failure is not retried',async()=>{
  const {client,requests}=live([new TypeError('fetch failed'),[200,{code:'created'}]]);
  await assert.rejects(submitEntry(client),{name:'TypeError',message:'fetch failed'});
  assert.equal(requests.length,1);
});

test('every client RPC resends exactly the request it first sent',async()=>{
  const calls=[
    ['pool_platform_claim_entry_invite',c=>c.claimInvite('AB'.repeat(32)),{p_invite_token:'ab'.repeat(32)}],
    ['pool_platform_participant_context',c=>c.participantContext('demo',2027,3),{p_pool_slug:'demo',p_season:2027,p_week:3}],
    ['pool_platform_commissioner_context',c=>c.commissionerContext('demo'),{p_pool_slug:'demo'}],
    ['pool_platform_submit_entry',submitEntry,{p_week_id:'week-1',p_entry_id:'entry-1',p_source:'participant',p_payload:PICKS}],
    ['pool_platform_submit_batch',c=>c.submitBatch({weekId:'week-1',source:'commissioner_manual',items:[{entry_id:'entry-1',payload:PICKS}]}),
      {p_week_id:'week-1',p_source:'commissioner_manual',p_items:[{entry_id:'entry-1',payload:PICKS}]}],
    ['pool_platform_create_entry_invite',c=>c.createInvite({entryId:'entry-1',email:' Player@Example.com ',expiresHours:24}),
      {p_entry_id:'entry-1',p_email:'player@example.com',p_expires_hours:24}]
  ];
  for(const [name,call,args] of calls){
    const {client,requests}=live([AUTH_REQUIRED,[200,{ok:true}]]);
    assert.deepEqual(await call(client),{ok:true},name);
    assert.equal(requests.length,2,name);
    assert.equal(requests[0].url,`${DATA_URL}rpc/${name}`,name);
    assert.deepEqual(requests[1],{...requests[0],at:requests[1].at},name);
    assert.deepEqual(JSON.parse(requests[1].init.body),args,name);
  }
});

// rpc() resends a request that failed with auth_required. That is safe only while each function a signed-in caller
// may execute either never answers auth_required, or raises it as its first statement, after computing nothing but
// side-effect-free locals. These checks read the migrations so that a new or changed RPC cannot break it silently.
test('retry contract: every browser-callable RPC raises auth_required before any read, lock, write or side effect',()=>{
  const dir=new URL('./migrations/',import.meta.url);
  const files=fs.readdirSync(dir).filter(f=>/^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  assert.deepEqual(files.slice(0,3),['001_foundation.sql','002_identity_submission_rls.sql','003_submit_entry_authorization_order.sql']);
  const defs=new Map(),callable=new Set();
  for(const file of files){
    const sql=fs.readFileSync(new URL(file,dir),'utf8');
    for(const m of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\nAS \$\$\n([\s\S]*?)\n\$\$;/g))defs.set(m[1],{head:m[2],body:m[3]});
    for(const m of sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^)]*\) TO authenticated;/g))callable.add(m[1]);
  }
  const raisesAuthRequired=name=>defs.get(name).body.includes("'auth_required'");
  // What an RPC may compute before its auth_required check: the caller's identity and plain expressions.
  const SAFE_INITIALIZERS=new Set(['public.pool_platform_current_user_id()','public.pool_platform_current_user_email()',"NULLIF(lower(btrim(p_email)),'')","'[]'::jsonb"]);
  const checksFirst=[];
  for(const name of callable){
    assert.ok(defs.has(name),`${name} is granted but not defined`);
    const {body}=defs.get(name);
    if(!raisesAuthRequired(name)){
      for(const other of defs.keys())if(raisesAuthRequired(other))assert.doesNotMatch(body,new RegExp(`\\b${other}\\(`),`${name} calls ${other}`);
      continue;
    }
    const m=/^DECLARE\n([\s\S]*?)\nBEGIN\n([\s\S]*)$/.exec(body);
    assert.ok(m,`${name}: DECLARE ... BEGIN`);
    assert.equal(m[2].trimStart().split('\n')[0],"IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'; END IF;",`${name}: the auth_required check is the first statement`);
    assert.equal(body.split("'auth_required'").length-1,1,`${name}: auth_required is raised in one place only`);
    assert.match(m[1],/^ {2}v_uid text:=public\.pool_platform_current_user_id\(\);$/m,`${name}: v_uid is the caller's resolved identity`);
    assert.doesNotMatch(m[1],/\bDEFAULT\b/i,`${name}: no DEFAULT initializers`);
    for(const init of m[1].matchAll(/:=(.*);$/gm))assert.ok(SAFE_INITIALIZERS.has(init[1]),`${name}: ${init[1]} runs before the auth_required check`);
    checksFirst.push(name);
  }
  // The identity helpers those initializers call only read.
  for(const helper of ['pool_platform_current_user_id','pool_platform_current_user_email']){
    const {head,body}=defs.get(helper);
    assert.match(head,/\nLANGUAGE sql\nSTABLE\n/,helper);
    assert.match(body,/^\s*SELECT\b/,helper);
    assert.doesNotMatch(body,/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|nextval|setval|pg_advisory\w*|pg_notify|NOTIFY|SHARE)\b/i,helper);
  }
  // Every RPC the client calls is one of them.
  const called=[...fs.readFileSync(new URL('./platform-client.js',import.meta.url),'utf8').matchAll(/this\.rpc\('(\w+)'/g)].map(m=>m[1]).sort();
  assert.deepEqual(called,['pool_platform_claim_entry_invite','pool_platform_commissioner_context','pool_platform_create_entry_invite',
    'pool_platform_participant_context','pool_platform_submit_batch','pool_platform_submit_entry']);
  for(const name of called)assert.ok(checksFirst.includes(name),`${name} must raise auth_required first`);
});
