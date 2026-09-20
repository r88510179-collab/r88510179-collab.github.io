import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const parserSource=readFileSync(new URL('./parser-core.js',import.meta.url),'utf8');
const parserUrl='data:text/javascript;base64,'+Buffer.from(parserSource).toString('base64');
const {carryForwardWeekHints,parseDocumentGroups,validateConfig}=await import(parserUrl);

const matchups=[
  '1) Panthers at 2) Falcons','3) Saints at 4) Ravens','5) Vikings at 6) Bears','7) Bengals at 8) Texans','9) Steelers at 10) Patriots',
  '11) Packers at 12) Jets','13) Browns at 14) Buccaneers','15) Eagles at 16) Titans','17) Jaguars at 18) Broncos','19) Raiders at 20) Chargers',
  '21) Seahawks at 22) Cardinals','23) Commanders at 24) Cowboys','25) Dolphins at 26) 49ers','27) Colts at 28) Chiefs','29) Giants at 30) Rams'
];
const tracked=[
  'D.C. 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 42 0',
  'JC 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 48 0',
  'DJS 1 4 5 8 9 12 13 16 17 20 21 24 25 28 29 45 0',
  'Thaddius 2 3 6 7 10 11 14 15 18 19 22 23 26 27 30 46 0'
];
const anonA='Alpha 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0';
const anonB='Beta 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 55 0';

function participantTail(line){
  const tokens=String(line).trim().split(/\s+/),tail=tokens.slice(-17);
  return tail.length===17&&tail.every(t=>/^\d+$/.test(t));
}
function sourceRows(lines,page=1){
  return lines.map((text,rowIndex)=>{
    const tokens=String(text).trim().split(/\s+/);
    const parts=participantTail(text)
      ?[{x:10,text:tokens.slice(0,-17).join(' ')},...tokens.slice(-17).map((token,i)=>({x:160+i*24,text:token}))]
      :[{x:10,text}];
    return{kind:'pdf',pageNumber:page,y:760-rowIndex*12,rowIndex,text,parts};
  });
}
function parse(lines,extra={}){
  const page=extra.pageNumber||1,rows=extra.sourceRows||sourceRows(lines,page),pageFingerprint=extra.pageFingerprint||lines.join('\n').replace(/\s+/g,' ').trim().toLowerCase();
  return parseDocumentGroups([{week:2,lines,sourceRows:rows,pageNumber:page,pageFingerprint,...extra}],{filename:'fixture.pdf',season:2026})[0];
}
function pdfGroup(lines,page){
  return{week:2,lines,sourceRows:sourceRows(lines,page),pageNumber:page,pageFingerprint:`page-${page}-${lines.join('|')}`};
}

{
  const c=parse([...matchups,...tracked,anonA]);
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,5);
}
{
  const c=parse([...matchups,...tracked,'Alice 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0 2 4']);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.config.fieldEntries,undefined);
  assert.equal(c.errors.length,0);
}
{
  const c=parse([...matchups,...tracked,anonA,'1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17']);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries.length,1);
}
{
  const lines=[...matchups,...tracked,anonA];
  const groups=[
    {week:2,lines,sourceRows:sourceRows(lines,1),pageFingerprint:'same-page'},
    {week:2,lines,sourceRows:sourceRows(lines,2),pageFingerprint:'same-page'}
  ];
  const c=parseDocumentGroups(groups,{filename:'dup.pdf',season:2026})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.length,4);
  assert.equal(c.config.fullFieldReady,false);
}
{
  const c=parse([...matchups,...tracked,
    'One 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0',
    'Two 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0'
  ]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries.length,2);
}
{
  const c=parse([...matchups,...tracked,tracked[0]+' 99',anonA]);
  assert(c.errors.includes('Multiple D.C. rows found'));
}
{
  const c=parse([...matchups,'DC Smith 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 41 0',...tracked,anonA]);
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.find(p=>p.id==='dc').sourceName,'D.C.');
}
{
  const c=parse([...matchups,...tracked,'Rosie 500 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0']);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries.length,1);
  assert.equal(Object.keys(c.config.fieldEntries[0]).sort().join(','),'id,pickNumbers,tiebreak');
}
{
  const c=parse([...matchups,...tracked,"O'Brien-Smith 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0"]);
  assert.equal(c.config.fullFieldReady,true);
}
{
  const c=parse([...matchups,...tracked,'Missing 1 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0']);
  assert.equal(c.config.fullFieldReady,false);
}
{
  const c=parse([...matchups,...tracked,'DuplicateSide 1 2 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0']);
  assert.equal(c.config.fullFieldReady,false);
}
{
  const c=parse([...matchups,...tracked,anonA]);
  const cfg=structuredClone(c.config);
  cfg.fieldEntries[0].metadata={x:1};
  assert(validateConfig(cfg).some(e=>e.includes('only id, pickNumbers, and tiebreak')));
}
{
  const groups=carryForwardWeekHints([{week:2,lines:['Week 2']},{week:null,lines:tracked},{week:null,lines:matchups}]);
  assert.deepEqual(groups.map(g=>g.week),[2,2,2]);
  const c=parseDocumentGroups(groups,{filename:'continuation.pdf',season:2026})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,false);
}
{
  const oldCfg=parse([...matchups,...tracked,anonA]).config;
  delete oldCfg.fullFieldReady;delete oldCfg.fullFieldValidationVersion;delete oldCfg.fullFieldEntryCount;delete oldCfg.fieldEntries;delete oldCfg.competitionSize;
  assert.deepEqual(validateConfig(oldCfg),[]);
}
{
  const c=parse([...matchups,...tracked,anonA]);
  const cfg=structuredClone(c.config);
  cfg.fieldEntries[0].rawSourceLine='private';
  assert(validateConfig(cfg).some(e=>e.includes('only id, pickNumbers, and tiebreak')));
}
{
  const c=parse([...matchups,...tracked,anonA]);
  assert.equal(JSON.stringify(c.config).includes('Alpha'),false);
}
{
  const c=parse([...matchups,...tracked,anonA]);
  const cfg=structuredClone(c.config);
  cfg.fieldEntries[0].pickNumbers[1]=2;
  assert(validateConfig(cfg).some(e=>e.includes('not exactly one pick per game')));
}


{
  const c=parse([...matchups,...tracked,anonA,'SECONDARY RESULTS','Survivor Results 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 51 0']);
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.length,4);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
  assert(c.fullFieldIssues.some(x=>x.includes('outside the proven regular participant table')));
}
{
  const c=parse([...matchups,...tracked,anonA,'SURVIVOR SECTION','Survivor Results 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 51 0']);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.config.fieldEntries,undefined);
  assert.equal(JSON.stringify(c.config).toLowerCase().includes('survivor'),false);
}
{
  const page1=[...matchups,'PICKEM ENTRIES',tracked[0],tracked[1],anonA];
  const page2=['PICKEM ENTRIES CONTINUED',tracked[2],tracked[3],anonB];
  const c=parseDocumentGroups([pdfGroup(page1,1),pdfGroup(page2,2)],{filename:'continuation.pdf',season:2026})[0];
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries.length,2);
  assert.equal(c.config.competitionSize,6);
}
{
  const c=parse([...matchups,...tracked,anonA,'OTHER WEEKLY CONTEST','Contest Leader 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 60 0']);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
}
{
  const header=['Entry',...Array.from({length:15},(_,i)=>`Pick${i+1}`),'Pts','W'];
  const rows=[['Week 2'],...matchups.map(line=>[line]),header,...[...tracked,anonA].map(line=>{
    const tokens=line.split(/\s+/),tail=tokens.slice(-17),name=tokens.slice(0,-17).join(' ');
    return[name,...tail];
  })];
  const sheetRows=rows.map((cells,i)=>({kind:'spreadsheet',sheetName:'Week 2',rowNumber:i+1,cells,text:cells.filter(Boolean).join(' ')}));
  const c=parseDocumentGroups([{week:2,lines:sheetRows.map(r=>r.text),sourceRows:sheetRows,sheetName:'Week 2'}],{filename:'fixture.xlsx',season:2026})[0];
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,5);
  assert.equal(Object.keys(c.config.fieldEntries[0]).sort().join(','),'id,pickNumbers,tiebreak');
}

console.log('parser-core regular-table region, continuation, fail-closed field, duplicate, and privacy regressions passed');
