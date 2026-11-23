import {extractAccessToken,normalizeEmail,validEmail,validOtp,authErrorMessage} from './auth-core.js';

// The first request a newly opened Data API backend connection serves can run with auth.user_id() = NULL although its
// JWT is valid (observed on the commercial Neon endpoint; the cause inside Neon is not established). The RPC then fails
// closed with exactly 'auth_required', and rpc() sends the same request once more, after AUTH_RETRY_DELAY_MS.
// That is safe only because every browser-callable RPC raises 'auth_required' as its first statement, before it reads,
// locks or writes anything, so the first request did nothing. A new RPC must keep that order or this retry would replay
// its work; platform-client.test.mjs checks the migrations for it.
const AUTH_REQUIRED='auth_required';
const AUTH_RETRY_DELAY_MS=200;
export const SIGN_IN_NOT_CONFIRMED='Your sign-in could not be confirmed. Try again, or sign out and sign in again.';
// Shown when a page cannot load platform-config.js, which the service worker never caches (offline, or missing).
export const CONFIG_UNAVAILABLE='This page could not load its configuration. Check your connection, then reload.';
// Neon Auth is reached only through the same-origin proxy (server/auth-proxy-core.mjs). The browser never names or
// calls the Neon Auth host, and the page CSP's connect-src does not list it, so it could not even if asked to.
export const AUTH_PROXY_PATH='/api/auth';

// A browser holds one sign-in for all of its tabs, but the SDK answers getSession() from its own memory until the
// token it holds expires, and nothing tells it that another tab signed out or signed someone else in (its own
// cross-tab notice needs a listener that only its session hook installs, and these pages do not use that hook).
// So a page left open kept reading and writing as the account it was opened with. Three measures close that:
//   - a page binds the sign-in it shows (bindSession). From then on a write is sent only after the server, asked
//     through the same-origin Auth proxy and never through the SDK, has answered that the browser is still signed
//     in as that account; the write carries the token that came with that very answer;
//   - signing in or out tells the app's other tabs at once, over a BroadcastChannel that carries no data;
//   - a page asks again whenever it is shown or focused (watchSignIn), for a browser without that channel.
// A page whose sign-in changed sends nothing more, takes the previous account off the screen and starts again.
export const SESSION_CHANGED='session_changed';
export const SIGN_IN_CHANGED_HASH='#sign-in-changed';
export const SIGN_IN_CHANGED='The sign-in on this browser changed, so this page was reloaded. It shows only the account that is signed in now.';
export const SIGNED_OUT_ELSEWHERE='You were signed out on this browser. Sign in again to continue.';
const SIGN_IN_CHANNEL='pool-platform-sign-in';

// The account a session belongs to. The same field of the same endpoint is compared on both sides (the SDK and
// currentSignIn() both read it from the Auth proxy's get-session), so nothing is assumed about its value.
const accountOf=signIn=>typeof signIn?.user?.id==='string'&&signIn.user.id!==''?signIn.user.id:null;
export const sameAccount=(a,b)=>accountOf(a)!==null&&accountOf(a)===accountOf(b);
const sessionChangedError=()=>Object.assign(new Error(SIGN_IN_NOT_CONFIRMED),{code:SESSION_CHANGED});

function announceSignInChange(){
  try{const channel=new BroadcastChannel(SIGN_IN_CHANNEL);channel.postMessage('changed');channel.close()}
  catch{ /* no channel in this browser: the other tabs find out when they are shown, and before any write */ }
}

// Whether this page was started again because its sign-in changed. The mark is taken out of the address at once.
export function takeSignInChangedMark(){
  if(location.hash!==SIGN_IN_CHANGED_HASH)return false;
  history.replaceState(null,'',location.pathname+location.search);
  return true;
}
// Starts the page again with nothing of the previous account in it: no pool, no entry and no query string. A
// reload, because only a new page drops what the SDK remembers of the previous sign-in.
export function restartAfterSignInChange(){
  history.replaceState(null,'',location.pathname+SIGN_IN_CHANGED_HASH);
  location.reload();
}

// Keeps a page asking whose page it is: when it is shown or focused again, when it comes back from the back/forward
// cache, and at once when another tab of the app signs in or out. It asks only while the page shows a sign-in, and
// on being shown or focused at most once a minute, counting what a write has just asked: every question is a
// request to the Auth proxy, which the host limits per network address (netlify/functions/auth-session.mjs).
export const SIGN_IN_CHECK_INTERVAL_MS=60_000;
export function watchSignIn(client,{minIntervalMs=SIGN_IN_CHECK_INTERVAL_MS}={}){
  let last=-Infinity;
  const ask=force=>{
    if(!client.boundSession)return;
    if(!force&&(document.visibilityState==='hidden'||Date.now()-Math.max(last,client.lastAskedAt??-Infinity)<minIntervalMs))return;
    last=Date.now();
    void client.confirmBoundSession();
  };
  window.addEventListener('focus',()=>ask(false));
  document.addEventListener('visibilitychange',()=>ask(false));
  window.addEventListener('pageshow',event=>{if(event.persisted)ask(true)});
  try{new BroadcastChannel(SIGN_IN_CHANNEL).addEventListener('message',()=>ask(true))}
  catch{ /* no channel in this browser: asked when the page is shown, and before any write */ }
}

// Better Auth's notice to other tabs is a localStorage entry, "better-auth.message", and the SDK posts one at
// sign-out and every time it renews its token. The renewal notice holds the whole session: the Data API token, the
// email address and the name (seen in the built page, once the token the SDK remembered had expired). No page of this
// app ever read those notices, because the listener for them is installed only by the SDK's session hook, which these
// pages do not use; they did nothing but leave a bearer token and personal data in storage. The SDK takes its channel
// from a well-known global when one is already there, so a channel that keeps nothing is put there before the SDK
// loads, and an entry an earlier version of the page left behind is removed. What another tab needs to know reaches
// it without any data (announceSignInChange).
const SDK_NOTICE_CHANNEL=Symbol.for('better-auth:broadcast-channel');
const SDK_NOTICE_KEY='better-auth.message';
const KEEPS_NOTHING=Object.freeze({post(){},subscribe(){return()=>{}},setup(){return()=>{}}});
function keepSdkNoticesOutOfStorage(){
  globalThis[SDK_NOTICE_CHANNEL]=KEEPS_NOTHING;
  try{globalThis.localStorage?.removeItem(SDK_NOTICE_KEY)}catch{ /* no storage here: nothing was kept in it */ }
}

async function postRpc(url,token,args){
  const response=await fetch(url,{
    method:'POST',
    headers:{
      'Authorization':`Bearer ${token}`,
      'Content-Type':'application/json',
      'Accept':'application/json'
    },
    body:JSON.stringify(args)
  });
  const text=await response.text();
  let body=null;
  try{body=text?JSON.parse(text):null}catch{body=text}
  return {response,text,body};
}

const authRequired=({response,body})=>!response.ok&&!!body&&typeof body==='object'&&body.message===AUTH_REQUIRED;

export class PlatformClient{
  constructor(config){
    this.config=config;
    this.neon=null;
    // The sign-in the page shows and what to do when the browser's is no longer that one (bindSession). sessionEnded
    // is set when that was found, and from then on this client sends nothing.
    this.boundSession=null;
    this.onSessionChanged=null;
    this.sessionEnded=false;
    // When the server was last asked whose sign-in the browser holds (currentSignIn).
    this.lastAskedAt=-Infinity;
  }

  get live(){
    return this.config?.mode==='live'&&!!this.config?.dataUrl;
  }

  async init(){
    if(!this.live)return this;
    keepSdkNoticesOutOfStorage();
    // The pinned @neondatabase/neon-js 0.7.0-beta, bundled by scripts/build.mjs into a module on this same origin.
    const {createClient}=await import('./vendor/neon-js.js');
    this.neon=createClient({auth:{url:new URL(AUTH_PROXY_PATH,location.origin).href},dataApi:{url:this.config.dataUrl}});
    return this;
  }

  async getSession(){
    if(!this.live)return null;
    const result=await this.neon.auth.getSession();
    return result?.data?.session&&result?.data?.user?{session:result.data.session,user:result.data.user}:null;
  }

  async sendOtp(email){
    const normalized=normalizeEmail(email);
    if(!validEmail(normalized))throw new Error('Enter a valid email address.');
    const {error}=await this.neon.auth.emailOtp.sendVerificationOtp({email:normalized,type:'sign-in'});
    if(error)throw error;
    return normalized;
  }

  async verifyOtp(email,otp){
    const normalized=normalizeEmail(email);
    if(!validEmail(normalized)||!validOtp(otp))throw new Error('Enter a valid email and numeric sign-in code.');
    const {error}=await this.neon.auth.signIn.emailOtp({email:normalized,otp:String(otp).trim()});
    if(error)throw error;
    const session=await this.getSession();
    if(!session)throw new Error('Sign-in completed but no session was created.');
    announceSignInChange();
    return session;
  }

  async signOut(){
    if(this.neon)await this.neon.auth.signOut();
    announceSignInChange();
  }

  // The browser's sign-in as the server sees it at this moment, and the Data API token that came with the answer:
  // asked of the same-origin Auth proxy with the session cookie, never of the SDK. signIn is null when the browser
  // is signed out. It throws when the server did not answer the question, so that nothing is decided on a guess.
  async currentSignIn(){
    let response,data;
    this.lastAskedAt=Date.now();
    try{
      response=await fetch(new URL(`${AUTH_PROXY_PATH}/get-session`,location.origin).href,
        {method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error(String(response.status));
      data=await response.json();
    }catch{throw new Error(SIGN_IN_NOT_CONFIRMED)}
    const signIn=data?.session&&accountOf(data)?{session:data.session,user:data.user}:null;
    return {signIn,token:signIn?extractAccessToken({token:response.headers.get('set-auth-jwt')}):null};
  }

  // Binds the sign-in the page shows; null when it shows none. onChanged is called once, when the browser turns out
  // to be signed out or signed in as another account. A session that names no account binds nothing, and the page
  // then works as it did before this check existed rather than refusing everything.
  bindSession(session,onChanged=null){
    const bound=accountOf(session)?session:null;
    this.boundSession=bound;
    this.onSessionChanged=bound?onChanged:null;
    // Unbinding does not lift an end: a page that was told its sign-in changed sends nothing while it starts again.
    if(bound)this.sessionEnded=false;
  }

  // The page's sign-in is no longer the browser's: nothing more is sent, and the page is told once.
  endBoundSession(bound){
    if(!bound||this.boundSession!==bound)return;
    const changed=this.onSessionChanged;
    this.boundSession=null;this.onSessionChanged=null;this.sessionEnded=true;
    try{changed?.()}catch{ /* the page is refused its requests either way */ }
  }

  // Asks the server whether the browser is still signed in as the bound account, and ends the binding when it is
  // not. The server not answering changes nothing: the page stays as it is, and every write still asks first.
  async confirmBoundSession(){
    const bound=this.boundSession;
    if(!this.live||!bound)return;
    let now;
    try{now=await this.currentSignIn()}catch{return}
    if(!sameAccount(bound,now.signIn))this.endBoundSession(bound);
  }

  async rpcToken(bound,write){
    let token=null;
    if(bound&&write){
      // Nothing is written on the SDK's word. If the server cannot be asked, this throws and nothing is sent.
      const now=await this.currentSignIn();
      if(!sameAccount(bound,now.signIn)){this.endBoundSession(bound);throw sessionChangedError()}
      token=now.token;
    }
    if(!token){
      const sessionResult=await this.neon.auth.getSession();
      // The SDK can move on to another account when its saved token expires.
      if(bound&&accountOf(sessionResult?.data)&&!sameAccount(bound,sessionResult.data)){this.endBoundSession(bound);throw sessionChangedError()}
      if(!bound||!write||sameAccount(bound,sessionResult?.data))token=extractAccessToken(sessionResult);
    }
    if(!token)throw new Error('Authentication required.');
    return token;
  }

  async rpc(name,args={},{write=false}={}){
    if(!this.live)throw new Error('Live backend is not configured.');
    if(this.sessionEnded)throw sessionChangedError();
    const bound=this.boundSession;
    const requireSameBinding=()=>{if(this.sessionEnded||this.boundSession!==bound)throw sessionChangedError()};
    let token=await this.rpcToken(bound,write);
    requireSameBinding();
    const url=`${this.config.dataUrl.replace(/\/$/,'')}/rpc/${encodeURIComponent(name)}`;
    let result=await postRpc(url,token,args);
    if(authRequired(result)){
      await new Promise(resolve=>setTimeout(resolve,AUTH_RETRY_DELAY_MS));
      requireSameBinding();
      // The user may have signed out or changed accounts while the first attempt was in flight.
      if(bound&&write)token=await this.rpcToken(bound,write);
      requireSameBinding();
      result=await postRpc(url,token,args);
      if(authRequired(result))throw new Error(SIGN_IN_NOT_CONFIRMED);
    }
    const {response,text,body}=result;
    if(!response.ok){
      const message=body?.message||body?.details||body?.hint||text||`HTTP ${response.status}`;
      const error=new Error(authErrorMessage(message));
      // Retain the server code solely for internal control flow. Never show it in the normal UI.
      error.code=String(message);
      throw error;
    }
    return body;
  }

  async claimEmailInvite(entryId){
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(entryId??'')))
      throw new Error('Invitation link is invalid.');
    return this.rpc('pool_platform_claim_email_invite',{p_entry_id:entryId},{write:true});
  }

  async listParticipantPools(){
    return this.rpc('pool_platform_list_participant_pools');
  }

  async participantContext(poolSlug,season=null,week=null){
    return this.rpc('pool_platform_participant_context',{
      p_pool_slug:poolSlug,p_season:season,p_week:week
    });
  }

  async listCommissionerPools(){
    return this.rpc('pool_platform_list_commissioner_pools');
  }

  async commissionerContext(poolSlug){
    return this.rpc('pool_platform_commissioner_context',{p_pool_slug:poolSlug});
  }

  async weekProjectionSnapshot(weekId){
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(weekId??'')))
      throw new Error('The selected week is invalid.');
    return this.rpc('pool_platform_week_projection_snapshot',{p_week_id:weekId});
  }

  async weekResultSnapshot(weekId){
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(weekId??'')))
      throw new Error('The selected week is invalid.');
    return this.rpc('pool_platform_week_result_snapshot',{p_week_id:weekId});
  }

  async seasonStandingsSnapshot(poolId,season){
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(poolId??''))||!Number.isInteger(season))
      throw new Error('The selected pool season is invalid.');
    return this.rpc('pool_platform_season_standings_snapshot',{p_pool_id:poolId,p_season:season});
  }

  async attestWeekFinalResults({weekId,expectedRevision,results,sourceSha256,sourceReference,correctionReason=null}){
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(weekId??'')) ||
       !Number.isInteger(expectedRevision)||expectedRevision<0 ||
       !/^[a-f0-9]{64}$/.test(String(sourceSha256??'')) ||
       typeof sourceReference!=='string'||sourceReference.trim().length<12||sourceReference.length>500)
      throw new Error('The final-results review is incomplete.');
    return this.rpc('pool_platform_attest_week_final_results_with_source',{
      p_week_id:weekId,p_expected_revision:expectedRevision,
      p_results:results,p_source_sha256:sourceSha256,
      p_source_reference:sourceReference.trim(),p_correction_reason:correctionReason
    },{write:true});
  }

  async submitEntry({weekId,entryId,source,payload}){
    return this.rpc('pool_platform_submit_entry',{
      p_week_id:weekId,p_entry_id:entryId,p_source:source,p_payload:payload
    },{write:true});
  }

  async submitBatch({weekId,source,items}){
    return this.rpc('pool_platform_submit_batch',{
      p_week_id:weekId,p_source:source,p_items:items
    },{write:true});
  }

  async createEntry({seasonId,entryCode,displayName}){
    return this.rpc('pool_platform_create_entry',{
      p_season_id:seasonId,p_entry_code:entryCode,p_display_name:displayName
    },{write:true});
  }

  async createDraftWeek({seasonId,week,deadlineAt,opensAt=null}){
    return this.rpc('pool_platform_create_draft_week',{
      p_season_id:seasonId,p_week:week,p_deadline_at:deadlineAt,p_opens_at:opensAt
    },{write:true});
  }

  async createPool({tenantId,displayName,poolType}){
    return this.rpc('pool_platform_create_pool',{
      p_tenant_id:tenantId,p_display_name:displayName,p_pool_type:poolType
    },{write:true});
  }

  async createSeason({poolId,season}){
    return this.rpc('pool_platform_create_season',{
      p_pool_id:poolId,p_season:season
    },{write:true});
  }

  async previewVerifiedSchedule({weekId}){
    return this.rpc('pool_platform_verified_schedule_preview',{p_week_id:weekId});
  }

  async applyVerifiedSchedule({weekId,digest,tiebreakRequired=false}){
    return this.rpc('pool_platform_apply_verified_schedule',{
      p_week_id:weekId,p_expected_source_sha256:digest,p_tiebreak_required:tiebreakRequired
    },{write:true});
  }

  async openVerifiedWeek({weekId,digest}){
    return this.rpc('pool_platform_open_verified_week',{
      p_week_id:weekId,p_expected_source_sha256:digest,p_confirm:true
    },{write:true});
  }

  async saveDraftSchedule({weekId,config}){
    return this.rpc('pool_platform_save_draft_schedule',{p_week_id:weekId,p_config:config},{write:true});
  }

  async createInvite({entryId,email=null,expiresHours=168}){
    const normalized=normalizeEmail(email);
    if(!validEmail(normalized))throw new Error('Enter a valid invitation email.');
    return this.rpc('pool_platform_create_email_invite',{
      p_entry_id:entryId,p_email:normalized,p_expires_hours:expiresHours
    },{write:true});
  }
}
