import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=relative=>readFileSync(new URL(relative,import.meta.url),"utf8");

test("CRM bridge reuses the existing same-origin live client contract",()=>{
  const client=read("../../platform-client.js");
  const config=read("../../platform-config.js");
  const adapter=read("./platform-host.mjs");
  assert.match(config,/export const PLATFORM_CONFIG/);
  assert.match(client,/export class PlatformClient/);
  for(const name of ["init","getSession","sendOtp","verifyOtp","signOut","rpc","commissionerContext","createInvite"]){
    assert.match(client,new RegExp("\\basync\\s+"+name+"\\s*\\("),name+" missing");
  }
  assert.match(adapter,/\/platform-config\.js/);
  assert.match(adapter,/\/platform-client\.js/);
  assert.match(adapter,/PLATFORM_CONFIG\?\.mode!=="live"/);
  assert.doesNotMatch(adapter,/localStorage|sessionStorage|document\.cookie/);
});

test("commercial build allowlist excludes all CRM auth, app and bundle candidates",()=>{
  const build=read("../../scripts/build.mjs");
  assert.match(build,/export const STATIC_FILES=Object\.freeze/);
  assert.match(build,/STATIC_FILES\.map/);
  assert.match(build,/readAllowedFile/);
  const staticSection=build.split("export const STATIC_FILES=Object.freeze(")[1]?.split(");")[0];
  assert.ok(staticSection,"commercial static allowlist missing");
  for(const banned of ["commissioner-crm","connected.html","connected-main.jsx","dist-connected-candidate"])
    assert.equal(staticSection.includes(banned),false,"commercial output has CRM source: "+banned);
  const sw=read("../../service-worker.js");
  assert.match(sw,/const CACHE_PREFIX='pool-platform-commercial-'/);
  assert.match(sw,/const ASSETS=/);
  const cacheList=sw.split("const ASSETS=")[1]?.split("];")[0];
  assert.ok(cacheList);
  assert.doesNotMatch(cacheList,/connected\.html|commissioner-crm|dist-connected-candidate/);
});

test("build-time CSP remains same-origin and refuses unsafe inline scripts",()=>{
  const config=read("../../scripts/runtime-config.mjs");
  assert.match(config,/script-src 'self'/);
  assert.match(config,/style-src 'self'/);
  assert.match(config,/connect-src 'self'/);
  assert.doesNotMatch(config,/unsafe-inline|unsafe-eval/);
});
