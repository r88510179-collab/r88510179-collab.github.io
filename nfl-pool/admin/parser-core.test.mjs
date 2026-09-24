import assert from 'node:assert/strict';
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
  return s;
})();
class AdminEl{
  constructor(id){Object.assign(this,{id,hidden:false,disabled:false,checked:false,value:'',textContent:'',innerHTML:'',className:'',files:null,listeners:{},onchange:null,classList:{add(){},remove(){}}})}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn)}
  dispatch(type){return Promise.all((this.listeners[type]||[]).map(fn=>fn({preventDefault(){},target:this})))}
  focus(){}
}
const adminFlush=async(n=8)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};
const adminDeferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
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
let adminInstance=0;
async function bootAdmin(){
  const els=new Map(),$=id=>{if(!els.has(id))els.set(id,new AdminEl(id));return els.get(id)};
  const db={session:{id:'admin-1',email:'djsmokke@gmail.com'},rows:[],log:[],readGate:null},net={gate:null};
  class Query{
    constructor(table){Object.assign(this,{table,op:'select',filters:[],row:null})}
    select(){return this}
    eq(k,v){this.filters.push([k,v]);return this}
    limit(){return this}
    insert(row){this.op='insert';this.row=row;return this}
    update(row){this.op='update';this.row=row;return this}
    then(ok,fail){return this.run().then(ok,fail)}
    async run(){
      if(this.op==='select'&&db.readGate){const gate=db.readGate;db.readGate=null;await gate.promise}
      db.log.push(this.op);
      const match=r=>this.filters.every(([k,v])=>r[k]===v);
      if(this.op==='select')return{data:db.rows.filter(match).map(r=>structuredClone(r)),error:null};
      if(this.op==='insert'){db.rows.push(structuredClone(this.row));return{data:[{season:this.row.season,week:this.row.week,revision:this.row.revision}],error:null}}
      const hits=db.rows.filter(match);for(const r of hits)Object.assign(r,structuredClone(this.row));
      return{data:hits.map(r=>({season:r.season,week:r.week,revision:r.revision})),error:null};
    }
  }
  globalThis.document={getElementById:$};
  globalThis.__pickemTest={
    neonModule:{createClient:()=>({auth:{getSession:async()=>({data:db.session?{user:db.session,session:{token:'t'}}:null}),signOut:async()=>{db.session=null},emailOtp:{sendVerificationOtp:async()=>({error:null})},signIn:{emailOtp:async()=>({error:null})}},from:table=>new Query(table)})},
    pdfjs:{GlobalWorkerOptions:{},getDocument:({data})=>{const pages=ADMIN_SHEETS[new TextDecoder().decode(data)];return{promise:Promise.resolve({numPages:pages.length,getPage:async n=>({getTextContent:async()=>({items:pages[n-1]})})})}}}
  };
  globalThis.fetch=async()=>{if(net.gate)await net.gate.promise;return{ok:true,status:200,json:async()=>structuredClone(scheduleFeed)}};
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
  // ADMIN 4c — a count change while the publish is reading the database aborts it before any write.
  const t=await bootAdmin();
  await t.count('6');await t.choose('six.pdf');await t.parse();
  const gate=adminDeferred();t.db.readGate=gate;
  const pending=t.publish();await adminFlush();
  assert.equal(t.db.readGate,null,'the publish is waiting on its database read');
  t.$('totalEntries').value='7';await t.$('totalEntries').dispatch('input');
  gate.resolve();await pending;await adminFlush();
  assert.equal(t.writes(),0,'in-flight publish aborted');
  assert.match(t.$('message').textContent,/changed before publishing completed/);
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

console.log('parser-core regular-table region, continuation, fail-closed field, duplicate, and privacy regressions passed');
