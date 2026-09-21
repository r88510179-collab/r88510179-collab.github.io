import assert from 'node:assert/strict';
import {parseSurvivorPages,validateSurvivorConfig,normalizeSurvivorTeam} from './survivor-parser.js';

const header={text:'Week 1 2 3 4',y:760,rowIndex:0,parts:[
  {x:116,text:'Week'},{x:159,text:'1'},{x:192,text:'2'},{x:225,text:'3'},{x:258,text:'4'}
]};
const row=(name,w1,w2=null,w3=null,w4=null,i=1)=>({text:[name,w1,w2,w3,w4].filter(Boolean).join(' '),y:760-i*12,rowIndex:i,parts:[
  {x:20,text:name},...(w1?[{x:151,text:w1}]:[]),...(w2?[{x:184,text:w2}]:[]),...(w3?[{x:217,text:w3}]:[]),...(w4?[{x:250,text:w4}]:[])
]});
const pages=[{pageNumber:1,rows:[
  header,
  row('Alpha','JAC','BAL',null,null,1),
  row('D.C.','PIT','SF',null,null,2),
  row('DJS','LV','SF',null,null,3),
  row('Thaddius','LA C',null,null,null,4),
  row('Duplicate Name','DET','TB',null,null,5),
  row('Duplicate Name','PHI','TB',null,null,6)
]}];

assert.equal(normalizeSurvivorTeam('JAC'),'JAX');
assert.equal(normalizeSurvivorTeam('LA C'),'LAC');
assert.equal(normalizeSurvivorTeam('LA R'),'LAR');
assert.equal(normalizeSurvivorTeam('XXX'),null);

const parsed=parseSurvivorPages(pages,{season:2026,filename:'Suicide 26 w2.pdf'});
assert.deepEqual(parsed.errors,[]);
assert.equal(parsed.config.week,2);
assert.equal(parsed.config.competitionSize,6);
assert.equal(parsed.config.currentWeekEntryCount,5);
assert.equal(parsed.config.trackedEntries.length,3);
assert.deepEqual(parsed.config.trackedEntries.find(x=>x.id==='dc').picks,['PIT','SF']);
assert.deepEqual(parsed.config.trackedEntries.find(x=>x.id==='thaddeus').picks,['LAC',null]);
assert.equal(parsed.config.fieldEntries.length,3);
assert.deepEqual(Object.keys(parsed.config.fieldEntries[0]).sort(),['id','picks']);
assert.equal(JSON.stringify(parsed.config).includes('Alpha'),false);
assert.equal(JSON.stringify(parsed.config).includes('Duplicate Name'),false);
assert.deepEqual(validateSurvivorConfig(parsed.config),[]);

const bad=structuredClone(parsed.config);bad.fieldEntries[0].sourceName='private';
assert(validateSurvivorConfig(bad).some(e=>e.includes('only id and picks')));

const badCount=structuredClone(parsed.config);badCount.currentWeekEntryCount=99;
assert(validateSurvivorConfig(badCount).some(e=>e.includes('current-week entry count')));

const unknown=[{pageNumber:1,rows:[header,row('D.C.','PIT','SF',null,null,1),row('DJS','LV','SF',null,null,2),row('Thaddius','LAC',null,null,null,3),row('Mystery','ABC','SF',null,null,4)]}];
assert(parseSurvivorPages(unknown,{season:2026}).errors.some(e=>e.includes('unknown Week 1 team')));

console.log('survivor parser privacy, tracked identity, row geometry, and week detection regressions passed');
