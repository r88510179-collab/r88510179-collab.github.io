// QA ONLY — branch qa/personal-pdf-import-e2e-20261105 (draft PR #29). Never merge into main or promote to production.
//
// Staging-only publisher configuration, bound exclusively to the authorized isolated QA child database:
//   Neon project green-base-66242978 · child branch br-damp-credit-bbn7d0zr · database nfl_pool · endpoint ep-shiny-snow-bbx446zt
// Everything fails closed. A page origin, Neon target, request host or signed-in identity outside the allowlists below is
// refused with a visible diagnostic: before the Neon client exists (origin/target), as a rejected request (network guard), or
// by signing the session out (identity). Row-level security on the child still authorizes every write; nothing here relaxes
// it. No credential, token or password is stored in this file.

export const QA_AUTHORIZED_ENDPOINT='ep-shiny-snow-bbx446zt';
const AUTH_HOST=`${QA_AUTHORIZED_ENDPOINT}.neonauth.c-15.us-east-1.aws.neon.tech`;
const DATA_HOST=`${QA_AUTHORIZED_ENDPOINT}.apirest.c-15.us-east-1.aws.neon.tech`;

export const QA_TARGET=Object.freeze({
  projectId:'green-base-66242978',
  branchId:'br-damp-credit-bbn7d0zr',
  branchName:'qa-pr23-personal-pdf-e2e-20261105',
  parentBranchId:'br-dawn-fire-bb923034',
  database:'nfl_pool',
  endpointId:QA_AUTHORIZED_ENDPOINT,
  authUrl:`https://${AUTH_HOST}/nfl_pool/auth`,
  dataUrl:`https://${DATA_HOST}/nfl_pool/rest/v1`,
  // Synthetic identity on the child's own Neon Auth (reserved example.com domain; no mailbox, so no email codes).
  publisherEmail:'qa.pdf-e2e.publisher@example.com'
});

// Never contacted by this publisher, whatever any other file says.
export const FORBIDDEN_NEON_ENDPOINTS=Object.freeze({
  'ep-muddy-forest-au7eygkw':'live Personal production database',
  'ep-silent-sunset-bbdqbm47':'isolated QA parent branch br-dawn-fire-bb923034, which must stay unchanged'
});
export const FORBIDDEN_HOSTS=Object.freeze({
  'br-late-hat-b55ygmj4-nflscores2.compute.c-7.us-east-2.aws.neon.tech':'production NFL score proxy',
  'picks.smokkeventures.com':'production Pool Center domain',
  'r88510179-collab.github.io':'production GitHub Pages site'
});
// The production publisher identity is refused here even though the QA child's Neon Auth also lists it.
export const FORBIDDEN_PUBLISHERS=Object.freeze(['djsmokke@gmail.com']);

// The SSO-protected Vercel branch alias of draft PR #29. Every other Vercel host is refused.
export const QA_PREVIEW_ORIGIN='https://nfl-pool-personal-git-qa-pers-0b745e-r88510179-collabs-projects.vercel.app';
const LOCAL_HOSTS=new Set(['localhost','127.0.0.1']);
// The publisher reads and writes only these two tables.
const DATA_PATH=/^\/nfl_pool\/rest\/v1\/(?:nfl_pool_weeks|nfl_survivor_weeks)$/;
const ESPN_ORIGIN='https://site.api.espn.com',ESPN_PATH='/apis/site/v2/sports/football/nfl/scoreboard';

export class QaPublisherRefusal extends Error{constructor(message){super(message);this.name='QaPublisherRefusal'}}

const parse=(value,base)=>{try{return base===undefined?new URL(String(value)):new URL(String(value),base)}catch{return null}};
const forbiddenEndpoint=text=>Object.entries(FORBIDDEN_NEON_ENDPOINTS).find(([id])=>String(text).toLowerCase().includes(id))||null;

// Where this publisher may run: the local QA harness (the child's Neon Auth trusts localhost) or the protected PR preview.
export function qaPageOriginRefusal(href){
  const url=parse(href);
  if(!url)return 'the page URL is unreadable';
  const host=url.hostname.toLowerCase();
  if(Object.hasOwn(FORBIDDEN_HOSTS,host))return `this page is served from the ${FORBIDDEN_HOSTS[host]} (${host})`;
  if(url.protocol==='http:'&&LOCAL_HOSTS.has(host))return null;
  if(url.origin===QA_PREVIEW_ORIGIN)return null;
  return `page origin ${url.origin} is not an authorized QA publisher environment`;
}

// The Neon target must be exactly the authorized child: exact HTTPS hosts and base paths, never production or the parent.
export function qaTargetRefusal(target=QA_TARGET){
  const problems=[];
  const exact=(label,value,host,path)=>{
    const url=parse(value);
    if(!url){problems.push(`${label} URL is unreadable`);return}
    const found=forbiddenEndpoint(url.href);
    if(found)problems.push(`${label} targets ${found[0]}, the ${found[1]}`);
    if(url.protocol!=='https:')problems.push(`${label} is not HTTPS`);
    if(url.hostname!==host)problems.push(`${label} host ${url.hostname} is not the authorized QA child host ${host}`);
    if(url.pathname!==path||url.search||url.hash||url.username||url.password||url.port)problems.push(`${label} must be exactly https://${host}${path}`);
  };
  exact('Neon Auth',target?.authUrl,AUTH_HOST,'/nfl_pool/auth');
  exact('Neon Data API',target?.dataUrl,DATA_HOST,'/nfl_pool/rest/v1');
  for(const [key,value] of [['projectId','green-base-66242978'],['branchId','br-damp-credit-bbn7d0zr'],['database','nfl_pool'],['endpointId',QA_AUTHORIZED_ENDPOINT]])
    if(target?.[key]!==value)problems.push(`${key} must be ${value}`);
  const email=String(target?.publisherEmail??'').trim().toLowerCase();
  if(FORBIDDEN_PUBLISHERS.includes(email))problems.push('the publisher identity is the production publisher');
  else if(email!==QA_TARGET.publisherEmail)problems.push('the publisher identity is not the synthetic QA publisher');
  return problems.length?problems.join('; '):null;
}

// Only the synthetic QA publisher may hold a publishing session here.
export function qaIdentityRefusal(user){
  const email=String(user?.email??'').trim().toLowerCase();
  if(!email)return 'the session has no email identity';
  if(FORBIDDEN_PUBLISHERS.includes(email))return 'the production publisher identity is refused on the QA publisher';
  if(email!==QA_TARGET.publisherEmail)return `${email} is not the authorized synthetic QA publisher`;
  return null;
}

// Every request the publisher page makes must be one of: the child's Neon Auth, the child's Data API for the two
// publication tables, a GET of the public ESPN scoreboard, or a GET of this page's own protected /api/qa-schedule.
export function qaRequestRefusal(input,{method='GET',pageHref}={}){
  const page=parse(pageHref),url=parse(input,page?.href);
  if(!page||!url)return 'the request URL is unreadable';
  const verb=String(method||'GET').toUpperCase(),host=url.hostname.toLowerCase(),found=forbiddenEndpoint(host);
  if(found)return `${host} is the ${found[1]}`;
  if(Object.hasOwn(FORBIDDEN_HOSTS,host))return `${host} is the ${FORBIDDEN_HOSTS[host]}`;
  if(url.origin===page.origin)return verb==='GET'&&url.pathname==='/api/qa-schedule'?null:`same-origin ${verb} ${url.pathname} is not allowed`;
  if(url.protocol!=='https:')return `${url.origin} is not HTTPS`;
  if(host===AUTH_HOST)return url.pathname.startsWith('/nfl_pool/auth/')?null:`${url.pathname} is outside the QA child's Neon Auth`;
  if(host===DATA_HOST)return DATA_PATH.test(url.pathname)?null:`${url.pathname} is not a QA publication table`;
  if(url.origin===ESPN_ORIGIN&&url.pathname===ESPN_PATH)return verb==='GET'?null:'the ESPN scoreboard is read-only';
  return `${url.origin} is outside the QA publisher allowlist`;
}

const redact=href=>{const url=parse(href);return url?`${url.origin}${url.pathname}`:'(unreadable)'};
function installQaNetworkGuard(win,refusals){
  const refuse=(method,href,refusal)=>{refusals.push({at:new Date().toISOString(),method:String(method||'GET').toUpperCase(),url:redact(href),refusal});return new TypeError(`QA publisher network guard refused ${redact(href)}: ${refusal}`)};
  const nativeFetch=win.fetch.bind(win);
  win.fetch=function(input,init){
    const request=typeof win.Request==='function'&&input instanceof win.Request?input:null;
    const href=request?request.url:input instanceof URL?input.href:String(input);
    const method=init?.method||request?.method||'GET';
    const refusal=qaRequestRefusal(href,{method,pageHref:win.location.href});
    return refusal?Promise.reject(refuse(method,href,refusal)):nativeFetch(input,init);
  };
  const XHR=win.XMLHttpRequest?.prototype;
  if(XHR?.open){const open=XHR.open;XHR.open=function(method,url,...rest){const refusal=qaRequestRefusal(url,{method,pageHref:win.location.href});if(refusal)throw refuse(method,url,refusal);return open.call(this,method,url,...rest)}}
  if(typeof win.navigator?.sendBeacon==='function')win.navigator.sendBeacon=url=>{refuse('POST',url,'beacons are not allowed');return false};
}

const STATE=Symbol.for('nfl-pool.qa-publisher.state');
const el=(doc,id)=>doc?.getElementById?.(id)||null;
function showBanner(doc,state){
  const banner=el(doc,'qaBanner');if(!banner)return;
  banner.className=`qa-banner ${state.verified?'ok':'refused'}`;
  banner.textContent=state.verified
    ?`QA STAGING PUBLISHER — writes only to Neon project ${QA_TARGET.projectId} · child branch ${QA_TARGET.branchId} (${QA_TARGET.branchName}) · database ${QA_TARGET.database} · endpoint ${QA_TARGET.endpointId}. Production, the QA parent ${QA_TARGET.parentBranchId} and every other host are refused. Authorized identity: synthetic ${QA_TARGET.publisherEmail}. QA only — never merge.`
    :`QA PUBLISHER DISABLED — ${state.refusal}. Nothing can be signed in to, read or published from this page.`;
}
function lockPage(doc){for(const id of ['sendCode','verifyCode','qaSignIn','qaEmail','qaPassword','parseBtn','publishBtn','file','season','totalEntries','absenceConfirm','replaceLocked','confirmPartial'])if(el(doc,id))el(doc,id).disabled=true}
function qaAuthUi(doc){
  // The synthetic identity has no mailbox: email codes are hidden and refused; it signs in with email and password.
  for(const id of ['sendCode','otpWrap'])if(el(doc,id))el(doc,id).hidden=true;
  if(el(doc,'qaPublisherEmail'))el(doc,'qaPublisherEmail').textContent=QA_TARGET.publisherEmail;
  if(el(doc,'qaEmail')&&!el(doc,'qaEmail').value)el(doc,'qaEmail').value=QA_TARGET.publisherEmail;
}

// Runs first on the page (qa-publisher-boot.js), before the Neon client library is evaluated.
export function qaPublisherBoot(win){
  if(win[STATE])return win[STATE];
  const state={verified:false,refusal:null,refusals:[],identityRefusals:[]};
  win[STATE]=state;
  try{
    const refusal=qaPageOriginRefusal(win.location?.href)||qaTargetRefusal(QA_TARGET);
    if(refusal)throw new QaPublisherRefusal(refusal);
    installQaNetworkGuard(win,state.refusals);
    state.verified=true;qaAuthUi(win.document);
  }catch(error){state.verified=false;state.refusal=error?.message||String(error);lockPage(win.document)}
  showBanner(win.document,state);
  // Read-only diagnostics for the QA harness and reviewers. Contains no credential.
  win.__qaPublisher=Object.freeze({target:QA_TARGET,get verified(){return state.verified},get refusal(){return state.refusal},get networkRefusals(){return state.refusals.slice()},get identityRefusals(){return state.identityRefusals.slice()}});
  return state;
}

// Called by admin.js / survivor-admin.js before createClient. Refuses unless the boot checks ran first and passed.
export function qaPublisherRuntime(win){
  const state=win[STATE];
  if(!state||!state.verified){
    const reason=state?.refusal||'the QA safety checks did not run before the publisher (qa-publisher-boot.js must load first)';
    if(!state){const fallback={verified:false,refusal:reason,refusals:[],identityRefusals:[]};win[STATE]=fallback;lockPage(win.document);showBanner(win.document,fallback)}
    throw new QaPublisherRefusal(`QA publisher disabled: ${reason}`);
  }
  return Object.freeze({
    authUrl:QA_TARGET.authUrl,dataUrl:QA_TARGET.dataUrl,publisherEmail:QA_TARGET.publisherEmail,otpDisabled:true,
    identityRefusal:qaIdentityRefusal,
    reportRefusedIdentity(user){
      const refusal=qaIdentityRefusal(user)||'the session does not match the synthetic QA publisher';
      state.identityRefusals.push({at:new Date().toISOString(),refusal});
      const note=el(win.document,'qaIdentityNote');
      if(note){note.hidden=false;note.className='qa-banner refused';note.textContent=`Signed-in account refused and signed out — ${refusal}. Only the synthetic QA publisher ${QA_TARGET.publisherEmail} may publish here.`}
      return refusal;
    }
  });
}
