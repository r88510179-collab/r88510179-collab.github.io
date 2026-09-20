import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const parserSource=readFileSync(new URL('./parser-core.js',import.meta.url),'utf8');
const parserUrl='data:text/javascript;base64,'+Buffer.from(parserSource).toString('base64');
const {carryForwardWeekHints,groupPdfTextItems,parseDocumentGroups,validateConfig}=await import(parserUrl);

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
const anonA='Alice 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0';
const anonB='Bob 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 55 0';
function parse(lines){return parseDocumentGroups([{week:2,lines:['Name Picks Pts W',...lines]}],{filename:'fixture.pdf',season:2026})[0]}

{
 const rows=groupPdfTextItems([{str:'Rosie 500',transform:[1,0,0,1,10,100]},{str:'1',transform:[1,0,0,1,100,100]}],{pageNumber:2});
 assert.equal(rows[0].pageNumber,2);assert.equal(rows[0].y,100);assert.equal(rows[0].parts.length,2);assert.equal(rows[0].text,'Rosie 500 1');
}
{
 const groups=carryForwardWeekHints([{week:2,lines:['Week 2']},{week:null,lines:tracked},{week:null,lines:matchups}]);assert.deepEqual(groups.map(g=>g.week),[2,2,2]);
}
{
 const c=parse([...matchups,'99 DC Smith 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 99 0',...tracked]);assert.deepEqual(c.errors,[]);assert.equal(c.config.participants.find(p=>p.id==='dc').sourceName,'D.C.');
}
{
 const c=parse([...matchups,...tracked,'Rosie 500 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0',"O'Brien-Smith 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 51 0"]);
 assert.equal(c.config.fullFieldReady,true);assert.equal(c.config.fieldEntries.length,2);for(const x of c.config.fieldEntries)assert.deepEqual(Object.keys(x).sort(),['id','pickNumbers','tiebreak']);
}
{
 const c=parse([...matchups,...tracked,'Alice 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0 2 4']);assert.equal(c.errors.length,0);assert.equal(c.config.fullFieldReady,false);assert.equal('fieldEntries' in c.config,false);
}
{
 const c=parse([...matchups,...tracked,anonA,'SURVIVOR','Survivor Person 1 2 3 4 5']);assert.equal(c.config.fullFieldReady,true);assert.equal(c.config.fieldEntries.length,1);assert.equal('survivorEntries' in c.config,false);
}
{
 const c=parse([...matchups,...tracked,anonA,'Mystery Bonus Section',anonB]);assert.equal(c.config.fullFieldReady,false);assert.equal('fieldEntries' in c.config,false);
}
{
 const groups=[
  {week:2,sourceType:'pdf',pageNumber:1,pageFingerprint:'core',lines:['Name Picks Pts W',...matchups,...tracked]},
  {week:2,sourceType:'pdf',pageNumber:2,pageFingerprint:'same-anon',lines:[anonA]},
  {week:2,sourceType:'pdf',pageNumber:3,pageFingerprint:'same-anon',lines:[anonA]}
 ];
 const c=parseDocumentGroups(groups,{filename:'dup.pdf',season:2026})[0];assert.equal(c.errors.length,0);assert.equal(c.config.fullFieldReady,false);
}
{
 const same='1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0';const c=parse([...matchups,...tracked,`Alice ${same}`,`Bob ${same}`]);assert.equal(c.config.fullFieldReady,true);assert.equal(c.config.fieldEntries.length,2);
}
{
 const c=parse([...matchups,...tracked,'D.C. 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 42 0 2']);assert(c.errors.includes('Multiple D.C. rows found'));
}
{
 const c=parse([...matchups,...tracked,'Missing 1 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0']);assert.equal(c.config.fullFieldReady,false);
}
{
 const c=parse([...matchups,...tracked,'Broken 1 2 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0']);assert.equal(c.config.fullFieldReady,false);
}
{
 const c=parse([...matchups,...tracked,`${anonA} 9`]);assert.equal(c.config.fullFieldReady,false);
}
{
 const header=['Name',...Array.from({length:15},(_,i)=>`G${i+1}`),'Pts','W'];
 const mk=(name,picks,tb,w)=>[name,...picks.map(String),String(tb),String(w)];
 const groups=[{week:2,sourceType:'spreadsheet',sheetName:'Week 2',rows:[
  ...matchups.map((text,i)=>({kind:'spreadsheet',sheetName:'Week 2',rowNumber:i+1,cells:[text],text})),
  {kind:'spreadsheet',sheetName:'Week 2',rowNumber:20,cells:header,text:header.join(' ')},
  ...tracked.map((line,i)=>{const [name,...rest]=line.split(' ');return{kind:'spreadsheet',sheetName:'Week 2',rowNumber:21+i,cells:[name,...rest],text:line}}),
  {kind:'spreadsheet',sheetName:'Week 2',rowNumber:30,cells:mk('Rosie 500',[1,3,5,7,9,11,13,15,17,19,21,23,25,27,29],44,0),text:'Rosie 500 row'}
 ]}];
 const c=parseDocumentGroups(groups,{filename:'fixture.xlsx',season:2026})[0];assert.equal(c.config.fullFieldReady,true);assert.equal(c.config.fieldEntries.length,1);
}
{
 const c=parse([...matchups,...tracked,anonA]);const cfg=structuredClone(c.config);cfg.fieldEntries[0].metadata={source:'x'};assert(validateConfig(cfg).some(e=>e.includes('keys must be exactly')));
}
{
 const c=parse([...matchups,...tracked,'Nonnumeric 1 - 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0']);assert.equal(c.config.fullFieldReady,false);assert.equal('fieldEntries' in c.config,false);
}
{
 const c=parse([...matchups,...tracked]);const cfg=structuredClone(c.config);delete cfg.fullFieldReady;delete cfg.fullFieldValidationVersion;delete cfg.fullFieldEntryCount;delete cfg.fieldEntries;delete cfg.competitionSize;assert.deepEqual(validateConfig(cfg),[]);
}

{
 const c=parseDocumentGroups([{week:2,lines:[...matchups,...tracked,anonA]}],{filename:'no-header.pdf',season:2026})[0];assert.equal(c.errors.length,0);assert.equal(c.config.fullFieldReady,false);
}
{
 const header=['Name',...Array.from({length:15},(_,i)=>`G${i+1}`),'Pts','W','Mystery'];
 const rows=[...matchups.map((text,i)=>({kind:'spreadsheet',sheetName:'Week 2',rowNumber:i+1,cells:[text],text})),{kind:'spreadsheet',sheetName:'Week 2',rowNumber:20,cells:header,text:header.join(' ')}];
 for(const [i,line] of tracked.entries()){const [name,...rest]=line.split(' ');rows.push({kind:'spreadsheet',sheetName:'Week 2',rowNumber:21+i,cells:[name,...rest,''],text:line})}
 const c=parseDocumentGroups([{week:2,sourceType:'spreadsheet',sheetName:'Week 2',rows}],{filename:'unknown-extra.xlsx',season:2026})[0];assert.equal(c.errors.length,0);assert.equal(c.config.fullFieldReady,false);
}
assert.equal(parserSource.includes('nfl_pool_weeks'),false);assert.equal(parserSource.includes('neon.from'),false);
console.log('parser-core source-boundary, duplicate, fail-closed, privacy regressions passed');
