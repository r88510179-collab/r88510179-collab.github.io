import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context={};vm.createContext(context);vm.runInContext(readFileSync(new URL('./public-math.js',import.meta.url),'utf8'),context);
const {rankCompetition,fieldSnapshot,ownershipForGame,tiebreak}=context.PoolMath;
const entries=[
 {id:'dc',mnf:44,picks:['A','C']},
 {id:'jc',mnf:46,picks:['A','D']},
 {id:'djs',mnf:48,picks:['B','C']},
];
const pre=[
 {away:'A',home:'B',state:'pre',completed:false,winner:null,awayScore:null,homeScore:null},
 {away:'C',home:'D',state:'pre',completed:false,winner:null,awayScore:null,homeScore:null},
];
{
 const r=rankCompetition(entries,pre,1);assert.deepEqual(r.rows.map(x=>x.rank),[1,1,1]);
}
{
 const g=[{...pre[0],state:'post',completed:true,winner:'A',awayScore:21,homeScore:10},pre[1]];
 const r=rankCompetition(entries,g,1);assert.deepEqual(r.rows.map(x=>[x.id,x.rank]),[['dc',1],['jc',1],['djs',3]]);
}
{
 const anon=[{id:'f1',mnf:50,picks:['A','C']},{id:'f2',mnf:51,picks:['B','C']}];
 const g=[{...pre[0],state:'post',completed:true,winner:'A',awayScore:21,homeScore:10},pre[1]];
 const r=rankCompetition([...entries,...anon],g,1);assert.equal(r.byId.get('dc').rank,1);assert.equal(r.byId.get('jc').rank,1);assert.equal(r.byId.get('f1').rank,1);assert.equal(r.byId.get('djs').rank,4);
}
{
 const tie=[{...pre[0],state:'post',completed:true,winner:null,awayScore:17,homeScore:17},pre[1]];
 const r=rankCompetition(entries,tie,1);for(const row of r.rows){assert.equal(row.w,0);assert.equal(row.l,0)}
}
{
 assert.equal(tiebreak(pre,1).final,false);
 const live=[pre[0],{...pre[1],state:'in',completed:false,awayScore:10,homeScore:7}];assert.equal(tiebreak(live,1).final,false);
 const done=[pre[0],{...pre[1],state:'post',completed:true,winner:'C',awayScore:24,homeScore:20}];const tb=tiebreak(done,1);assert.equal(tb.final,true);assert.equal(tb.total,44);
}
{
 const tied=[{id:'x',mnf:42,picks:['A','C']},{id:'y',mnf:46,picks:['A','C']}];
 const done=[{...pre[0],state:'post',completed:true,winner:'A',awayScore:20,homeScore:10},{...pre[1],state:'post',completed:true,winner:'C',awayScore:24,homeScore:20}];
 const r=rankCompetition(tied,done,1);assert.equal(r.byId.get('x').rank,1);assert.equal(r.byId.get('y').rank,1);assert.equal(r.byId.get('x').tieCount,2);
}
{
 const tracked=[{id:'dc',mnf:44,picks:['A','C']}],field=[{id:'f1',mnf:40,picks:['A','C']},{id:'f2',mnf:60,picks:['B','D']}];
 const snap=fieldSnapshot(tracked,field,pre,1),m=snap.metrics.get('dc');assert.equal(m.ceilingRank,1);assert.equal(m.ceilingTieCount,2);assert.equal(m.ceilingTiebreakProjected,false);
}
{
 const o=ownershipForGame([{picks:['A']},{picks:['B']},{picks:['A']},{picks:[null]}],0,'A','B');assert.equal(o.awayCount,2);assert.equal(o.homeCount,1);assert.equal(o.denominator,3);assert.equal(o.invalidCount,1);assert.equal(o.awayPct,67);assert.equal(o.homePct,33);assert.equal(o.awayPct+o.homePct,100);
}
{
 const app=readFileSync(new URL('./weekly-app.js',import.meta.url),'utf8');const race=app.match(/function raceStatus[\s\S]*?function renderRace/)?.[0]||'';assert(race.includes('P.map'));assert.equal(race.includes('allCompetitionEntries'),false);assert.equal(race.includes('F.map'),false);
}
console.log('public-math full-field ranking, tie, tiebreak, ceiling, ownership regressions passed');
