// The service worker stores an explicit list of files. A module a page imports statically but the list leaves out is
// never cached: when the network then fails, the cached page script cannot load its imports, so the page does nothing
// and says nothing. These checks read the pages' real imports, so a module added to a page and forgotten in the worker
// fails here. No network, no browser, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {STATIC_FILES} from '../scripts/build.mjs';

const dir=path.resolve(import.meta.dirname,'..');
const read=name=>fs.readFileSync(path.join(dir,name),'utf8');
// Left to the network on purpose: the runtime configuration and the bundled SDK (see service-worker.js).
const NETWORK_ONLY=['platform-config.js','vendor/neon-js.js'];

const STATIC_IMPORT=/(?:^|[;\n])\s*import\s+(?:[^'"()]*?\sfrom\s+)?['"](\.\/[^'"]+)['"]/g;
const DYNAMIC_IMPORT=/\bimport\s*\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
const names=(source,pattern)=>[...source.matchAll(pattern)].map(match=>match[1].slice(2));

function entryModules(){
  const modules=[];
  for(const page of STATIC_FILES.filter(name=>name.endsWith('.html'))){
    const scripts=[...read(page).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match=>match[1].replace(/^\.?\//,''));
    assert.ok(scripts.length>0,`${page} loads a module`);
    modules.push(...scripts);
  }
  return [...new Set(modules)];
}

// Every module reachable from the pages through static imports, and every module they import dynamically.
function moduleGraph(){
  const reached=new Set(),dynamic=new Set(),queue=entryModules();
  while(queue.length){
    const name=queue.pop();
    if(reached.has(name))continue;
    reached.add(name);
    const source=read(name);
    for(const next of names(source,STATIC_IMPORT))queue.push(next);
    for(const next of names(source,DYNAMIC_IMPORT))dynamic.add(next);
  }
  return {reached:[...reached].sort(),dynamic:[...dynamic].sort()};
}

function workerAssets(){
  const list=/const ASSETS=\[([^\]]*)\];/.exec(read('service-worker.js'));
  assert.ok(list,'service-worker.js declares its asset list');
  return [...list[1].matchAll(/'([^']*)'/g)].map(match=>match[1]);
}

test('the import walk finds the modules the pages are known to load',()=>{
  const {reached,dynamic}=moduleGraph();
  for(const expected of ['participant.js','commissioner.js','sw-register.js','platform-client.js','auth-core.js',
    'pool-standings-board.js','season-standings-board.js','game-day-board.js','final-results-form.js'])
    assert.ok(reached.includes(expected),`${expected} is reached from a page`);
  assert.deepEqual(dynamic,NETWORK_ONLY,'the only dynamic imports are the configuration and the bundled SDK');
});

test('every module a page imports statically is in the service worker asset list',()=>{
  const assets=workerAssets().map(asset=>asset.replace(/^\.\//,''));
  const missing=moduleGraph().reached.filter(name=>!assets.includes(name));
  assert.deepEqual(missing,[],'a module the pages import is not cached: offline, the cached page script cannot load');
});

test('the asset list holds only files the build ships, each once, and never the configuration or the SDK',()=>{
  const assets=workerAssets();
  assert.equal(new Set(assets).size,assets.length,'no asset is listed twice');
  for(const asset of assets){
    assert.match(asset,/^\.\/[a-z0-9.-]*$/,`${asset} is a bare same-directory path`);
    if(asset!=='./')assert.ok(STATIC_FILES.includes(asset.slice(2)),`${asset} is on the build allow-list`);
  }
  for(const name of [...NETWORK_ONLY,'service-worker.js'])
    assert.ok(!assets.includes(`./${name}`),`${name} is left to the network`);
  // Every page and its stylesheet, so a cached page is never shown without them.
  for(const name of STATIC_FILES.filter(file=>/\.(?:html|css|webmanifest)$/.test(file)))
    assert.ok(assets.includes(`./${name}`),`${name} is cached`);
});
