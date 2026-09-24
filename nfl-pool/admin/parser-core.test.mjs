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
  // A single wrong-side/blank-equivalent anonymous slot is represented as explicit no-pick 0.
  const c=parse([...matchups,...tracked,'DuplicateSide 1 2 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0']);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries[0].pickNumbers[1],0);
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
  assert(validateConfig(cfg).some(e=>e.includes('not exactly one pick/no-pick per game')));
}
{
  // Anonymous no-pick normalization: an invalid/missing matchup cell becomes 0 without guessing a team.
  const noPick='Skip 1 2 5 7 9 11 13 15 17 19 21 23 25 27 29 47 0';
  const c=parse([...matchups,...tracked,anonA,noPick]);
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
  // TEST E — real page-edge continuation: prior run reaches the physical bottom band, next run starts in the top band.
  const page1=[...matchups,tracked[0],tracked[1],anonA],page2=[tracked[2],tracked[3],anonB];
  const y1=page1.map((_,i)=>760-i*12);y1[y1.length-3]=48;y1[y1.length-2]=36;y1[y1.length-1]=24;
  const y2=[760,748,736];
  const groups=[
    {week:2,lines:page1,sourceRows:rowsAt(page1,1,y1),pageNumber:1,pageFingerprint:'real-edge-page-1'},
    {week:2,lines:page2,sourceRows:rowsAt(page2,2,y2),pageNumber:2,pageFingerprint:'real-edge-page-2'}
  ];
  const c=parseDocumentGroups(groups,{filename:'continuation.pdf',season:2026})[0];
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
  ],{filename:'real-margin.pdf',season:2026})[0];
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
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'sparse-inactive-row'});
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
  ],{filename:'sparse-tail.pdf',season:2026})[0];
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
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'consecutive-sparse-bridge'});
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
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'large-gap-one'});
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
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'large-gap-multi'});
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
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'normal-drift'});
  assert.deepEqual(c.errors,[]);
  assert.deepEqual(c.fullFieldIssues,[]);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.competitionSize,5);
}
{
  // TEST D — ordinary consistent same-page table spacing remains accepted.
  const c=parse([...matchups,...tracked,anonA],{pageFingerprint:'normal-spacing'});
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
  const c=parseDocumentGroups([pdfGroup(page1,1),pdfGroup(page2,2)],{filename:'later-table.pdf',season:2026})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.participants.length,4);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
}
{
  // TEST G — a repeated compatible header physically near its participant run proves continuation.
  const header='Entry Pts W';
  const page1=[...matchups,header,tracked[0],tracked[1],anonA],page2=[header,tracked[2],tracked[3],anonB];
  const rows1=applyRegularHeaderGeometry(sourceRows(page1,1),header);
  const rows2=applyRegularHeaderGeometry(rowsAt(page2,2,[760,740,728,716]),header);
  const c=parseDocumentGroups([
    {week:2,lines:page1,sourceRows:rows1,pageNumber:1,pageFingerprint:'header-near-page-1'},
    {week:2,lines:page2,sourceRows:rows2,pageNumber:2,pageFingerprint:'header-near-page-2'}
  ],{filename:'header-continuation.pdf',season:2026})[0];
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
  ],{filename:'remote-header.pdf',season:2026})[0];
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
  ],{filename:'missing-y-header.pdf',season:2026})[0];
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
  ],{filename:'bad-header-geometry.pdf',season:2026})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.competitionSize,4);
  assert.equal(c.config.fieldEntries,undefined);
}
{
  // Explicitly preserve names that contain digits and hyphens.
  const c=parse([...matchups,...tracked,'7-11 Guy 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 44 0']);
  assert.equal(c.config.fullFieldReady,true);
  assert.equal(c.config.fieldEntries.length,1);
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


{
  // STEP 2 P2-A — an all-digit participant name must not bypass damaged-row detection.
  const damagedNumericName='12345 1 2 5 6 9 11 13 15 17 19 21 23 25 27 29 44 0';
  const c=parse([...matchups,...tracked,anonA,damagedNumericName],{pageFingerprint:'step2-p2-a-numeric-damaged'});
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
  const c=parse(lines,{sourceRows:rows,pageFingerprint:'step2-p2-c-summary-intrusion'});
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
  ],{filename:'near-header-break.pdf',season:2026})[0];
  assert.deepEqual(c.errors,[]);
  assert.equal(c.config.fullFieldReady,false);
  assert.equal(c.config.fieldEntries,undefined);
  assert(c.fullFieldIssues.some(x=>x.includes('continuous PDF participant-table chain')));
}

console.log('parser-core regular-table region, continuation, fail-closed field, duplicate, and privacy regressions passed');
