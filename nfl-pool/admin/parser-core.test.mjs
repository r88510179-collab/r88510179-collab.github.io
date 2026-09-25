import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const parserSource=readFileSync(new URL('./parser-core.js',import.meta.url),'utf8');
const parserUrl='data:text/javascript;base64,'+Buffer.from(parserSource).toString('base64');
const {carryForwardWeekHints,chooseBestCandidate,parseDocumentGroups,validateConfig}=await import(parserUrl);

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
// `expectedCompetitionSize` is the admin's authoritative total pool entry count: a parse option, never document content.
function parse(lines,{expectedCompetitionSize,...extra}={}){
  const page=extra.pageNumber||1,rows=extra.sourceRows||sourceRows(lines,page),pageFingerprint=extra.pageFingerprint||lines.join('\n').replace(/\s+/g,' ').trim().toLowerCase();
  return parseDocumentGroups([{week:2,lines,sourceRows:rows,pageNumber:page,pageFingerprint,...extra}],{filename:'fixture.pdf',season:2026,expectedCompetitionSize})[0];
}
function pdfGroup(lines,page){
  return{week:2,lines,sourceRows:sourceRows(lines,page),pageNumber:page,pageFingerprint:`page-${page}-${lines.join('|')}`};
}
function rowsAt(lines,page,ys){
  const rows=sourceRows(lines,page);
  rows.forEach((row,i)=>{if(Number.isFinite(ys?.[i]))row.y=ys[i]});
  return rows;
}
function applyRegularHeaderGeometry(rows,headerText='Entry Pts W'){
  for(const row of rows){
    if(row.text!==headerText)continue;
    row.parts=[{x:10,text:'Entry'},{x:520,text:'Pts'},{x:544,text:'W'}];
  }
  return rows;
}
const oddPicks=[1,3,5,7,9,11,13,15,17,19,21,23,25,27,29];
// Explicit PDF cell geometry: name text items at their own X, one item per filled column (null = empty cell).
function geometryLine(nameParts,values){
  const parts=[...nameParts.map(([x,text])=>({x,text})),...values.flatMap((value,i)=>value===null?[]:[{x:160+i*24,text:String(value)}])];
  return{text:parts.map(p=>p.text).join(' '),parts};
}
function parseMixed(items,pageFingerprint,expectedCompetitionSize){
  const lines=items.map(item=>typeof item==='string'?item:item.text),rows=sourceRows(lines,1);
  items.forEach((item,i)=>{if(typeof item!=='string')rows[i].parts=item.parts});
  return parse(lines,{sourceRows:rows,pageFingerprint,expectedCompetitionSize});
}
function sheetParse(participantLines,extraRows=[],expectedCompetitionSize){
  const header=['Entry',...Array.from({length:15},(_,i)=>`Pick${i+1}`),'Pts','W'];
  const rows=[['Week 2'],...matchups.map(line=>[line]),header,...participantLines.map(line=>{
    const tokens=line.split(/\s+/);
    return[tokens.slice(0,-17).join(' '),...tokens.slice(-17)];
  }),...extraRows];
  const sheetRows=rows.map((cells,i)=>({kind:'spreadsheet',sheetName:'Week 2',rowNumber:i+1,cells,text:cells.filter(Boolean).join(' ')}));
  return parseDocumentGroups([{week:2,lines:sheetRows.map(r=>r.text),sourceRows:sheetRows,sheetName:'Week 2'}],{filename:'fixture.xlsx',season:2026,expectedCompetitionSize})[0];
}
// Spreadsheet cells by column: 0 name, 1-15 picks, 16 Pts, 17 W (null = empty cell).
function sheetRow(name,values){return[name,...values.map(v=>v===null?'':String(v))]}
function sheetSparse(name,columns){const cells=Array(18).fill('');cells[0]=name;for(const [i,v] of Object.entries(columns))cells[i]=String(v);return cells}
const COUNT_GATE_ISSUE=/authoritative total pool entr/i;
// A structural fail-closed must stand on its own: callers pass the count of rows the parser validates, so the
// authoritative-count gate passes and the structural check alone keeps the field closed.
function assertFieldFailsClosed(c){
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.length,4);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.config.fieldEntries,undefined);
  assert.equal(c.competitionSize,4);
  assert(c.fullFieldIssues.length>0);
  assert(!c.fullFieldIssues.some(x=>COUNT_GATE_ISSUE.test(x)),'structural fail-closed leaned on the count gate: '+c.fullFieldIssues.join(' | '));
  assert.deepEqual(validateConfig(c.config),[]);
}
function assertFieldReady(c,competitionSize){
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.competitionSize,competitionSize);
  assert.equal(c.config.fieldEntries.length,competitionSize-4);
  assert.deepEqual(validateConfig(c.config),[]);
}

{
  const c=parse([...matchups,...tracked,anonA],{expectedCompetitionSize:5});
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,5);
}
{
  const c=parse([...matchups,...tracked,'Alice 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0 2 4'],{expectedCompetitionSize:4});
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.config.fieldEntries,undefined);
  assert.equal(c.errors.length,0);
}
{
  // A participant-width numeric row in the next participant slot, on the participant columns, is not ignorable noise.
  const c=parse([...matchups,...tracked,anonA,'1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17'],{expectedCompetitionSize:5});
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.config.fieldEntries,undefined);
}
{
  // The same numeric text away from the proven table, and a short numeric footer under it, remain ignorable.
  const lines=[...matchups,...tracked,anonA,'1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17'],rows=sourceRows(lines,1);
  rows[rows.length-1].y=rows[rows.length-2].y-96;
  assertFieldReady(parse(lines,{sourceRows:rows,pageFingerprint:'remote-numeric-noise',expectedCompetitionSize:5}),5);
  assertFieldReady(parse([...matchups,...tracked,anonA,'2026 9 24'],{pageFingerprint:'short-numeric-footer',expectedCompetitionSize:5}),5);
}
{
  const lines=[...matchups,...tracked,anonA];
  const groups=[
    {week:2,lines,sourceRows:sourceRows(lines,1),pageFingerprint:'same-page'},
    {week:2,lines,sourceRows:sourceRows(lines,2),pageFingerprint:'same-page'}
  ];
  const c=parseDocumentGroups(groups,{filename:'dup.pdf',season:2026,expectedCompetitionSize:5})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.length,4);
  assert.equal(c.config.fullFieldReady,false);
}
{
  const c=parse([...matchups,...tracked,
    'One 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0',
    'Two 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0'
  ],{expectedCompetitionSize:6});
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
  const c=parse([...matchups,...tracked,'Rosie 500 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0'],{expectedCompetitionSize:5});
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries.length,1);
  assert.equal(Object.keys(c.config.fieldEntries[0]).sort().join(','),'id,pickNumbers,tiebreak');
}
{
  const c=parse([...matchups,...tracked,"O'Brien-Smith 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0"],{expectedCompetitionSize:5});
  assert.equal(c.config.fullFieldReady,true);
}
{
  const c=parse([...matchups,...tracked,'Missing 1 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0'],{expectedCompetitionSize:4});
  assert.equal(c.config.fullFieldReady,false);
}
{
  // A single wrong-side/blank-equivalent anonymous slot is represented as explicit no-pick 0.
  const c=parse([...matchups,...tracked,'DuplicateSide 1 2 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0'],{expectedCompetitionSize:5});
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries[0].pickNumbers[1],0);
}
{
  const c=parse([...matchups,...tracked,anonA],{expectedCompetitionSize:5});
  const cfg=structuredClone(c.config);
  cfg.fieldEntries[0].metadata={x:1};
  assert(validateConfig(cfg).some(e=>e.includes('only id, pickNumbers, and tiebreak')));
}
{
  const groups=carryForwardWeekHints([{week:2,lines:['Week 2']},{week:null,lines:tracked},{week:null,lines:matchups}]);
  assert.deepEqual(groups.map(g=>g.week),[2,2,2]);
  const c=parseDocumentGroups(groups,{filename:'continuation.pdf',season:2026,expectedCompetitionSize:4})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,false);
}
{
  const oldCfg=parse([...matchups,...tracked,anonA],{expectedCompetitionSize:5}).config;
  delete oldCfg.fullFieldReady;delete oldCfg.fullFieldValidationVersion;delete oldCfg.fullFieldEntryCount;delete oldCfg.fieldEntries;delete oldCfg.competitionSize;
  assert.deepEqual(validateConfig(oldCfg),[]);
}
{
  const c=parse([...matchups,...tracked,anonA],{expectedCompetitionSize:5});
  const cfg=structuredClone(c.config);
  cfg.fieldEntries[0].rawSourceLine='private';
  assert(validateConfig(cfg).some(e=>e.includes('only id, pickNumbers, and tiebreak')));
}
{
  const c=parse([...matchups,...tracked,anonA],{expectedCompetitionSize:5});
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(JSON.stringify(c.config).includes('Alpha'),false);
}
{
  const c=parse([...matchups,...tracked,anonA],{expectedCompetitionSize:5});
  const cfg=structuredClone(c.config);
  cfg.fieldEntries[0].pickNumbers[1]=2;
  assert(validateConfig(cfg).some(e=>e.includes('not exactly one pick/no-pick per game')));
}
{
  // Anonymous no-pick normalization: an invalid/missing matchup cell becomes 0 without guessing a team.
  const noPick='Skip 1 2 5 7 9 11 13 15 17 19 21 23 25 27 29 47 0';
  const c=parse([...matchups,...tracked,anonA,noPick],{expectedCompetitionSize:6});
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,6);
  const normalized=c.config.fieldEntries.find(p=>p.pickNumbers.includes(0));
  assert(normalized);
  assert.equal(normalized.pickNumbers[1],0);
  assert.equal(normalized.pickNumbers[0],1);
  assert.equal(Object.keys(normalized).sort().join(','),'id,pickNumbers,tiebreak');
  assert.deepEqual(validateConfig(c.config),[]);
  const manyZeroes=structuredClone(c.config);
  manyZeroes.fieldEntries[0].pickNumbers=Array(matchups.length).fill(0);
  assert(validateConfig(manyZeroes).some(e=>e.includes('at most one no-pick')));
}
{
  // Tracked entries remain strict; no-pick sentinel is never accepted for the tracked four.
  const c=parse([...matchups,
    'D.C. 1 0 5 7 9 11 13 15 17 19 21 23 25 27 29 42 0',
    tracked[1],tracked[2],tracked[3],anonA
  ]);
  assert(c.errors.some(e=>e.includes('D.C.')));
  assert.equal(c.config.fullFieldReady,false);
}


{
  const c=parse([...matchups,...tracked,anonA,'SECONDARY RESULTS','Survivor Results 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 51 0'],{expectedCompetitionSize:5});
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.length,4);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
  assert(c.fullFieldIssues.some(x=>x.includes('outside the proven regular participant table')));
}
{
  const c=parse([...matchups,...tracked,anonA,'SURVIVOR SECTION','Survivor Results 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 51 0'],{expectedCompetitionSize:5});
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.config.fieldEntries,undefined);
  assert.equal(JSON.stringify(c.config).toLowerCase().includes('survivor'),false);
}
{
  // TEST E — real page-edge continuation: prior run reaches the physical bottom band, next run starts in the top band.
  const page1=[...matchups,tracked[0],tracked[1],anonA],page2=[tracked[2],tracked[3],anonB];
  const y1=page1.map((_,i)=>760-i*12);y1[y1.length-3]=48;y1[y1.length-2]=36;y1[y1.length-1]=24;
  const y2=[760,748,736];
  const groups=[
    {week:2,lines:page1,sourceRows:rowsAt(page1,1,y1),pageNumber:1,pageFingerprint:'real-edge-page-1'},
    {week:2,lines:page2,sourceRows:rowsAt(page2,2,y2),pageNumber:2,pageFingerprint:'real-edge-page-2'}
  ];
  const c=parseDocumentGroups(groups,{filename:'continuation.pdf',season:2026,expectedCompetitionSize:6})[0];
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries.length,2);
  assert.equal(c.config.competitionSize,6);
}
{
  // REAL-SHEET MARGIN — a regular table ending around Y=60 is still physically at the page edge.
  const page1=[...matchups,tracked[0],tracked[1],anonA],page2=[tracked[2],tracked[3],anonB];
  const y1=page1.map((_,i)=>760-i*12);y1[y1.length-3]=84;y1[y1.length-2]=72;y1[y1.length-1]=60;
  const y2=[760,748,736];
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rowsAt(page1,1,y1),pageNumber:1,pageFingerprint:'real-margin-page-1'},
    {week:2,lines:page2,sourceRows:rowsAt(page2,2,y2),pageNumber:2,pageFingerprint:'real-margin-page-2'}
  ],{filename:'real-margin.pdf',season:2026,expectedCompetitionSize:6})[0];
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,6);
}
{
  // SPARSE INACTIVE ROW — a name plus a lone right-edge numeric cell may occupy a table row without becoming a Pick'em entry.
  const sparse='Inactive Entry 15',lines=[...matchups,tracked[0],anonA,sparse,tracked[1],tracked[2],tracked[3],anonB],rows=sourceRows(lines,1);
  const sparseRow=rows.find(row=>row.text===sparse);
  sparseRow.parts=[{x:10,text:'Inactive Entry'},{x:538,text:'15'}];
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'sparse-inactive-row',expectedCompetitionSize:6});
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries.length,2);
  assert.equal(c.config.competitionSize,6);
}
{
  // TRAILING SPARSE ROW — sparse inactive table evidence at page end may prove the edge without being published.
  const sparse='Inactive Tail 15',page1=[...matchups,tracked[0],tracked[1],anonA,sparse],page2=[tracked[2],tracked[3],anonB];
  const rows1=sourceRows(page1,1),tail=rows1.find(row=>row.text===sparse);
  tail.parts=[{x:10,text:'Inactive Tail'},{x:538,text:'15'}];
  const y1=page1.map((_,i)=>760-i*12);y1[y1.length-4]=96;y1[y1.length-3]=84;y1[y1.length-2]=72;y1[y1.length-1]=60;
  rows1.forEach((row,i)=>row.y=y1[i]);
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rows1,pageNumber:1,pageFingerprint:'sparse-tail-page-1'},
    {week:2,lines:page2,sourceRows:rowsAt(page2,2,[760,748,736]),pageNumber:2,pageFingerprint:'sparse-tail-page-2'}
  ],{filename:'sparse-tail.pdf',season:2026,expectedCompetitionSize:6})[0];
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,6);
}
{
  // CONSECUTIVE SPARSE ROWS — sparse evidence cannot walk a trusted run into another aligned mini-table.
  const s1='S1 15',s2='S2 15',s3='S3 15';
  const falseA='False Leader 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 60 0';
  const falseB='False Runner 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 61 0';
  const lines=[...matchups,...tracked,anonA,s1,s2,s3,falseA,falseB],rows=sourceRows(lines,1);
  for(const text of [s1,s2,s3]){
    const row=rows.find(r=>r.text===text);
    row.parts=[{x:10,text:text.split(' ')[0]},{x:538,text:'15'}];
  }
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'consecutive-sparse-bridge',expectedCompetitionSize:5});
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
  assert(c.fullFieldIssues.some(x=>x.includes('outside the proven regular participant table')));
}
{
  // TEST A — same X geometry after a large same-page whitespace gap must not enlarge the field.
  const mystery='Mystery Leader 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 60 0';
  const lines=[...matchups,...tracked,anonA,mystery],rows=sourceRows(lines,1);
  rows[rows.length-1].y=rows[rows.length-2].y-96;
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'large-gap-one',expectedCompetitionSize:5});
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.length,4);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
  assert(c.fullFieldIssues.some(x=>x.includes('outside the proven regular participant table')));
}
{
  // TEST B — an internally consistent aligned mini-table beyond the gap is still a separate ambiguous region.
  const falseA='Mystery Leader 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 60 0';
  const falseB='Mystery Runner 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 61 0';
  const lines=[...matchups,...tracked,anonA,falseA,falseB],rows=sourceRows(lines,1);
  rows[rows.length-2].y=rows[rows.length-3].y-96;rows[rows.length-1].y=rows[rows.length-2].y-12;
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'large-gap-multi',expectedCompetitionSize:5});
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.length,4);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
}
{
  // TEST C — small non-uniform drift remains within the table-derived cadence tolerance.
  const lines=[...matchups,...tracked,anonA],rows=sourceRows(lines,1),start=matchups.length;
  [560,547,535,521,509].forEach((y,i)=>{rows[start+i].y=y});
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'normal-drift',expectedCompetitionSize:5});
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,5);
}
{
  // TEST D — ordinary consistent same-page table spacing remains accepted.
  const c=parse([...matchups,...tracked,anonA],{pageFingerprint:'normal-spacing',expectedCompetitionSize:5});
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,5);
}
{
  // TEST F — aligned participant rows on a later page are not continuation without header or physical edge proof.
  const falseA='Later Leader 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 60 0';
  const falseB='Later Runner 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 61 0';
  const page1=[...matchups,...tracked,anonA],page2=[falseA,falseB];
  const c=parseDocumentGroups([pdfGroup(page1,1),pdfGroup(page2,2)],{filename:'later-table.pdf',season:2026,expectedCompetitionSize:5})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.length,4);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
}
{
  // TEST G — a repeated compatible header plus prior-page edge proof permits continuation.
  const header='Entry Pts W';
  const page1=[...matchups,header,tracked[0],tracked[1],anonA],page2=[header,tracked[2],tracked[3],anonB];
  const rows1=applyRegularHeaderGeometry(sourceRows(page1,1),header);
  const edgeY=new Map([[header,96],[tracked[0],84],[tracked[1],72],[anonA,60]]);
  for(const row of rows1)if(edgeY.has(row.text))row.y=edgeY.get(row.text);
  const rows2=applyRegularHeaderGeometry(rowsAt(page2,2,[760,740,728,716]),header);
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rows1,pageNumber:1,pageFingerprint:'header-near-page-1'},
    {week:2,lines:page2,sourceRows:rows2,pageNumber:2,pageFingerprint:'header-near-page-2'}
  ],{filename:'header-continuation.pdf',season:2026,expectedCompetitionSize:6})[0];
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,6);
}
{
  // REMOTE MATCHING HEADER — identical header geometry cannot authorize a participant mini-table across a large physical gap.
  const header='Entry Pts W';
  const falseA='Remote Leader 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 60 0';
  const falseB='Remote Runner 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 61 0';
  const page1=[...matchups,header,...tracked,anonA],page2=[header,falseA,falseB];
  const rows1=applyRegularHeaderGeometry(sourceRows(page1,1),header);
  const rows2=applyRegularHeaderGeometry(rowsAt(page2,2,[760,300,288]),header);
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rows1,pageNumber:1,pageFingerprint:'remote-header-page-1'},
    {week:2,lines:page2,sourceRows:rows2,pageNumber:2,pageFingerprint:'remote-header-page-2'}
  ],{filename:'remote-header.pdf',season:2026,expectedCompetitionSize:5})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.length,4);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
  assert(c.fullFieldIssues.some(x=>x.includes('outside the proven regular participant table')));
}
{
  // Missing header/run Y evidence must fail closed even when header text and X geometry match.
  const header='Entry Pts W';
  const falseA='Missing Y Leader 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 60 0';
  const falseB='Missing Y Runner 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 61 0';
  const page1=[...matchups,header,...tracked,anonA],page2=[header,falseA,falseB];
  const rows1=applyRegularHeaderGeometry(sourceRows(page1,1),header);
  const rows2=applyRegularHeaderGeometry(rowsAt(page2,2,[760,748,736]),header);
  rows2[1].y=undefined;
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rows1,pageNumber:1,pageFingerprint:'missing-y-header-page-1'},
    {week:2,lines:page2,sourceRows:rows2,pageNumber:2,pageFingerprint:'missing-y-header-page-2'}
  ],{filename:'missing-y-header.pdf',season:2026,expectedCompetitionSize:5})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
}
{
  // A physically near header with incompatible Pts/W X geometry cannot authorize continuation.
  const header='Entry Pts W';
  const falseA='Wrong Header Leader 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 60 0';
  const falseB='Wrong Header Runner 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 61 0';
  const page1=[...matchups,header,...tracked,anonA],page2=[header,falseA,falseB];
  const rows1=applyRegularHeaderGeometry(sourceRows(page1,1),header),rows2=rowsAt(page2,2,[760,748,736]);
  const headerRow=rows2.find(row=>row.text===header);
  headerRow.parts=[{x:10,text:'Entry'},{x:100,text:'Pts'},{x:124,text:'W'}];
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rows1,pageNumber:1,pageFingerprint:'bad-header-page-1'},
    {week:2,lines:page2,sourceRows:rows2,pageNumber:2,pageFingerprint:'bad-header-page-2'}
  ],{filename:'bad-header-geometry.pdf',season:2026,expectedCompetitionSize:5})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
}
{
  // Explicitly preserve names that contain digits and hyphens.
  const c=parse([...matchups,...tracked,'7-11 Guy 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0'],{expectedCompetitionSize:5});
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries.length,1);
}
{
  const c=parse([...matchups,...tracked,anonA,'OTHER WEEKLY CONTEST','Contest Leader 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 60 0'],{expectedCompetitionSize:5});
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
  const c=parseDocumentGroups([{week:2,lines:sheetRows.map(r=>r.text),sourceRows:sheetRows,sheetName:'Week 2'}],{filename:'fixture.xlsx',season:2026,expectedCompetitionSize:5})[0];
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,5);
  assert.equal(Object.keys(c.config.fieldEntries[0]).sort().join(','),'id,pickNumbers,tiebreak');
}


{
  // STEP 2 P2-A — an all-digit participant name must not bypass damaged-row detection.
  const damagedNumericName='12345 1 2 5 6 9 11 13 15 17 19 21 23 25 27 29 44 0';
  const c=parse([...matchups,...tracked,anonA,damagedNumericName],{pageFingerprint:'step2-p2-a-numeric-damaged',expectedCompetitionSize:5});
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.config.fieldEntries,undefined);
  assert(c.fullFieldIssues.some(x=>x.includes('structurally invalid')));
}
{
  // STEP 2 P2-B — a later unrelated Week label must not override the page's authoritative week hint.
  const lines=['Week 2',...matchups,...tracked,anonA,'Results from Week 1'];
  const rows=sourceRows(lines,1);
  const candidates=parseDocumentGroups([
    {week:2,lines,sourceRows:rows,pageNumber:1,pageFingerprint:'step2-p2-b-week-binding'}
  ],{filename:'week-binding.pdf',season:2026});
  assert.deepEqual(candidates.map(c=>c.week),[2]);
  assert.equal(candidates[0].config.label,'Week 2');
}
{
  // STEP 2 P2-C — a summary-like row with split label geometry is not proven to be a participant.
  const summary='Winning Picks 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0';
  const lines=[...matchups,...tracked,anonA,summary],rows=sourceRows(lines,1);
  const summaryRow=rows.find(r=>r.text===summary);
  const numericParts=summaryRow.parts.slice(1);
  summaryRow.parts=[{x:10,text:'Winning'},{x:90,text:'Picks'},...numericParts];
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'step2-p2-c-summary-intrusion',expectedCompetitionSize:5});
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.config.fieldEntries,undefined);
  assert(c.fullFieldIssues.some(x=>x.includes('outside the proven regular participant table')));
}
{
  // STEP 2 P2-D — a matching next-page header cannot bridge a prior run that ended mid-page.
  const header='Entry Pts W';
  const page1=[...matchups,header,tracked[0],tracked[1],anonA],page2=[header,tracked[2],tracked[3],anonB];
  const rows1=applyRegularHeaderGeometry(sourceRows(page1,1),header);
  const rows2=applyRegularHeaderGeometry(sourceRows(page2,2),header);
  const setY=(rows,text,y)=>{const row=rows.find(r=>r.text===text);row.y=y;};
  setY(rows1,header,548);setY(rows1,tracked[0],536);setY(rows1,tracked[1],524);setY(rows1,anonA,512);
  setY(rows2,header,760);setY(rows2,tracked[2],748);setY(rows2,tracked[3],736);setY(rows2,anonB,724);
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rows1,pageNumber:1,pageFingerprint:'step2-p2-d-page-1'},
    {week:2,lines:page2,sourceRows:rows2,pageNumber:2,pageFingerprint:'step2-p2-d-page-2'}
  ],{filename:'near-header-break.pdf',season:2026,expectedCompetitionSize:5})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.config.fieldEntries,undefined);
  assert(c.fullFieldIssues.some(x=>x.includes('continuous PDF participant-table chain')));
}
{
  // STEP 2 P1 — the reviewed all-numeric row that is one tail token short must not vanish at the trailing table edge.
  assertFieldFailsClosed(parse([...matchups,...tracked,anonA,'12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0'],{pageFingerprint:'p1-review-row-end',expectedCompetitionSize:5}));
}
{
  // STEP 2 P1 — the same row at the leading table edge.
  assertFieldFailsClosed(parse([...matchups,'12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0',...tracked,anonA],{pageFingerprint:'p1-review-row-start',expectedCompetitionSize:5}));
}
{
  // STEP 2 P1 — real cell geometry: numeric name in the name column, one empty matchup column, leading table edge.
  const damaged=geometryLine([[10,'12345']],[...oddPicks.slice(0,6),null,...oddPicks.slice(7),44,0]);
  assertFieldFailsClosed(parseMixed([...matchups,damaged,...tracked,anonA],'p1-missing-pick-start',5));
}
{
  // STEP 2 P1 — the same damaged row between tracked rows (already fails closed through run breakage; guarded here).
  const damaged=geometryLine([[10,'12345']],[...oddPicks.slice(0,6),null,...oddPicks.slice(7),44,0]);
  assertFieldFailsClosed(parseMixed([...matchups,tracked[0],tracked[1],damaged,tracked[2],tracked[3],anonA],'p1-missing-pick-middle',4));
}
{
  // STEP 2 P1 — inside the physical table, followed by a numeric-named single no-pick row: neither row may silently vanish.
  const damaged=geometryLine([[10,'12345']],[...oddPicks.slice(0,6),null,...oddPicks.slice(7),44,0]);
  assertFieldFailsClosed(parseMixed([...matchups,...tracked,anonA,damaged,'67890 1 2 5 7 9 11 13 15 17 19 21 23 25 27 29 47 0'],'p1-missing-pick-inner',5));
}
{
  // STEP 2 P1 — the same damaged row at the trailing table edge.
  const damaged=geometryLine([[10,'12345']],[...oddPicks.slice(0,6),null,...oddPicks.slice(7),44,0]);
  assertFieldFailsClosed(parseMixed([...matchups,...tracked,anonA,damaged],'p1-missing-pick-end',5));
}
{
  // STEP 2 P1 — truncated numeric tail: every matchup pick but no tiebreak or wins cells.
  assertFieldFailsClosed(parseMixed([...matchups,...tracked,anonA,geometryLine([[10,'12345']],[...oddPicks])],'p1-truncated-tail',5));
}
{
  // STEP 2 P1 — truncated numeric tail: the row stops after ten picks.
  assertFieldFailsClosed(parseMixed([...matchups,...tracked,anonA,geometryLine([[10,'12345']],oddPicks.slice(0,10))],'p1-truncated-ten',5));
}
{
  // STEP 2 P1 — truncated numeric tail in the default single-text-item form.
  assertFieldFailsClosed(parse([...matchups,...tracked,anonA,'12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29'],{pageFingerprint:'p1-truncated-text',expectedCompetitionSize:5}));
}
{
  // STEP 2 P1 — missing tiebreak cell.
  assertFieldFailsClosed(parseMixed([...matchups,...tracked,anonA,geometryLine([[10,'12345']],[...oddPicks,null,0])],'p1-missing-tiebreak',5));
}
{
  // STEP 2 P1 — missing wins cell.
  assertFieldFailsClosed(parseMixed([...matchups,...tracked,anonA,geometryLine([[10,'12345']],[...oddPicks,44,null])],'p1-missing-wins',5));
}
{
  // STEP 2 P1 — a damaged numeric row that opens a proven continuation page is not skipped by the continuation.
  const damaged='12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0';
  const page1=[...matchups,tracked[0],tracked[1],anonA],page2=[damaged,tracked[2],tracked[3],anonB];
  const y1=page1.map((_,i)=>760-i*12);y1[y1.length-3]=48;y1[y1.length-2]=36;y1[y1.length-1]=24;
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rowsAt(page1,1,y1),pageNumber:1,pageFingerprint:'p1-edge-page-1'},
    {week:2,lines:page2,sourceRows:rowsAt(page2,2,[760,748,736,724]),pageNumber:2,pageFingerprint:'p1-edge-page-2'}
  ],{filename:'p1-edge.pdf',season:2026,expectedCompetitionSize:6})[0];
  assertFieldFailsClosed(c);
}
{
  // STEP 2 P1 — the table's last row spilling alone onto the next page (bare, or under a repeated header) cannot vanish.
  const damaged='12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0',header='Entry Pts W';
  const page1=[...matchups,...tracked,anonA],y1=page1.map((_,i)=>i<matchups.length?760-i*12:24+(page1.length-1-i)*12);
  for(const page2 of [[damaged],[header,damaged]]){
    const c=parseDocumentGroups([
      {week:2,lines:page1,sourceRows:rowsAt(page1,1,y1),pageNumber:1,pageFingerprint:'p1-spill-page-1'},
      {week:2,lines:page2,sourceRows:applyRegularHeaderGeometry(rowsAt(page2,2,[760,748]),header),pageNumber:2,pageFingerprint:'p1-spill-page-2-'+page2.length}
    ],{filename:'p1-spill.pdf',season:2026,expectedCompetitionSize:5})[0];
    assertFieldFailsClosed(c);
  }
}
{
  // STEP 2 P1 — a damaged first row at the bottom of the prior page, with the proven table starting at the next page top.
  const page1=[...matchups,'12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0'],page2=[...tracked,anonA];
  const y1=page1.map((_,i)=>i<matchups.length?760-i*12:24);
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rowsAt(page1,1,y1),pageNumber:1,pageFingerprint:'p1-lead-page-1'},
    {week:2,lines:page2,sourceRows:rowsAt(page2,2,[760,748,736,724,712]),pageNumber:2,pageFingerprint:'p1-lead-page-2'}
  ],{filename:'p1-lead.pdf',season:2026,expectedCompetitionSize:5})[0];
  assertFieldFailsClosed(c);
}
{
  // STEP 2 P1 — sparse continuity evidence cannot hide a damaged numeric row after it (one and two sparse rows).
  const damaged='12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0',sparse=text=>({text,parts:[{x:10,text:text.split(' ')[0]},{x:538,text:'15'}]});
  assertFieldFailsClosed(parseMixed([...matchups,...tracked,anonA,sparse('S1 15'),damaged],'p1-after-one-sparse',5));
  assertFieldFailsClosed(parseMixed([...matchups,...tracked,anonA,sparse('S1 15'),sparse('S2 15'),damaged],'p1-after-two-sparse',5));
}
{
  // STEP 2 P1 — a damaged numeric row between the regular header and the first participant.
  const header='Entry Pts W',lines=[...matchups,header,'12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0',...tracked,anonA];
  assertFieldFailsClosed(parse(lines,{sourceRows:applyRegularHeaderGeometry(sourceRows(lines,1),header),pageFingerprint:'p1-after-header',expectedCompetitionSize:5}));
}
{
  // STEP 2 P1 — a numeric-named single no-pick row outside the proven table is as ambiguous as a text-named one.
  const lines=[...matchups,...tracked,anonA,'67890 1 2 5 7 9 11 13 15 17 19 21 23 25 27 29 47 0'],rows=sourceRows(lines,1);
  rows[rows.length-1].y=rows[rows.length-2].y-96;
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'p1-numeric-skip-remote',expectedCompetitionSize:5});
  assertFieldFailsClosed(c);
  assert(c.fullFieldIssues.some(x=>x.includes('outside the proven regular participant table')));
}
{
  // STEP 2 P1 — spreadsheet form: an all-numeric name with an empty pick cell.
  assertFieldFailsClosed(sheetParse([...tracked,anonA],[['12345','1','','5','7','9','11','13','15','17','19','21','23','25','27','29','44','0']],5));
}
{
  // STEP 2 P1 — spreadsheet form: an all-numeric name with an empty wins cell.
  assertFieldFailsClosed(sheetParse([...tracked,anonA],[['12345','1','3','5','7','9','11','13','15','17','19','21','23','25','27','29','44','']],5));
}
{
  // STEP 2 P1 — structurally complete all-numeric names remain ordinary participants, including a single no-pick.
  assertFieldReady(parse([...matchups,...tracked,anonA,'12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0'],{pageFingerprint:'p1-numeric-complete-end',expectedCompetitionSize:6}),6);
  assertFieldReady(parseMixed([...matchups,geometryLine([[10,'12345']],[...oddPicks,44,0]),...tracked,anonA],'p1-numeric-complete-start',6),6);
  const c=parse([...matchups,...tracked,anonA,'67890 1 2 5 7 9 11 13 15 17 19 21 23 25 27 29 47 0'],{pageFingerprint:'p1-numeric-skip-inside',expectedCompetitionSize:6});
  assertFieldReady(c,6);
  assert.deepEqual(c.config.fieldEntries[1].pickNumbers,[1,0,5,7,9,11,13,15,17,19,21,23,25,27,29]);
  assertFieldReady(sheetParse([...tracked,anonA,'12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0'],[],6),6);
  assertFieldReady(sheetParse([...tracked,anonA],[['Ginner',...Array(16).fill(''),'0']],5),5);
}
{
  // STEP 2 P2-1 — a legitimate two-part name split into two PDF text items at natural increasing X positions.
  const name=geometryLine([[10,'Mary'],[48,'Jane']],[...oddPicks,44,0]);
  assertFieldReady(parseMixed([...matchups,...tracked,anonA,name],'p2-split-two-part-end',6),6);
  assertFieldReady(parseMixed([...matchups,tracked[0],tracked[1],name,tracked[2],tracked[3],anonA],'p2-split-two-part-middle',6),6);
}
{
  // STEP 2 P2-1 — a realistic three-part name, one text item per word.
  const name=geometryLine([[10,'Juan'],[48,'Carlos'],[100,'Rivera']],[2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,51,0]);
  assertFieldReady(parseMixed([...matchups,...tracked,anonA,name],'p2-split-three-part',6),6);
}
{
  // STEP 2 P2-1 — summary-sounding words inside a naturally flowing split name are not blacklisted.
  const name=geometryLine([[10,'Winning'],[70,'Picks'],[115,'Wendy']],[...oddPicks,39,0]);
  const c=parseMixed([...matchups,...tracked,anonA,name],'p2-summary-words-in-name',6);
  assertFieldReady(c,6);
  assert.equal(JSON.stringify(c.config).includes('Wendy'),false);
}
{
  // STEP 2 P2-S — spreadsheet notes, totals, dates and counts below the table lack participant-column evidence.
  const debris={
    'blank spacer':[Array(18).fill('')],
    'text-only note':[['Picks lock at kickoff']],
    'totals, two numbers on pick columns':[sheetSparse('Totals',{5:12,12:34})],
    'totals, two numbers on Pts/W':[sheetSparse('Totals',{16:12,17:34})],
    'totals, one number on a pick column':[sheetSparse('Total entries',{3:282})],
    'note with a date and two counts':[sheetSparse('Entries paid',{1:282,2:'9/24/2026',3:5})],
    'date label with two counts':[sheetSparse('9/24/2026',{1:282,16:5})],
    'two numbers that are valid picks for their columns':[sheetSparse('Notes',{1:1,2:3})],
    'per-game counts on ten pick columns':[sheetRow('Pick counts',[140,142,138,139,141,137,143,136,144,135,null,null,null,null,null,null,null])],
    'spacer then an unnamed sparse numeric row':[Array(18).fill(''),sheetSparse('',{4:7,9:3})],
    'spacer then a named sparse numeric row':[Array(18).fill(''),sheetSparse('Next slate',{2:5,6:13,11:21})]
  };
  for(const [label,rows] of Object.entries(debris)){
    const c=sheetParse([...tracked,anonA],rows,5);
    assert.deepEqual(c.fullFieldIssues,[],label);
    assertFieldReady(c,5);
  }
}
{
  // STEP 2 P2-S — a damaged spreadsheet participant keeps its evidence in the participant columns and fails closed.
  const damage={
    'missing first pick':v=>{v[0]=null},
    'missing middle pick':v=>{v[7]=null},
    'missing last pick':v=>{v[14]=null},
    'missing tiebreak':v=>{v[15]=null},
    'missing wins':v=>{v[16]=null},
    'truncated after ten picks':v=>{v.fill(null,10)},
    'truncated before the tiebreak':v=>{v.fill(null,15)},
    'invalid pick':v=>{v[3]=99}
  };
  for(const name of ['Gamma','12345'])for(const [label,apply] of Object.entries(damage)){
    const values=[...oddPicks,44,0];apply(values);
    const c=sheetParse([...tracked,anonA],[sheetRow(name,values)],5);
    assert(c.fullFieldIssues.some(x=>x.includes('structurally invalid')),`${name} ${label}`);
    assertFieldFailsClosed(c);
  }
}
{
  // STEP 2 P2-H — a repeated header proven identical to the anchored participant header carries damaged-row checks
  // across the page edge; a header that merely shares the Pts/W columns starts another region.
  const header='Entry Pts W',other='Standings Pts W',damaged='12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0';
  const page1=[...matchups,header,...tracked,anonA],tableRows=[header,...tracked,anonA];
  const parsePages=(page2,id)=>{
    const rows1=applyRegularHeaderGeometry(sourceRows(page1,1),header);
    for(const row of rows1){const i=tableRows.indexOf(row.text);if(i>=0)row.y=24+(tableRows.length-1-i)*12}
    const lines2=page2.map(item=>typeof item==='string'?item:item.text),rows2=rowsAt(lines2,2,lines2.map((_,i)=>760-i*12));
    page2.forEach((item,i)=>{if(typeof item!=='string')rows2[i].parts=item.parts});
    applyRegularHeaderGeometry(rows2,header);
    for(const row of rows2)if(row.text===other)row.parts=[{x:10,text:'Standings'},{x:520,text:'Pts'},{x:544,text:'W'}];
    return parseDocumentGroups([
      {week:2,lines:page1,sourceRows:rows1,pageNumber:1,pageFingerprint:'p2h-page-1'},
      {week:2,lines:lines2,sourceRows:rows2,pageNumber:2,pageFingerprint:'p2h-page-2-'+id}
    ],{filename:'p2h.pdf',season:2026,expectedCompetitionSize:5})[0];
  };
  const proven=parsePages([header,damaged],'repeated');
  assertFieldFailsClosed(proven);
  assert(proven.fullFieldIssues.some(x=>x.includes('adjoining the proven regular participant table')));
  assertFieldReady(parsePages([other,'3 1 4 1 5 9 2 6 5 3 5 8 9 7 9 3 2','2 7 1 8 2 8 1 8 2 8 4 5 9 0 4 5 2'],'foreign-numeric'),5);
  assertFieldReady(parsePages([other,geometryLine([[10,'Club A']],[null,7,null,null,null,null,null,null,null,12])],'foreign-aligned'),5);
}
{
  // STEP 2 P2-H — the anchored header above a table that opens at the next page top still carries the check back to a
  // damaged row at the prior page bottom.
  const header='Entry Pts W',page1=[...matchups,'12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0'],page2=[header,...tracked,anonA];
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rowsAt(page1,1,page1.map((_,i)=>i<matchups.length?760-i*12:24)),pageNumber:1,pageFingerprint:'p2h-lead-page-1'},
    {week:2,lines:page2,sourceRows:applyRegularHeaderGeometry(rowsAt(page2,2,page2.map((_,i)=>760-i*12)),header),pageNumber:2,pageFingerprint:'p2h-lead-page-2'}
  ],{filename:'p2h-lead.pdf',season:2026,expectedCompetitionSize:5})[0];
  assertFieldFailsClosed(c);
}

// ---------------------------------------------------------------------------------------------------------------------
// STEP 2 AUTHORITATIVE COUNT GATE. A natural-flow summary row and a legitimate entrant who chose the same name are the same
// parser input, so no parser-only rule can separate them. The admin's authoritative total pool entry count is independent
// external evidence: it only gates full-field validation and never selects, drops, adds or renames a row.
const countMismatch=(parsed,expected)=>`Parsed competition size ${parsed} does not match authoritative total pool entries ${expected}`;
const COUNT_REQUIRED='Authoritative total pool entry count is required for full-field validation';
const COUNT_INVALID='Authoritative total pool entry count must be a whole number of at least 4';
function assertTrackedOnly(c,issue,label=''){
  assert.deepEqual(c.errors,[],label);
  assert.deepEqual(c.config.participants.map(p=>p.id),['dc','jc','djs','thaddeus'],label);
  assert.equal(c.config.fullFieldReady,false,label);
  assert.equal(c.config.fieldEntries,undefined,label);
  assert.equal(c.config.competitionSize,undefined,label);
  assert.equal(c.competitionSize,4,label);
  assert(c.fullFieldIssues.includes(issue),`${label}: expected "${issue}" in ${JSON.stringify(c.fullFieldIssues)}`);
  assert.deepEqual(validateConfig(c.config),[],label);
}
{
  // COUNT GATE PAIR — identical rows: with five genuine entries the summary-shaped sixth row cannot publish; with six (the
  // sixth row is a real entrant named "Winning Picks…") the same rows validate. Only the external count differs.
  const shapes={
    'one text item':'Winning Picks 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0',
    'two natural-flow items':geometryLine([[10,'Winning'],[62,'Picks']],[...oddPicks,44,0]),
    'three natural-flow items':geometryLine([[10,'Winning'],[62,'Picks'],[100,'Wendy']],[...oddPicks,44,0])
  };
  for(const [label,row] of Object.entries(shapes)){
    const items=[...matchups,...tracked,anonA,row];
    const summary=parseMixed(items,'count-pair',5);
    assertTrackedOnly(summary,countMismatch(6,5),label);
    assert.deepEqual(summary.fullFieldIssues,[countMismatch(6,5)],label);
    const entrant=parseMixed(items,'count-pair',6);
    assertFieldReady(entrant,6);
    assert.equal(JSON.stringify(entrant.config).includes('Winning'),false,label);
    assert(!Object.keys(entrant.config).some(k=>/expected|authoritative/i.test(k)),'the count is not persisted in the config');
    // Without the count, neither reading of the rows can validate.
    assertTrackedOnly(parseMixed(items,'count-pair'),COUNT_REQUIRED,label);
  }
}
{
  // COUNT GATE — a missing count (absent or null) closes the full field; the tracked four stay valid and publishable.
  for(const expectedCompetitionSize of [undefined,null]){
    const candidates=parseDocumentGroups([{week:2,lines:[...matchups,...tracked,anonA],sourceRows:sourceRows([...matchups,...tracked,anonA],1),pageNumber:1,pageFingerprint:'count-missing'}],{filename:'fixture.pdf',season:2026,expectedCompetitionSize});
    assertTrackedOnly(candidates[0],COUNT_REQUIRED,String(expectedCompetitionSize));
    assert.deepEqual(candidates[0].fullFieldIssues,[COUNT_REQUIRED]);
    assert.equal(chooseBestCandidate(candidates),candidates[0],'tracked-only publication remains available');
  }
}
{
  // COUNT GATE — for an actual six-entry field, both a low and a high count fail closed; only the exact count validates.
  const six=[...matchups,...tracked,anonA,anonB];
  for(const expected of [5,7]){
    const c=parse(six,{pageFingerprint:'count-six',expectedCompetitionSize:expected});
    assertTrackedOnly(c,countMismatch(6,expected),String(expected));
    assert.deepEqual(c.fullFieldIssues,[countMismatch(6,expected)]);
  }
  const exact=parse(six,{pageFingerprint:'count-six',expectedCompetitionSize:6});
  assertFieldReady(exact,6);
  // The published field is the parsed rows themselves: never trimmed to a low count, padded to a high one, or sized by it.
  assert.equal(exact.config.competitionSize,exact.config.participants.length+exact.config.fieldEntries.length);
  assert.deepEqual(exact.config.fieldEntries.map(e=>[e.pickNumbers,e.tiebreak]),[[oddPicks,44],[oddPicks.map(n=>n+1),55]]);
}
{
  // COUNT GATE — a malformed count is never read as a count.
  for(const bad of [0,3,-6,5.5,Number.NaN,Number.POSITIVE_INFINITY,2**53,'5','',true,{},[5]]){
    const c=parse([...matchups,...tracked,anonA],{pageFingerprint:'count-invalid',expectedCompetitionSize:bad});
    assertTrackedOnly(c,COUNT_INVALID,JSON.stringify(bad)??String(bad));
    assert.deepEqual(c.fullFieldIssues,[COUNT_INVALID]);
  }
  // Four is the smallest well-formed count; it is compared like any other count.
  assertTrackedOnly(parse([...matchups,...tracked,anonA],{pageFingerprint:'count-four',expectedCompetitionSize:4}),countMismatch(5,4));
}
{
  // COUNT GATE — spreadsheets obey the same contract, including a complete summary-shaped row directly under the table.
  const base=[...tracked,anonA],summaryRow=sheetRow('Winning Picks',[...oddPicks,44,0]);
  assertTrackedOnly(sheetParse(base),COUNT_REQUIRED,'sheet missing');
  assertFieldReady(sheetParse(base,[],5),5);
  for(const expected of [4,6])assertTrackedOnly(sheetParse(base,[],expected),countMismatch(5,expected),'sheet '+expected);
  assertTrackedOnly(sheetParse(base,[summaryRow],5),countMismatch(6,5),'sheet summary');
  assertFieldReady(sheetParse(base,[summaryRow],6),6);
}
{
  // COUNT GATE — a second, independent defense: a damaged participant row still raises its own structural issue, and with
  // the true pool count (which includes that entrant) the parsed field is additionally one short.
  const c=parse([...matchups,...tracked,anonA,'12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0'],{pageFingerprint:'count-second-defense',expectedCompetitionSize:6});
  assertTrackedOnly(c,countMismatch(5,6));
  assert(c.fullFieldIssues.some(x=>x.includes('adjoining the proven regular participant table')));
  const s=sheetParse([...tracked,anonA],[sheetRow('12345',[...oddPicks.slice(0,14),null,44,0])],6);
  assertTrackedOnly(s,countMismatch(5,6),'sheet second defense');
  assert(s.fullFieldIssues.some(x=>x.includes('structurally invalid')));
}
{
  // COUNT GATE — rows that no structural check can attribute to the proven table are where a silent deletion would hide;
  // the true pool count exposes each one.
  const detached=[...matchups,...tracked,anonA,'12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0'],rows=sourceRows(detached,1);
  rows[rows.length-1].y=rows[rows.length-2].y-96;
  assertTrackedOnly(parse(detached,{sourceRows:rows,pageFingerprint:'count-detached',expectedCompetitionSize:6}),countMismatch(5,6),'detached numeric row');
  assertTrackedOnly(sheetParse([...tracked,anonA],[sheetRow('Gamma',[1,3,5,7,9,null,null,null,null,null,null,null,null,null,null,44,0])],6),countMismatch(5,6),'sparse spreadsheet entrant');
  const header='Entry Pts W',tableRows=[header,...tracked,anonA],page1=[...matchups,...tableRows];
  const rows1=applyRegularHeaderGeometry(sourceRows(page1,1),header);
  for(const row of rows1){const i=tableRows.indexOf(row.text);if(i>=0)row.y=24+(tableRows.length-1-i)*12}
  const page2=['Standings Pts W','12345 1 3 5 7 9 11 13 15 17 19 21 23 25 27 44 0'],rows2=rowsAt(page2,2,[760,748]);
  rows2[0].parts=[{x:10,text:'Standings'},{x:520,text:'Pts'},{x:544,text:'W'}];
  const foreign=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rows1,pageNumber:1,pageFingerprint:'count-foreign-1'},
    {week:2,lines:page2,sourceRows:rows2,pageNumber:2,pageFingerprint:'count-foreign-2'}
  ],{filename:'count-foreign.pdf',season:2026,expectedCompetitionSize:6})[0];
  assertTrackedOnly(foreign,countMismatch(5,6),'row under a different compatible header');
}
{
  // COUNT GATE — one entered count is asserted for every week a file yields; a week whose parsed field differs stays closed
  // rather than borrowing another week's size.
  const w2=[...matchups,...tracked,anonA],w3=[...matchups,...tracked,anonA,anonB];
  const candidates=parseDocumentGroups([
    {week:2,lines:w2,sourceRows:sourceRows(w2,1),pageNumber:1,pageFingerprint:'count-week-2'},
    {week:3,lines:w3,sourceRows:sourceRows(w3,2),pageNumber:2,pageFingerprint:'count-week-3'}
  ],{filename:'count-weeks.pdf',season:2026,expectedCompetitionSize:5});
  assert.deepEqual(candidates.map(c=>c.week),[2,3]);
  assertFieldReady(candidates[0],5);
  assertTrackedOnly(candidates[1],countMismatch(6,5),'week 3');
}

// ---------------------------------------------------------------------------------------------------------------------
// Pick'em publisher state (admin.js) for the authoritative count, against a fake DOM, a mock Neon client, a mock PDF reader
// and a mock NFL schedule feed. Only the CDN imports and the versioned parser URL are rewritten; publisher logic runs as is.
const adminHtml=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const adminSource=readFileSync(new URL('./admin.js',import.meta.url),'utf8');
const adminPatched=(()=>{
  let s=adminSource;
  const swap=(from,to)=>{assert(s.includes(from),`admin harness expects: ${from}`);s=s.split(from).join(to)};
  swap("import {createClient} from 'https://cdn.jsdelivr.net/npm/@neondatabase/neon-js@0.7.0-beta/+esm';","const {createClient}=globalThis.__pickemTest.neonModule;");
  const parserImport=s.match(/from '\.\/parser-core\.js\?v=(\d+)';/);
  assert(parserImport,'admin harness expects a versioned parser-core import');
  swap(parserImport[0],`from '${new URL(`./parser-core.js?v=${parserImport[1]}`,import.meta.url).href}';`);
  swap("await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs')","globalThis.__pickemTest.pdfjs");
  // Each instance binds its own page and schedule feed, so two Admin pages can run side by side against one database.
  return `const {document,fetch}=globalThis.__pickemTest;\n${s}`;
})();
class AdminEl{
  constructor(id){Object.assign(this,{id,hidden:false,disabled:false,checked:false,value:'',textContent:'',innerHTML:'',className:'',files:null,listeners:{},onchange:null,classList:{add(){},remove(){}}})}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn)}
  dispatch(type){return Promise.all((this.listeners[type]||[]).map(fn=>fn({preventDefault(){},target:this})))}
  focus(){}
}
const adminFlush=async(n=8)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};
const adminUntil=async(ready,what)=>{for(let i=0;i<200&&!ready();i++)await new Promise(r=>setTimeout(r,0));assert(ready(),what)};
const adminDeferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
const PUBLISH_FROZEN='Publishing is in progress. Total pool entries cannot be changed until it finishes.';
const FILE_FROZEN='Publishing is in progress. Wait for it to finish before changing files.';
const FEED_TEAMS=[['CAR','ATL'],['NO','BAL'],['MIN','CHI'],['CIN','HOU'],['PIT','NE'],['GB','NYJ'],['CLE','TB'],['PHI','TEN'],['JAX','DEN'],['LV','LAC'],['SEA','ARI'],['WAS','DAL'],['MIA','SF'],['IND','KC'],['NYG','LAR']];
const scheduleFeed={events:FEED_TEAMS.map(([away,home],i)=>({id:String(401+i),date:'2026-09-13T17:00:00Z',competitions:[{competitors:[{homeAway:'away',team:{abbreviation:away}},{homeAway:'home',team:{abbreviation:home}}]}]}))};
function sheetPage(week,participantLines){
  const items=[];let y=760;
  const put=parts=>{for(const [x,str] of parts)items.push({str,transform:[1,0,0,1,x,y]});y-=12};
  put([[10,`Week ${week} Pick Sheet`]]);for(const m of matchups)put([[10,m]]);
  for(const line of participantLines){const t=line.split(' ');put([[10,t.slice(0,-17).join(' ')],...t.slice(-17).map((v,i)=>[160+i*24,v])])}
  return items;
}
const ADMIN_SHEETS={
  'six.pdf':[sheetPage(2,[...tracked,anonA,anonB])],
  'summary.pdf':[sheetPage(2,[...tracked,anonA,'Winning Picks 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0'])],
  'weeks.pdf':[sheetPage(2,[...tracked,anonA,anonB]),sheetPage(3,[...tracked,anonA])]
};
// A JSONB column keeps no key order of its own: it returns object keys shorter first, then bytewise. Arrays keep theirs.
const jsonbKeyOrder=v=>Array.isArray(v)?v.map(jsonbKeyOrder):v!==null&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort((a,b)=>Buffer.byteLength(a)-Buffer.byteLength(b)||Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>[k,jsonbKeyOrder(v[k])])):v;
// What the table keeps of a written row: its config is the JSON the client sent, stored as a JSONB column stores it.
const storedRow=row=>({...structuredClone(row),config:jsonbKeyOrder(JSON.parse(JSON.stringify(row.config)))});
let adminInstance=0;
async function bootAdmin({rows=[]}={}){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new AdminEl(id));return els.get(id)};
  // `rows` is the nfl_pool_weeks table: pages booted with the same array share it, and each keeps its own session, logs
  // and hooks. `affected` records how many rows each committed write changed. A read returns only the columns it selects.
  const db={session:{id:'admin-1',email:'djsmokke@gmail.com'},rows,log:[],dispatched:[],affected:[],readGate:null,writeGate:null,readFail:null,beforeWrite:null,afterWrite:null},net={gate:null};
  class Query{
    constructor(table){Object.assign(this,{table,op:'select',filters:[],row:null,columns:null})}
    select(columns){if(this.op==='select'&&columns)this.columns=columns.split(',');return this}
    eq(k,v){this.filters.push([k,v]);return this}
    limit(){return this}
    insert(row){this.op='insert';this.row=row;return this}
    update(row){this.op='update';this.row=row;return this}
    then(ok,fail){return this.run().then(ok,fail)}
    async run(){
      // `dispatched` records every query the publisher issues, held or not; `log` records those that have completed.
      db.dispatched.push(this.op);
      if(this.op==='select'&&db.readGate){const gate=db.readGate;db.readGate=null;await gate.promise}
      // A held write has been dispatched by the publisher; it commits only when the test releases it.
      if(this.op!=='select'&&db.writeGate){const gate=db.writeGate;db.writeGate=null;await gate.promise}
      db.log.push(this.op);
      const match=r=>this.filters.every(([k,v])=>r[k]===v);
      if(this.op==='select'){if(db.readFail){const e=db.readFail;db.readFail=null;throw e}const pick=r=>this.columns?Object.fromEntries(this.columns.map(c=>[c,c in r?r[c]:null])):r;return{data:db.rows.filter(match).map(r=>pick(structuredClone(r))),error:null}}
      // A write can be raced by another writer (beforeWrite changes the table), fail before it commits (beforeWrite throws,
      // or returns the response the client receives), or commit and lose its response (afterWrite throws, or returns the
      // response the client receives instead).
      if(db.beforeWrite){const f=db.beforeWrite;db.beforeWrite=null;const received=await f(this);if(received)return received}
      let data;
      if(this.op==='insert'){
        // (season, week) is unique: a second insert of a week is refused, never merged.
        if(db.rows.some(r=>r.season===this.row.season&&r.week===this.row.week)){db.affected.push(0);return{data:null,error:{code:'23505',message:'duplicate key value violates unique constraint'}}}
        db.rows.push(storedRow(this.row));data=[{season:this.row.season,week:this.row.week,revision:this.row.revision}];
      }else{
        const hits=db.rows.filter(match);for(const r of hits)Object.assign(r,storedRow(this.row));
        data=hits.map(r=>({season:r.season,week:r.week,revision:r.revision}));
      }
      db.affected.push(data.length);
      if(db.afterWrite){const f=db.afterWrite;db.afterWrite=null;const received=await f(this);if(received)return received}
      return{data,error:null};
    }
  }
  globalThis.__pickemTest={
    document:{getElementById:$},
    fetch:async()=>{if(net.gate)await net.gate.promise;return{ok:true,status:200,json:async()=>structuredClone(scheduleFeed)}},
    neonModule:{createClient:()=>({auth:{getSession:async()=>({data:db.session?{user:db.session,session:{token:'t'}}:null}),signOut:async()=>{db.session=null},emailOtp:{sendVerificationOtp:async()=>({error:null})},signIn:{emailOtp:async()=>({error:null})}},from:table=>new Query(table)})},
    pdfjs:{GlobalWorkerOptions:{},getDocument:({data})=>{const pages=ADMIN_SHEETS[new TextDecoder().decode(data)];return{promise:Promise.resolve({numPages:pages.length,getPage:async n=>({getTextContent:async()=>({items:pages[n-1]})})})}}}
  };
  await import(`data:text/javascript;base64,${Buffer.from(adminPatched+`\n//pickem admin instance ${++adminInstance}`).toString('base64')}`);
  await adminFlush();
  $('season').value='2026';
  return{$,db,net,
    choose:name=>{$('file').files=[new File([name],name,{type:'application/pdf'})];return $('file').dispatch('change')},
    count:value=>{$('totalEntries').value=value;return Promise.all([$('totalEntries').dispatch('input'),$('totalEntries').dispatch('change')])},
    parse:()=>$('parseBtn').dispatch('click'),
    publish:()=>$('publishBtn').dispatch('click'),
    writes:()=>db.log.filter(op=>op!=='select').length};
}
{
  // ADMIN — the entry-count field exists, is an integer input with the tracked-entry floor, and hardcodes no pool size;
  // every element the publisher script touches is present in the page.
  const input=adminHtml.match(/<input id="totalEntries"[^>]*>/);
  assert(input,'Total pool entries input');
  assert.match(input[0],/type="number"/);assert.match(input[0],/min="4"/);assert.match(input[0],/step="1"/);
  assert.match(adminHtml,/<label for="totalEntries">Total pool entries<\/label>/);
  assert.equal(/\b282\b/.test(adminHtml)||/\b282\b/.test(adminSource),false,'no hardcoded pool size');
  for(const [,id] of adminSource.matchAll(/\$\('([A-Za-z]+)'\)/g))assert(adminHtml.includes(`id="${id}"`),`index.html lacks #${id}`);
}
{
  // ADMIN 1/7 — blank count: the tracked parse succeeds, the full field is unavailable with the reason, and tracked-only
  // publication stays possible without any anonymous field.
  const t=await bootAdmin();
  await t.choose('six.pdf');await t.parse();
  assert.equal(t.$('review').hidden,false,t.$('message').textContent);
  assert.match(t.$('message').textContent,new RegExp(`Full-field metrics unavailable — ${COUNT_REQUIRED}`));
  assert.match(t.$('validation').innerHTML,new RegExp(`Full-field metrics unavailable — ${COUNT_REQUIRED}`));
  assert.equal(t.$('publishBtn').disabled,false,'tracked-only publication remains available');
  await t.publish();
  const row=t.db.rows.find(r=>r.week===2);
  assert.equal(row.config.fullFieldReady,false);assert.equal(row.config.fieldEntries,undefined);assert.equal(row.config.participants.length,4);
}
{
  // ADMIN 1b — reading the sheet reads and validates the field itself: a count the field shows without any input event
  // (restored by the browser, say) is the count the read validates and a publish uses.
  const t=await bootAdmin();
  t.$('totalEntries').value='6';await t.choose('six.pdf');await t.parse();
  assert.match(t.$('validation').innerHTML,/Full-field regular Pick'em data validated · 6 entries/);
  assert.equal(t.$('publishBtn').disabled,false);
  await t.publish();
  assert.equal(t.db.rows.find(r=>r.week===2).config.competitionSize,6);
}
{
  // ADMIN 2 — the correct count validates the full field, and the published config carries only the anonymous allowlist.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  assert.match(t.$('message').textContent,/parsed with 6 competition entries/);
  assert.match(t.$('validation').innerHTML,/Full-field regular Pick'em data validated · 6 entries/);
  await t.publish();
  const row=t.db.rows.find(r=>r.week===2);
  assert.equal(row.config.fullFieldReady,true);assert.equal(row.config.competitionSize,6);assert.equal(row.config.fieldEntries.length,2);
  assert.deepEqual(Object.keys(row.config.fieldEntries[0]).sort(),['id','pickNumbers','tiebreak']);
  assert.equal(/Alpha|Beta/.test(JSON.stringify(row.config)),false);
  assert(!Object.keys(row.config).some(k=>/expected|authoritative/i.test(k)),'the count is not persisted');
}
{
  // ADMIN 3 — a wrong count leaves the full field unavailable with the mismatch; the natural-flow summary row is the case.
  const t=await bootAdmin();
  await t.count('5');await t.choose('summary.pdf');await t.parse();
  assert.equal(t.$('review').hidden,false,t.$('message').textContent);
  assert.match(t.$('validation').innerHTML,new RegExp(countMismatch(6,5)));
  assert.match(t.$('message').textContent,new RegExp(countMismatch(6,5)));
  await t.publish();
  const row=t.db.rows.find(r=>r.week===2);
  assert.equal(row.config.fullFieldReady,false);assert.equal(row.config.fieldEntries,undefined);
  // The same sheet where "Winning Picks" is a real entrant: six entries validate.
  const u=await bootAdmin();
  await u.count('6');await u.choose('summary.pdf');await u.parse();
  assert.match(u.$('validation').innerHTML,/Full-field regular Pick'em data validated · 6 entries/);
}
{
  // ADMIN 4 — changing the count after a successful validation invalidates the candidate; publishing needs a new read.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  assert.equal(t.$('publishBtn').disabled,false);
  await t.count('7');
  assert.equal(t.$('review').hidden,true);assert.equal(t.$('publishBtn').disabled,true);
  assert.match(t.$('message').textContent,/Total pool entries changed/);
  await t.publish();
  assert.equal(t.writes(),0,'no publish without revalidation');
  // The closed selector of the old read cannot revive its candidate or its review either.
  await t.$('detectedWeek').onchange?.();
  assert.equal(t.$('review').hidden,true,'the invalidated review stays closed');
  assert.equal(t.$('publishBtn').disabled,true);await t.publish();assert.equal(t.writes(),0);
  await t.parse();
  assert.match(t.$('validation').innerHTML,new RegExp(countMismatch(6,7)));
}
{
  // ADMIN 4b — a count edited without any input event still cannot publish the candidate validated under the old count:
  // the button follows the count on its next render, and a click is refused before any database access.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  t.$('totalEntries').value='5';
  await t.$('detectedWeek').onchange();
  assert.equal(t.$('publishBtn').disabled,true,'the re-rendered button follows the current count');
  await t.publish();
  assert.deepEqual(t.db.log,[],'refused before any database access');
  assert.equal(t.$('message').textContent,'The selected file changed or is no longer validated. Read and validate it again before publishing.');
}
{
  // ADMIN 4c — publication inputs are frozen when the publish starts. A count edit while the publish is reading the
  // database is rejected, not accepted: the field shows the validated count again at once, the publish snapshot stays
  // valid, and the frozen count-6 snapshot publishes.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  const gate=adminDeferred();t.db.readGate=gate;
  const pending=t.publish();await adminFlush();
  assert.equal(t.db.readGate,null,'the publish is waiting on its database read');
  for(const type of ['input','change']){
    t.$('totalEntries').value='7';await t.$('totalEntries').dispatch(type);
    assert.equal(t.$('totalEntries').value,'6',`${type}: the rejected edit does not stay on screen`);
    assert.equal(t.$('message').textContent,PUBLISH_FROZEN,type);
    assert.equal(t.$('review').hidden,false,`${type}: the publish snapshot is not invalidated`);
  }
  gate.resolve();await pending;await adminFlush();
  assert.equal(t.writes(),1,'the frozen snapshot publishes');
  const row=t.db.rows.find(r=>r.week===2);
  assert.equal(row.config.fullFieldReady,true);assert.equal(row.config.competitionSize,6);
  assert.match(t.$('message').textContent,/Week 2 published and locked successfully/);
}
{
  // ADMIN 4d — a count change while a read is still verifying the schedule discards that read.
  const t=await bootAdmin();
  t.net.gate=adminDeferred();await t.count('6');await t.choose('six.pdf');
  const pending=t.parse();await adminFlush();
  await t.count('7');
  t.net.gate.resolve();await pending;await adminFlush();
  assert.equal(t.$('review').hidden,true,'stale read discarded');assert.equal(t.$('publishBtn').disabled,true);
  assert.equal(t.$('message').className,'notice info','the stale read ends quietly, not in an error');
  assert.match(t.$('message').textContent,/Total pool entries changed/);
  await t.publish();assert.equal(t.writes(),0);
}
{
  // ADMIN 4e — the independent review's race. The insert is dispatched and held, then the count is edited to 7 by an
  // input event and by a change event. A browser cannot cancel a dispatched write, so it is the edit that is refused: the
  // field shows the frozen count again at once while the publish is still running, and the held write commits exactly
  // the validated count-6 configuration. Once the publish has finished, the same edit is accepted and needs a new read.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  const gate=adminDeferred();t.db.writeGate=gate;
  const pending=t.publish();await adminUntil(()=>t.db.writeGate===null,'the publish dispatches its write');
  assert.equal(t.db.rows.length,0,'the dispatched write is held');
  for(const type of ['input','change']){
    t.$('totalEntries').value='7';await t.$('totalEntries').dispatch(type);
    assert.equal(t.$('totalEntries').value,'6',`${type}: the field is restored to the frozen count`);
    assert.equal(t.$('message').textContent,PUBLISH_FROZEN,type);
    assert.equal(t.$('busy').hidden,false,`${type}: the publish is still running`);assert.equal(t.$('totalEntries').disabled,true,type);
    assert.equal(t.$('review').hidden,false,`${type}: the publish snapshot is not invalidated`);
    assert.equal(t.db.rows.length,0,type);
  }
  gate.resolve();await pending;await adminFlush();
  assert.equal(t.writes(),1);assert.equal(t.db.rows.length,1,'exactly one row');
  const [row]=t.db.rows;
  assert.equal(row.config.fullFieldReady,true);assert.equal(row.config.competitionSize,6);assert.equal(row.config.fieldEntries.length,2);
  assert.match(t.$('message').textContent,/Week 2 published and locked successfully/);
  assert.equal(t.$('totalEntries').value,'6');assert.equal(t.$('totalEntries').disabled,false,'editable again');
  assert.equal(t.$('publishBtn').disabled,false,'the candidate is still the one validated at 6');
  await t.count('7');
  assert.equal(t.$('review').hidden,true);assert.equal(t.$('publishBtn').disabled,true);
  assert.match(t.$('message').textContent,/Total pool entries changed/);
  await t.publish();assert.equal(t.writes(),1,'no publish without revalidation');
  await t.parse();
  assert.match(t.$('validation').innerHTML,new RegExp(countMismatch(6,7)));
}
{
  // ADMIN 4f — a raw value change with no event while the write is held is not an edit the publisher accepted: the frozen
  // count-6 snapshot publishes, and the field is synchronized back to the authoritative count when the publish ends. A
  // real edit afterwards is accepted normally.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  const gate=adminDeferred();t.db.writeGate=gate;
  const pending=t.publish();await adminUntil(()=>t.db.writeGate===null,'the publish dispatches its write');
  t.$('totalEntries').value='7';
  gate.resolve();await pending;await adminFlush();
  assert.equal(t.db.rows.length,1);assert.equal(t.db.rows[0].config.competitionSize,6);
  assert.match(t.$('message').textContent,/Week 2 published and locked successfully/);
  assert.equal(t.$('totalEntries').value,'6','the field shows the authoritative count again');
  assert.equal(t.$('publishBtn').disabled,false);
  await t.count('7');
  assert.equal(t.$('review').hidden,true);assert.equal(t.$('publishBtn').disabled,true);
}
{
  // ADMIN 4g — the publish's own checks compare its snapshot with application state, never with the field: a raw value
  // change while the publish reads the database does not redefine the publish, which completes at the frozen count.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  const gate=adminDeferred();t.db.readGate=gate;
  const pending=t.publish();await adminFlush();
  assert.equal(t.db.readGate,null,'the publish is waiting on its database read');
  t.$('totalEntries').value='7';
  gate.resolve();await pending;await adminFlush();
  assert.equal(t.writes(),1,'the frozen snapshot publishes');assert.equal(t.db.rows[0].config.competitionSize,6);
  assert.equal(t.$('totalEntries').value,'6');
}
{
  // ADMIN 4h — the same freeze for a tracked-only publish validated with a blank count. An edit to 282 while the write is
  // held is rejected and the field is blank again; the frozen count stays blank and the tracked-only snapshot publishes.
  // Afterwards 282 is accepted normally and needs a new read.
  const t=await bootAdmin();
  await t.choose('six.pdf');await t.parse();
  const gate=adminDeferred();t.db.writeGate=gate;
  const pending=t.publish();await adminUntil(()=>t.db.writeGate===null,'the publish dispatches its write');
  t.$('totalEntries').value='282';await t.$('totalEntries').dispatch('input');
  assert.equal(t.$('totalEntries').value,'','the field is blank again');
  assert.equal(t.$('message').textContent,PUBLISH_FROZEN);
  gate.resolve();await pending;await adminFlush();
  assert.equal(t.db.rows.length,1);
  const [row]=t.db.rows;
  assert.equal(row.config.fullFieldReady,false);assert.equal(row.config.fieldEntries,undefined);assert.equal(row.config.participants.length,4);
  assert.equal(t.$('totalEntries').value,'');assert.equal(t.$('publishBtn').disabled,false,'the candidate is still the one validated blank');
  await t.count('282');
  assert.equal(t.$('review').hidden,true);assert.equal(t.$('publishBtn').disabled,true);
  await t.parse();
  assert.match(t.$('validation').innerHTML,new RegExp(countMismatch(6,282)));
}
{
  // ADMIN 4i — the pre-write checks still refuse a publish whose validated context is invalidated before its write is
  // dispatched: a season change event while the publish reads the database leaves nothing written.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  const gate=adminDeferred();t.db.readGate=gate;
  const pending=t.publish();await adminFlush();
  assert.equal(t.db.readGate,null,'the publish is waiting on its database read');
  t.$('season').value='2025';await t.$('season').dispatch('change');
  gate.resolve();await pending;await adminFlush();
  assert.equal(t.writes(),0,'in-flight publish aborted before any write');
  assert.match(t.$('message').textContent,/changed before publishing completed/);
}
{
  // ADMIN 4j — no path changes the frozen count while a publish is in flight, not even a read of the sheet started then
  // (its button is disabled): the held write commits the validated count 6, and the field and the review show 6.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  const gate=adminDeferred();t.db.writeGate=gate;
  const pending=t.publish();await adminUntil(()=>t.db.writeGate===null,'the publish dispatches its write');
  t.$('totalEntries').value='7';const read=t.parse();
  gate.resolve();await pending;await read;await adminFlush();
  assert.equal(t.db.rows.length,1);assert.equal(t.db.rows[0].config.competitionSize,6);
  assert.equal(t.$('totalEntries').value,'6','the field shows the frozen count');
  assert.match(t.$('validation').innerHTML,/Full-field regular Pick'em data validated · 6 entries/);
}
{
  // ADMIN 4k — one publish at a time, enforced by the Publish handler itself. While publish A waits on its database read,
  // or has its insert, or its update of a locked week, dispatched and held, publish B invokes the registered listener
  // directly, as script can although the button is disabled. B returns at once, so the freeze holds until A ends; and when
  // A's finally lifts it, no second publish is left running behind it: an edit accepted from then on stands, and exactly
  // one read and one write of the validated snapshot, with one revision, ever reach the database.
  for(const [gate,replace] of [['readGate',false],['writeGate',false],['readGate',true],['writeGate',true]]){
    const write=replace?'update':'insert',revision=replace?2:1,label=`${write}, A held at ${gate}`;
    const t=await bootAdmin();
    await t.count('6');await t.choose('six.pdf');await t.parse();
    if(replace){await t.publish();t.$('replaceLocked').checked=true;t.db.dispatched.length=0;t.db.log.length=0}
    const heldA=adminDeferred();t.db[gate]=heldA;
    const a=t.publish();await adminUntil(()=>t.db[gate]===null,`${label}: A is held`);
    assert.equal(t.$('publishBtn').disabled,true,`${label}: the button is disabled, so it is not what refuses B`);
    const heldB=adminDeferred();t.db[gate]=heldB;
    let bDone=false;const b=t.publish().then(()=>{bDone=true});await adminFlush();
    const bReturnedAtOnce=bDone;
    // A is still running, so everything stays frozen: the controls, a count edit, a file change and the candidate.
    assert.equal(t.$('busy').hidden,false,label);
    for(const id of ['parseBtn','publishBtn','file','season','totalEntries','detectedWeek','tiebreakGame','replaceLocked'])assert.equal(t.$(id).disabled,true,`${label}: #${id}`);
    t.$('totalEntries').value='7';await t.$('totalEntries').dispatch('input');
    assert.equal(t.$('totalEntries').value,'6',label);assert.equal(t.$('message').textContent,PUBLISH_FROZEN,label);
    await t.choose('summary.pdf');
    assert.equal(t.$('message').textContent,FILE_FROZEN,label);assert.match(t.$('fileName').textContent,/^six\.pdf /,label);
    assert.equal(t.$('review').hidden,false,label);
    // A ends normally, and only now is the freeze lifted.
    heldA.resolve();await a;await adminFlush();
    assert.equal(t.$('message').textContent,`Week 2 published and locked successfully. Revision ${revision}.`,label);
    assert.equal(t.$('busy').hidden,true,label);assert.equal(t.$('file').disabled,false,label);assert.equal(t.$('totalEntries').disabled,false,label);
    // The lift is not early: a count edit is accepted, and nothing is still publishing that could overtake it.
    await t.count('7');
    assert.equal(t.$('message').textContent,'Total pool entries changed. Read the weekly sheet again.',label);
    assert.equal(bDone,true,`${label}: no second publish is still running behind the lifted freeze`);
    assert.equal(bReturnedAtOnce,true,`${label}: B returned at once`);
    assert.equal(t.db[gate],heldB,`${label}: B never reached the database`);t.db[gate]=null;
    assert.deepEqual(t.db.dispatched,['select',write],`${label}: one read and one ${write}, both A's`);
    heldB.resolve();await b;await adminFlush();
    assert.deepEqual(t.db.log,['select',write],label);
    assert.equal(t.db.rows.length,1,label);assert.equal(t.db.rows[0].revision,revision,label);assert.equal(t.db.rows[0].config.competitionSize,6,label);
    assert.equal(t.$('message').textContent,'Total pool entries changed. Read the weekly sheet again.',`${label}: no late publish result`);
  }
}
{
  // ADMIN 4l — a refused publish is silent in any state: it shows no message, clears none and invalidates nothing. Publish
  // A has its insert dispatched and held; B arrives after a rejected count edit, after a season change has invalidated the
  // candidate, and after sign-out. The guard precedes the handler's own sign-in and validation checks, so neither runs.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  const gate=adminDeferred();t.db.writeGate=gate;
  const a=t.publish();await adminUntil(()=>t.db.writeGate===null,'the publish dispatches its write');
  const refused=async(change,shown)=>{await change();assert.equal(t.$('message').textContent,shown);await t.publish();assert.equal(t.$('message').textContent,shown,`B left "${shown}" alone`)};
  await refused(async()=>{t.$('totalEntries').value='7';await t.$('totalEntries').dispatch('input')},PUBLISH_FROZEN);
  await refused(async()=>{t.$('season').value='2025';await t.$('season').dispatch('change')},'Season changed. Read the weekly sheet again.');
  await refused(()=>t.$('signOut').dispatch('click'),'Signed out.');
  assert.deepEqual(t.db.dispatched,['select','insert'],'no refused publish reached the database');
  gate.resolve();await a;await adminFlush();
  assert.deepEqual(t.db.log,['select','insert']);assert.equal(t.db.rows.length,1);
}
{
  // ADMIN 5/6 — changing the file or the season still invalidates the candidate.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  await t.choose('summary.pdf');
  assert.equal(t.$('review').hidden,true);assert.equal(t.$('publishBtn').disabled,true);
  await t.choose('six.pdf');await t.parse();
  t.$('season').value='2025';await t.$('season').dispatch('change');
  assert.equal(t.$('review').hidden,true);assert.equal(t.$('publishBtn').disabled,true);
  t.$('season').value='2026';await t.publish();assert.equal(t.writes(),0);
}
{
  // ADMIN — a malformed count is an explicit validation error and produces no candidate.
  for(const bad of ['3','2.5','-6','1e3','six']){
    const t=await bootAdmin();
    await t.count(bad);await t.choose('six.pdf');await t.parse();
    assert.equal(t.$('review').hidden,true,bad);
    assert.equal(t.$('message').className,'notice error',bad);
    assert.match(t.$('message').textContent,/Total pool entries must be a whole number of at least 4/,bad);
  }
  const t=await bootAdmin();
  t.$('totalEntries').validity={badInput:true};await t.count('');await t.choose('six.pdf');await t.parse();
  assert.match(t.$('message').textContent,/Total pool entries must be a whole number of at least 4/,'unparseable number input');
}
{
  // ADMIN — a multi-week file: the entered count is asserted for every week; choosing another week keeps it.
  const t=await bootAdmin();
  await t.count('6');await t.choose('weeks.pdf');await t.parse();
  assert.equal(t.$('weekChoice').hidden,false);
  assert.match(t.$('validation').innerHTML,new RegExp(countMismatch(5,6)),'week 3 has five entries');
  t.$('detectedWeek').value='2';await t.$('detectedWeek').onchange();
  assert.match(t.$('validation').innerHTML,/Full-field regular Pick'em data validated · 6 entries/);
  await t.publish();
  const row=t.db.rows.find(r=>r.week===2);
  assert.equal(row.config.fullFieldReady,true);assert.equal(row.config.fieldEntries.length,2);
}

// ---------------------------------------------------------------------------------------------------------------------
// Pick'em publication write integrity: compare-and-swap replacement across pages, the insert uniqueness boundary, exact
// write confirmation, and read-back of writes whose response was lost.
const sheetDigest=name=>createHash('sha256').update(name).digest('hex');
// Week 2 as an earlier publish stored it.
const lockedWeek2=(revision,source_sha256='earlier-sheet',updated_at='2026-09-10T12:00:00.000Z')=>({season:2026,week:2,status:'locked',config:{season:2026,week:2,source:{kind:'weekly-upload',filename:'earlier.pdf',sha256:source_sha256}},source_filename:'earlier.pdf',source_sha256,revision,published_at:updated_at,locked_at:updated_at,updated_at});
const STALE=revision=>`Publish failed: Week 2 changed before this write (no row matched revision ${revision}). Nothing from this stale attempt was written. Read and validate the sheet again before publishing.`;
const CONFIRMED_BY_READ_BACK=' Success confirmed by read-back after the database response was lost or incomplete.';
const NOT_VALIDATED='The selected file changed or is no longer validated. Read and validate it again before publishing.';
// The page has dropped its validated candidate and its replace confirmation: a publish is refused before the database.
async function assertRevalidationRequired(t,label){
  assert.equal(t.$('review').hidden,true,label);assert.equal(t.$('publishBtn').disabled,true,label);assert.equal(t.$('replaceLocked').checked,false,label);
  const dispatched=t.db.dispatched.length;await t.publish();
  assert.equal(t.db.dispatched.length,dispatched,`${label}: a new publish is refused before any database access`);
  assert.equal(t.$('message').textContent,NOT_VALIDATED,label);
}
const NOT_CONFIRMED=revision=>`Publish not confirmed: Failed to fetch. Read-back does not show this attempt's write: Week 2 is at revision ${revision}. Nothing was retried. Read and validate the sheet again before publishing.`;
// The JSON a write sends for a value.
const sent=v=>JSON.parse(JSON.stringify(v));
// The same JSON with the keys of every object in reverse order; arrays keep their order.
const reverseKeys=v=>Array.isArray(v)?v.map(reverseKeys):v!==null&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reverseKeys(v[k])])):v;
// Every Admin page reads the clock at `iso` while `run` is in progress, as pages publishing in the same millisecond do.
async function atInstant(iso,run){
  const RealDate=Date,at=RealDate.parse(iso);
  globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[at]))}static now(){return at}};
  try{await run()}finally{globalThis.Date=RealDate}
}
{
  // ADMIN 7a — CROSS-SESSION STALE REPLACEMENT. Two Admin pages share one database in which Week 2 is locked at revision 3.
  // Page A validates a count-6 correction of six.pdf and page B a tracked-only correction of summary.pdf, and both
  // publishes read revision 3 before either replacement commits. A commits revision 4 first. B's replacement, predicated
  // on the revision 3 it read, then matches no row: A's correction stays exactly as stored, B reports the conflict and not
  // success, and B must read and validate again, and confirm the replacement again, before it can replace revision 4.
  const table=[lockedWeek2(3)];
  const a=await bootAdmin({rows:table}),b=await bootAdmin({rows:table});
  await a.count('6');await a.choose('six.pdf');await a.parse();a.$('replaceLocked').checked=true;
  await b.choose('summary.pdf');await b.parse();b.$('replaceLocked').checked=true;
  assert.notEqual(sheetDigest('six.pdf'),sheetDigest('summary.pdf'));
  const heldA=adminDeferred(),heldB=adminDeferred();a.db.writeGate=heldA;b.db.writeGate=heldB;
  const pa=a.publish();await adminUntil(()=>a.db.writeGate===null,'A dispatches its replacement');
  const pb=b.publish();await adminUntil(()=>b.db.writeGate===null,'B dispatches its replacement');
  assert.deepEqual([a.db.log,b.db.log],[['select'],['select']],'both pages read Week 2 before either replacement commits');
  assert.deepEqual([a.db.dispatched,b.db.dispatched],[['select','update'],['select','update']]);
  assert.deepEqual(table,[lockedWeek2(3)]);
  heldA.resolve();await pa;await adminFlush();
  assert.equal(a.$('message').textContent,'Week 2 published and locked successfully. Revision 4.');
  const corrected=structuredClone(table[0]);
  assert.equal(corrected.revision,4);assert.equal(corrected.source_sha256,sheetDigest('six.pdf'));assert.equal(corrected.config.competitionSize,6);
  heldB.resolve();await pb;await adminFlush();
  assert.deepEqual(b.db.affected,[0],'B\'s compare-and-swap matched no row');
  assert.deepEqual(table,[corrected],'A\'s correction is the only revision 4, and B did not overwrite it');
  assert.equal(b.$('message').className,'notice error');assert.equal(b.$('message').textContent,STALE(3));
  assert.equal(b.$('publishResult').hidden,true,'B shows no publication result');
  await assertRevalidationRequired(b,'B after its stale replacement');
  assert.deepEqual(table,[corrected]);
  // After a fresh read, replacing A's correction is a new, deliberate replacement of revision 4.
  await b.parse();assert.equal(b.$('publishBtn').disabled,false);
  await b.publish();assert.match(b.$('message').textContent,/Week 2 is already locked/);assert.deepEqual(table,[corrected]);
  b.$('replaceLocked').checked=true;await b.publish();
  assert.equal(b.$('message').textContent,'Week 2 published and locked successfully. Revision 5.');
  assert.equal(table.length,1);assert.equal(table[0].revision,5);assert.equal(table[0].source_sha256,sheetDigest('summary.pdf'));
}
{
  // ADMIN 7b — NEW WEEK INSERT RACE. Both pages find no Week 2 and insert it; A's insert commits first. B's insert is
  // refused by the unique season/week key and never merged into A's row: A's week stays as stored, B reports that another
  // publish created the week first and that nothing from its attempt was written, and B must read and validate again.
  const table=[];
  const a=await bootAdmin({rows:table}),b=await bootAdmin({rows:table});
  await a.count('6');await a.choose('six.pdf');await a.parse();
  await b.choose('summary.pdf');await b.parse();
  const heldA=adminDeferred(),heldB=adminDeferred();a.db.writeGate=heldA;b.db.writeGate=heldB;
  const pa=a.publish();await adminUntil(()=>a.db.writeGate===null,'A dispatches its insert');
  const pb=b.publish();await adminUntil(()=>b.db.writeGate===null,'B dispatches its insert');
  heldA.resolve();await pa;await adminFlush();
  assert.equal(a.$('message').textContent,'Week 2 published and locked successfully. Revision 1.');
  const created=structuredClone(table);
  heldB.resolve();await pb;await adminFlush();
  assert.deepEqual(b.db.affected,[0]);assert.deepEqual(table,created);
  assert.equal(table.length,1);assert.equal(table[0].source_sha256,sheetDigest('six.pdf'));
  assert.equal(b.$('message').textContent,'Publish failed: another publish created Week 2 before this write (duplicate key value violates unique constraint). Nothing from this attempt was written. Read and validate the sheet again before publishing.');
  assert.deepEqual(b.db.log,['select','insert'],'a refused insert is neither read back nor retried');
  await assertRevalidationRequired(b,'B after its refused insert');
  assert.deepEqual(table,created);
}
{
  // ADMIN 7c — TRUE STALE COMPARE-AND-SWAP FAILURE. After this page reads revision 3 and before its replacement runs,
  // another writer replaces Week 2 with revision 4. The replacement, predicated on revision 3, affects no row; revision 4
  // stays exactly as that writer stored it; the conflict is reported, never success; and a fresh validation is required.
  const table=[lockedWeek2(3)],t=await bootAdmin({rows:table});
  await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=true;
  const theirs=lockedWeek2(4,'their-sheet','2026-09-24T09:00:00.000Z');
  t.db.beforeWrite=()=>{table[0]=structuredClone(theirs)};
  await t.publish();await adminFlush();
  assert.deepEqual(t.db.log,['select','update']);assert.deepEqual(t.db.affected,[0]);
  assert.deepEqual(table,[theirs]);
  assert.equal(t.$('message').className,'notice error');assert.equal(t.$('message').textContent,STALE(3));
  await assertRevalidationRequired(t,'after the stale replacement');
  assert.deepEqual(table,[theirs]);
}
{
  // ADMIN 7d — LOST RESPONSE AFTER A COMMITTED INSERT. Week 2 is new. The insert commits and its response is lost: the
  // client throws, or returns a network error. The page stays frozen while it reads Week 2 back; the read-back finds
  // exactly this attempt (revision 1 with this file's digest and this write's timestamp), so the publication is reported
  // as successful, confirmed by read-back. Nothing is written again, then or by a later Publish.
  const lost=[['thrown',()=>{throw new TypeError('Failed to fetch')}],['returned',()=>({data:null,error:{message:'FetchError: Failed to fetch',code:''}})]];
  for(const [how,lose] of lost){
    const t=await bootAdmin();
    await t.count('6');await t.choose('six.pdf');await t.parse();
    const readBack=adminDeferred();t.db.afterWrite=()=>{t.db.readGate=readBack;return lose()};
    const pending=t.publish();await adminUntil(()=>t.db.dispatched.length===3,`${how}: the read-back is dispatched`);
    assert.deepEqual(t.db.dispatched,['select','insert','select'],how);
    assert.equal(t.db.readGate,null,`${how}: the read-back holds the gate`);assert.deepEqual(t.db.log,['select','insert'],`${how}: the read-back is still held`);
    assert.equal(t.$('busy').hidden,false,how);
    for(const id of ['parseBtn','publishBtn','file','season','totalEntries','detectedWeek','tiebreakGame','replaceLocked'])assert.equal(t.$(id).disabled,true,`${how}: #${id}`);
    await t.publish();assert.deepEqual(t.db.dispatched,['select','insert','select'],`${how}: no second publish during the read-back`);
    t.$('totalEntries').value='7';await t.$('totalEntries').dispatch('input');
    assert.equal(t.$('totalEntries').value,'6',how);assert.equal(t.$('message').textContent,PUBLISH_FROZEN,how);
    readBack.resolve();await pending;await adminFlush();
    assert.equal(t.db.rows.length,1,how);const [row]=t.db.rows;
    assert.equal(row.revision,1,how);assert.equal(row.source_sha256,sheetDigest('six.pdf'),how);assert.equal(row.config.competitionSize,6,how);
    assert.equal(t.$('message').className,'notice success',how);
    assert.equal(t.$('message').textContent,`Week 2 published and locked successfully. Revision 1.${CONFIRMED_BY_READ_BACK}`,how);
    assert.equal(t.$('publishResult').hidden,false,how);assert.equal(t.$('busy').hidden,true,how);
    const landed=structuredClone(row);await t.publish();await adminFlush();
    assert.match(t.$('message').textContent,/Week 2 is already locked/,how);
    assert.equal(t.writes(),1,`${how}: the landed insert is never written again`);assert.deepEqual(t.db.rows,[landed],how);
  }
}
{
  // ADMIN 7e — LOST RESPONSE AFTER A COMMITTED REPLACEMENT. From revision 3, the compare-and-swap replacement commits
  // revision 4 and its response is lost. The read-back proves revision 4 carries this attempt's digest and timestamp, so
  // the replacement is reported as successful, and the lost response never produces a revision 5: not from the publish
  // itself, and not from publishing again.
  const table=[lockedWeek2(3)],t=await bootAdmin({rows:table});
  await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=true;
  t.db.afterWrite=()=>{throw new TypeError('Failed to fetch')};
  await t.publish();await adminFlush();
  assert.deepEqual(t.db.log,['select','update','select']);assert.deepEqual(t.db.affected,[1]);
  assert.equal(table.length,1);assert.equal(table[0].revision,4);assert.equal(table[0].source_sha256,sheetDigest('six.pdf'));assert.equal(table[0].config.competitionSize,6);
  assert.equal(t.$('message').textContent,`Week 2 published and locked successfully. Revision 4.${CONFIRMED_BY_READ_BACK}`);
  assert.equal(t.$('replaceLocked').checked,false,'the replace confirmation is spent, as after any successful replacement');
  const landed=structuredClone(table[0]);await t.publish();await adminFlush();
  assert.match(t.$('message').textContent,/Week 2 is already locked/);
  assert.equal(t.writes(),1,'no revision 5');assert.deepEqual(table,[landed]);
}
{
  // ADMIN 7f — AMBIGUOUS FOREIGN ROW. The write fails with an exception and the read-back shows a Week 2 that does not
  // prove this attempt landed: another writer's revision 4 (from another sheet, or even from this same sheet written at
  // another time), a later revision 5, another writer's new week, or a row that differs from this attempt's write in any
  // one of revision, digest, timestamp or locked status. Success is never reported, nothing is retried, the row found is
  // left alone, and the page must read and validate again. `found` receives the attempted row.
  const other='2026-09-24T09:00:00.000Z',six=sheetDigest('six.pdf');
  const cases=[
    ['another sheet at the target revision',lockedWeek2(3),()=>lockedWeek2(4,'their-sheet',other)],
    ['this same sheet written by another publish',lockedWeek2(3),()=>lockedWeek2(4,six,other)],
    ['another sheet written at the same instant',lockedWeek2(3),mine=>lockedWeek2(4,'their-sheet',mine.updated_at)],
    ['this sheet and instant at another revision',lockedWeek2(3),mine=>lockedWeek2(5,six,mine.updated_at)],
    ['this attempt\'s write no longer locked',lockedWeek2(3),mine=>({...lockedWeek2(4,six,mine.updated_at),status:'draft'})],
    ['a later revision',lockedWeek2(3),()=>lockedWeek2(5,'their-sheet',other)],
    ['another writer\'s new week',null,()=>lockedWeek2(1,'their-sheet',other)]
  ];
  for(const [label,before,foreign] of cases){
    const table=before?[before]:[],t=await bootAdmin({rows:table});
    await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=!!before;
    let found;
    t.db.beforeWrite=q=>{found=foreign(q.row);table.splice(0,table.length,structuredClone(found));throw new TypeError('Failed to fetch')};
    await t.publish();await adminFlush();
    assert.deepEqual(t.db.log,['select',before?'update':'insert','select'],`${label}: one write and one read-back, no retry`);
    assert.deepEqual(t.db.affected,[],`${label}: this attempt's write never committed`);
    assert.deepEqual(table,[found],`${label}: the row found is left alone`);
    assert.equal(t.$('message').className,'notice error',label);
    assert.equal(t.$('message').textContent,`Publish not confirmed: Failed to fetch. Read-back does not show this attempt's write: Week 2 is at revision ${found.revision}. Nothing was retried. Read and validate the sheet again before publishing.`,label);
    assert.equal(t.$('publishResult').hidden,true,label);
    await assertRevalidationRequired(t,label);
    assert.deepEqual(table,[found],label);
  }
}
{
  // ADMIN 7g — PROVEN NOT LANDED. The write fails before it commits, and the read-back shows Week 2 exactly as this publish
  // read it: still revision 3, or still unpublished. Nothing was written, so the still-validated page may retry, and the
  // retry replaces or creates the week once.
  for(const before of [lockedWeek2(3),null]){
    const label=before?'replacement':'new week',table=before?[structuredClone(before)]:[],t=await bootAdmin({rows:table});
    await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=!!before;
    t.db.beforeWrite=()=>{throw new TypeError('Failed to fetch')};
    await t.publish();await adminFlush();
    assert.deepEqual(t.db.log,['select',before?'update':'insert','select'],label);
    assert.deepEqual(table,before?[before]:[],label);
    assert.equal(t.$('message').className,'notice error',label);
    assert.equal(t.$('message').textContent,`Publish failed: Failed to fetch. Read-back shows Week 2 ${before?'still at revision 3':'still unpublished'}, so this attempt wrote nothing. You can retry Publish.`,label);
    assert.equal(t.$('review').hidden,false,label);assert.equal(t.$('publishBtn').disabled,false,`${label}: the validated page may retry`);
    assert.equal(t.$('replaceLocked').checked,!!before,`${label}: the replace confirmation still applies`);
    await t.publish();await adminFlush();
    const revision=before?4:1;
    assert.equal(t.$('message').textContent,`Week 2 published and locked successfully. Revision ${revision}.`,label);
    assert.equal(table.length,1,label);assert.equal(table[0].revision,revision,label);assert.equal(table[0].source_sha256,sheetDigest('six.pdf'),label);
    assert.deepEqual(t.db.affected,[1],`${label}: written once`);
  }
  // A LATE COMMIT. The read-back shows the week unchanged, but the write it could not see yet commits afterwards. The retry
  // checks that attempt first, finds it written as exactly this configuration, and writes nothing more.
  for(const before of [lockedWeek2(3),null]){
    const label=`late ${before?'replacement':'new week'}`,table=before?[structuredClone(before)]:[],t=await bootAdmin({rows:table});
    await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=!!before;
    let late;t.db.beforeWrite=q=>{late=structuredClone(q.row);throw new TypeError('Failed to fetch')};
    await t.publish();await adminFlush();
    assert.match(t.$('message').textContent,/so this attempt wrote nothing\. You can retry Publish\.$/,label);
    table.splice(0,table.length,{...(before||{}),...late});
    const landed=structuredClone(table);
    await t.publish();await adminFlush();
    assert.equal(t.$('message').className,'notice success',label);
    assert.equal(t.$('message').textContent,`Week 2 published and locked successfully. Revision ${before?4:1}. The earlier attempt of this publication had been written after all, so nothing new was written.`,label);
    assert.deepEqual(t.db.log,['select',before?'update':'insert','select','select'],`${label}: the retry only reads`);
    assert.deepEqual(table,landed,label);
  }
}
{
  // ADMIN 7h — UNKNOWN OUTCOME. A replacement's write response is lost and the read-back fails too. Nothing is retried or
  // reported as success, and the page must read and validate again. The next publish of Week 2 first checks the attempt
  // it could not confirm: if that attempt landed as exactly this configuration, this is reported instead of writing a
  // duplicate revision; if it never landed, or another configuration is being published, the new write goes ahead.
  const UNKNOWN='Publish outcome unknown: Failed to fetch. Week 2 could not be read back (offline), so nothing was retried. Read and validate the sheet again; the next publish of this week checks whether this attempt was written before writing anything.';
  const unknownOutcome=async committed=>{
    const table=[lockedWeek2(3)],t=await bootAdmin({rows:table});
    await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=true;
    t.db[committed?'afterWrite':'beforeWrite']=()=>{t.db.readFail=new TypeError('offline');throw new TypeError('Failed to fetch')};
    await t.publish();await adminFlush();
    assert.deepEqual(t.db.log,['select','update','select']);
    assert.equal(t.$('message').className,'notice error');assert.equal(t.$('message').textContent,UNKNOWN);
    await assertRevalidationRequired(t,'after the unknown outcome');
    assert.equal(table[0].revision,committed?4:3);
    return{table,t};
  };
  {
    // The attempt had landed; the same configuration is validated and published again.
    const {table,t}=await unknownOutcome(true),landed=structuredClone(table[0]);
    await t.parse();t.$('replaceLocked').checked=true;await t.publish();await adminFlush();
    assert.equal(t.$('message').className,'notice success');
    assert.equal(t.$('message').textContent,'Week 2 published and locked successfully. Revision 4. The earlier attempt of this publication had been written after all, so nothing new was written.');
    assert.equal(t.writes(),1,'no duplicate revision 5');assert.deepEqual(table,[landed]);
    assert.equal(t.$('replaceLocked').checked,false);
    await t.publish();assert.match(t.$('message').textContent,/Week 2 is already locked/);assert.equal(t.writes(),1);
  }
  {
    // The attempt had not landed; publishing the same configuration writes it, never reporting a false earlier write.
    const {table,t}=await unknownOutcome(false);
    await t.parse();t.$('replaceLocked').checked=true;await t.publish();await adminFlush();
    assert.equal(t.$('message').textContent,'Week 2 published and locked successfully. Revision 4.');
    assert.equal(t.writes(),2);assert.equal(table.length,1);assert.equal(table[0].revision,4);assert.equal(table[0].source_sha256,sheetDigest('six.pdf'));
  }
  {
    // The attempt had landed; another configuration of the sheet (tracked-only) is a real replacement of revision 4.
    const {table,t}=await unknownOutcome(true);
    await t.count('');await t.parse();t.$('replaceLocked').checked=true;await t.publish();await adminFlush();
    assert.equal(t.$('message').textContent,'Week 2 published and locked successfully. Revision 5.');
    assert.equal(t.writes(),2);assert.equal(table.length,1);assert.equal(table[0].revision,5);assert.equal(table[0].config.fullFieldReady,false);
  }
}
{
  // ADMIN 7i — EXACT WRITE CONFIRMATION. A write whose response does not confirm exactly one row with this season, week
  // and revision (no data, no rows from an insert, two rows, another revision) is never a normal success, whether or not
  // the write committed: a read-back decides it.
  const cases=[
    ['insert answered with no data',null,{data:null,error:null}],
    ['insert answered with no rows',null,{data:[],error:null}],
    ['update answered with two rows',lockedWeek2(3),{data:[{season:2026,week:2,revision:4},{season:2026,week:2,revision:4}],error:null}],
    ['update answered with another revision',lockedWeek2(3),{data:[{season:2026,week:2,revision:3}],error:null}]
  ];
  for(const [label,before,answer] of cases)for(const committed of [true,false]){
    const name=`${label}, ${committed?'committed':'not committed'}`,table=before?[structuredClone(before)]:[],t=await bootAdmin({rows:table});
    await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=!!before;
    t.db[committed?'afterWrite':'beforeWrite']=()=>structuredClone(answer);
    await t.publish();await adminFlush();
    assert.deepEqual(t.db.log,['select',before?'update':'insert','select'],`${name}: decided by a read-back`);
    const revision=before?4:1;
    if(committed){
      assert.equal(t.$('message').textContent,`Week 2 published and locked successfully. Revision ${revision}.${CONFIRMED_BY_READ_BACK}`,name);
      assert.equal(table.length,1,name);assert.equal(table[0].revision,revision,name);
    }else{
      assert.equal(t.$('message').textContent,`Publish failed: The database did not confirm exactly one written Pick'em week. Read-back shows Week 2 ${before?'still at revision 3':'still unpublished'}, so this attempt wrote nothing. You can retry Publish.`,name);
      assert.deepEqual(table,before?[before]:[],name);
    }
  }
}
{
  // ADMIN 7j — the revision is the concurrency token: an existing week without a valid revision is never replaced blind.
  for(const revision of [null,0,'3',3.5]){
    const table=[{...lockedWeek2(3),revision}],t=await bootAdmin({rows:table});
    await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=true;
    await t.publish();await adminFlush();
    assert.deepEqual(t.db.log,['select'],`revision ${revision}: nothing is written`);
    assert.equal(t.$('message').textContent,'Week 2 has an unexpected revision value. Nothing was written.',`revision ${revision}`);
    assert.deepEqual(table,[{...lockedWeek2(3),revision}]);
  }
}
{
  // ADMIN 7k — SAME FILE, SAME REVISION, SAME INSTANT, ANOTHER CONFIGURATION. Pages A and B publish Week 2 from the same
  // six.pdf, so their writes carry the same digest, in the same millisecond, so they carry the same write time; but B
  // publishes another configuration of that file: another tiebreak game, or tracked-only instead of the full field. Both
  // writes are the same locked revision (4 replacing revision 3, or 1 for a new week), and only one can land: A's. B's
  // write changes nothing (its compare-and-swap matches no row, or its insert is refused) and its response is lost, so B
  // reads the week back and finds a locked row with B's revision, digest and write time: A's write, not B's
  // configuration. B does not report success: the outcome is not confirmed, nothing is retried, A's row is left exactly
  // as stored, and B must read and validate again.
  const instant='2026-09-25T18:00:00.000Z';
  const anotherTiebreak=async b=>{await b.count('6');await b.choose('six.pdf');await b.parse();b.$('tiebreakGame').value='3';b.$('tiebreakGame').onchange()};
  const trackedOnly=async b=>{await b.choose('six.pdf');await b.parse()};
  const variants=[
    ['replacement, another tiebreak game',lockedWeek2(3),anotherTiebreak,(theirs,mine)=>{assert.equal(theirs.tiebreakGameIndex,14);assert.equal(mine.tiebreakGameIndex,3)}],
    ['replacement, tracked-only instead of the full field',lockedWeek2(3),trackedOnly,(theirs,mine)=>{assert.equal(theirs.fullFieldReady,true);assert.equal(mine.fullFieldReady,false)}],
    ['new week, another tiebreak game',null,anotherTiebreak,(theirs,mine)=>{assert.equal(theirs.tiebreakGameIndex,14);assert.equal(mine.tiebreakGameIndex,3)}]
  ];
  for(const [label,before,prepareB,differ] of variants){
    const table=before?[structuredClone(before)]:[],revision=before?4:1,write=before?'update':'insert';
    const a=await bootAdmin({rows:table}),b=await bootAdmin({rows:table});
    await a.count('6');await a.choose('six.pdf');await a.parse();a.$('replaceLocked').checked=!!before;
    await prepareB(b);b.$('replaceLocked').checked=!!before;
    const heldA=adminDeferred(),heldB=adminDeferred();a.db.writeGate=heldA;b.db.writeGate=heldB;
    let pa,pb;
    await atInstant(instant,async()=>{
      pa=a.publish();await adminUntil(()=>a.db.writeGate===null,`${label}: A dispatches its write`);
      pb=b.publish();await adminUntil(()=>b.db.writeGate===null,`${label}: B dispatches its write`);
    });
    assert.deepEqual([a.db.dispatched,b.db.dispatched],[['select',write],['select',write]],`${label}: both pages read the week before either write`);
    heldA.resolve();await pa;await adminFlush();
    assert.equal(a.$('message').textContent,`Week 2 published and locked successfully. Revision ${revision}.`,label);
    const stored=JSON.stringify(table);
    // B's write changes nothing and its response is lost: its compare-and-swap runs and matches no row, or its insert,
    // which the unique season/week key refuses now that A's row exists, inserts nothing.
    let mine;
    if(before){b.db.beforeWrite=q=>{mine=sent(q.row)};b.db.afterWrite=()=>{throw new TypeError('Failed to fetch')}}
    else b.db.beforeWrite=q=>{mine=sent(q.row);throw new TypeError('Failed to fetch')};
    heldB.resolve();await pb;await adminFlush();
    // The collision is real: A's row is a locked week with B's revision, digest and write time, and another configuration.
    const [theirs]=table;
    for(const k of ['season','week','revision','source_sha256','updated_at','status'])assert.equal(theirs[k],mine[k],`${label}: the same ${k}`);
    assert.equal(mine.updated_at,instant,label);assert.equal(mine.source_sha256,sheetDigest('six.pdf'),label);assert.equal(mine.status,'locked',label);
    assert.deepEqual(theirs.config.source,mine.config.source,`${label}: the same file`);
    differ(theirs.config,mine.config);assert.notDeepEqual(theirs.config,mine.config,label);
    assert.equal(b.$('message').textContent,NOT_CONFIRMED(revision),label);
    assert.equal(b.$('message').className,'notice error',label);assert.equal(b.$('publishResult').hidden,true,label);
    assert.deepEqual(b.db.log,['select',write,'select'],`${label}: one write and one read-back, no retry`);
    assert.deepEqual(b.db.affected,before?[0]:[],`${label}: B's write changed no row`);
    assert.equal(JSON.stringify(table),stored,`${label}: A's row is left exactly as stored`);
    await assertRevalidationRequired(b,label);
    assert.equal(JSON.stringify(table),stored,label);
  }
}
{
  // ADMIN 7l — ALL OF A WRITE IDENTIFIES IT. The replacement fails with an exception and the read-back finds exactly this
  // attempt's write but for one thing: its revision, digest, write time or status, or its configuration: another
  // tiebreak game, the same bytes under another file name, tracked-only instead of the full field, the same games,
  // entries or picks in another order (arrays keep their order), a field added or missing, or no configuration at all.
  // None of them is this attempt's write: success is never reported, nothing is retried, the row found is left exactly
  // as stored, and the page must read and validate again.
  const alter=change=>mine=>{const row=structuredClone(mine);change(row);return row};
  const cases=[
    ['another revision',alter(r=>{r.revision=5})],
    ['another digest',alter(r=>{r.source_sha256='their-sheet'})],
    ['another write time',alter(r=>{r.updated_at='2026-09-24T09:00:00.000Z'})],
    ['not locked',alter(r=>{r.status='draft'})],
    ['another tiebreak game',alter(r=>{r.config.tiebreakGameIndex=3})],
    ['the same bytes under another file name',alter(r=>{r.config.source.filename=r.source_filename='six (1).pdf'})],
    ['tracked-only instead of the full field',alter(r=>{r.config.fullFieldReady=false;for(const k of ['fieldEntries','fullFieldEntryCount','competitionSize'])delete r.config[k]})],
    ['the games in another order',alter(r=>{r.config.games.reverse()})],
    ['the tracked entries in another order',alter(r=>{r.config.participants.reverse()})],
    ['an entry\'s picks in another order',alter(r=>{r.config.participants[0].pickNumbers.reverse()})],
    ['a field added',alter(r=>{r.config.note='edited'})],
    ['a field missing',alter(r=>{delete r.config.label})],
    ['no configuration',alter(r=>{r.config=null})]
  ];
  for(const [label,foreign] of cases){
    const table=[lockedWeek2(3)],t=await bootAdmin({rows:table});
    await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=true;
    let mine,found;
    t.db.beforeWrite=q=>{mine=sent(q.row);found=foreign(mine);table.splice(0,table.length,structuredClone(found));throw new TypeError('Failed to fetch')};
    await t.publish();await adminFlush();
    assert.notDeepEqual(found,mine,label);
    assert.equal(t.$('message').textContent,NOT_CONFIRMED(found.revision),label);
    assert.equal(t.$('message').className,'notice error',label);assert.equal(t.$('publishResult').hidden,true,label);
    assert.deepEqual(t.db.log,['select','update','select'],`${label}: one write and one read-back, no retry`);
    assert.deepEqual(t.db.affected,[],`${label}: this attempt's write never committed`);
    assert.equal(JSON.stringify(table),JSON.stringify([found]),`${label}: the row found is left exactly as stored`);
    await assertRevalidationRequired(t,label);
    assert.equal(JSON.stringify(table),JSON.stringify([found]),label);
  }
}
{
  // ADMIN 7m — THE WEEK EXACTLY AS THIS PUBLISH READ IT. The replacement fails before it commits, and the read-back finds
  // Week 2 with the revision, digest and write time this publish read, but changed in place: another configuration, or
  // no longer locked. That is not the week this publish read, so the page is not told that it wrote nothing and may retry:
  // the outcome is not confirmed, nothing is retried, the row found is left exactly as stored, and the page must read and
  // validate again. The week with only its configuration's keys in another order is unchanged, and the page may retry.
  const changes=[
    ['another configuration at revision 3',r=>{r.config.tiebreakGameIndex=3}],
    ['no longer locked at revision 3',r=>{r.status='draft'}]
  ];
  for(const [label,change] of changes){
    const table=[lockedWeek2(3)],t=await bootAdmin({rows:table});
    await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=true;
    let found;
    t.db.beforeWrite=()=>{change(table[0]);found=structuredClone(table[0]);throw new TypeError('Failed to fetch')};
    await t.publish();await adminFlush();
    for(const k of ['revision','source_sha256','updated_at'])assert.equal(found[k],lockedWeek2(3)[k],`${label}: the same ${k}`);
    assert.notDeepEqual(found,lockedWeek2(3),label);
    assert.equal(t.$('message').textContent,NOT_CONFIRMED(3),label);
    assert.equal(t.$('message').className,'notice error',label);assert.equal(t.$('publishResult').hidden,true,label);
    assert.deepEqual(t.db.log,['select','update','select'],`${label}: one write and one read-back, no retry`);
    assert.deepEqual(t.db.affected,[],label);
    assert.equal(JSON.stringify(table),JSON.stringify([found]),`${label}: the row found is left exactly as stored`);
    await assertRevalidationRequired(t,label);
    assert.equal(JSON.stringify(table),JSON.stringify([found]),label);
  }
  const table=[lockedWeek2(3)],t=await bootAdmin({rows:table});
  await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=true;
  t.db.beforeWrite=()=>{table[0].config=reverseKeys(table[0].config);throw new TypeError('Failed to fetch')};
  await t.publish();await adminFlush();
  assert.notEqual(JSON.stringify(table[0].config),JSON.stringify(lockedWeek2(3).config),'stored in another key order');
  assert.deepEqual(table,[lockedWeek2(3)],'the same week');
  assert.equal(t.$('message').textContent,'Publish failed: Failed to fetch. Read-back shows Week 2 still at revision 3, so this attempt wrote nothing. You can retry Publish.');
  assert.equal(t.$('review').hidden,false);assert.equal(t.$('publishBtn').disabled,false,'the validated page may retry');
  await t.publish();await adminFlush();
  assert.equal(t.$('message').textContent,'Week 2 published and locked successfully. Revision 4.');
  assert.deepEqual(t.db.affected,[1],'written once');assert.equal(table.length,1);assert.equal(table[0].revision,4);
}
{
  // ADMIN 7n — AN UNDECIDED ATTEMPT IS RECOGNIZED ONLY WITH ITS CONFIGURATION. A replacement's outcome is unknown: its
  // write fails and so does the read-back. Before this page publishes again, another publish of the same file lands a
  // locked revision 4 with exactly that attempt's write time, but another tiebreak game. After a fresh read, publishing
  // the attempt's configuration again does not take that row for the earlier attempt: nothing is reported as written, the
  // locked week is not replaced without the replace confirmation, and with it the week is replaced as revision 5.
  const table=[lockedWeek2(3)],t=await bootAdmin({rows:table});
  await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=true;
  let mine;t.db.beforeWrite=q=>{mine=sent(q.row);t.db.readFail=new TypeError('offline');throw new TypeError('Failed to fetch')};
  await t.publish();await adminFlush();
  assert.match(t.$('message').textContent,/^Publish outcome unknown: Failed to fetch\. /);
  const theirs=structuredClone(mine);theirs.config.tiebreakGameIndex=3;
  table.splice(0,table.length,structuredClone(theirs));const stored=JSON.stringify(table);
  await t.parse();await t.publish();await adminFlush();
  assert.equal(t.$('message').className,'notice error');assert.match(t.$('message').textContent,/^Week 2 is already locked\. /);
  assert.equal(t.$('publishResult').hidden,true);
  assert.deepEqual(t.db.log,['select','update','select','select'],'the new publish only reads');
  assert.equal(JSON.stringify(table),stored,'the other publish\'s row is left exactly as stored');
  t.$('replaceLocked').checked=true;await t.publish();await adminFlush();
  assert.equal(t.$('message').textContent,'Week 2 published and locked successfully. Revision 5.');
  assert.equal(t.writes(),2);assert.equal(table.length,1);assert.equal(table[0].revision,5);assert.equal(table[0].config.tiebreakGameIndex,14);
}
{
  // ADMIN 7o — KEY ORDER IS NOT PART OF A CONFIGURATION. A database may return a configuration's object keys in any order
  // (a JSONB column keeps none of its own); here every object in it comes back with its keys reversed, while its arrays
  // keep their order. It is still this attempt's configuration: a replacement or a new week whose response is lost is
  // confirmed by read-back and never written again, and a late commit is recognized by the retry, which writes nothing.
  // (The same entries in another array order are another configuration: ADMIN 7l.)
  for(const before of [lockedWeek2(3),null]){
    const label=before?'replacement':'new week',table=before?[structuredClone(before)]:[],t=await bootAdmin({rows:table});
    await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=!!before;
    let mine;t.db.afterWrite=q=>{mine=sent(q.row);table[0].config=reverseKeys(mine.config);throw new TypeError('Failed to fetch')};
    await t.publish();await adminFlush();
    assert.notEqual(JSON.stringify(table[0].config),JSON.stringify(mine.config),`${label}: stored in another key order`);
    assert.deepEqual(table[0].config,mine.config,`${label}: the same configuration`);
    assert.equal(t.$('message').className,'notice success',label);
    assert.equal(t.$('message').textContent,`Week 2 published and locked successfully. Revision ${before?4:1}.${CONFIRMED_BY_READ_BACK}`,label);
    const landed=JSON.stringify(table);await t.publish();await adminFlush();
    assert.match(t.$('message').textContent,/Week 2 is already locked/,label);
    assert.equal(t.writes(),1,`${label}: never written again`);assert.equal(JSON.stringify(table),landed,label);
  }
  for(const before of [lockedWeek2(3),null]){
    const label=`late ${before?'replacement':'new week'}`,table=before?[structuredClone(before)]:[],t=await bootAdmin({rows:table});
    await t.count('6');await t.choose('six.pdf');await t.parse();t.$('replaceLocked').checked=!!before;
    let late;t.db.beforeWrite=q=>{late=sent(q.row);throw new TypeError('Failed to fetch')};
    await t.publish();await adminFlush();
    assert.match(t.$('message').textContent,/so this attempt wrote nothing\. You can retry Publish\.$/,label);
    table.splice(0,table.length,{...(before||{}),...late,config:reverseKeys(late.config)});
    assert.notEqual(JSON.stringify(table[0].config),JSON.stringify(late.config),`${label}: stored in another key order`);
    const landed=JSON.stringify(table);
    await t.publish();await adminFlush();
    assert.equal(t.$('message').textContent,`Week 2 published and locked successfully. Revision ${before?4:1}. The earlier attempt of this publication had been written after all, so nothing new was written.`,label);
    assert.deepEqual(t.db.log,['select',before?'update':'insert','select','select'],`${label}: the retry only reads`);
    assert.equal(JSON.stringify(table),landed,label);
  }
}

console.log('parser-core regular-table region, continuation, fail-closed field, duplicate, privacy, and publication write-integrity regressions passed');
