import assert from 'node:assert/strict';
import {verifySurvivorSchedule,survivorScheduleWeek,survivorPublishGuard} from './survivor-publish-checks.js';
import {validateSurvivorConfig} from './survivor-parser.js';
import {survivorEntryState,survivorSummary} from '../survivor-math.js';

// Fixture schedules (synthetic pairings, away team wins every final).
const W1=[['PIT','CLE'],['LV','NE'],['KC','LAC'],['JAX','CAR'],['ARI','ATL'],['BAL','BUF'],['CHI','CIN'],['DAL','DEN'],['DET','GB'],['HOU','IND'],['LAR','MIA'],['MIN','NO'],['NYG','NYJ'],['PHI','SEA'],['SF','TB'],['TEN','WAS']];
const W2=[['SF','ARI'],['ATL','BAL'],['BUF','CAR'],['CHI','CIN'],['CLE','DAL'],['DEN','DET'],['GB','HOU'],['IND','JAX'],['KC','LV'],['LAC','LAR'],['MIA','MIN'],['NE','NO'],['NYG','NYJ'],['PHI','PIT'],['SEA','TB'],['TEN','WAS']];
const event=(away,home,{state='post',as='24',hs='10',week,season,id}={})=>({
  ...(id?{id}:{}),...(week!==undefined?{week:{number:week}}:{}),...(season!==undefined?{season:{year:season,type:2}}:{}),
  status:{type:{completed:state==='post',state}},
  competitions:[{competitors:[{homeAway:'away',team:{abbreviation:away},score:as},{homeAway:'home',team:{abbreviation:home},score:hs}]}]
});
const payload=(pairs,week,opts={})=>({season:{year:2026,type:2},week:{number:week},events:pairs.map(([a,h],i)=>event(a,h,{week,season:2026,id:`${week}-${i}`,...(typeof opts.state==='function'?{state:opts.state(i)}:opts)}))});

// Production-shaped Week 2: 247 entries, 161 alive entering, 160 Week-2 selections, 98 alive after Week 2.
function productionWeek2(){
  const field=[];
  for(let i=0;i<85;i++)field.push(['CLE',null]);
  for(let i=0;i<96;i++)field.push(['JAX','SF']);
  for(let i=0;i<62;i++)field.push(['JAX','ARI']);
  field.push(['JAX',null]);
  const tracked=[{id:'dc',displayName:'D.C.',picks:['PIT','SF']},{id:'djs',displayName:'DJS',picks:['LV','SF']},{id:'thaddeus',displayName:'Thaddeus',picks:['LAC',null]}];
  const fieldEntries=field.map((picks,i)=>({id:'survivor-'+String(i+1).padStart(3,'0'),picks}));
  const all=[...tracked,...fieldEntries];
  return{schemaVersion:1,season:2026,week:2,label:'Survivor Week 2',competitionSize:all.length,currentWeekEntryCount:all.filter(e=>e.picks[1]).length,sheetWeeks:18,trackedEntries:tracked,fieldEntries,source:{kind:'survivor-upload',filename:'w2.pdf'}};
}
function week1Of(config){
  const clone=structuredClone(config);
  clone.week=1;clone.label='Survivor Week 1';
  for(const e of [...clone.trackedEntries,...clone.fieldEntries])e.picks=e.picks.slice(0,1);
  clone.currentWeekEntryCount=[...clone.trackedEntries,...clone.fieldEntries].filter(e=>e.picks[0]).length;
  return clone;
}

const config=productionWeek2();
assert.deepEqual(validateSurvivorConfig(config),[]);
assert.equal(config.competitionSize,247);
assert.equal(config.currentWeekEntryCount,160);
const payloads={1:payload(W1,1),2:payload(W2,2)};

// ---- Schedule verification succeeds for a schedule-consistent sheet and returns verified results.
{
  const v=verifySurvivorSchedule(config,payloads);
  assert.deepEqual(v.errors,[]);assert.equal(v.ok,true);
  const all=[...config.trackedEntries,...config.fieldEntries];
  const summary=survivorSummary(all,1,v.resultsByWeek);
  assert.equal(summary.poolSize,247);assert.equal(summary.eligibleEntering,161);assert.equal(summary.submitted,160);assert.equal(summary.active,98);assert.equal(summary.pending,0);
  const state=id=>survivorEntryState(config.trackedEntries.find(x=>x.id===id),1,v.resultsByWeek);
  assert.equal(state('dc').status,'alive');assert.equal(state('djs').status,'alive');
  assert.deepEqual(state('thaddeus'),{status:'out',pick:'LAC',week:1,eliminatedWeek:1,reason:'LAC lost in Week 1',type:'loss'});
  // Array and Map payload containers are equivalent.
  assert.equal(verifySurvivorSchedule(config,[payloads[1],payloads[2]]).ok,true);
  assert.equal(verifySurvivorSchedule(config,new Map([[1,payloads[1]],[2,payloads[2]]])).ok,true);
}

// ---- Bye / nonexistent-team picks cannot publish, current week or historical.
{
  const byeW2={...payloads,2:payload(W2.filter(([a,h])=>a!=='SF'&&h!=='SF'),2)};
  const v=verifySurvivorSchedule(config,byeW2);
  assert.equal(v.ok,false);
  const msg=v.errors.find(e=>e.startsWith('Week 2: SF'));
  assert(msg,'current-week bye pick is reported');
  assert.match(msg,/not scheduled in verified NFL Week 2 \(bye or invalid team\) — 98 entries: D\.C\., DJS, survivor-086/);
  assert.match(msg,/\+90 more/);
  assert.equal(msg.includes('Alpha'),false);
  const byeW1={...payloads,1:payload(W1.filter(([a])=>a!=='LV'),1)};
  const h=verifySurvivorSchedule(config,byeW1);
  assert(h.errors.some(e=>/^Week 1: (LV|NE) is not scheduled/.test(e)&&e.includes('DJS')),'historical bye pick is reported');
}

// ---- Missing, empty, wrong-context, ambiguous and malformed schedules fail closed.
{
  const cases=[
    [{1:payloads[1]},/NFL Week 2 schedule could not be loaded/],
    [{...payloads,2:{events:[]}},/Week 2 feed returned no games/],
    [{...payloads,2:{}},/Week 2 feed returned no event list/],
    [{...payloads,2:{...payload(W2,2),week:{number:3}}},/context mismatch: week 3/],
    [{...payloads,2:{...payload(W2,2),season:{year:2025,type:2}}},/season year 2025/],
    [{...payloads,2:{...payload(W2,2),season:{year:2026,type:1}}},/season type 1/],
    [{...payloads,2:{events:payload(W2,2).events.map((e,i)=>i===3?{...e,week:{number:1}}:e)}},/CHI at CIN is outside the expected context: week 1/],
    [{...payloads,2:{events:[...payload(W2,2).events,event('SF','DAL')]}},/lists SF in 2 games; schedule is ambiguous/],
    [{...payloads,2:{events:[...payload(W2,2).events,event('KC','XXX')]}},/malformed game/],
    [{...payloads,2:{events:[...payload(W2,2).events,{competitions:[{competitors:[{homeAway:'away',team:{abbreviation:'SF'}}]}]}]}},/malformed game/]
  ];
  for(const [p,pattern] of cases){
    const v=verifySurvivorSchedule(config,p);
    assert.equal(v.ok,false,String(pattern));assert(v.errors.some(e=>pattern.test(e)),`${pattern} in ${v.errors.join(' | ')}`);
  }
  // Context fields are optional: a feed that exposes none is still verified by team/game structure.
  const bare={1:{events:W1.map(([a,h])=>event(a,h))},2:{events:W2.map(([a,h])=>event(a,h))}};
  assert.equal(verifySurvivorSchedule(config,bare).ok,true);
  assert.equal(survivorScheduleWeek(bare[2],{season:2026,week:2}).teams.size,32);
  // A requested week beyond the NFL regular season is refused outright.
  assert.equal(verifySurvivorSchedule({...config,week:19},{}).ok,false);
}

// ---- Partial-week guard.
const verified=verifySurvivorSchedule(config,payloads);
const games2=survivorScheduleWeek(payloads[2],{season:2026,week:2}).games;
const lockedRow=(cfg,revision=1)=>({season:cfg.season,week:cfg.week,status:'locked',revision,config:cfg});
const published=(...rows)=>({checked:true,rows});
const w1Published=published(lockedRow(week1Of(config)));
const guardFor=(cfg,opts={})=>survivorPublishGuard(cfg,{resultsByWeek:verified.resultsByWeek,currentGames:games2,published:w1Published,...opts});
{
  // Production Week 2: one alive entry has no Week 2 pick -> explicit confirmation with exact counts.
  const before=JSON.stringify(config);
  const g=guardFor(config);
  assert.equal(JSON.stringify(config),before,'guard never mutates the config');
  assert.equal(g.aliveEntering,161);assert.equal(g.picksAlive,160);assert.equal(g.missingAlive,1);assert.equal(g.unresolvedEntering,0);assert.equal(g.picksFromEliminated,0);assert.equal(g.noPickOuts,1);
  assert.deepEqual(g.blocking,[]);assert.equal(g.requiresConfirmation,true);
  assert.deepEqual(g.reasons,['1 of 161 entries alive entering Week 2 has no Week 2 pick. Publishing shows it OUT (no pick) in Week 2.']);
  assert.equal(g.facts[0],'161 entries are proven alive entering Week 2 from verified Week 1 NFL results; 160 of them have a Week 2 pick.');
  assert(g.facts.includes('16 of 16 NFL Week 2 games have kicked off.'));
  assert(g.facts.includes('Published Survivor weeks visible for 2026: 1.'));
  assert(g.facts.includes('Entry count and Week 1 pick histories match published Week 1 (revision 1).'));
  assert.equal(g.confirmText,'I reviewed every item listed above and confirm this sheet is the final Survivor Week 2 submission set — no more Week 2 picks will be added. Publishing shows 1 entry OUT for no pick (Week 2).');
}
{
  // Complete sheet consistent with published Week 1: no confirmation.
  const complete=structuredClone(config);complete.fieldEntries[243].picks[1]='SF';complete.currentWeekEntryCount=161;
  const g=guardFor(complete);
  assert.equal(g.requiresConfirmation,false);assert.deepEqual(g.reasons,[]);assert.deepEqual(g.blocking,[]);
}
{
  // Tracked entries among missing picks are named (tracked names only; anonymous entries never are).
  const dcBlank=structuredClone(config);dcBlank.trackedEntries[0].picks[1]=null;dcBlank.currentWeekEntryCount--;
  assert.match(guardFor(dcBlank).reasons[0],/^2 of 161 entries alive entering Week 2 have no Week 2 pick \(including D\.C\.\)\. Publishing shows them OUT \(no pick\) in Week 2\.$/);
}
{
  // Thursday-style premature export: only a handful of picks and most games not kicked off.
  const early=structuredClone(config);
  [...early.trackedEntries,...early.fieldEntries].forEach((e,i)=>{if(i>12)e.picks[1]=null});
  early.currentWeekEntryCount=[...early.trackedEntries,...early.fieldEntries].filter(e=>e.picks[1]).length;
  const pre=survivorScheduleWeek(payload(W2,2,{state:i=>i===0?'post':'pre'}),{season:2026,week:2}).games;
  const g=guardFor(early,{currentGames:pre});
  assert.equal(g.requiresConfirmation,true);assert.equal(g.notStarted,15);
  assert.match(g.reasons[0],/^159 of 161 entries alive entering Week 2 have no Week 2 pick\. Publishing shows them OUT \(no pick\) in Week 2\. 15 of 16 Week 2 games have not kicked off yet, so this export may be premature\.$/);
  assert.match(g.confirmText,/Publishing shows 159 entries OUT for no pick \(Week 2\)\./);
  assert.match(guardFor(early,{currentGames:null}).reasons[0],/Kickoff status for Week 2 could not be confirmed\./);
}
{
  // Week 1: everyone enters; blank Week-1 entrants are no-pick OUTs that need confirmation.
  const w1=week1Of(config);
  const g=survivorPublishGuard(w1,{resultsByWeek:[],currentGames:survivorScheduleWeek(payloads[1],{season:2026,week:1}).games,published:published()});
  assert.equal(g.aliveEntering,247);assert.equal(g.missingAlive,0);assert.equal(g.requiresConfirmation,false);
  assert(g.facts.includes('No published Survivor weeks are visible for 2026.'));
  const blank=structuredClone(w1);blank.fieldEntries[5].picks[0]=null;blank.currentWeekEntryCount--;
  assert.deepEqual(survivorPublishGuard(blank,{resultsByWeek:[],currentGames:[],published:published()}).reasons,['1 of 247 entries alive entering Week 1 has no Week 1 pick. Publishing shows it OUT (no pick) in Week 1.']);
}
{
  // Skipped / never-published weeks: a stray later-column token cannot hide earlier no-pick eliminations.
  const w3=structuredClone(config);w3.week=3;w3.label='Survivor Week 3';w3.sheetWeeks=18;
  for(const e of [...w3.trackedEntries,...w3.fieldEntries])e.picks=[...e.picks,null];
  w3.fieldEntries[100].picks[2]='KC';w3.currentWeekEntryCount=1;
  const v3=verifySurvivorSchedule(w3,{...payloads,3:{events:W2.map(([a,h])=>event(a,h))}});
  assert.equal(v3.ok,true);
  const g=survivorPublishGuard(w3,{resultsByWeek:v3.resultsByWeek,currentGames:[],published:w1Published});
  assert.equal(g.priorWeek,1);
  assert(g.reasons.includes('1 of 161 entries alive entering Week 2 has no Week 2 pick, and Week 2 has never been published. Publishing shows it OUT (no pick) in Week 2.'),g.reasons.join(' | '));
  assert(g.reasons.some(r=>/^97 of 98 entries alive entering Week 3 have no Week 3 pick \(including D\.C\., DJS\)/.test(r)),g.reasons.join(' | '));
  assert(g.reasons.includes('Survivor Week 2 has never been published; this sheet becomes the first published record of that week.'));
  assert.equal(g.noPickOuts,98);
  // Week 2 published instead: only Week 3 blanks are new.
  const g2=survivorPublishGuard(w3,{resultsByWeek:v3.resultsByWeek,currentGames:[],published:published(lockedRow(week1Of(config)),lockedRow(config))});
  assert.equal(g2.priorWeek,2);assert.equal(g2.noPickOuts,97);assert.equal(g2.reasons.some(r=>r.includes('never been published')),false);
  // First-ever publication at a later week lists every week it creates.
  const g0=survivorPublishGuard(w3,{resultsByWeek:v3.resultsByWeek,currentGames:[],published:published()});
  assert(g0.reasons.includes('No published Survivor week before Week 3 exists to compare this sheet against.'));
  assert.equal(g0.noPickOuts,98);
}
{
  // Unresolved earlier result: entries missing a current pick are disclosed as possible no-pick OUTs.
  const badW1={...payloads,1:{...payload(W1,1),events:payload(W1,1).events.map(e=>e.competitions[0].competitors[0].team.abbreviation==='JAX'?event('JAX','CAR',{as:null,hs:null}):e)}};
  const v=verifySurvivorSchedule(config,badW1);
  assert.equal(v.ok,true,'schedule itself is still valid');
  const g=survivorPublishGuard(config,{resultsByWeek:v.resultsByWeek,currentGames:games2,published:w1Published});
  assert.equal(g.unresolvedEntering,159);assert.equal(g.missingUnresolved,1);assert.equal(g.requiresConfirmation,true);
  assert(g.reasons.includes('1 entry with no Week 2 pick cannot yet be proven alive or out (an earlier result is not verifiable in the feed); it will show OUT (no pick) in Week 2 if it survives.'),g.reasons.join(' | '));
  assert.match(g.confirmText,/Publishing shows 0 entries OUT for no pick, and up to 1 more once earlier results are final \(Week 2\)\./);
  // Unresolved entries that all have a current pick are information, not a confirmation trigger.
  const complete=structuredClone(config);complete.fieldEntries[243].picks[1]='SF';complete.currentWeekEntryCount=161;
  const g2=survivorPublishGuard(complete,{resultsByWeek:v.resultsByWeek,currentGames:games2,published:w1Published});
  assert.equal(g2.requiresConfirmation,false);assert(g2.facts.includes('159 entries are not yet proven alive or out entering Week 2; all of them have a Week 2 pick.'));
}
{
  // Eliminated entries that still show a current-week pick are surfaced, grouped by how they were eliminated.
  const odd=structuredClone(config);odd.fieldEntries[0].picks[1]='KC';odd.fieldEntries[1].picks[1]='KC';odd.trackedEntries[2].picks[1]='BUF';odd.currentWeekEntryCount+=3;
  const g=guardFor(odd);
  assert.equal(g.picksFromEliminated,3);
  assert(g.reasons.includes("3 entries already eliminated before Week 2 still show a Week 2 pick (2 OUT by CLE's Week 1 loss; 1 OUT by LAC's Week 1 loss). The sheet may disagree with the NFL results; Survivor rules still treat them as OUT."),g.reasons.join(' | '));
}
{
  // Published state: unchecked blocks; history / size / tracked mismatches need confirmation.
  const unchecked=guardFor(config,{published:{checked:false}});
  assert.deepEqual(unchecked.blocking,['Published Survivor weeks for this season have not been checked. Sign in; the comparison runs automatically.']);
  assert.equal(guardFor(config,{published:null}).blocking.length,1);
  const smaller=structuredClone(week1Of(config));smaller.fieldEntries.pop();smaller.competitionSize--;smaller.currentWeekEntryCount--;
  assert(guardFor(config,{published:published(lockedRow(smaller))}).reasons.includes('This sheet has 247 entries but published Week 1 (revision 1) has 246.'));
  const changed=structuredClone(week1Of(config));changed.fieldEntries[100].picks[0]='DET';
  assert(guardFor(config,{published:published(lockedRow(changed))}).reasons.includes('1 pick history for Week 1 differs from published Week 1 (revision 1).'));
  const tracked=structuredClone(week1Of(config));tracked.trackedEntries[0].picks[0]='DET';
  assert(guardFor(config,{published:published(lockedRow(tracked))}).reasons.includes("D.C.'s Week 1 history differs from published Week 1 (revision 1)."));
  const invalid=structuredClone(week1Of(config));invalid.fieldEntries[0].name='leak';
  assert(guardFor(config,{published:published(lockedRow(invalid))}).reasons.includes('Published Survivor Week 1 could not be validated for comparison.'));
  // Draft rows and other seasons are not treated as published history.
  const draft={...lockedRow(week1Of(config)),status:'draft'};
  assert(guardFor(config,{published:published(draft)}).reasons.includes('No published Survivor week before Week 2 exists to compare this sheet against.'));
  const other={...lockedRow(week1Of(config)),season:2025};
  assert(guardFor(config,{published:published(other)}).reasons.includes('No published Survivor week before Week 2 exists to compare this sheet against.'));
}
{
  // Replacing a published week: identical sheet is a fact; a staler sheet (even with the same pick count) is surfaced.
  const newer=structuredClone(config);newer.fieldEntries[243].picks[1]='SF';newer.currentWeekEntryCount=161;
  const withExisting=cfg=>published(lockedRow(week1Of(config)),lockedRow(cfg,3));
  const same=guardFor(newer,{published:withExisting(newer)});
  assert.equal(same.requiresConfirmation,false);assert(same.facts.includes('This sheet is identical to published Week 2 revision 3 (entries and Weeks 1–2 pick histories).'));
  const stale=guardFor(config,{published:withExisting(newer)});
  assert(stale.reasons.includes('This replaces published Week 2 revision 3:'));
  assert(stale.reasons.includes('1 pick history for Weeks 1–2 differs from published Week 2 revision 3.'));
  assert(stale.reasons.includes('1 Week 2 pick in published Week 2 revision 3 is blank in this sheet.'));
  assert(stale.reasons.includes('Published Week 2 revision 3 has 161 Week 2 picks; this sheet has only 160.'));
  assert.match(stale.confirmText,/no more Week 2 picks will be added, replacing published Week 2 revision 3\. Publishing shows 1 entry OUT for no pick \(Week 2\)\.$/);
  // Same count, different picks: still a regression.
  const sw=structuredClone(newer);sw.fieldEntries[100].picks[1]='ARI';
  const swG=guardFor(sw,{published:withExisting(newer)});
  assert(swG.reasons.includes('1 pick history for Weeks 1–2 differs from published Week 2 revision 3.'));
  // Later published weeks are disclosed.
  const later=guardFor(newer,{published:published(lockedRow(week1Of(config)),lockedRow(newer,3),{season:2026,week:3,status:'locked',revision:1,config:{}})});
  assert(later.reasons.includes('Published Survivor Week 3 already exists; it keeps its own history and is not changed by this publication.'),later.reasons.join(' | '));
}
{
  // Physically separated blank rows need explicit acknowledgement and are named in the confirmation.
  const complete=structuredClone(config);complete.fieldEntries[243].picks[1]='SF';complete.currentWeekEntryCount=161;
  const g=guardFor(complete,{detachedRows:[{page:1,label:'Page 1 of 3'},{page:3,label:'Notes'}]});
  assert.equal(g.requiresConfirmation,true);
  assert(g.reasons.includes('2 rows without picks were physically separated from the participant table and were NOT counted as entrants: "Page 1 of 3" (page 1), "Notes" (page 3). If any is a real entrant, do not publish.'));
  assert.equal(g.confirmText,'I reviewed every item listed above and confirm this sheet is the final Survivor Week 2 submission set — no more Week 2 picks will be added. The 2 separated rows listed above are not entrants.');
}
{
  // Feed context exposure is disclosed as a fact; the regular season is capped.
  const bare={1:{events:W1.map(([a,h])=>event(a,h))},2:{events:W2.map(([a,h])=>event(a,h))}};
  const v=verifySurvivorSchedule(config,bare);
  assert.deepEqual(v.contextUnexposed,[1,2]);
  assert(guardFor(config,{contextUnexposed:v.contextUnexposed}).facts.includes('The NFL feed did not identify its season/week for Weeks 1, 2; those games were matched by team structure only.'));
  assert.deepEqual(verifySurvivorSchedule(config,payloads).contextUnexposed,[]);
  assert.match(verifySurvivorSchedule({...config,week:19},{}).errors[0],/outside the NFL regular season \(Weeks 1–18\)/);
}

// ---- Review regressions.
{
  // PC-1: an entry pending on an unresolved earlier result is counted once, at its first blank week.
  const small=(picksList,week)=>{const tracked=[{id:'dc',displayName:'D.C.',picks:['PIT','SF','KC','BUF'].slice(0,week)},{id:'djs',displayName:'DJS',picks:['LV','SF','DEN','MIA'].slice(0,week)},{id:'thaddeus',displayName:'Thaddeus',picks:['LAC',null,null,null].slice(0,week)}];const fieldEntries=picksList.map((picks,i)=>({id:'survivor-'+String(i+1).padStart(3,'0'),picks:picks.slice(0,week)}));const all=[...tracked,...fieldEntries];return{schemaVersion:1,season:2026,week,label:'Survivor Week '+week,competitionSize:all.length,currentWeekEntryCount:all.filter(e=>e.picks[week-1]).length,sheetWeeks:18,trackedEntries:tracked,fieldEntries,source:{kind:'survivor-upload',filename:'x.pdf'}}};
  const cfg4=small([['JAX','NE',null,null],['JAX','BUF','KC','ATL']],4);
  const w2bad={...payload(W2,2),events:payload(W2,2).events.map(e=>e.competitions[0].competitors[0].team.abbreviation==='NE'?event('NE','NO',{as:null,hs:null}):e)};
  const v=verifySurvivorSchedule(cfg4,{1:payload(W1,1),2:w2bad,3:{events:W2.map(([a,h])=>event(a,h,{state:'post'}))},4:{events:W2.map(([a,h])=>event(a,h,{state:'pre'}))}});
  assert.equal(v.ok,true,v.errors.join(' | '));
  const g=survivorPublishGuard(cfg4,{resultsByWeek:v.resultsByWeek,currentGames:[],published:published(lockedRow(small([['JAX','NE',null,null],['JAX','BUF','KC','ATL']],1)))});
  assert.equal(g.maybeNoPickOuts,1);
  assert(g.reasons.some(r=>r.startsWith('1 entry with no Week 3 pick cannot yet be proven alive or out')));
  assert.equal(g.reasons.some(r=>r.includes('no Week 4 pick cannot yet be proven')),false);
}
{
  // PC-3: republishing the identical sheet when Week W is the only published week never claims earlier weeks are unpublished.
  const only=published(lockedRow(config,1));
  const g=guardFor(config,{published:only});
  assert.equal(g.coveredThrough,1);
  assert.equal(g.reasons.some(r=>/never been published|No published Survivor week before/.test(r)),false,g.reasons.join(' | '));
  assert(g.facts.includes('This sheet is identical to published Week 2 revision 1 (entries and Weeks 1–2 pick histories).'));
  assert.deepEqual(g.reasons,['1 of 161 entries alive entering Week 2 has no Week 2 pick. Publishing shows it OUT (no pick) in Week 2.']);
}
{
  // PC-4: a blank introduced into an already-published week is a new no-pick elimination, named by week.
  const blanked=structuredClone(config);blanked.fieldEntries[100].picks=[null,null];blanked.currentWeekEntryCount--;
  const g=guardFor(blanked);
  assert(g.reasons.includes('1 more entry is OUT (no pick) in Week 1 than in published Week 1 (revision 1).'),g.reasons.join(' | '));
  assert.equal(g.noPickOuts,2);
  assert.match(g.confirmText,/Publishing shows 2 entries OUT for no pick \(Week 1: 1, Week 2: 1\)\.$/);
  // Wording follows the elimination type: a no-pick OUT with a later pick is not blamed on NFL results.
  const odd=structuredClone(config);odd.fieldEntries[243].picks=[null,'SF'];
  assert(guardFor(odd).reasons.some(r=>r.includes('(1 OUT by no Week 1 pick). The sheet may disagree with the NFL results or its own earlier picks;')));
}
{
  // Rows counted from a page without picks always need explicit confirmation.
  const complete=structuredClone(config);complete.fieldEntries[243].picks[1]='SF';complete.currentWeekEntryCount=161;
  const g=guardFor(complete,{unanchoredRows:[{page:6,label:'Zed Blank'}]});
  assert.equal(g.requiresConfirmation,true);
  assert(g.reasons.includes('1 row without picks on a page with no participant picks was counted as an entrant (OUT for no pick): "Zed Blank" (page 6). If any is not a real entrant, do not publish.'));
  assert.match(g.confirmText,/The 1 row counted from a page without picks is a real entrant\.$/);
}


{
  // A parser-proven single-row grid restart is counted only with explicit admin confirmation.
  const complete=structuredClone(config);complete.fieldEntries[243].picks[1]='SF';complete.currentWeekEntryCount=161;
  const g=guardFor(complete,{gridBreaks:[{page:4,upper:'JulesyPoo 1',lower:'Juice 2'}]});
  assert.equal(g.requiresConfirmation,true);
  assert(g.reasons.includes('1 participant-table grid restart was counted across a single empty visual row: "JulesyPoo 1" → "Juice 2" (page 4). Confirm it is a real continuation of the participant table.'),g.reasons.join(' | '));
  assert.match(g.confirmText,/The 1 participant-table grid restart listed above is a real continuation\.$/);
  // The parser reports at most one restart per page, so a multi-page sheet can carry several: the wording is plural.
  const two=guardFor(complete,{gridBreaks:[{page:4,upper:'JulesyPoo 1',lower:'Juice 2'},{page:5,upper:'Kiki 3',lower:'Lulu 4'}]});
  assert.equal(two.requiresConfirmation,true);
  assert(two.reasons.includes('2 participant-table grid restarts were counted across a single empty visual row: "JulesyPoo 1" → "Juice 2" (page 4), "Kiki 3" → "Lulu 4" (page 5). Confirm they are real continuations of the participant table.'),two.reasons.join(' | '));
  assert.match(two.confirmText,/The 2 participant-table grid restarts listed above are real continuations\.$/);
}

// ---- Round-2 regressions.
{
  // G2-1: a draft Week-W row is never published history; only a locked Week W covers earlier weeks.
  const blanked=structuredClone(config);blanked.fieldEntries[100].picks=[null,null];blanked.currentWeekEntryCount--;
  const draft={...lockedRow(blanked,4),status:'draft'};
  const withDraft=guardFor(blanked,{published:published(lockedRow(week1Of(config)),draft)});
  assert.equal(withDraft.coveredThrough,1);assert.equal(withDraft.requiresConfirmation,true);
  assert(withDraft.reasons.includes('1 more entry is OUT (no pick) in Week 1 than in published Week 1 (revision 1).'),withDraft.reasons.join(' | '));
  assert(withDraft.facts.includes('This sheet is identical to draft Week 2 revision 4 (entries and Weeks 1–2 pick histories).'));
  assert.match(withDraft.confirmText,/replacing draft Week 2 revision 4\./);
  const draftOnly=guardFor(blanked,{published:published(draft)});
  assert.equal(draftOnly.coveredThrough,0);assert(draftOnly.reasons.includes('No published Survivor week before Week 2 exists to compare this sheet against.'));
  assert(draftOnly.facts.includes('No published Survivor weeks are visible for 2026.'));
  // an identical republish of a LOCKED Week 2 still needs no extra confirmation for its already-published blanks
  const locked=guardFor(blanked,{published:published(lockedRow(blanked,4))});
  assert.equal(locked.coveredThrough,1);assert.equal(locked.reasons.some(r=>/OUT \(no pick\) in Week 1/.test(r)),false,locked.reasons.join(' | '));
}
{
  // G2-2: a tracked entry newly OUT for no pick in a published week is counted and named even when another blank is
  // filled in the same week (offsetting totals).
  const w1=week1Of(config);w1.fieldEntries[100].picks=[null];w1.currentWeekEntryCount--;
  const sheet=structuredClone(config);sheet.trackedEntries[0].picks=[null,null];sheet.currentWeekEntryCount--;
  const g=guardFor(sheet,{published:published(lockedRow(w1))});
  assert(g.reasons.includes('D.C. is newly OUT (no pick) in Week 1 compared with published Week 1 (revision 1).'),g.reasons.join(' | '));
  assert.equal(g.noPickOuts,2);assert.match(g.confirmText,/Publishing shows 2 entries OUT for no pick \(Week 1: 1, Week 2: 1\)\.$/);
  // without an offsetting change the tracked entry is counted exactly once (never also as an anonymous total)
  const once=guardFor(sheet);
  assert.equal(once.noPickOuts,2);assert(once.reasons.includes('D.C. is newly OUT (no pick) in Week 1 compared with published Week 1 (revision 1).'));
  assert.equal(once.reasons.some(r=>/more entr(y is|ies are) OUT \(no pick\) in Week 1/.test(r)),false,once.reasons.join(' | '));
  // a tracked entry that was already OUT for no pick in the published week is not reported again
  const already=structuredClone(week1Of(config));already.trackedEntries[0].picks=[null];already.currentWeekEntryCount--;
  assert.equal(guardFor(sheet,{published:published(lockedRow(already))}).reasons.some(r=>r.startsWith('D.C. is newly OUT')),false);
}

// ---- Round-2c: symbol-only name-column rows are described accurately and always need confirmation.
{
  const complete=structuredClone(config);complete.fieldEntries[243].picks[1]='SF';complete.currentWeekEntryCount=161;
  const g=guardFor(complete,{symbolRows:[{page:1,label:'*'},{page:2,label:'🏈🏈'}]});
  assert.equal(g.requiresConfirmation,true);
  assert(g.reasons.includes('2 name-column rows have no letter or digit and were NOT counted as entrants: "*" (page 1), "🏈🏈" (page 2). If any is a real entrant, do not publish.'),g.reasons.join(' | '));
  assert.equal(g.reasons.some(r=>r.includes('physically separated')),false);
  assert.match(g.confirmText,/The 2 rows without a letter or digit listed above are not entrants\.$/);
}

// ---- HDC-14: the Survivor publication exception for a picked game the NFL feed no longer lists in its week. The
// matchup is proved only by the locked Pick'em slate of the same season and week (exactly one game of the pair, no other
// game of either team, neither team listed in that week's feed), and only an exact typed confirmation WEEK N AWAY @ HOME
// ABSENT accepts it. Nothing is decided for the picks: they stay pending until a ruling exists. A bye pick, a matchup the
// slate cannot prove (the Thursday game a sheet omits), a re-paired, duplicate, draft, other-season or other-week slate,
// and a later-week makeup listing never prove an absence. Every regression reports through one collector.
{
  const failures=[];
  const regression=(name,check)=>{try{check()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
  const slate=(pairs,{season=2026,week=2,status='locked',revision=3,configWeek=week,configSeason=season}={})=>({season,week,status,revision,config:{schemaVersion:1,season:configSeason,week:configWeek,games:pairs.map(([away,home],i)=>({away,home,awayNumber:2*i+1,homeNumber:2*i+2,eventId:String(402600+i)}))}});
  const noSfAri=W2.filter(([a])=>a!=='SF');
  const absent={1:payloads[1],2:payload(noSfAri,2)};
  const SLATE=slate(W2),PHRASE='WEEK 2 SF @ ARI ABSENT';
  const EXC={type:'absent-from-week-feed',week:2,away:'SF',home:'ARI',pickemRevision:3,confirmation:PHRASE};
  const OLD_SF="Week 2: SF is not scheduled in verified NFL Week 2 (bye or invalid team) — 98 entries: D.C., DJS, survivor-086, survivor-087, survivor-088, survivor-089, survivor-090, survivor-091, +90 more. Check the sheet's Week 2 column for SF.";
  const OLD_ARI="Week 2: ARI is not scheduled in verified NFL Week 2 (bye or invalid team) — 62 entries: survivor-182, survivor-183, survivor-184, survivor-185, survivor-186, survivor-187, survivor-188, survivor-189, +54 more. Check the sheet's Week 2 column for ARI.";
  const HINT=" Pick'em Week 2 (revision 3) proves SF @ ARI, and neither team is listed in the NFL Week 2 feed: if that game was moved out of Week 2, type WEEK 2 SF @ ARI ABSENT under Absent games and Read & validate again.";
  const stray=text=>`Absent-game confirmation "${text}" does not match a picked game that the same-week Pick'em slate proves and the NFL feed no longer lists. Correct or clear it, then Read & validate again.`;
  const blocked=(v,expected,label)=>{assert.equal(v.ok,false,label);assert.deepEqual(v.errors,expected,label);assert.deepEqual(v.absentGames,[],label)};

  regression('without Pick\'em evidence an absent pick keeps the unchanged bye-or-invalid error and nothing is offered',()=>{
    const v=verifySurvivorSchedule(config,absent);
    blocked(v,[OLD_SF,OLD_ARI]);assert.deepEqual(v.absenceRequests,[]);
    assert.deepEqual(v.offSchedule,[{week:2,team:'SF',entries:98},{week:2,team:'ARI',entries:62}]);
    // The two-argument call is the same as passing no slate and no confirmation.
    assert.deepEqual(verifySurvivorSchedule(config,absent,{pickemSlates:[],absenceConfirmations:[]}).errors,v.errors);
  });
  regression('the same-week locked slate proves the matchup, but without the typed confirmation publication still blocks',()=>{
    const v=verifySurvivorSchedule(config,absent,{pickemSlates:[SLATE]});
    blocked(v,[OLD_SF+HINT,OLD_ARI+HINT]);
    assert.deepEqual(v.absenceRequests,[{week:2,away:'SF',home:'ARI',pickemRevision:3,confirmation:PHRASE}]);
  });
  regression('a confirmation that is not the exact phrase never accepts the absence',()=>{
    for(const text of ['week 2 sf @ ari absent','WEEK 2 ARI @ SF ABSENT','WEEK 3 SF @ ARI ABSENT','WEEK 2 SF @ ARI',' WEEK 2 SF @ ARI ABSENT','yes']){
      const v=verifySurvivorSchedule(config,absent,{pickemSlates:[SLATE],absenceConfirmations:[text]});
      blocked(v,[OLD_SF+HINT,OLD_ARI+HINT,stray(text)],text);
    }
  });
  regression('the slate plus the exact confirmation verifies the sheet; the absent picks stay pending, nothing is invented',()=>{
    const v=verifySurvivorSchedule(config,absent,{pickemSlates:[SLATE],absenceConfirmations:[PHRASE]});
    assert.equal(v.ok,true,v.errors.join(' | '));assert.deepEqual(v.errors,[]);
    assert.deepEqual(v.absentGames,[EXC]);assert.deepEqual(v.absenceRequests,[]);
    const dc=survivorEntryState(config.trackedEntries[0],1,v.resultsByWeek),ari=survivorEntryState(config.fieldEntries[181],1,v.resultsByWeek);
    assert.deepEqual(dc,{status:'pending',pick:'SF',week:2,reason:'SF not present in verified Week 2 feed/schedule',type:'absent'});
    assert.equal(ari.status,'pending');assert.equal(ari.pick,'ARI');
    assert.equal(v.resultsByWeek[1].has('SF')||v.resultsByWeek[1].has('ARI'),false,'no Week 2 result exists for either team');
    assert.equal(survivorSummary([...config.trackedEntries,...config.fieldEntries],1,v.resultsByWeek).pending,160,'every SF/ARI pick is pending');
  });
  regression('a bye-week pick still blocks, with or without a typed phrase',()=>{
    // SF and ARI are both off this week: neither the feed nor the Pick'em slate lists them.
    const bye=slate(noSfAri);
    blocked(verifySurvivorSchedule(config,absent,{pickemSlates:[bye]}),[OLD_SF,OLD_ARI]);
    blocked(verifySurvivorSchedule(config,absent,{pickemSlates:[bye],absenceConfirmations:[PHRASE]}),[OLD_SF,OLD_ARI,stray(PHRASE)]);
  });
  regression('an unprovable Thursday matchup (left off the Pick\'em sheet) still blocks',()=>{
    const thursday=structuredClone(config);thursday.fieldEntries[243].picks[1]='PHI';thursday.currentWeekEntryCount++;
    const feed={1:payloads[1],2:payload(W2.filter(([a])=>a!=='PHI'),2)},sheet=slate(W2.filter(([a])=>a!=='PHI'));
    const old="Week 2: PHI is not scheduled in verified NFL Week 2 (bye or invalid team) — 1 entry: survivor-244. Check the sheet's Week 2 column for PHI.";
    blocked(verifySurvivorSchedule(thursday,feed,{pickemSlates:[sheet]}),[old]);
    blocked(verifySurvivorSchedule(thursday,feed,{pickemSlates:[sheet],absenceConfirmations:['WEEK 2 PHI @ PIT ABSENT']}),[old,stray('WEEK 2 PHI @ PIT ABSENT')]);
  });
  regression('a re-paired matchup (the slate opponent listed against another team) still blocks',()=>{
    const repaired={1:payloads[1],2:payload([...W2.filter(([a])=>a!=='SF'&&a!=='SEA'),['SEA','ARI']],2)};
    const v=verifySurvivorSchedule(config,repaired,{pickemSlates:[SLATE],absenceConfirmations:[PHRASE]});
    blocked(v,[OLD_SF,stray(PHRASE)]);assert.deepEqual(v.absenceRequests,[]);
  });
  regression('the slate must list the pair exactly once and no other game of either team',()=>{
    for(const [label,pairs] of [['pair twice',[...W2,['SF','ARI']]],['SF twice',[...W2,['SF','LAR']]],['ARI twice',[...W2,['ARI','LAR']]]]){
      blocked(verifySurvivorSchedule(config,absent,{pickemSlates:[slate(pairs)],absenceConfirmations:[PHRASE]}),[OLD_SF,OLD_ARI,stray(PHRASE)],label);
    }
  });
  regression("the slate's own orientation is the matchup: a slate publishing ARI @ SF needs WEEK 2 ARI @ SF ABSENT, never the reversed phrase",()=>{
    const reversed=slate([['ARI','SF'],...W2.slice(1)]);
    const hint=" Pick'em Week 2 (revision 3) proves ARI @ SF, and neither team is listed in the NFL Week 2 feed: if that game was moved out of Week 2, type WEEK 2 ARI @ SF ABSENT under Absent games and Read & validate again.";
    const v=verifySurvivorSchedule(config,absent,{pickemSlates:[reversed],absenceConfirmations:[PHRASE]});
    blocked(v,[OLD_SF+hint,OLD_ARI+hint,stray(PHRASE)]);
    assert.deepEqual(v.absenceRequests,[{week:2,away:'ARI',home:'SF',pickemRevision:3,confirmation:'WEEK 2 ARI @ SF ABSENT'}]);
    const ok=verifySurvivorSchedule(config,absent,{pickemSlates:[reversed],absenceConfirmations:['WEEK 2 ARI @ SF ABSENT']});
    assert.equal(ok.ok,true,ok.errors.join(' | '));
    assert.deepEqual(ok.absentGames,[{type:'absent-from-week-feed',week:2,away:'ARI',home:'SF',pickemRevision:3,confirmation:'WEEK 2 ARI @ SF ABSENT'}]);
  });
  regression('only a locked slate of the same season and week proves a matchup',()=>{
    const cases=[['draft',slate(W2,{status:'draft'})],['row of another season',slate(W2,{season:2025})],['config of another season',slate(W2,{configSeason:2025})],
      ['config of another week',slate(W2,{configWeek:3})],['slate of another week only',slate(W2,{week:3})],['games not an array',{...SLATE,config:{...SLATE.config,games:{}}}],
      ['a malformed slate game',slate([...W2,['XXX','LAR']])],['lowercase codes',slate(W2.map(([a,h])=>a==='SF'?['sf','ari']:[a,h]))],['two rows for the week',[SLATE,slate(W2,{revision:4})]]];
    for(const [label,rows] of cases){
      blocked(verifySurvivorSchedule(config,absent,{pickemSlates:[rows].flat(),absenceConfirmations:[PHRASE]}),[OLD_SF,OLD_ARI,stray(PHRASE)],label);
    }
  });
  regression('a later-week makeup listing never proves, resolves or links the absent pick',()=>{
    const w3=structuredClone(config);w3.week=3;w3.label='Survivor Week 3';
    for(const e of [...w3.trackedEntries,...w3.fieldEntries])e.picks=[...e.picks,null];
    w3.currentWeekEntryCount=0;
    // Week 3 lists SF @ ARI as a distinct, final makeup event; only Week 3's own slate lists it.
    const feeds={...absent,3:payload(W2,3)},makeupSlate=slate(W2,{week:3,revision:7});
    const v=verifySurvivorSchedule(w3,feeds,{pickemSlates:[SLATE,makeupSlate],absenceConfirmations:[PHRASE]});
    assert.equal(v.ok,true,v.errors.join(' | '));assert.deepEqual(v.absentGames,[EXC],'the exception is Week 2 only');
    assert.equal(survivorEntryState(w3.trackedEntries[0],1,v.resultsByWeek).status,'pending','the Week 3 makeup final never resolves the Week 2 pick');
    blocked(verifySurvivorSchedule(w3,feeds,{pickemSlates:[makeupSlate],absenceConfirmations:[PHRASE]}),[OLD_SF,OLD_ARI,stray(PHRASE)],'a Week 3 slate never proves Week 2');
  });
  regression('a typed confirmation that matches no absent pick blocks publication',()=>{
    blocked(verifySurvivorSchedule(config,payloads,{pickemSlates:[SLATE],absenceConfirmations:[PHRASE]}),[stray(PHRASE)]);
  });
  regression('the approved aliases (JAC -> JAX, WSH -> WAS) are the only slate normalization',()=>{
    const ind=structuredClone(config);ind.fieldEntries[243].picks[1]='IND';ind.currentWeekEntryCount++;
    const feed={1:payloads[1],2:payload(W2.filter(([a])=>a!=='IND'),2)};
    const v=verifySurvivorSchedule(ind,feed,{pickemSlates:[slate(W2.map(([a,h])=>a==='IND'?['IND','JAC']:[a,h]))],absenceConfirmations:['WEEK 2 IND @ JAX ABSENT']});
    assert.equal(v.ok,true,v.errors.join(' | '));
    assert.deepEqual(v.absentGames,[{type:'absent-from-week-feed',week:2,away:'IND',home:'JAX',pickemRevision:3,confirmation:'WEEK 2 IND @ JAX ABSENT'}]);
  });
  assert.equal(failures.length,0,`HDC-14 Survivor publication-exception regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
}

console.log('survivor schedule verification, bye/absent-team publication, and partial-week guard regressions passed');
