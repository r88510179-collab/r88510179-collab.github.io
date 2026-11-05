import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));
function run(fixture,args=[]){
  const result=spawnSync(process.execPath,['--import',join(dir,'score-reconcile.mock.mjs'),join(dir,'score-reconcile.mjs'),'--season','2026','--weeks','1',...args],{
    encoding:'utf8',timeout:8000,env:{...process.env,SCORE_FIXTURE:fixture}
  });
  if(result.error)throw result.error;
  return {code:result.status,out:result.stdout+result.stderr};
}
test('synthetic final tie has both winner flags false and checks cleanly',()=>{
  const r=run('parity');
  assert.equal(r.code,0,r.out);
  assert.match(r.out,/RESULT PASS: 1 finalized-game projections match ESPN/);
  assert.match(r.out,/0 failures/);
});
test('corrupting a finalized score fails with explicit expected/actual public data',()=>{
  const r=run('mismatch');
  assert.equal(r.code,1,r.out);
  assert.match(r.out,/final mismatch/);
  assert.match(r.out,/"expected":/);
  assert.match(r.out,/"actual":/);
  assert.match(r.out,/"score":"99"/);
});
test('two empty feeds cannot yield a false PASS',()=>{
  const r=run('empty');
  assert.equal(r.code,1,r.out);
  assert.match(r.out,/empty scoreboard/);
});
test('frozen proxy timestamp is diagnosed',()=>{
  const r=run('stale');
  assert.equal(r.code,1,r.out);
  assert.match(r.out,/stale\/future fetchedAt/);
});
test('independent CSV accepts exact synthetic tie and catches an altered final score',()=>{
  const dirName=mkdtempSync(join(tmpdir(),'score-reconcile-spec-'));
  try{
    const file=join(dirName,'official.csv');
    writeFileSync(file,'week,away,home,awayScore,homeScore\n1,BUF,BAL,17,17\n');
    let r=run('parity',['--official',file]);
    assert.equal(r.code,0,r.out);
    writeFileSync(file,'week,away,home,awayScore,homeScore\n1,BUF,BAL,17,18\n');
    r=run('parity',['--official',file]);
    assert.equal(r.code,1,r.out);
    assert.match(r.out,/official NFL.com manual-reference mismatch/);
  }finally{rmSync(dirName,{recursive:true,force:true});}
});
test('out-of-range week arguments are rejected before requests',()=>{
  const r=run('parity',['--weeks','0']);
  assert.notEqual(r.code,0);
  assert.match(r.out,/invalid week range/);
});
