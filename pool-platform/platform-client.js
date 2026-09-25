import {extractAccessToken,normalizeEmail,validEmail,validOtp,normalizeInviteToken,authErrorMessage} from './auth-core.js';

// The first request a newly opened Data API backend connection serves can run with auth.user_id() = NULL although its
// JWT is valid (observed on the commercial Neon endpoint; the cause inside Neon is not established). The RPC then fails
// closed with exactly 'auth_required', and rpc() sends the same request once more, after AUTH_RETRY_DELAY_MS.
// That is safe only because every browser-callable RPC raises 'auth_required' as its first statement, before it reads,
// locks or writes anything, so the first request did nothing. A new RPC must keep that order or this retry would replay
// its work; platform-client.test.mjs checks the migrations for it.
const AUTH_REQUIRED='auth_required';
const AUTH_RETRY_DELAY_MS=200;
export const SIGN_IN_NOT_CONFIRMED='Your sign-in could not be confirmed. Try again, or sign out and sign in again.';

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
  }

  get live(){
    return this.config?.mode==='live'&&!!this.config?.authUrl&&!!this.config?.dataUrl;
  }

  async init(){
    if(!this.live)return this;
    const {createClient}=await import('https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm');
    this.neon=createClient({auth:{url:this.config.authUrl},dataApi:{url:this.config.dataUrl}});
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
    return session;
  }

  async signOut(){
    if(this.neon)await this.neon.auth.signOut();
  }

  async rpc(name,args={}){
    if(!this.live)throw new Error('Live backend is not configured.');
    const sessionResult=await this.neon.auth.getSession();
    const token=extractAccessToken(sessionResult);
    if(!token)throw new Error('Authentication required.');
    const url=`${this.config.dataUrl.replace(/\/$/,'')}/rpc/${encodeURIComponent(name)}`;
    let result=await postRpc(url,token,args);
    if(authRequired(result)){
      await new Promise(resolve=>setTimeout(resolve,AUTH_RETRY_DELAY_MS));
      result=await postRpc(url,token,args);
      if(authRequired(result))throw new Error(SIGN_IN_NOT_CONFIRMED);
    }
    const {response,text,body}=result;
    if(!response.ok){
      const message=body?.message||body?.details||body?.hint||text||`HTTP ${response.status}`;
      throw new Error(authErrorMessage(message));
    }
    return body;
  }

  async claimInvite(token){
    const normalized=normalizeInviteToken(token);
    if(!normalized)throw new Error('Invitation link is invalid.');
    return this.rpc('pool_platform_claim_entry_invite',{p_invite_token:normalized});
  }

  async participantContext(poolSlug,season=null,week=null){
    return this.rpc('pool_platform_participant_context',{
      p_pool_slug:poolSlug,p_season:season,p_week:week
    });
  }

  async commissionerContext(poolSlug){
    return this.rpc('pool_platform_commissioner_context',{p_pool_slug:poolSlug});
  }

  async submitEntry({weekId,entryId,source,payload}){
    return this.rpc('pool_platform_submit_entry',{
      p_week_id:weekId,p_entry_id:entryId,p_source:source,p_payload:payload
    });
  }

  async submitBatch({weekId,source,items}){
    return this.rpc('pool_platform_submit_batch',{
      p_week_id:weekId,p_source:source,p_items:items
    });
  }

  async createInvite({entryId,email=null,expiresHours=168}){
    const normalized=email?normalizeEmail(email):null;
    if(normalized&&!validEmail(normalized))throw new Error('Enter a valid invitation email or leave it blank.');
    return this.rpc('pool_platform_create_entry_invite',{
      p_entry_id:entryId,p_email:normalized,p_expires_hours:expiresHours
    });
  }
}
