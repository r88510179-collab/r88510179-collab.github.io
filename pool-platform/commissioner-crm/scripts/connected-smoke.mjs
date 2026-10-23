// CI browser rehearsal of the isolated connected build using TWO fictional accounts.
// All HTTPS requests are intercepted inside Chromium. No real Auth, Neon or API traffic.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
const deps=process.env.CRM_VISUAL_DEPS;
if(!deps)throw new Error("CRM_VISUAL_DEPS required");
const {chromium}=await import(pathToFileURL(path.join(deps,"node_modules","playwright","index.mjs")).href);
const origin="https://crm.example.test";
const root=path.resolve("dist-connected-candidate");
const policy=["default-src 'self'","script-src 'self'","style-src 'self'",
  "img-src 'self'","font-src 'none'","connect-src 'self'","object-src 'none'"].join("; ");
const fakeConfig="export const PLATFORM_CONFIG={mode:'live',dataUrl:'https://data.example.invalid'};";
const fakeClient=[
  "let loggedIn=null;",
  "export class PlatformClient {",
  "constructor(config){if(config.mode!=='live')throw new Error('config')} ",
  "async init(){return this}",
  "async getSession(){return loggedIn?{user:{id:loggedIn},session:{id:'fixture'}}:null}",
  "async sendOtp(email){if(!email.includes('@'))throw new Error('Invalid email');return email}",
  "async verifyOtp(email,code){if(code!=='123456')throw new Error('Wrong code');loggedIn=email.includes('second')?'second':'first';return this.getSession()}",
  "async signOut(){loggedIn=null}",
  "async rpc(name){if(!loggedIn)throw new Error('auth_required');",
  "  if(name==='pool_platform_crm_pools')return [{id:loggedIn==='first'?'11111111-1111-1111-1111-111111111111':'22222222-2222-2222-2222-222222222222',",
  "  tenant_id:loggedIn==='first'?'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa':'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',",
  "  slug:loggedIn+'-pool',display_name:loggedIn==='first'?'First Pool':'Second Pool',pool_type:'pickem',status:'active',",
  "  dues_tracking_enabled:false,permissions:{view_pool:true,manage_players:false,manage_staff:false,record_dues:false}}];",
  "  if(name==='pool_platform_crm_dues_summary')return [];throw new Error('Unexpected RPC: '+name);}",
  "async commissionerContext(slug){if(!loggedIn||slug!==loggedIn+'-pool')throw new Error('commissioner_required');",
  " return {pool:{id:loggedIn==='first'?'11111111-1111-1111-1111-111111111111':'22222222-2222-2222-2222-222222222222',slug},",
  " seasons:[{season:2026,status:'active',weeks:[{week:7,status:'open'}],entries:[{id:'33333333-3333-3333-3333-333333333333',",
  " entry_code:'E01',display_name:loggedIn==='first'?'First Entry':'Second Entry',status:'active',submissions:[]}]}]};}",
  "async createInvite(){throw new Error('not granted')}",
  "}"
].join("\n");
const browser=await chromium.launch({executablePath:"/usr/bin/google-chrome",headless:true,args:["--no-sandbox"]});
let requests=0;
try{
  const page=await browser.newPage({viewport:{width:360,height:780}});
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin)throw new Error("Unexpected external network: "+url.origin);
    requests++;
    const headers={"Content-Security-Policy":policy,"Cache-Control":"no-store"};
    if(url.pathname==="/platform-config.js"||url.pathname==="/platform-client.js"){
      await route.fulfill({status:200,headers:{"Content-Type":"text/javascript",...headers},
        body:url.pathname==="/platform-config.js"?fakeConfig:fakeClient});return;
    }
    if(url.pathname==="/favicon.ico"){await route.fulfill({status:204,body:""});return;}
    if(!/^\/(?:connected\.html|assets\/[a-zA-Z0-9._-]+)$/.test(url.pathname)){
      await route.fulfill({status:404,body:"Unexpected asset path"});return;
    }
    const body=await fs.readFile(path.join(root,url.pathname));
    await route.fulfill({status:200,headers:{
      "Content-Type":url.pathname.endsWith(".html")?"text/html":
        url.pathname.endsWith(".css")?"text/css":"text/javascript",...headers},body});
  });
  await page.goto(origin+"/connected.html",{waitUntil:"networkidle"});
  await page.getByRole("heading",{name:"Sign in to manage your pools"}).waitFor();
  assert.equal(await page.getByText("Office Football Pool",{exact:true}).count(),0);
  async function login(email,poolName){
    await page.getByRole("textbox",{name:"Email address"}).fill(email);
    await page.getByRole("button",{name:"Send sign-in code"}).click();
    await page.getByRole("textbox",{name:"Sign-in code"}).fill("123456");
    await page.getByRole("button",{name:"Verify and continue"}).click();
    await page.getByRole("option",{name:poolName}).waitFor({timeout:10000});
  }
  await login("first@example.test","First Pool");
  await page.getByRole("button",{name:"Sign out"}).click();
  await page.getByRole("heading",{name:"Sign in to manage your pools"}).waitFor();
  assert.equal(await page.getByText("First Entry",{exact:true}).count(),0);
  await login("second@example.test","Second Pool");
  assert.equal(await page.getByRole("option",{name:"First Pool"}).count(),0);
  assert.deepEqual(errors,[]);
  assert.ok(requests>=5);
  console.log("CONNECTED browser PASS: no demo fallback; first account -> sign-out -> second account, strict CSP, all requests intercepted.");
}finally{await browser.close();}
