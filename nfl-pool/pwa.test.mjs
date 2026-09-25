import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./pwa.js',import.meta.url),'utf8');
const manifest=JSON.parse(readFileSync(new URL('./manifest.webmanifest',import.meta.url),'utf8'));
assert.equal(manifest.start_url,'/nfl-pool/?view=home');
assert.equal(manifest.scope,'/nfl-pool/');
assert.equal(manifest.display,'standalone');
assert(manifest.icons.some(x=>x.sizes==='192x192'));
assert(manifest.icons.some(x=>x.sizes==='512x512'));

const button={hidden:true,disabled:false};
const winListeners={},docListeners={},classes=new Map(),registrations=[];
let standalone=false,prompted=0,prevented=0;
const navigator={standalone:false,serviceWorker:{register:async(path,options)=>{registrations.push({path,options});return{}}}};
const window={
  navigator,
  matchMedia:()=>({matches:standalone}),
  addEventListener(t,f){(winListeners[t]||=[]).push(f)}
};
const document={
  querySelectorAll:()=>[button],
  documentElement:{classList:{toggle(name,value){classes.set(name,value)}}},
  addEventListener(t,f){(docListeners[t]||=[]).push(f)}
};
vm.runInNewContext(source,{window,document,navigator,console});
assert.equal(button.hidden,true);

const installEvent={preventDefault(){prevented++},prompt:async()=>{prompted++},userChoice:Promise.resolve({outcome:'accepted'})};
winListeners.beforeinstallprompt[0](installEvent);
assert.equal(prevented,1);
assert.equal(button.hidden,false);
await docListeners.click[0]({target:{closest:()=>button}});
assert.equal(prompted,1);
assert.equal(button.hidden,true,'consumed install prompt should hide the button');

const secondEvent={preventDefault(){prevented++},prompt:async()=>{prompted++},userChoice:Promise.resolve({outcome:'dismissed'})};
winListeners.beforeinstallprompt[0](secondEvent);
winListeners.appinstalled[0]();
assert.equal(button.hidden,true,'installed app should not keep an install button');

standalone=true;
winListeners.beforeinstallprompt[0](secondEvent);
assert.equal(button.hidden,true,'standalone mode must suppress install UI');
assert.equal(classes.get('standalone'),true);

await winListeners.load[0]();
assert.equal(registrations.length,1);
assert.equal(registrations[0].path,'/nfl-pool/service-worker.js');
assert.equal(registrations[0].options.scope,'/nfl-pool/');

console.log('PWA install-prompt, standalone detection, registration and manifest-contract regressions passed');
