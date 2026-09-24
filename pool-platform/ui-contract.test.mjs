import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read=name=>fs.readFileSync(new URL('./'+name,import.meta.url),'utf8');
const participant=read('participant.html')+read('participant.js');
const commissioner=read('commissioner.html')+read('commissioner.js');
const css=read('styles.css');
const sw=read('service-worker.js');
const tree=participant+commissioner+read('index.html')+read('platform-config.js');

test('commercial tree stays generic and synthetic',()=>{
  for(const privateName of ['Thaddeus','DJS','D.C.','JC'])assert.equal(tree.includes(privateName),false);
  assert.equal(/NFL shield|National Football League/i.test(tree),false);
});

test('participant UI supports Pickem and Survivor with no-referrer invite pages',()=>{
  assert.match(participant,/pool_type==='survivor'/);
  assert.match(participant,/validatePickPayload/);
  assert.match(participant,/validateSurvivorSelection/);
  assert.match(participant,/name="referrer" content="no-referrer"/);
});

test('commissioner UI exposes invite and conflict-report workflows',()=>{
  assert.match(commissioner,/createInvite/);
  assert.match(commissioner,/submitBatch/);
  assert.match(commissioner,/source conflict/i);
});

test('responsive baseline keeps mobile controls touch-friendly',()=>{
  assert.match(css,/min-width:320px/);
  assert.match(css,/font-size:16px/);
  assert.match(css,/min-height:48px/);
  assert.match(css,/@media\(max-width:560px\)/);
});

test('service worker precaches all Step 2 modules',()=>{
  for(const asset of ['participant.js','commissioner.js','platform-client.js','participant-core.js','import-core.js','auth-core.js']){
    assert.match(sw,new RegExp(asset.replace('.','\\.')));
  }
});
