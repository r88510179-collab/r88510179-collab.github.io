import assert from 'node:assert/strict';
import {groupSurvivorPdfTextItems,parseSurvivorPages,validateSurvivorConfig,normalizeSurvivorTeam} from './survivor-parser.js';

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

// Real-sheet geometry: participant name and team cells are offset by ~1.8 PDF points.
const grouped=groupSurvivorPdfTextItems([
  {str:'D.C.',transform:[1,0,0,1,20,100]},
  {str:'PIT',transform:[1,0,0,1,154,98.2]},
  {str:'SF',transform:[1,0,0,1,188,98.2]}
]);
assert.equal(grouped.length,1);
assert.equal(grouped[0].text,'D.C. PIT SF');

// Adjacent participant rows must remain distinct at the 2.2-point grouping tolerance.
const adjacent=groupSurvivorPdfTextItems([
  {str:'Long Participant One',transform:[1,0,0,1,20,100]},
  {str:'PIT',transform:[1,0,0,1,154,98.2]},
  {str:'SF',transform:[1,0,0,1,188,98.2]},
  {str:'Long Participant Two',transform:[1,0,0,1,20,95]},
  {str:'LV',transform:[1,0,0,1,154,93.2]},
  {str:'TB',transform:[1,0,0,1,188,93.2]}
]);
assert.equal(adjacent.length,2);
assert.equal(adjacent[0].text,'Long Participant One PIT SF');
assert.equal(adjacent[1].text,'Long Participant Two LV TB');

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

// A genuine no-pick entrant occupies the next row of the participant grid (directly below the last entry).
const noPickRow=row('No Pick Entry',null,null,null,null,4);
const withNoPick=parseSurvivorPages([{pageNumber:1,rows:[header,row('D.C.','PIT','SF',null,null,1),row('DJS','LV','SF',null,null,2),row('Thaddius','LAC',null,null,null,3),noPickRow]}],{season:2026});
assert.deepEqual(withNoPick.errors,[]);
assert.equal(withNoPick.config.competitionSize,4);
assert.deepEqual(withNoPick.config.fieldEntries[0].picks,[null,null]);

// Week-2 scale contract mirrors the uploaded sheet aggregate without persisting source names.
const bigRows=[header,row('D.C.','PIT','SF',null,null,1),row('DJS','LV','SF',null,null,2),row('Thaddius','LAC',null,null,null,3)];
for(let i=0;i<244;i++)bigRows.push(row('Anon '+i,'JAC',i<158?'TB':null,null,null,4+i));
const scaled=parseSurvivorPages([{pageNumber:1,rows:bigRows}],{season:2026});
assert.deepEqual(scaled.errors,[]);
assert.equal(scaled.config.competitionSize,247);
assert.equal(scaled.config.currentWeekEntryCount,160);
assert.equal(scaled.config.fieldEntries.length,244);
assert.equal(JSON.stringify(scaled.config).includes('Anon 0'),false);

const unknown=[{pageNumber:1,rows:[header,row('D.C.','PIT','SF',null,null,1),row('DJS','LV','SF',null,null,2),row('Thaddius','LAC',null,null,null,3),row('Mystery','ABC','SF',null,null,4)]}];
assert(parseSurvivorPages(unknown,{season:2026}).errors.some(e=>e.includes('unknown Week 1 team')));

console.log('survivor parser privacy, tracked identity, row geometry, and week detection regressions passed');


// ================= Out-of-column pick tokens (requirement 5) =================
// Geometry mirrors the fixtures above: Week headers at 159/192/225/258 (gap 33), pick text starts 8pt left of its header.
const at=(y,parts)=>({text:parts.map(p=>p[1]).join(' '),y,rowIndex:0,parts:parts.map(([x,text])=>({x,text}))});
const base=(extra=[],more=[])=>[{pageNumber:1,rows:[
  header,
  at(748,[[20,'D.C.'],[151,'PIT'],[184,'SF']]),
  at(736,[[20,'DJS'],[151,'LV'],[184,'SF']]),
  at(724,[[20,'Thaddius'],[151,'LAC']]),
  at(712,[[20,'Alpha'],[151,'JAX'],[184,'BAL']]),
  ...extra
]},...more];
const parse=pages=>parseSurvivorPages(pages,{season:2026});

{
  // valid aligned pick
  const r=parse(base([at(700,[[20,'Bravo'],[151,'DET'],[184,'TB']])]));
  assert.deepEqual(r.errors,[]);assert.equal(r.config.competitionSize,5);
  assert.deepEqual(r.config.fieldEntries[1].picks,['DET','TB']);
  // slightly offset but still unambiguous geometry (10pt either side of the observed column start)
  for(const cells of [[[155,'DET'],[184,'TB']],[[151,'DET'],[194,'TB']],[[145,'DET'],[174,'TB']],[[151,'DET'],[176,'TB']],[[161,'DET'],[194,'TB']]]){
    const s=parse(base([at(700,[[20,'Bravo'],...cells])]));
    assert.deepEqual(s.errors,[],JSON.stringify(cells));assert.deepEqual(s.config.fieldEntries[1].picks,['DET','TB']);
  }
  // two cells squeezed into overlapping positions are merged and rejected, never split by guesswork
  assert(parse(base([at(700,[[20,'Bravo'],[161,'DET'],[174,'TB']])])).errors.includes('Bravo: unknown Week 1 team DET TB'));
  // a whole sheet shifted consistently right of its headers is still read by the observed column positions
  const shifted=[{pageNumber:1,rows:[header,...[['D.C.','PIT','SF'],['DJS','LV','SF'],['Thaddius','LAC',null],['Alpha','JAX','BAL']].map(([n,a,b],i)=>at(748-12*i,[[20,n],[165,a],...(b?[[198,b]]:[])]))]}];
  const sh=parse(shifted);assert.deepEqual(sh.errors,[]);assert.deepEqual(sh.config.trackedEntries.find(x=>x.id==='dc').picks,['PIT','SF']);
  assert.equal(sh.review.geometry.columnOffset,6);
  // ...but a sheet whose text does not line up with its Week headers at all is rejected
  const far=[{pageNumber:1,rows:[header,...[['D.C.','PIT','SF'],['DJS','LV','SF'],['Thaddius','LAC',null],['Alpha','JAX','BAL']].map(([n,a,b],i)=>at(748-12*i,[[20,n],[173,a],...(b?[[206,b]]:[])]))]}];
  assert(parse(far).errors.some(e=>/Week column positions could not be proven/.test(e)));
}
{
  // token just outside the right-hand tolerance is an error, not a silent null
  const lastCol=(x,text)=>[{pageNumber:1,rows:[header,
    at(748,[[20,'D.C.'],[151,'PIT'],[184,'SF']]),at(736,[[20,'DJS'],[151,'LV'],[184,'SF']]),at(724,[[20,'Thaddius'],[151,'LAC']]),
    at(712,[[20,'Alpha'],[151,'JAX'],[184,'BAL'],[217,'KC'],[x,text]])]}];
  const inside=parse(lastCol(270,'MIA'));
  assert.deepEqual(inside.errors,[]);assert.deepEqual(inside.config.fieldEntries[0].picks,['JAX','BAL','KC','MIA']);
  const outside=parse(lastCol(271,'MIA'));
  assert(outside.errors.some(e=>e==='Alpha: text MIA is outside every Week column'),outside.errors.join(' | '));
  // non-team words far right are meaningful text too: fail closed rather than discard
  assert(parse(base([at(700,[[20,'Bravo'],[151,'DET'],[400,'ALIVE']])])).errors.some(e=>e==='Bravo: text ALIVE is outside every Week column'));
  // punctuation-only marks cannot encode a team and are not treated as picks
  assert.deepEqual(parse(base([at(700,[[20,'Bravo'],[151,'DET'],[400,'*']])])).errors,[]);
}
{
  // token between two Week columns is ambiguous and must not be silently binned
  const r=parse(base([at(700,[[20,'Bravo'],[151,'DET'],[200.5,'TB']])]));
  assert(r.errors.some(e=>e==='Bravo: text TB is between the Week 2 and Week 3 columns'),r.errors.join(' | '));
  const r2=parse(base([at(700,[[20,'Bravo'],[151,'DET'],[197,'TB']])]));
  assert(r2.errors.some(e=>/between the Week 2 and Week 3 columns/.test(e)));
  // a pick drifting left out of Week 1 into the name region is not silently absorbed into the name
  // (ordinary name words that merely spell a team code in lowercase are not treated as drifted picks)
  const longName=parse(base([at(700,[[20,'Bravo'],[90,'Van'],[132,'Den'],[151,'DET'],[184,'TB']])]));
  assert.deepEqual(longName.errors,[]);
  for(const x of [132,141.5]){
    const drift=parse(base([at(700,[[20,'Bravo'],[x,'DET'],[184,'TB']])]));
    assert(drift.errors.some(e=>e==='Bravo DET: text DET sits between the name column and the Week 1 column'),drift.errors.join(' | '));
  }
}
{
  // unknown team in a valid column
  const r=parse(base([at(700,[[20,'Bravo'],[151,'DET'],[184,'XYZ']])]));
  assert(r.errors.includes('Bravo: unknown Week 2 team XYZ'));
  // two teams landing in one Week cell are never guessed
  const two=parse(base([at(700,[[20,'Bravo'],[151,'DET'],[168,'KC']])]));
  assert(two.errors.includes('Bravo: unknown Week 1 team DET KC'));
  // split cell text ("LA" + "C") stays one Week 1 pick even at larger font sizes
  // (pdf.js may return "LA" and "C" as separate items; "C" starts ~1.5 x font size after "LA".)
  for(const [lx,cx] of [[149,166],[149,169],[149,172],[154,169],[154,170.5],[154,172]]){
    const split=parse([{pageNumber:1,rows:[header,at(748,[[20,'D.C.'],[154,'PIT'],[188,'SF']]),at(736,[[20,'DJS'],[154,'LV'],[188,'SF']]),at(724,[[20,'Thaddius'],[lx,'LA'],[cx,'C']]),at(712,[[20,'Alpha'],[151,'JAX'],[184,'BAL']])]}]);
    assert.deepEqual(split.errors,[],`split LA C at ${lx}/${cx}`);
    assert.deepEqual(split.config.trackedEntries.find(x=>x.id==='thaddeus').picks,['LAC',null]);
  }
}

{
  // Split "LA" + "C" in a tight layout (11.9pt text in 24.5pt columns): the fragment completes its own cell and never
  // chains into, or is binned as, the next Week column.
  const tight={text:'Week 1 2 3 4',y:760,rowIndex:0,parts:[{x:116,text:'Week'},{x:159,text:'1'},{x:183.5,text:'2'},{x:208,text:'3'},{x:232.5,text:'4'}]};
  const r=parse([{pageNumber:1,rows:[tight,
    at(748,[[20,'D.C.'],[149,'PIT'],[176,'SF']]),at(736,[[20,'DJS'],[150,'LV'],[176,'SF']]),
    at(724,[[20,'Thaddius'],[148.4,'LA'],[166.3,'C'],[176,'SF']]),at(712,[[20,'Alpha'],[150,'JAX'],[173,'BAL']])]}]);
  assert.deepEqual(r.errors,[]);assert.deepEqual(r.config.trackedEntries.find(x=>x.id==='thaddeus').picks,['LAC','SF']);
}

// ================= Participant region / stray rows (requirement 6) =================
{
  // Titles/legends above the Week header are outside the table; footers separated from the grid are not entrants.
  const pages=base(
    [at(700,[[20,'Bravo'],[151,'DET'],[184,'TB']]),at(640,[[20,'Page 1 of 3']]),at(628,[[20,'Notes']])],
  );
  pages[0].rows.unshift(at(790,[[20,'Name']]),at(780,[[20,'2026 Standings as of Week 2']]));
  const r=parse(pages);
  assert.deepEqual(r.errors,[]);
  assert.equal(r.config.competitionSize,5,'stray rows never join the field');
  assert.deepEqual(r.review.detachedRows.map(x=>x.label),['Page 1 of 3','Notes']);
  assert(r.review.ignoredRows.some(x=>x.text==='Name'&&x.reason==='above the Week header'));
  assert(r.review.ignoredRows.some(x=>x.text==='2026 Standings as of Week 2'));
  const json=JSON.stringify(r.config);
  for(const leak of ['Page 1 of 3','Notes','"Name"','Standings','Alpha','Bravo'])assert.equal(json.includes(leak),false,leak);
  // a centered footer in the Week-column area with no team code is ignored; a nameless team code is an error
  const centered=parse(base([at(700,[[20,'Bravo'],[151,'DET']]),at(650,[[210,'Page 1 of 3']]),at(640,[[184,'No pick = OUT']])]));
  assert.deepEqual(centered.errors,[]);assert.equal(centered.config.competitionSize,5);
  const orphan=parse(base([at(700,[[20,'Bravo'],[151,'DET']]),at(688,[[184,'SF']])]));
  assert(orphan.errors.some(e=>e==='Page 1: Week-column team text SF has no participant name'),orphan.errors.join(' | '));
  // a repeated sheet title on a later page is still ignored, including right-side text on that row
  const t=parse(base([],[{pageNumber:2,rows:[at(790,[[20,'Suicide Pool'],[500,'9/16/2026']]),at(760,[[20,'Charlie'],[151,'NE'],[184,'KC']])]}]));
  assert.deepEqual(t.errors,[]);assert.equal(t.config.competitionSize,5);
}
{
  // Genuine no-pick entrants on the row grid stay in the field: first row, interior, consecutive, last row, later page.
  const rows=[
    header,
    at(748,[[20,'Blank Top']]),
    at(736,[[20,'D.C.'],[151,'PIT'],[184,'SF']]),
    at(724,[[20,'Blank Middle']]),
    at(712,[[20,'DJS'],[151,'LV'],[184,'SF']]),
    at(700,[[20,'Blank A']]),at(688,[[20,'Blank B']]),
    at(676,[[20,'Thaddius'],[151,'LAC']]),
    at(664,[[20,'Alpha'],[151,'JAX'],[184,'BAL']]),
    at(652,[[20,'Blank Bottom']])
  ];
  const page2=[at(780,[[20,'Blank P2 Top']]),at(768,[[20,'Charlie'],[151,'NE'],[184,'KC']]),at(756,[[20,'Delta'],[151,'MIA']]),at(744,[[20,'Blank P2 Bottom']]),at(60,[[20,'Page 2 of 2']])];
  const r=parse([{pageNumber:1,rows},{pageNumber:2,rows:page2}]);
  assert.deepEqual(r.errors,[]);
  assert.equal(r.config.competitionSize,13);
  assert.equal(r.config.fieldEntries.filter(e=>e.picks.every(p=>p===null)).length,7);
  assert.deepEqual(r.review.blankEntrants.map(x=>x.label),['Blank Top','Blank Middle','Blank A','Blank B','Blank Bottom','Blank P2 Top','Blank P2 Bottom']);
  assert.deepEqual(r.review.detachedRows.map(x=>x.label),['Page 2 of 2']);
  assert.equal(r.review.geometry.rowPitch,12);
  // blank entrants are OUT (no pick) in Week 1 exactly like before; privacy unchanged
  assert.equal(JSON.stringify(r.config).includes('Blank'),false);
  assert.deepEqual(validateSurvivorConfig(r.config),[]);
}
{
  // Rows without picks that cannot be proven to belong to the participant table fail closed.
  const misaligned=parse(base([at(700,[[100,'Legend: yellow = Thursday']]),at(688,[[20,'Bravo'],[151,'DET']])]));
  assert(misaligned.errors.some(e=>/Legend: yellow = Thursday: row has no picks and its name is outside the participant name column/.test(e)),misaligned.errors.join(' | '));
  // A page of blank entrants (e.g. sorted last) is counted only as one unbroken grid chain in the name column, and is
  // surfaced for explicit confirmation; anything less fails closed.
  const blankPage=parse(base([],[{pageNumber:2,rows:[at(780,[[20,'Echo']]),at(768,[[20,'Foxtrot']])]}]));
  assert.deepEqual(blankPage.errors,[]);assert.equal(blankPage.config.competitionSize,6);
  assert.deepEqual(blankPage.review.unanchoredRows,[{page:2,label:'Echo'},{page:2,label:'Foxtrot'}]);
  const brokenPage=parse(base([],[{pageNumber:2,rows:[at(780,[[20,'Echo']]),at(700,[[20,'Page 2 of 2']])]}]));
  assert(brokenPage.errors.some(e=>/Echo: row has no picks on a page without participant picks and is not on the participant row grid/.test(e)),brokenPage.errors.join(' | '));
  const offColumn=parse(base([],[{pageNumber:2,rows:[at(780,[[20,'Echo']]),at(768,[[90,'Printed 9/21']])]}]));
  assert(offColumn.errors.some(e=>/is outside the participant name column/.test(e)),offColumn.errors.join(' | '));
  // no two rows with picks are adjacent, so the row pitch (and therefore grid membership of every row on the page) is
  // unproven: rows with picks fail closed exactly like rows without picks
  const noPitch=parse([{pageNumber:1,rows:[header,at(748,[[20,'D.C.'],[151,'PIT'],[184,'SF']]),at(736,[[20,'Golf']]),at(724,[[20,'DJS'],[151,'LV'],[184,'SF']]),at(712,[[20,'Hotel']]),at(700,[[20,'Thaddius'],[151,'LAC']])]}]);
  const unplaced=name=>name+': row with picks cannot be placed on the participant row grid because the Survivor row spacing could not be proven';
  assert.deepEqual(noPitch.errors,[unplaced('D.C.'),'Golf: row has no picks and the Survivor row spacing could not be proven',unplaced('DJS'),'Hotel: row has no picks and the Survivor row spacing could not be proven',unplaced('Thaddius'),
    'No Survivor entries found','No populated Survivor week found','Missing D.C. Survivor row','Missing DJS Survivor row','Missing Thaddeus Survivor row']);
  assert.equal(noPitch.competitionSize,0);
  // a blank row far below widely spaced rows is off the grid and surfaced as separated
  const wide=parse([{pageNumber:1,rows:[header,at(748,[[20,'D.C.'],[151,'PIT'],[184,'SF']]),at(700,[[20,'DJS'],[151,'LV'],[184,'SF']]),at(652,[[20,'Thaddius'],[151,'LAC']]),at(640,[[20,'Golf']])]}]);
  assert.deepEqual(wide.errors,[]);assert.deepEqual(wide.review.detachedRows.map(x=>x.label),['Golf']);
  // a label squeezed off-grid between the header and the first entry is not an entrant
  const squeezed=parse([{pageNumber:1,rows:[header,at(755,[[20,'Name']]),at(748,[[20,'D.C.'],[151,'PIT'],[184,'SF']]),at(736,[[20,'DJS'],[151,'LV'],[184,'SF']]),at(724,[[20,'Thaddius'],[151,'LAC']])]}]);
  assert.deepEqual(squeezed.errors,[]);assert.equal(squeezed.config.competitionSize,3);assert.deepEqual(squeezed.review.detachedRows.map(x=>x.label),['Name']);
}
{
  // Review regressions: a stray "." in an empty Week cell never absorbs the next week's pick (fails closed as before);
  // a stray off-grid mark between rows never detaches a real blank entrant; symbol-only rows are not entrants;
  // left-aligned codes under centered Week numbers in wide columns are still read.
  const dot=parse(base([at(700,[[20,'Bravo'],[151,'JAX'],[190,'.'],[217,'SF']])]));
  assert(dot.errors.includes('Bravo: unknown Week 2 team .'),dot.errors.join(' | '));
  const dot1=parse(base([at(700,[[20,'Bravo'],[157,'.'],[184,'PIT']])]));
  assert(dot1.errors.includes('Bravo: unknown Week 1 team .'),dot1.errors.join(' | '));
  const intruder=parse(base([at(705,[[20,'b']]),at(700,[[20,'Bravo Blank']])]));
  assert.deepEqual(intruder.errors,[]);assert.equal(intruder.config.competitionSize,5);
  assert.deepEqual(intruder.review.blankEntrants.map(x=>x.label),['Bravo Blank']);assert.deepEqual(intruder.review.detachedRows.map(x=>x.label),['b']);
  // off-grid text squeezed against a participant row, or beside a genuine blank row, is surfaced rather than counted
  const squeezedCode=parse(base([at(700,[[20,'Bravo'],[151,'DET']]),at(691,[[20,'PIT']]),at(688,[[20,'Charlie'],[151,'NE']])]));
  assert.deepEqual(squeezedCode.errors,[]);assert.equal(squeezedCode.config.competitionSize,6);assert.deepEqual(squeezedCode.review.detachedRows.map(x=>x.label),['PIT']);
  const besideBlank=parse(base([at(700,[[20,'Blank One']]),at(697,[[20,'note']]),at(688,[[20,'Charlie'],[151,'NE']])]));
  assert.deepEqual(besideBlank.errors,[]);assert.equal(besideBlank.config.competitionSize,6);
  assert.deepEqual(besideBlank.review.blankEntrants.map(x=>x.label),['Blank One']);assert.deepEqual(besideBlank.review.detachedRows.map(x=>x.label),['note']);
  const symbol=parse(base([at(700,[[20,'*']]),at(688,[[20,'—']])]));
  assert.deepEqual(symbol.errors,[]);assert.equal(symbol.config.competitionSize,4);
  assert(symbol.review.ignoredRows.some(x=>x.text==='*'&&x.reason==='name-column text with no letter or digit'));
  assert.deepEqual(symbol.review.symbolRows.map(x=>x.label),['*','—']);assert.deepEqual(symbol.review.detachedRows,[]);
  const wide={text:'Week 1 2 3 4',y:760,rowIndex:0,parts:[{x:116,text:'Week'},{x:167.2,text:'1'},{x:207.2,text:'2'},{x:247.2,text:'3'},{x:287.2,text:'4'}]};
  const left=parse([{pageNumber:1,rows:[wide,...[['D.C.','PIT','SF'],['DJS','LV','SF'],['Thaddius','LAC',null],['Alpha','JAX','BAL']].map(([n,a,b],i)=>at(748-12*i,[[20,n],[152,a],...(b?[[192,b]]:[])]))]}]);
  assert.deepEqual(left.errors,[]);assert.deepEqual(left.config.trackedEntries.find(x=>x.id==='dc').picks,['PIT','SF']);
  assert.equal(left.review.geometry.columnOffset,-15.2);assert(-15.2<-40*0.375,'beyond the old symmetric bound');
}
{
  // Round-2 regressions.
  // P3-1: a centered stray "." in an empty Week cell never absorbs the next week's pick through the continuation window.
  for(const x of [190,193,194,195,196]){
    const r=parse(base([at(700,[[20,'Bravo'],[151,'JAX'],[x,'.'],[217,'NYG']])]));
    assert(r.errors.includes('Bravo: unknown Week 2 team .'),`dot at ${x}: ${r.errors.join(' | ')}`);
  }
  // punctuation between two columns cannot encode a team and is not a pick; the real picks keep their columns
  const between=parse(base([at(700,[[20,'Bravo'],[151,'JAX'],[200,'.'],[217,'NYG']])]));
  assert.deepEqual(between.errors,[]);assert.deepEqual(between.config.fieldEntries[1].picks,['JAX',null,'NYG']);
  // P3-2: when no entry has a Week 1 pick the column mapping is shifted, so the sheet fails closed.
  const shiftedHeader={text:'Week 1 2 3 4',y:760,rowIndex:0,parts:[{x:116,text:'Week'},{x:159,text:'1'},{x:197,text:'2'},{x:235,text:'3'},{x:273,text:'4'}]};
  const shiftedCells=[['D.C.','PIT','SF'],['DJS','LV','SF'],['Thaddius','LAC',null],['Alpha','JAX','BAL']].map(([n,a,b],i)=>at(748-12*i,[[20,n],[181,a],...(b?[[219,b]]:[])]));
  const shiftedParse=parse([{pageNumber:1,rows:[shiftedHeader,...shiftedCells]}]);
  assert(shiftedParse.errors.includes('No Survivor entry has a Week 1 pick; Week column positions could not be proven'),shiftedParse.errors.join(' | '));
  // P3-3: the row grid is measured on name baselines, so a real blank entrant is kept even when pdf.js lists the lower
  // pick baseline first (row.y = pick baseline) and a note sits just off the grid next to the blank row.
  const pickFirst=(name,y,picks)=>[...picks.map(([x,t])=>({str:t,transform:[1,0,0,1,x,y-1.8]})),{str:name,transform:[1,0,0,1,20,y]}];
  const items=[...header.parts.map(p=>({str:p.text,transform:[1,0,0,1,p.x,760]})),
    ...pickFirst('D.C.',748,[[151,'PIT'],[184,'SF']]),...pickFirst('DJS',736,[[151,'LV'],[184,'SF']]),...pickFirst('Thaddius',724,[[151,'LAC']]),
    ...pickFirst('Alpha',712,[[151,'JAX'],[184,'BAL']]),{str:'Late Entry',transform:[1,0,0,1,20,700]},{str:'paid',transform:[1,0,0,1,20,697.5]}];
  const tie=parse([{pageNumber:1,rows:groupSurvivorPdfTextItems(items)}]);
  assert.deepEqual(tie.errors,[]);assert.equal(tie.config.competitionSize,5);
  assert.deepEqual(tie.review.blankEntrants.map(x=>x.label),['Late Entry']);assert.deepEqual(tie.review.detachedRows.map(x=>x.label),['paid']);
  // P3-4: blank entrants whose names use any script (or digits) are counted; only rows with no letter or digit are not.
  for(const name of ['Zoë','李明','Αλέξης','007']){
    const r=parse(base([at(700,[[20,name]])]));
    assert.deepEqual(r.errors,[],name);assert.equal(r.config.competitionSize,5,name);assert.deepEqual(r.review.blankEntrants.map(x=>x.label),[name]);
  }
  // A row with no letter or digit is not an entrant, but it is surfaced for explicit confirmation, never dropped silently.
  for(const name of ['*','—','🏈🏈']){
    const r=parse(base([at(700,[[20,name]])]));
    assert.deepEqual(r.errors,[],name);assert.equal(r.config.competitionSize,4,name);
    assert.deepEqual(r.review.symbolRows,[{page:1,label:name}],name);assert.deepEqual(r.review.detachedRows,[],name);
  }
  // R5-TR-3: a symbol-only "name" next to Week picks is not a participant name: the row fails closed like an unnamed
  // pick row instead of being counted as an entrant.
  for(const name of ['*','🏈','—']){
    const r=parse(base([at(700,[[20,name],[151,'KC'],[184,'NE']])]));
    assert(r.errors.includes('Page 1: Week-column team text KC NE has no participant name'),`${name}: ${r.errors.join(' | ')}`);
  }
  // Round 2d: beside symbol-only name-column text, every team spelling a named row would accept also fails closed, and
  // any other Week text still surfaces the row for confirmation instead of only listing it as uncounted text.
  for(const name of ['.','..','--','*','---','/','///']){
    for(const [cells,text] of [[[[151,'kc']],'kc'],[[[151,'Kc']],'Kc'],[[[151,'K.C.']],'K.C.'],[[[184,'Jax']],'Jax'],[[[151,'K'],[156,'C']],'K C']]){
      const r=parse(base([at(700,[[20,name],...cells])]));
      assert(r.errors.includes(`Page 1: Week-column team text ${text} has no participant name`),`${name} ${text}: ${r.errors.join(' | ')}`);
    }
    for(const cells of [[[151,'xx']],[[151,'n/a']],[[184,'tbd'],[217,'?']],[[400,'paid']]]){
      const r=parse(base([at(700,[[20,name],...cells])])),tag=`${name} ${cells.map(c=>c[1]).join(' ')}`;
      assert.deepEqual(r.errors,[],tag);assert.equal(r.config.competitionSize,4,tag);assert.deepEqual(r.review.blankEntrants,[],tag);
      assert.deepEqual(r.review.symbolRows,[{page:1,label:name}],tag);assert.deepEqual(r.review.detachedRows,[],tag);
    }
  }
  // P4-PARSER-2: stray text grouped into a participant row through the (first-listed) pick baseline puts the row's name
  // text on two baselines; the row's name baseline is then not trusted, and the real blank entrant below still counts.
  for(const noteX of [18,22]){
    const its=[...header.parts.map(p=>({str:p.text,transform:[1,0,0,1,p.x,760]}))];let yy=748;
    for(const [n,p] of [['D.C.',['PIT','SF']],['DJS',['LV','SF']],['Thaddius',['LAC']],['Alpha',['JAX','BAL']],['Late Entry',[]],['Bravo',['KC','NE']],['Charlie',['GB','TB']]]){
      p.forEach((t,i)=>its.push({str:t,transform:[1,0,0,1,151+33*i,yy-1.8]}));its.push({str:n,transform:[1,0,0,1,20,yy]});
      if(n==='Alpha')its.push({str:'paid',transform:[1,0,0,1,noteX,yy-3.5]});yy-=12;
    }
    const r=parse([{pageNumber:1,rows:groupSurvivorPdfTextItems(its)}]);
    assert.deepEqual(r.errors,[],`note x ${noteX}`);assert.equal(r.config.competitionSize,7,`note x ${noteX}`);
    assert.deepEqual(r.review.blankEntrants.map(x=>x.label),['Late Entry'],`note x ${noteX}`);
  }
}
{
  // The historical no-pick fixture geometry (three empty grid rows below the table) is physically detached: it is
  // not counted silently; it is surfaced for explicit admin acknowledgement instead.
  const detached=parseSurvivorPages([{pageNumber:1,rows:[header,row('D.C.','PIT','SF',null,null,1),row('DJS','LV','SF',null,null,2),row('Thaddius','LAC',null,null,null,3),row('No Pick Entry',null,null,null,null,7)]}],{season:2026});
  assert.deepEqual(detached.errors,[]);
  assert.equal(detached.config.competitionSize,3);
  assert.deepEqual(detached.review.detachedRows,[{page:1,label:'No Pick Entry'}]);
}

console.log('survivor parser out-of-column, split-cell, participant-region, stray-row and no-pick-entrant regressions passed');


// ================= Seeded property test: realistic generated sheets parse to their exact ground truth =================
// Centered team codes (Helvetica-like widths), 8-12pt fonts, 24-40pt Week columns (text always fits its column),
// 4-18 sheet weeks, 20-250 entries across pages with the header only on page 1, +-1.8pt baselines, split "LA"+"C"
// items, blank-pick entrants anywhere, and a sheet title above the header.
{
  const TEAMS=['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];
  const EM={A:.667,B:.667,C:.722,D:.722,E:.667,F:.611,G:.778,H:.722,I:.278,J:.5,K:.667,L:.556,M:.833,N:.722,O:.778,P:.667,Q:.778,R:.722,S:.667,T:.611,U:.722,V:.667,W:.944,X:.667,Y:.667,Z:.611,' ':.278};
  const width=(s,fs)=>[...s].reduce((a,c)=>a+(EM[c]??.556),0)*fs;
  let seed=20260924;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;const pick=a=>a[Math.floor(rnd()*a.length)];
  for(let t=0;t<150;t++){
    const fs=8+rnd()*4,gap=Math.max(24+rnd()*16,fs*2.6),weeks=4+Math.floor(rnd()*15),cur=1+Math.floor(rnd()*Math.min(weeks,6)),n=20+Math.floor(rnd()*230);
    const firstCenter=130+rnd()*40,centers=Array.from({length:weeks},(_,i)=>firstCenter+i*gap),nameX=15+rnd()*10,pitch=Math.max(fs*1.25,9+rnd()*6),perPage=40+Math.floor(rnd()*40);
    const entries=Array.from({length:n},(_,i)=>({name:i<3?['D.C.','DJS','Thaddius'][i]:`Person ${i}`,picks:[]})).sort(()=>rnd()-0.5);
    for(const e of entries){
      const blank=rnd()<0.04,used=new Set();
      for(let w=0;w<cur;w++){
        if(blank||(w>0&&e.picks[w-1]===null)||(w===cur-1&&rnd()<0.15)){e.picks.push(null);continue}
        let team=pick(TEAMS);while(used.has(team))team=pick(TEAMS);used.add(team);e.picks.push(team);
      }
    }
    entries[0].picks[cur-1]=entries[0].picks[cur-1]||'KC';
    const pages=[];let items=[],y=760,onPage=0;
    items.push({str:'Suicide Pool',x:nameX,y:y+20},{str:'Week',x:nameX+60,y});
    centers.forEach((c,i)=>items.push({str:String(i+1),x:c-width(String(i+1),fs)/2,y}));
    y-=pitch;
    for(const e of entries){
      if(onPage>=perPage){pages.push(items);items=[];y=740;onPage=0}
      const jitter=rnd()<0.5?0:-1.8,rowItems=[{str:e.name,x:nameX,y}];
      e.picks.forEach((team,w)=>{
        if(!team)return;
        if(team==='LAC'&&rnd()<0.5){const s=centers[w]-width('LA C',fs)/2;rowItems.push({str:'LA',x:s,y:y+jitter},{str:'C',x:s+width('LA ',fs),y:y+jitter})}
        else rowItems.push({str:team,x:centers[w]-width(team,fs)/2,y:y+jitter});
      });
      // pdf.js item order is not guaranteed: sometimes the (lower) pick baseline comes before the name.
      items.push(...(rnd()<0.5?rowItems:[...rowItems.slice(1),rowItems[0]]));
      y-=pitch;onPage++;
    }
    pages.push(items);
    const parsed=parseSurvivorPages(pages.map((its,i)=>({pageNumber:i+1,rows:groupSurvivorPdfTextItems(its.map(it=>({str:it.str,transform:[1,0,0,1,it.x,it.y]})))})),{season:2026,filename:'generated.pdf'});
    const label=`generated sheet ${t} (fs ${fs.toFixed(1)}, gap ${gap.toFixed(1)}, ${weeks} weeks, ${n} entries, ${pages.length} pages)`;
    assert.deepEqual(parsed.errors,[],label);
    assert.equal(parsed.config.week,cur,label);
    assert.equal(parsed.config.competitionSize,n,label);
    assert.equal(parsed.config.currentWeekEntryCount,entries.filter(e=>e.picks[cur-1]).length,label);
    const truth=new Map(entries.map(e=>[e.name,e.picks]));
    for(const tracked of parsed.config.trackedEntries)assert.deepEqual(tracked.picks,truth.get({dc:'D.C.',djs:'DJS',thaddeus:'Thaddius'}[tracked.id]),label);
    const expectedField=entries.filter(e=>!['D.C.','DJS','Thaddius'].includes(e.name)).map(e=>JSON.stringify(e.picks));
    assert.deepEqual(parsed.config.fieldEntries.map(e=>JSON.stringify(e.picks)),expectedField,label);
    assert.deepEqual(parsed.review.detachedRows,[],label);assert.deepEqual(parsed.review.unanchoredRows,[],label);
  }
}

console.log('survivor parser seeded realistic-sheet property test passed');


// ================= Rows with picks must prove participant-table membership =================
// A valid team code in a Week column never proves on its own that a row is a participant. Production geometry: names at
// x 20, Week-1 text 8pt left of its header, the pick baseline 1.8pt below the name baseline, a 12pt row grid.
{
  const item=(str,x,y)=>({str,transform:[1,0,0,1,x,y]});
  const heading=(y=760)=>header.parts.map(p=>item(p.text,p.x,y));
  const entry=(name,y,picks=[])=>[item(name,20,y),...picks.map((t,i)=>item(t,151+33*i,y-1.8))];
  const table=(top=748)=>[['D.C.','PIT'],['DJS','LV'],['Thaddius','LAC'],['Alpha','JAX']].flatMap(([n,t],i)=>entry(n,top-12*i,[t]));
  const sheet=(...pages)=>parseSurvivorPages(pages.map((items,i)=>({pageNumber:i+1,rows:groupSurvivorPdfTextItems(items)})),{season:2026});
  const separated=(name,page=1)=>name+': row with picks is separated from the participant row grid on page '+page+'; table membership cannot be proven';
  const squeezed=(name,beside)=>name+': row with picks is squeezed off the participant row grid beside '+beside+'; table membership cannot be proven';
  const noReview=r=>{for(const key of ['blankEntrants','ignoredRows','detachedRows','unanchoredRows','symbolRows'])assert.deepEqual(r.review[key],[],key)};

  // P1 blocker: four real Week-1 rows on a proven 12pt grid, then "Legend" / KC in the name and Week-1 columns 112pt below
  // the last real row. It never becomes entrant 5 silently: the parser fails closed and names the row.
  const control=sheet([...heading(),...table()]);
  assert.deepEqual(control.errors,[]);assert.equal(control.competitionSize,4);assert.equal(control.review.geometry.rowPitch,12);noReview(control);
  const blocker=sheet([...heading(),...table(),...entry('Legend',712-112,['KC'])]);
  assert.deepEqual(blocker.errors,[separated('Legend')]);
  assert.equal(blocker.competitionSize,4);assert.equal(blocker.config.fieldEntries.length,1);
  // Far below at any distance, on or off the row lattice (9 or 2 row slots on it, 1.5 or 1.75 slots off it).
  for(const d of [108,24,21,18,60.5])assert.deepEqual(sheet([...heading(),...table(),...entry('Legend',712-d,['KC'])]).errors,[separated('Legend')],`${d}pt below`);
  // Detached above the table: between the Week header and the first participant, and above a later page's table.
  assert.deepEqual(sheet([...heading(),...entry('Legend',745,['KC']),...table(700)]).errors,[separated('Legend')]);
  const aboveP2=sheet([...heading(),...table()],[...entry('Legend',790,['KC']),...entry('Charlie',700,['NE']),...entry('Delta',688,['MIA'])]);
  assert.deepEqual(aboveP2.errors,[separated('Legend',2)]);assert.equal(aboveP2.competitionSize,6);
  // Off the lattice between two real rows: only the squeezed row is blamed; the table on both sides stays one run.
  const between=sheet([...heading(),...table(),...entry('Legend',706,['KC']),...entry('Bravo',700,['NE']),...entry('Charlie',688,['MIA'])]);
  assert.deepEqual(between.errors,[squeezed('Legend','Alpha')]);assert.equal(between.competitionSize,6);
  // Squeezed against a real blank entrant, even within the grid tolerance of its slot: never counted in its place.
  for(const y of [697,697.5]){
    const beside=sheet([...heading(),...table(),...entry('Blank One',700),...entry('Legend',y,['KC']),...entry('Charlie',688,['MIA'])]);
    assert.deepEqual(beside.errors,[squeezed('Legend','Blank One')],`${y}`);
  }
  // Two strays forming their own run are still separated from the page's participant run.
  const pair=sheet([...heading(),...table(),...entry('Legend',600,['KC']),...entry('Notes',588,['NE'])]);
  assert.deepEqual(pair.errors,[separated('Legend'),separated('Notes')]);assert.equal(pair.competitionSize,4);

  // A normal participant on the next grid slot is accepted with no review item: picks alone never ask for confirmation.
  const normal=sheet([...heading(),...table(),...entry('Bravo',700,['NE'])]);
  assert.deepEqual(normal.errors,[]);assert.equal(normal.competitionSize,5);noReview(normal);
  // First and last participants need only one neighbour, including through blank entrants on the grid.
  const edges=sheet([...heading(),...entry('First',748,['KC']),...entry('Blank Top',736),...table(724),...entry('Blank Bottom',676),...entry('Last',664,['NE'])]);
  assert.deepEqual(edges.errors,[]);assert.equal(edges.competitionSize,8);assert.deepEqual(edges.review.blankEntrants.map(x=>x.label),['Blank Top','Blank Bottom']);
  // One entirely empty row slot (no text at all) is a two-pitch step, which the row-grid continuity model (steps of at
  // most 1.75 pitch) cannot bridge: the continuation is unproven and fails closed rather than being guessed. The same
  // slot holding a blank entrant is ordinary continuity.
  assert.deepEqual(sheet([...heading(),...table(),...entry('Bravo',688,['NE'])]).errors,[separated('Bravo')]);
  const filled=sheet([...heading(),...table(),...entry('Blank Middle',700),...entry('Bravo',688,['NE'])]);
  assert.deepEqual(filled.errors,[]);assert.equal(filled.competitionSize,6);
  // A later page is its own grid: no y relationship to page 1 is required.
  const p2=sheet([...heading(),...table()],[...entry('Charlie',300,['NE']),...entry('Delta',288,['MIA']),...entry('Echo',276)]);
  assert.deepEqual(p2.errors,[]);assert.equal(p2.competitionSize,7);assert.deepEqual(p2.review.blankEntrants.map(x=>x.label),['Echo']);
  assert.deepEqual(sheet([...heading(),...table()],[...entry('Charlie',780,['NE']),...entry('Delta',768,['MIA']),...entry('Legend',600,['KC'])]).errors,[separated('Legend',2)]);
  // Two unconnected rows with picks on one page cannot both be proven, and neither is preferred.
  assert.deepEqual(sheet([...heading(),...table()],[...entry('Echo',780,['NE']),...entry('Legend',500,['KC'])]).errors,[separated('Echo',2),separated('Legend',2)]);

  // Unavoidable ambiguity (documented, not guessed): a row that is physically identical to a participant - name in the
  // name column, team in a Week column, on the next row-grid slot within the grid's own tolerance - is counted, and so is
  // the only row with picks on a page, which is identical to a lone continuation row. Telling such a "Legend" from a real
  // entrant would need semantic inference, which the parser deliberately does not do.
  assert.equal(sheet([...heading(),...table(),...entry('Legend',700,['KC'])]).competitionSize,5);
  assert.equal(sheet([...heading(),...entry('Legend',712,['KC']),...table(700)]).competitionSize,5);
  const lone=sheet([...heading(),...table()],[...entry('Legend',500,['KC'])]);
  assert.deepEqual(lone.errors,[]);assert.equal(lone.competitionSize,5);

  // R5-PG-2 sweep: wherever a single stray row with picks lands near the table (below it, below trailing blank entrants,
  // above it, or in an empty slot), it is either within the grid's own tolerance of a free slot next to the run (the
  // documented ambiguity above) or the sheet fails closed without counting it. Nothing in between.
  const slot=d=>d>9&&d<15;
  for(let d=0.5;d<=150;d+=0.5){
    const below=sheet([...heading(),...table(),...entry('Legend',712-d,['KC'])]);
    if(slot(d)){assert.deepEqual(below.errors,[],`below ${d}`);assert.equal(below.competitionSize,5,`below ${d}`)}
    else{assert(below.errors.length,`below ${d}`);assert.equal(below.competitionSize,4,`below ${d}`)}
    const trailing=sheet([...heading(),...table(),...entry('Blank A',700),...entry('Blank B',688),...entry('Legend',688-d,['KC'])]);
    if(slot(d)){assert.deepEqual(trailing.errors,[],`trailing ${d}`);assert.equal(trailing.competitionSize,7,`trailing ${d}`)}
    else{assert(trailing.errors.length,`trailing ${d}`);assert(trailing.competitionSize<=6,`trailing ${d}`)}
    if(d<55){
      const above=sheet([...heading(),...table(700),...entry('Legend',700+d,['KC'])]);
      if(slot(d)){assert.deepEqual(above.errors,[],`above ${d}`);assert.equal(above.competitionSize,5,`above ${d}`)}
      else{assert(above.errors.length,`above ${d}`);assert.equal(above.competitionSize,4,`above ${d}`)}
    }
    if(d<24){
      const gap=sheet([...heading(),...table(),...entry('Legend',712-d,['KC']),...entry('Bravo',688,['NE'])]);
      if(slot(d)){assert.deepEqual(gap.errors,[],`gap ${d}`);assert.equal(gap.competitionSize,6,`gap ${d}`)}
      else assert(gap.errors.length,`gap ${d}`);
    }
  }
}

console.log('survivor parser picked-row participant-table membership regressions passed');
