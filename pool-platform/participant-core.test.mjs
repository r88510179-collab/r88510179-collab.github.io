import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeGames,pickemPayloadFromSelections,survivorBurnedTeams,survivorLegalTeams,validateSurvivorSelection,entrySubmissionAccess} from './participant-core.js';
import {validatePickPayload} from './submission-core.js';

const config={games:[
  {id:'g1',away:{key:'a',label:'Austin'},home:{key:'d',label:'Denver'}},
  {id:'g2',away:{key:'p',label:'Phoenix'},home:{key:'s',label:'Seattle'}}
]};

test('game normalization and Pickem payload are stable',()=>{
  assert.equal(normalizeGames(config).length,2);
  assert.deepEqual(pickemPayloadFromSelections({g1:'away',g2:'home'},47),{
    picks:{g1:'away',g2:'home'},tiebreak:47
  });
});

test('Pickem tiebreak entry: blank/whitespace is left out (required fails), 0 and "0" stay 0, 47 stays 47, text is flagged',()=>{
  const selections={g1:'away',g2:'home'},gameIds=['g1','g2'];
  const build=tiebreak=>pickemPayloadFromSelections(selections,tiebreak);
  const required=payload=>validatePickPayload(payload,{gameIds,tiebreakRequired:true});
  const optional=payload=>validatePickPayload(payload,{gameIds,tiebreakRequired:false});
  for(const blank of ['','   ',undefined,null]){
    const payload=build(blank);
    assert.equal(JSON.stringify(payload),'{"picks":{"g1":"away","g2":"home"}}',`blank ${JSON.stringify(blank)} must not become 0`);
    assert.deepEqual(required(payload).errors,[{code:'tiebreak_required'}]);
    assert.equal(optional(payload).ok,true);
  }
  for(const zero of [0,'0',' 0 ']){
    const payload=build(zero);
    assert.deepEqual(payload,{picks:selections,tiebreak:0});
    assert.equal(required(payload).ok,true);
  }
  assert.deepEqual(build('47'),{picks:selections,tiebreak:47});
  assert.deepEqual(build(47),{picks:selections,tiebreak:47});
  for(const bad of ['abc','4.5','-3','201']){
    const payload=build(bad);
    assert.equal(payload.tiebreak,bad);
    assert.deepEqual(required(payload).errors,[{code:'invalid_tiebreak'}]);
    assert.deepEqual(optional(payload).errors,[{code:'invalid_tiebreak'}]);
  }
});

test('Survivor burned teams are excluded from legal choices',()=>{
  const history=[{payload:{team:'a'}},{payload:{team:'s'}}];
  assert.deepEqual([...survivorBurnedTeams(history)],['a','s']);
  const legal=survivorLegalTeams(config,history);
  assert.equal(legal.find(x=>x.key==='a').burned,true);
  assert.equal(legal.find(x=>x.key==='d').burned,false);
  assert.equal(validateSurvivorSelection('a',config,history).code,'team_already_used');
  assert.equal(validateSurvivorSelection('d',config,history).ok,true);
});

test('commissioner-owned submission blocks participant editing',()=>{
  const entry={submission:{source:'commissioner_import',status:'submitted'}};
  assert.deepEqual(entrySubmissionAccess(entry,'open','2027-09-10T12:00:00Z','2027-09-10T23:00:00Z'),{
    editable:false,reason:'commissioner_claimed',source:'commissioner_import'
  });
});

test('participant may update own submission only before deadline',()=>{
  const entry={submission:{source:'participant',status:'submitted'}};
  assert.equal(entrySubmissionAccess(entry,'open','2027-09-10T12:00:00Z','2027-09-10T23:00:00Z').editable,true);
  assert.equal(entrySubmissionAccess(entry,'open','2027-09-10T23:00:00Z','2027-09-10T23:00:00Z').editable,false);
});

// Survivor choices as displayed: [key, display, burned, ambiguous].
const shown=(games,history=[])=>survivorLegalTeams({games},history).map(t=>[t.key,t.display,t.burned,t.ambiguous]);
const NY=[
  {id:'g1',away:{key:'NYG',label:'New York'},home:{key:'DAL',label:'Dallas'}},
  {id:'g2',away:{key:'MIA',label:'Miami'},home:{key:'NYJ',label:'New York'}}
];

test('Survivor display: unique labels are shown as configured',()=>{
  assert.deepEqual(shown(config.games),[['a','Austin',false,false],['d','Denver',false,false],['p','Phoenix',false,false],['s','Seattle',false,false]]);
});

test('Survivor display: two teams sharing a label each show their stable key; the value stays the key',()=>{
  assert.deepEqual(shown(NY),[['NYG','New York (NYG)',false,false],['DAL','Dallas',false,false],['MIA','Miami',false,false],['NYJ','New York (NYJ)',false,false]]);
  assert.equal(validateSurvivorSelection('NYJ',{games:NY}).ok,true);
  assert.equal(validateSurvivorSelection('NYG',{games:NY}).ok,true);
  assert.equal(validateSurvivorSelection('New York (NYJ)',{games:NY}).code,'unknown_team','the display text is never a submittable value');
  assert.equal(validateSurvivorSelection('New York',{games:NY}).code,'unknown_team');
});

test('Survivor display: three teams sharing a label are all told apart by key',()=>{
  const games=[{id:'g1',away:{key:'M1',label:'Metro'},home:{key:'M2',label:'Metro'}},{id:'g2',away:{key:'M3',label:'Metro'},home:{key:'x',label:'Xville'}}];
  assert.deepEqual(shown(games),[['M1','Metro (M1)',false,false],['M2','Metro (M2)',false,false],['M3','Metro (M3)',false,false],['x','Xville',false,false]]);
});

test('Survivor display: a used team still counts, so the remaining same-label team shows its key',()=>{
  const history=[{week:1,payload:{team:'NYG'}}];
  assert.deepEqual(shown(NY,history),[['NYG','New York (NYG)',true,false],['DAL','Dallas',false,false],['MIA','Miami',false,false],['NYJ','New York (NYJ)',false,false]]);
  assert.equal(validateSurvivorSelection('NYG',{games:NY},history).code,'team_already_used');
  assert.equal(validateSurvivorSelection('NYJ',{games:NY},history).ok,true);
});

test('Survivor display: labels that differ only in case or spacing match as the import matches them, so they show keys',()=>{
  const games=[{id:'g1',away:{key:'NYG',label:'New York'},home:{key:'NYJ',label:'NEW YORK'}},{id:'g2',away:{key:'NYC',label:'new  york'},home:{key:'b',label:'Boston'}}];
  assert.deepEqual(shown(games),[['NYG','New York (NYG)',false,false],['NYJ','NEW YORK (NYJ)',false,false],['NYC','new  york (NYC)',false,false],['b','Boston',false,false]]);
});

test('Survivor display: markup in a label or key is kept verbatim as text for the page to escape',()=>{
  const tag='<img src=x onerror="window.__xss=1">',games=[{id:'g1',away:{key:tag,label:'Twin'},home:{key:'<b>k</b>',label:'Twin'}},{id:'g2',away:{key:'s',label:tag},home:{key:'t',label:'Tee'}}];
  assert.deepEqual(shown(games),[[tag,`Twin (${tag})`,false,false],['<b>k</b>','Twin (<b>k</b>)',false,false],['s',tag,false,false],['t','Tee',false,false]]);
  assert.equal(validateSurvivorSelection(tag,{games}).ok,true);
});

test('Survivor display: a plain label equal to an appended one is appended too; a blank label shows its key',()=>{
  const games=[{id:'g1',away:{key:'NYG',label:'New York'},home:{key:'NYJ',label:'New York'}},{id:'g2',away:{key:'X',label:'New York (NYG)'},home:{key:'Q',label:''}}];
  assert.deepEqual(shown(games),[['NYG','New York (NYG)',false,false],['NYJ','New York (NYJ)',false,false],['X','New York (NYG) (X)',false,false],['Q','Q',false,false]]);
});

test('Survivor display: choices that still read alike after keys are added cannot be picked (fail closed)',()=>{
  const games=[{id:'g1',away:{key:'NYG',label:'New York'},home:{key:'nyg',label:'New York'}},{id:'g2',away:{key:'a',label:'Austin'},home:{key:'d',label:'Denver'}}];
  assert.deepEqual(shown(games).slice(0,2),[['NYG','New York (NYG)',false,true],['nyg','New York (nyg)',false,true]]);
  assert.equal(validateSurvivorSelection('NYG',{games}).code,'ambiguous_team');
  assert.equal(validateSurvivorSelection('a',{games}).ok,true);
  const crafted=[{id:'g1',away:{key:'C',label:'A (B)'},home:{key:'Z',label:'A (B)'}},{id:'g2',away:{key:'B) (C',label:'A'},home:{key:'Y',label:'A'}}];
  assert.deepEqual(shown(crafted),[['C','A (B) (C)',false,true],['Z','A (B) (Z)',false,false],['B) (C','A (B) (C)',false,true],['Y','A (Y)',false,false]]);
});
