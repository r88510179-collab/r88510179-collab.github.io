import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const parserSource=readFileSync(new URL('./parser-core.js',import.meta.url),'utf8');
const parserUrl='data:text/javascript;base64,'+Buffer.from(parserSource).toString('base64');
const {carryForwardWeekHints,parseDocumentGroups,validateConfig}=await import(parserUrl);

const matchups=[
  '1) Panthers at 2) Falcons',
  '3) Saints at 4) Ravens',
  '5) Vikings at 6) Bears',
  '7) Bengals at 8) Texans',
  '9) Steelers at 10) Patriots',
  '11) Packers at 12) Jets',
  '13) Browns at 14) Buccaneers',
  '15) Eagles at 16) Titans',
  '17) Jaguars at 18) Broncos',
  '19) Raiders at 20) Chargers',
  '21) Seahawks at 22) Cardinals',
  '23) Commanders at 24) Cowboys',
  '25) Dolphins at 26) 49ers',
  '27) Colts at 28) Chiefs',
  '29) Giants at 30) Rams',
];

const tracked=[
  'D.C. 1 3 5 7 9 11 13 15 17 19 21 23 25 27 29 42 0',
  'JC 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 48 0',
  'DJS 1 4 5 8 9 12 13 16 17 20 21 24 25 28 29 45 0',
  'Thaddius 2 3 6 7 10 11 14 15 18 19 22 23 26 27 30 46 0',
];

function parse(lines){
  return parseDocumentGroups([{week:2,lines}],{filename:'fixture.pdf',season:2026})[0];
}

{
  const candidate=parse([
    ...matchups,
    '99 DC Smith 2 4 6 8 10 12 14 16 18 20 22 24 26 28 30 99 0',
    ...tracked,
  ]);
  assert.deepEqual(candidate.errors,[]);
  const dc=candidate.config.participants.find(p=>p.id==='dc');
  assert.equal(dc.sourceName,'D.C.');
  assert.equal(dc.tiebreak,42);
  assert.deepEqual(dc.pickNumbers,[1,3,5,7,9,11,13,15,17,19,21,23,25,27,29]);
}

{
  const groups=carryForwardWeekHints([
    {week:2,lines:['Week 2']},
    {week:null,lines:tracked},
    {week:null,lines:matchups},
  ]);
  assert.deepEqual(groups.map(g=>g.week),[2,2,2]);
  const candidate=parseDocumentGroups(groups,{filename:'continuation.pdf',season:2026})[0];
  assert.deepEqual(candidate.errors,[]);
  assert.equal(candidate.gameCount,15);
  assert.equal(candidate.config.participants.length,4);
}

{
  const candidate=parse([...matchups,...tracked,tracked[0]]);
  assert(candidate.errors.includes('Multiple D.C. rows found'));
}

{
  const duplicate=[...matchups];
  duplicate[14]='29) Panthers at 30) Falcons';
  const candidate=parse([...duplicate,...tracked]);
  assert(candidate.errors.some(e=>e==='Duplicate matchup teams CAR-ATL'));
}

{
  const candidate=parse([...matchups,...tracked]);
  const config=structuredClone(candidate.config);
  config.games[14].away=config.games[0].away;
  config.games[14].home=config.games[0].home;
  const errors=validateConfig(config);
  assert(errors.includes('Duplicate matchup teams CAR-ATL'));
}

{
  const candidate=parse([...matchups,...tracked]);
  const config=structuredClone(candidate.config);
  config.games[14].away='JAC';
  config.games[14].home='DEN';
  const errors=validateConfig(config);
  assert(errors.includes('Duplicate matchup teams JAX-DEN'));
}

console.log('parser-core Week 2 hardening regressions passed');
