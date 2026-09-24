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
  const blankPage=parse(base([],[{pageNumber:2,rows:[at(780,[[20,'Echo']]),at(768,[[20,'Foxtrot']])]}]));
  assert(blankPage.errors.some(e=>/Echo: row has no picks on a page without participant picks/.test(e)));
  // no two rows with picks are adjacent, so the row pitch (and therefore grid membership of blank rows) is unproven
  const noPitch=parse([{pageNumber:1,rows:[header,at(748,[[20,'D.C.'],[151,'PIT'],[184,'SF']]),at(736,[[20,'Golf']]),at(724,[[20,'DJS'],[151,'LV'],[184,'SF']]),at(712,[[20,'Hotel']]),at(700,[[20,'Thaddius'],[151,'LAC']])]}]);
  assert.deepEqual(noPitch.errors,['Golf: row has no picks and the Survivor row spacing could not be proven','Hotel: row has no picks and the Survivor row spacing could not be proven']);
  // a blank row far below widely spaced rows is off the grid and surfaced as separated
  const wide=parse([{pageNumber:1,rows:[header,at(748,[[20,'D.C.'],[151,'PIT'],[184,'SF']]),at(700,[[20,'DJS'],[151,'LV'],[184,'SF']]),at(652,[[20,'Thaddius'],[151,'LAC']]),at(640,[[20,'Golf']])]}]);
  assert.deepEqual(wide.errors,[]);assert.deepEqual(wide.review.detachedRows.map(x=>x.label),['Golf']);
  // a label squeezed off-grid between the header and the first entry is not an entrant
  const squeezed=parse([{pageNumber:1,rows:[header,at(755,[[20,'Name']]),at(748,[[20,'D.C.'],[151,'PIT'],[184,'SF']]),at(736,[[20,'DJS'],[151,'LV'],[184,'SF']]),at(724,[[20,'Thaddius'],[151,'LAC']])]}]);
  assert.deepEqual(squeezed.errors,[]);assert.equal(squeezed.config.competitionSize,3);assert.deepEqual(squeezed.review.detachedRows.map(x=>x.label),['Name']);
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
