import test from "node:test";
import assert from "node:assert/strict";
import {connectExistingPlatform} from "./platform-host.mjs";

test("uses only the existing same-origin client and requires an authenticated session",async()=>{
  const seen=[];
  const importer=async url=>{
    seen.push(url);
    if(url.endsWith("/platform-config.js"))return {PLATFORM_CONFIG:{mode:"live",dataUrl:"https://data.example.test"}};
    if(url.endsWith("/platform-client.js"))return {PlatformClient:class {
      constructor(config){assert.equal(config.mode,"live");}
      async init(){return this;}
      async getSession(){return {user:{id:"u"},session:{id:"session"}};}
      async rpc(name){return name==="pool_platform_crm_pools"?[]:[];}
      async commissionerContext(){return {pool:{},seasons:[]};}
    }};
    throw new Error("Unexpected imported module");
  };
  const gateway=await connectExistingPlatform({origin:"https://pool.example.test",importer});
  assert.deepEqual(await gateway.listPools(),[]);
  assert.deepEqual(seen,[
    "https://pool.example.test/platform-config.js",
    "https://pool.example.test/platform-client.js"
  ]);
});
test("fails closed on missing sign-in, sandbox config and insecure origins",async()=>{
  await assert.rejects(connectExistingPlatform({origin:"http://example.test"}),/secure app origin/);
  await assert.rejects(connectExistingPlatform({
    origin:"https://pool.example.test",
    importer:async url=>url.endsWith("platform-config.js")?{PLATFORM_CONFIG:{mode:"sandbox"}}:{PlatformClient:class{}}
  }),/Live app configuration/);
  await assert.rejects(connectExistingPlatform({
    origin:"https://pool.example.test",
    importer:async url=>url.endsWith("platform-config.js")?{PLATFORM_CONFIG:{mode:"live",dataUrl:"https://data.example.test"}}:{
      PlatformClient:class {async init(){return this;}async getSession(){return null;}}
    }
  }),/Sign in/);
});
