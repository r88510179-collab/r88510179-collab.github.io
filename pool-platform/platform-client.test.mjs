import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test,{afterEach} from 'node:test';
import {pathToFileURL} from 'node:url';
import {authErrorMessage} from './auth-core.js';
import {AUTH_PROXY_PATH,PlatformClient,SESSION_CHANGED,SIGN_IN_CHANGED_HASH,SIGN_IN_CHECK_INTERVAL_MS,SIGN_IN_NOT_CONFIRMED,restartAfterSignInChange,sameAccount,takeSignInChangedMark,watchSignIn} from './platform-client.js';

// Shape-only fixture (base64url header.payload.signature); not a real credential.
const JWT='eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c2hhcGUtb25seS1zaWduYXR1cmU';
const DATA_URL='https://data.example.test/neondb/rest/v1/';
const SESSION={data:{session:{token:JWT},user:{id:'test-user'}},error:null};
const realFetch=globalThis.fetch;
// The browser globals the sign-in checks read. Node has none of them (its own BroadcastChannel would keep the test
// process alive), so each test that needs one installs a stand-in, and all of them are taken away again here.
const BROWSER_GLOBALS=['location','history','window','document','BroadcastChannel','localStorage'];
const realGlobals=BROWSER_GLOBALS.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
const setGlobal=(name,value)=>Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
afterEach(()=>{
  globalThis.fetch=realFetch;
  for(const [name,descriptor] of realGlobals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name]}
});

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
  const client=new PlatformClient({mode:'live',dataUrl:DATA_URL});
  client.neon={auth:{getSession:async()=>session}};
  return {client,requests};
}
const raised=message=>[400,{code:'P0001',message,details:null,hint:null}];
const AUTH_REQUIRED=raised('auth_required');
const PICKS={picks:{g1:'away',g2:'home'},tiebreak:10};
const submitEntry=client=>client.submitEntry({weekId:'week-1',entryId:'entry-1',source:'participant',payload:PICKS});

test('the client is live with a Data API URL alone, and hands the SDK only the same-origin Auth proxy, never a configured Auth URL',async t=>{
  assert.equal(new PlatformClient({mode:'live',dataUrl:DATA_URL}).live,true);
  for(const config of [{mode:'sandbox',dataUrl:''},{mode:'live',dataUrl:''},{mode:'live'},null,{mode:'live',authUrl:'https://auth.example.test/neondb/auth',dataUrl:''}]){
    assert.equal(new PlatformClient(config).live,false,JSON.stringify(config));
  }
  // The real module beside a stand-in SDK (vendor/neon-js.js exists only in a build) that records what it is given.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pool-platform-client-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const name of ['platform-client.js','auth-core.js'])fs.copyFileSync(new URL(`./${name}`,import.meta.url),path.join(dir,name));
  fs.mkdirSync(path.join(dir,'vendor'));
  // The stand-in also records the cross-tab channel it finds when it is created, as the real SDK would take it.
  fs.writeFileSync(path.join(dir,'vendor','neon-js.js'),"export function createClient(options){globalThis.__sdkOptions=options;globalThis.__sdkChannel=globalThis[Symbol.for('better-auth:broadcast-channel')];return{auth:{}}}\n");
  const realLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{value:{origin:'http://localhost:4173'},configurable:true});
  // Storage as an earlier version of the page may have left it: the SDK's last notice, and something that is not the SDK's.
  const storage=new Map([['better-auth.message','{"event":"session","data":{"trigger":"TOKEN_REFRESHED"}}'],['unrelated','kept']]),storageCalls=[];
  setGlobal('localStorage',{setItem:(key,value)=>{storageCalls.push(['setItem',key]);storage.set(key,value)},removeItem:key=>{storageCalls.push(['removeItem',key]);storage.delete(key)},
    getItem:key=>storage.get(key)??null});
  const channelKey=Symbol.for('better-auth:broadcast-channel');
  t.after(()=>{if(realLocation)Object.defineProperty(globalThis,'location',realLocation);else delete globalThis.location;
    for(const name of ['__sdkOptions','__sdkChannel','localStorage',channelKey])delete globalThis[name]});
  const {PlatformClient:Isolated}=await import(pathToFileURL(path.join(dir,'platform-client.js')).href);
  // Outside live mode the SDK is never loaded, and nothing is touched.
  await new Isolated({mode:'sandbox',dataUrl:''}).init();
  assert.deepEqual([globalThis[channelKey],storageCalls],[undefined,[]]);
  await new Isolated({mode:'live',authUrl:'https://ep-x.neonauth.c-0.aws.neon.test/neondb/auth',dataUrl:DATA_URL}).init();
  assert.deepEqual(globalThis.__sdkOptions,{auth:{url:'http://localhost:4173/api/auth'},dataApi:{url:DATA_URL}},'a stale authUrl in a configuration is ignored');
  assert.equal(AUTH_PROXY_PATH,'/api/auth');

  // The SDK's notices to other tabs are localStorage entries that hold the session. Before the SDK is created it is
  // given a channel that keeps nothing, under the very key the pinned SDK looks its channel up by.
  const channel=globalThis.__sdkChannel;
  assert.ok(channel&&Object.isFrozen(channel),'a channel was in place before the SDK was created');
  const {getGlobalBroadcastChannel,kBroadcastChannel}=await import('better-auth/client');
  assert.equal(kBroadcastChannel,channelKey,'the pinned SDK still looks its channel up under this key');
  assert.equal(getGlobalBroadcastChannel(),channel,'so the pinned SDK posts to this channel and to no other');
  assert.deepEqual(storageCalls,[['removeItem','better-auth.message']],'what an earlier version left behind is removed, and nothing else is touched');
  assert.deepEqual([...storage],[['unrelated','kept']]);
  // Everything the bundled SDK calls on its channel: it keeps nothing and delivers nothing.
  const heard=[];
  const unsubscribe=channel.subscribe(message=>heard.push(message));
  const cleanup=channel.setup();
  channel.post({event:'session',data:{trigger:'TOKEN_REFRESHED',sessionData:{session:{token:JWT},user:{email:'player@example.com',name:'Player'}}},clientId:'tab'});
  channel.post({event:'session',data:{trigger:'signout'},clientId:'tab'});
  assert.deepEqual([heard,storageCalls.length,[...storage]],[[],1,[['unrelated','kept']]]);
  assert.deepEqual([typeof unsubscribe,typeof cleanup,unsubscribe(),cleanup()],['function','function',undefined,undefined]);
  // A browser that refuses storage altogether still gets a working client.
  setGlobal('localStorage',{removeItem(){throw new DOMException('denied','SecurityError')}});
  await new Isolated({mode:'live',dataUrl:DATA_URL}).init();
  assert.deepEqual(globalThis.__sdkOptions,{auth:{url:'http://localhost:4173/api/auth'},dataApi:{url:DATA_URL}});
});

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

// ---- whose page this is ---------------------------------------------------------------------------------------
// A page binds the sign-in it shows. These checks are about what is then sent, to whom, and with which token.
const APP='https://app.example.test';
const GET_SESSION=`${APP}/api/auth/get-session`;
// Shape-only fixture, different from JWT: the token that comes with the Auth proxy's answer.
const JWT_NOW='eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJpYXQiOjJ9.ZnJlc2gtc2hhcGUtb25seS1zaWduYXR1cmU';
const signedIn=(user,jwt=JWT_NOW)=>({status:200,body:{session:{id:`session-of-${user}`,userId:user},user:{id:user}},jwt});
const SIGNED_OUT={status:200,body:null};
// A live client bound to the sign-in the SDK remembers. The Auth proxy answers get-session n with proxy[n-1] and the
// Data API answers request n with data[n-1] (the last of each repeats). Every request is recorded, in order.
function bound({proxy=[signedIn('test-user')],data=[[200,{ok:true}]],session=SESSION,bind=session.data}={}){
  const requests=[],changes=[];
  let asked=0,called=0;
  setGlobal('location',{origin:APP});
  globalThis.fetch=async(url,init)=>{
    const kind=url===GET_SESSION?'auth':'data';
    requests.push({kind,url,init,at:Date.now()});
    if(kind==='auth'){
      const reply=proxy[Math.min(++asked,proxy.length)-1];
      if(reply instanceof Error)throw reply;
      return new Response(reply.raw??JSON.stringify(reply.body),{status:reply.status,
        headers:{'content-type':'application/json',...(reply.jwt?{'set-auth-jwt':reply.jwt}:{})}});
    }
    const reply=data[Math.min(++called,data.length)-1];
    if(reply instanceof Error)throw reply;
    return new Response(JSON.stringify(reply[1]),{status:reply[0],headers:{'content-type':'application/json'}});
  };
  const client=new PlatformClient({mode:'live',dataUrl:DATA_URL});
  client.neon={auth:{getSession:async()=>session}};
  client.bindSession(bind,()=>changes.push(client.sessionEnded));
  return {client,requests,changes,kinds:()=>requests.map(request=>request.kind)};
}
const bearer=request=>request.init.headers.Authorization;

test('the same account is the same user id on both sides, and a sign-in that names no account is never the same',()=>{
  assert.equal(sameAccount({user:{id:'a'}},{user:{id:'a'}}),true);
  assert.equal(sameAccount({session:{id:'s1'},user:{id:'a'}},{session:{id:'s2'},user:{id:'a'}}),true,'signed in again as the same account');
  for(const [a,b] of [[{user:{id:'a'}},{user:{id:'b'}}],[{user:{id:'a'}},null],[null,null],[{user:{}},{user:{}}],[{user:{id:''}},{user:{id:''}}],
    [{user:{id:7}},{user:{id:7}}],[undefined,{user:{id:'a'}}]])assert.equal(sameAccount(a,b),false,JSON.stringify([a,b]));
});

test('a bound write asks the server first, through the same-origin Auth proxy, and is sent with the token of that answer',async()=>{
  const {client,requests,changes,kinds}=bound({data:[[200,{code:'created',revision:1}]]});
  assert.deepEqual(await submitEntry(client),{code:'created',revision:1});
  assert.deepEqual(kinds(),['auth','data']);
  assert.equal(requests[0].url,GET_SESSION);
  assert.deepEqual(requests[0].init,{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}},
    'the session cookie goes with it; no token, no body, no query string and never a cached answer');
  assert.equal(requests[1].url,`${DATA_URL}rpc/pool_platform_submit_entry`);
  assert.equal(bearer(requests[1]),`Bearer ${JWT_NOW}`,'the token the server just issued for this account, not the one the SDK remembered');
  assert.deepEqual(changes,[]);
  assert.equal(client.sessionEnded,false);
});

test('a bound write is not sent when the browser is signed in as another account, or signed out: nothing reaches the Data API',async()=>{
  for(const now of [signedIn('someone-else'),SIGNED_OUT,{status:200,body:{session:null,user:null}},{status:200,body:{session:{id:'s'},user:{}}}]){
    const {client,changes,kinds}=bound({proxy:[now]});
    const error=await submitEntry(client).catch(e=>e);
    assert.equal(error.code,SESSION_CHANGED,JSON.stringify(now));
    assert.equal(error.message,SIGN_IN_NOT_CONFIRMED);
    assert.deepEqual(kinds(),['auth'],'only the question was asked');
    assert.deepEqual(changes,[true],'the page is told once, after the client has already stopped sending');
    // The page is starting again. Until it has, this client sends nothing more: not a write, not a read, no question.
    await assert.rejects(submitEntry(client),{code:SESSION_CHANGED});
    await assert.rejects(client.participantContext('demo',2027,3),{code:SESSION_CHANGED});
    await client.confirmBoundSession();
    client.bindSession(null);
    await assert.rejects(client.listParticipantPools(),{code:SESSION_CHANGED},'taking the account off the page does not lift it');
    assert.deepEqual(kinds(),['auth']);
    assert.deepEqual(changes,[true]);
  }
});

test('a bound write is not sent when the server cannot be asked, and the page is left as it is',async()=>{
  for(const failure of [new TypeError('fetch failed'),{status:502,body:{code:'AUTH_UPSTREAM_ERROR',message:'x'}},{status:429,body:{code:'TOO_MANY_REQUESTS',message:'x'}},
    {status:401,body:{code:'UNAUTHORIZED',message:'x'}},{status:200,raw:'<html>not json</html>'}]){
    const {client,changes,kinds}=bound({proxy:[failure,signedIn('test-user')]});
    const error=await submitEntry(client).catch(e=>e);
    assert.equal(error.message,SIGN_IN_NOT_CONFIRMED,JSON.stringify(failure));
    assert.equal(error.code,undefined,'not reported as a changed sign-in');
    assert.deepEqual(kinds(),['auth']);
    assert.deepEqual(changes,[]);
    assert.equal(client.sessionEnded,false);
    // Nothing was decided on a guess, so the next attempt asks again and goes through.
    assert.deepEqual(await submitEntry(client),{ok:true});
    assert.deepEqual(kinds(),['auth','auth','data']);
  }
});

test('a bound write whose confirmation carries no token falls back to the SDK token, and only for the same account',async()=>{
  const confirmedWithoutToken={status:200,body:signedIn('test-user').body};
  const {client,requests,kinds}=bound({proxy:[confirmedWithoutToken]});
  assert.deepEqual(await submitEntry(client),{ok:true});
  assert.deepEqual(kinds(),['auth','data']);
  assert.equal(bearer(requests[1]),`Bearer ${JWT}`);
  // A token that is not a JWT is never sent as one.
  const odd=bound({proxy:[{...confirmedWithoutToken,jwt:'not-a-jwt'}]});
  assert.deepEqual(await submitEntry(odd.client),{ok:true});
  assert.equal(bearer(odd.requests[1]),`Bearer ${JWT}`);
  // The SDK has moved on to another account in the meantime: its token is not this page's.
  const moved=bound({proxy:[confirmedWithoutToken],bind:{session:{id:'s'},user:{id:'test-user'}},
    session:{data:{session:{token:JWT},user:{id:'someone-else'}},error:null}});
  await assert.rejects(submitEntry(moved.client),{code:SESSION_CHANGED});
  assert.deepEqual(moved.kinds(),['auth']);
  assert.deepEqual(moved.changes,[true]);
  const unidentified=bound({proxy:[confirmedWithoutToken],session:{data:{session:{token:JWT}},error:null},bind:SESSION.data});
  await assert.rejects(submitEntry(unidentified.client),/Authentication required/);
  assert.deepEqual(unidentified.kinds(),['auth']);
});

test('a bound read asks nobody and uses the SDK token, until the SDK itself names another account',async()=>{
  const {client,requests,kinds,changes}=bound();
  assert.deepEqual(await client.participantContext('demo',2027,3),{ok:true});
  assert.deepEqual(kinds(),['data']);
  assert.equal(bearer(requests[0]),`Bearer ${JWT}`);
  assert.deepEqual(changes,[]);
  const moved=bound({bind:{session:{id:'s'},user:{id:'test-user'}},session:{data:{session:{token:JWT},user:{id:'someone-else'}},error:null}});
  await assert.rejects(moved.client.participantContext('demo',2027,3),{code:SESSION_CHANGED});
  assert.deepEqual(moved.kinds(),[]);
  assert.deepEqual(moved.changes,[true]);
  // The SDK failing to answer is not a changed sign-in: the read fails as it always did and the page stays.
  const failing=bound({bind:{session:{id:'s'},user:{id:'test-user'}},session:{data:null,error:{message:'session lookup failed'}}});
  await assert.rejects(failing.client.participantContext('demo',2027,3),/Authentication required/);
  assert.deepEqual(failing.kinds(),[]);
  assert.deepEqual(failing.changes,[]);
  assert.equal(failing.client.sessionEnded,false);
});

test('a bound write that meets auth_required confirms the account again before retrying the same payload',async()=>{
  const retryToken=`${JWT_NOW}a`;
  const {client,requests,kinds}=bound({proxy:[signedIn('test-user'),signedIn('test-user',retryToken)],data:[AUTH_REQUIRED,[200,{code:'created',revision:1}]]});
  assert.deepEqual(await submitEntry(client),{code:'created',revision:1});
  assert.deepEqual(kinds(),['auth','data','auth','data']);
  assert.equal(requests[3].url,requests[1].url);
  assert.equal(requests[3].init.body,requests[1].init.body);
  assert.equal(bearer(requests[1]),`Bearer ${JWT_NOW}`);
  assert.equal(bearer(requests[3]),`Bearer ${retryToken}`);
});

test('a bound write that meets auth_required stops if the browser signed out or switched accounts',async()=>{
  for(const now of [SIGNED_OUT,signedIn('someone-else')]){
    const {client,kinds,changes}=bound({proxy:[signedIn('test-user'),now],data:[AUTH_REQUIRED]});
    await assert.rejects(submitEntry(client),{code:SESSION_CHANGED});
    assert.deepEqual(kinds(),['auth','data','auth']);
    assert.deepEqual(changes,[true]);
  }
});

test('a write is exactly a function that is not STABLE: each asks the server first when bound, and no read does',async()=>{
  const dir=new URL('./migrations/',import.meta.url);
  const volatility=new Map();
  for(const file of fs.readdirSync(dir).filter(name=>name.endsWith('.sql')).sort()){
    const sql=fs.readFileSync(new URL(file,dir),'utf8').replace(/^\s*--.*$/gm,'');
    for(const m of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(([\s\S]*?)\bAS\s+\$\w*\$/gi))
      volatility.set(m[1],/\b(?:STABLE|IMMUTABLE)\b/.test(m[2])?'reads':'writes');
  }
  const seen={reads:0,writes:0};
  for(const [suffix,call] of retryCases){
    const name='pool_platform_'+suffix,kind=volatility.get(name);
    assert.ok(kind,name);
    seen[kind]++;
    const {client,kinds}=bound();
    assert.deepEqual(await call(client),{ok:true},name);
    assert.deepEqual(kinds(),kind==='writes'?['auth','data']:['data'],`${name} ${kind}`);
    // Unbound, as a page with no sign-in on it: nothing is asked, exactly as before.
    const unbound=bound({bind:null});
    assert.deepEqual(await call(unbound.client),{ok:true},name);
    assert.deepEqual(unbound.kinds(),['data'],name);
  }
  assert.deepEqual(seen,{reads:8,writes:12});
});

test('a session that names no account binds nothing, and the page works as it did before the check existed',async()=>{
  for(const bind of [null,{},{session:{id:'s'}},{session:{id:'s'},user:{}},{session:{id:'s'},user:{id:''}},{session:{id:'s'},user:{id:7}}]){
    const {client,kinds,changes}=bound({bind,proxy:[signedIn('someone-else')]});
    assert.equal(client.boundSession,null,JSON.stringify(bind));
    client.bindSession(undefined,()=>changes.push('undefined'));
    assert.equal(client.boundSession,null);
    assert.deepEqual(await submitEntry(client),{ok:true});
    await client.confirmBoundSession();
    assert.deepEqual(kinds(),['data']);
    assert.deepEqual(changes,[]);
  }
});

test('asking on its own: the same account changes nothing, another or none ends the page, and no answer changes nothing',async()=>{
  const same=bound();
  await same.client.confirmBoundSession();
  assert.deepEqual([same.kinds(),same.changes,same.client.sessionEnded],[['auth'],[],false]);
  for(const now of [signedIn('someone-else'),SIGNED_OUT]){
    const {client,kinds,changes}=bound({proxy:[now]});
    await client.confirmBoundSession();
    await client.confirmBoundSession();
    assert.deepEqual([kinds(),changes,client.sessionEnded,client.boundSession],[['auth'],[true],true,null],JSON.stringify(now));
  }
  for(const failure of [new TypeError('fetch failed'),{status:502,body:{}},{status:200,raw:''}]){
    const {client,kinds,changes}=bound({proxy:[failure]});
    await client.confirmBoundSession();
    assert.deepEqual([kinds(),changes,client.sessionEnded],[['auth'],[],false]);
  }
  // Signed out on this very page while the question was in flight: the answer is about a page that is gone.
  const leaving=bound({proxy:[SIGNED_OUT]});
  const asking=leaving.client.confirmBoundSession();
  leaving.client.bindSession(null);
  await asking;
  assert.deepEqual([leaving.changes,leaving.client.sessionEnded],[[],false]);
});

// The page side: when to ask, and how a page starts again.
function browserStandIns(){
  const channels=[];
  class FakeChannel extends EventTarget{
    constructor(name){super();this.name=name;this.closed=false;this.posted=[];channels.push(this)}
    postMessage(data){this.posted.push(data);for(const other of channels)if(other!==this&&other.name===this.name&&!other.closed)other.dispatchEvent(new MessageEvent('message',{data}))}
    close(){this.closed=true}
  }
  const windowStandIn=new EventTarget(),documentStandIn=Object.assign(new EventTarget(),{visibilityState:'visible'});
  setGlobal('window',windowStandIn);setGlobal('document',documentStandIn);setGlobal('BroadcastChannel',FakeChannel);
  return {channels,window:windowStandIn,document:documentStandIn};
}
const pageShow=persisted=>Object.assign(new Event('pageshow'),{persisted});

test('a page asks when it is shown or focused, at most once per interval, at once when another tab signs in or out, and never while it shows no sign-in',async()=>{
  const page=browserStandIns();
  const asked=[];
  const client={boundSession:{user:{id:'a'}},confirmBoundSession:async()=>{asked.push(Date.now())}};
  watchSignIn(client,{minIntervalMs:60_000});
  page.window.dispatchEvent(new Event('focus'));
  assert.equal(asked.length,1);
  page.window.dispatchEvent(new Event('focus'));
  page.document.dispatchEvent(new Event('visibilitychange'));
  page.window.dispatchEvent(pageShow(false));
  assert.equal(asked.length,1,'not again within the interval, and an ordinary page load is not a return from the cache');
  page.window.dispatchEvent(pageShow(true));
  assert.equal(asked.length,2,'back from the back/forward cache: asked whatever the interval');
  // Another tab of the app signs out: this client is told through the channel and asks at once.
  setGlobal('location',{origin:APP});
  globalThis.fetch=async()=>new Response('{}',{status:200,headers:{'content-type':'application/json'}});
  const elsewhere=new PlatformClient({mode:'live',dataUrl:DATA_URL});
  elsewhere.neon={auth:{signOut:async()=>({error:null}),signIn:{emailOtp:async()=>({error:null})},getSession:async()=>SESSION}};
  await elsewhere.signOut();
  assert.equal(asked.length,3);
  await elsewhere.verifyOtp('player@example.com','123456');
  assert.equal(asked.length,4);
  assert.deepEqual(page.channels.filter(channel=>channel.posted.length).map(channel=>[channel.name,channel.posted,channel.closed]),
    [['pool-platform-sign-in',['changed'],true],['pool-platform-sign-in',['changed'],true]],'the notice carries no account, session or token');
  // A page that is hidden does not ask on its own; a page with no sign-in on it never asks.
  const hidden=browserStandIns(),quiet=[];
  hidden.document.visibilityState='hidden';
  const background={boundSession:{user:{id:'a'}},confirmBoundSession:async()=>{quiet.push(1)}};
  watchSignIn(background);
  hidden.document.dispatchEvent(new Event('visibilitychange'));
  hidden.window.dispatchEvent(new Event('focus'));
  assert.equal(quiet.length,0);
  hidden.document.visibilityState='visible';
  hidden.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(quiet.length,1);
  background.boundSession=null;
  hidden.window.dispatchEvent(pageShow(true));
  hidden.channels.at(-1).dispatchEvent(new MessageEvent('message',{data:'changed'}));
  assert.equal(quiet.length,1);
});

test('a page that has just asked for a write does not ask again on being shown: one question a minute, whoever asked',async()=>{
  assert.equal(SIGN_IN_CHECK_INTERVAL_MS,60_000);
  const page=browserStandIns();
  const {client,kinds}=bound();
  watchSignIn(client);
  assert.deepEqual(await submitEntry(client),{ok:true});
  assert.deepEqual(kinds(),['auth','data']);
  page.window.dispatchEvent(new Event('focus'));
  page.document.dispatchEvent(new Event('visibilitychange'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(kinds(),['auth','data'],'the write asked a moment ago');
  // A minute later the page is looked at again: it asks, once.
  client.lastAskedAt-=SIGN_IN_CHECK_INTERVAL_MS;
  page.window.dispatchEvent(new Event('focus'));
  page.window.dispatchEvent(new Event('focus'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(kinds(),['auth','data','auth']);
  // Being told by another tab is not held back by any of that.
  page.channels.at(-1).dispatchEvent(new MessageEvent('message',{data:'changed'}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(kinds(),['auth','data','auth','auth']);
});

test('a failed sign-in or sign-out tells no other tab, and a browser without the channel still signs in and out',async()=>{
  const page=browserStandIns();
  const client=new PlatformClient({mode:'live',dataUrl:DATA_URL});
  client.neon={auth:{signOut:async()=>{throw new Error('offline')},signIn:{emailOtp:async()=>({error:new Error('Invalid OTP')})},getSession:async()=>SESSION}};
  await assert.rejects(client.signOut(),/offline/);
  await assert.rejects(client.verifyOtp('player@example.com','123456'),/Invalid OTP/);
  assert.equal(page.channels.length,0);
  delete globalThis.BroadcastChannel;
  client.neon={auth:{signOut:async()=>({error:null}),signIn:{emailOtp:async()=>({error:null})},getSession:async()=>SESSION}};
  await client.signOut();
  assert.deepEqual(await client.verifyOtp('player@example.com','123456'),{session:SESSION.data.session,user:SESSION.data.user});
  const asked=[];
  watchSignIn({boundSession:{user:{id:'a'}},confirmBoundSession:async()=>{asked.push(1)}});
  page.window.dispatchEvent(new Event('focus'));
  assert.equal(asked.length,1,'without the channel the page still asks when it is looked at');
});

test('a page starts again at its bare address with a mark, and the mark is read once and taken out of the address',()=>{
  const calls=[];
  const location={origin:APP,pathname:'/participant.html',search:'?pool=demo-pool',hash:'',reload:()=>calls.push('reload')};
  setGlobal('location',location);
  setGlobal('history',{replaceState:(state,title,url)=>{calls.push(url);const at=url.indexOf('#');location.hash=at<0?'':url.slice(at);
    const rest=at<0?url:url.slice(0,at),query=rest.indexOf('?');location.search=query<0?'':rest.slice(query);location.pathname=query<0?rest:rest.slice(0,query)}});
  assert.equal(takeSignInChangedMark(),false);
  assert.deepEqual(calls,[],'an ordinary load is left alone');
  restartAfterSignInChange();
  assert.deepEqual(calls,[`/participant.html${SIGN_IN_CHANGED_HASH}`,'reload'],'no pool, no entry and no query string of the previous account');
  calls.length=0;
  assert.equal(takeSignInChangedMark(),true);
  assert.deepEqual(calls,['/participant.html']);
  assert.equal(takeSignInChangedMark(),false,'read once');
  location.hash='#sign-in-changed-not';
  assert.equal(takeSignInChangedMark(),false);
});

const exampleId='a0000000-0000-4000-8000-000000000001';
const digest='a'.repeat(64);
const source='League gamebook, regular season week 1';
const retryCases=[
  ['claim_email_invite',c=>c.claimEmailInvite(exampleId),{p_entry_id:exampleId}],
  ['list_participant_pools',c=>c.listParticipantPools(),{}],
  ['list_commissioner_pools',c=>c.listCommissionerPools(),{}],
  ['participant_context',c=>c.participantContext('demo',2027,3),{p_pool_slug:'demo',p_season:2027,p_week:3}],
  ['commissioner_context',c=>c.commissionerContext('demo'),{p_pool_slug:'demo'}],
  ['submit_entry',submitEntry,{p_week_id:'week-1',p_entry_id:'entry-1',p_source:'participant',p_payload:PICKS}],
  ['submit_batch',c=>c.submitBatch({weekId:'w',source:'commissioner_manual',items:[]}),{p_week_id:'w',p_source:'commissioner_manual',p_items:[]}],
  ['week_projection_snapshot',c=>c.weekProjectionSnapshot(exampleId),{p_week_id:exampleId}],
  ['week_result_snapshot',c=>c.weekResultSnapshot(exampleId),{p_week_id:exampleId}],
  ['season_standings_snapshot',c=>c.seasonStandingsSnapshot(exampleId,2027),{p_pool_id:exampleId,p_season:2027}],
  ['attest_week_final_results_with_source',c=>c.attestWeekFinalResults({weekId:exampleId,expectedRevision:0,results:[],sourceSha256:digest,sourceReference:source}),
    {p_week_id:exampleId,p_expected_revision:0,p_results:[],p_source_sha256:digest,p_source_reference:source,p_correction_reason:null}],
  ['create_entry',c=>c.createEntry({seasonId:'s',entryCode:'A',displayName:'Player'}),{p_season_id:'s',p_entry_code:'A',p_display_name:'Player'}],
  ['create_draft_week',c=>c.createDraftWeek({seasonId:'s',week:2,deadlineAt:'2030-09-01T16:00Z'}),{p_season_id:'s',p_week:2,p_deadline_at:'2030-09-01T16:00Z',p_opens_at:null}],
  ['create_pool',c=>c.createPool({tenantId:'t',displayName:'Demo',poolType:'survivor'}),{p_tenant_id:'t',p_display_name:'Demo',p_pool_type:'survivor'}],
  ['create_season',c=>c.createSeason({poolId:exampleId,season:2027}),{p_pool_id:exampleId,p_season:2027}],
  ['verified_schedule_preview',c=>c.previewVerifiedSchedule({weekId:'w'}),{p_week_id:'w'}],
  ['apply_verified_schedule',c=>c.applyVerifiedSchedule({weekId:'w',digest}),{p_week_id:'w',p_expected_source_sha256:digest,p_tiebreak_required:false}],
  ['open_verified_week',c=>c.openVerifiedWeek({weekId:'w',digest}),{p_week_id:'w',p_expected_source_sha256:digest,p_confirm:true}],
  ['save_draft_schedule',c=>c.saveDraftSchedule({weekId:'w',config:{}}),{p_week_id:'w',p_config:{}}],
  ['create_email_invite',c=>c.createInvite({entryId:exampleId,email:' Player@Example.com ',expiresHours:24}),{p_entry_id:exampleId,p_email:'player@example.com',p_expires_hours:24}]
];

test('every client RPC resends the same request after an uncommitted auth_required',async()=>{
  for(const [suffix,call,args] of retryCases){
    const name='pool_platform_'+suffix;
    const {client,requests}=live([AUTH_REQUIRED,[200,{ok:true}]]);
    assert.deepEqual(await call(client),{ok:true},name);
    assert.equal(requests.length,2,name);
    assert.equal(requests[0].url,DATA_URL+'rpc/'+name,name);
    assert.deepEqual(requests[1],{...requests[0],at:requests[1].at},name);
    assert.deepEqual(JSON.parse(requests[1].init.body),args,name);
  }
});

test('invitations require a recipient before an RPC is sent',async()=>{
  const {client,requests}=live([[200,{ok:true}]]);
  for(const email of [null,'','   ','invalid'])await assert.rejects(client.createInvite({entryId:exampleId,email}),/valid invitation email/);
  assert.equal(requests.length,0);
});

// rpc() resends a request that failed with auth_required. That is safe only while each function a signed-in caller
// may execute either never answers auth_required, or raises it as its first statement, after computing nothing but
// side-effect-free locals. These checks read the migrations so that a new or changed RPC cannot break it silently.
test('retry contract: every browser-callable RPC raises auth_required before any read, lock, write or side effect',()=>{
  const dir=new URL('./migrations/',import.meta.url);
  const manifest=name=>fs.readFileSync(new URL('./ops/release/'+name,import.meta.url),'utf8');
  const staged=[...manifest('predeploy.sql').matchAll(/\\ir \.\.\/\.\.\/migrations\/(\w+\.sql)/g)].map(m=>m[1]);
  const retired=[...manifest('retire-legacy-invites.sql').matchAll(/\\ir \.\.\/\.\.\/migrations\/(\w+\.sql)/g)].map(m=>m[1]);
  assert.equal(staged.length,13);
  assert.equal(retired.length,1);
  const files=[...fs.readdirSync(dir).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort(),...staged,...retired];
  const defs=new Map(),callable=new Set();
  for(const file of files){
    const sql=fs.readFileSync(new URL(file,dir),'utf8').replace(/^\s*--.*$/gm,'');
    for(const m of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(([\s\S]*?)\bAS\s+(\$\w*\$)([\s\S]*?)\3\s*;/gi))defs.set(m[1],{head:m[2],body:m[4].trim()});
    for(const m of sql.matchAll(/(GRANT EXECUTE|REVOKE (?:EXECUTE|ALL)) ON FUNCTION public\.(\w+)\([^)]*\)\s+(?:TO|FROM) authenticated;/gi)){
      if(m[1].startsWith('GRANT'))callable.add(m[2]);else callable.delete(m[2]);
    }
  }
  const safe=new Set(['public.pool_platform_current_user_id()','public.pool_platform_current_user_email()',
    "NULLIF(lower(btrim(p_email)),'')","'[]'::jsonb",'upper(btrim(p_entry_code))','btrim(p_display_name)','ARRAY[]::text[]','0','false']);
  const checksFirst=new Set();
  for(const name of callable){
    assert.ok(defs.has(name),name);
    const {body}=defs.get(name);
    if(!body.includes("'auth_required'")){
      for(const [other,fn] of defs)if(fn.body.includes("'auth_required'"))assert.ok(!body.includes(other+'('),name+' calls '+other);
      continue;
    }
    const parts=/^DECLARE\b([\s\S]*?)\bBEGIN\b([\s\S]*)$/i.exec(body);
    assert.ok(parts,name);
    assert.match(parts[2],/^\s*IF\s+v_uid\s+IS\s+NULL\s+THEN\s+RAISE EXCEPTION 'auth_required';\s*END IF;/i,name);
    assert.equal(body.split("'auth_required'").length,2,name);
    assert.match(parts[1],/\bv_uid\s+text\s*:=\s*public\.pool_platform_current_user_id\(\)\s*;/i,name);
    assert.doesNotMatch(parts[1],/\bDEFAULT\b/i,name);
    for(const m of parts[1].matchAll(/:=\s*([^;]+);/g)){
      const init=m[1].replace(/\s/g,'');
      assert.ok(safe.has(init)||/^ARRAY\['[A-Z]{2,3}'(?:,'[A-Z]{2,3}')*\]$/.test(init),name+' initializer '+init);
    }
    checksFirst.add(name);
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
  assert.deepEqual(called,retryCases.map(([suffix])=>'pool_platform_'+suffix).sort());
  for(const name of called)assert.ok(checksFirst.has(name),name+' must authorize before any side effect');
  for(const retiredName of ['pool_platform_claim_entry_invite','pool_platform_create_entry_invite','pool_platform_attest_week_final_results'])assert.ok(!callable.has(retiredName),retiredName);

});
