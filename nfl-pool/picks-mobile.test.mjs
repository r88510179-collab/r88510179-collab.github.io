// V1.4 premium compact Picks UX regressions (after the V1.3 mobile UX), with the V1.4 final polish (compact pick chips, card
// name labels and Disagreements only) and the V1.4 collapsible slate groups. picks-mobile.js's pure parts directly (kickoff
// grouping in Eastern time, the slate options and filter, the status filter, the slate expansion states and summaries, the
// entrant selection and its storage, the card name labels and their storage, the
// disagreement filter, the compact card, slate, board and control markup, the Rules & rulings summary and alerts), and its page part on a small DOM built from the real Games,
// Survivor and Picks panels of index.html (so the markup the module needs is the markup the page ships), with the two apps stood
// in for by poolcenter:picks and poolcenter:rules listeners that answer with fixtures and poolcenter:update announcements,
// exactly as weekly-app.js and survivor-app.js do. The stylesheet and the page are checked as text for the small-screen layout
// and the desktop fallback they declare.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {STORAGE_KEY,PREFERENCES_VERSION,TIME_ZONE,STATUS_FILTERS,STATUS_LABELS,KINDS,ALL_SLATES,kickoffParts,dateParts,slotOf,slotLabel,groupGames,
  slateOptions,resolveSlate,filterSlate,matchesStatus,filterGames,statusCounts,normalizeSelection,readSelection,writeSelection,toggleEntrant,compareLabel,
  summaryHtml,detailsHtml,cardHtml,boardHtml,slateOptionsHtml,filterBarHtml,entrantPanelHtml,filterNote,rulesSummary,alertsHtml,
  LABELS_KEY,LABEL_MODES,LABEL_MAX,NARROW_SCREEN,shortLabels,labelMap,defaultLabels,readLabels,writeLabels,disagreement,filterDisagreements,emptyDisagreements,
  slateHasLive,defaultSlateOpen,slateOpen,nextSlateStates,setSlateOpen,slateSummary,slateSummaryHtml,slateHtml,slatesBarHtml} from './picks-mobile.js';

const failures=[];
const check=async(name,fn)=>{try{await fn()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
const flush=async(n=10)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};
const index=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('./picks-mobile.css',import.meta.url),'utf8');
const baseCss=readFileSync(new URL('./style.css',import.meta.url),'utf8');
const panelOf=name=>{
  const start=index.indexOf(`<section class="view-panel" data-view-panel="${name}"`),tags=/<section\b[^>]*>|<\/section>/g;
  assert(start>=0,`index.html has the ${name} panel`);
  tags.lastIndex=start;let depth=0,m;
  while((m=tags.exec(index))){depth+=m[0][1]==='/'?-1:1;if(!depth)return index.slice(start,m.index+m[0].length)}
  throw new Error(`the ${name} panel does not close`);
};
const PAGE=[panelOf('games'),panelOf('survivor'),panelOf('picks')].join('\n');
assert(PAGE.includes('data-rules-card="pickem"')&&PAGE.includes('data-rules-card="survivor"')&&PAGE.includes('id="picksBoard"')&&PAGE.includes('id="picksEntrants"'),'the panels of index.html hold the mobile UX markup');

// ---- Fixtures, as weekly-app.js answers poolcenter:picks (weekly-app.test.mjs checks that it does).
const T=code=>({code,color:'#123456',logo:`https://a.espncdn.com/i/teamlogos/nfl/500/${code.toLowerCase()}.png`});
const NAMES=['D.C.','JC','DJS','Thaddeus'];
const pk=(teams,results)=>NAMES.map((name,i)=>({name,team:teams[i],result:results[i]}));
const game=(index,away,home,o={})=>({index,away:T(away),home:T(home),kickoff:null,date:null,kind:'upcoming',status:'Sun 1:00 PM',note:null,detail:'Sun 1:00 PM',awayScore:null,homeScore:null,winner:null,
  void:false,hold:null,underReview:null,tiebreak:false,issue:null,ownership:null,picks:pk([away,home,away,null],['pending','pending','pending','pending']),...o});
const share=(a,h,total=87)=>({away:{pct:a,count:Math.round(a*total/100),total},home:{pct:h,count:Math.round(h*total/100),total}});
const GAMES=()=>[
  game(0,'DEN','KC',{kickoff:'2026-09-25T00:15:00Z',date:'2026-09-24',kind:'final',status:'FINAL',detail:'Final',awayScore:24,homeScore:17,winner:'DEN',picks:pk(['DEN','KC','DEN',null],['correct','incorrect','correct','incorrect'])}),
  game(1,'MIA','BUF',{kickoff:'2026-09-27T17:00:00Z',date:'2026-09-27',kind:'tie',status:'FINAL TIE',detail:'Final/OT',awayScore:20,homeScore:20,picks:pk(['MIA','BUF','MIA',null],['tie','tie','tie','tie'])}),
  game(2,'NYJ','NE',{kickoff:'2026-09-27T17:00:00Z',date:'2026-09-27',kind:'live',status:'3rd 7:41',detail:'3rd 7:41',awayScore:10,homeScore:7}),
  game(3,'WAS','PHI',{kickoff:'2026-09-27T20:25:00Z',date:'2026-09-27',status:'Sun 4:25 PM',detail:'Sun 4:25 PM',ownership:share(31,69)}),
  game(4,'ATL','TB',{kickoff:'2026-09-28T00:20:00Z',date:'2026-09-27',status:'Sun 8:20 PM',detail:'Sun 8:20 PM'}),
  game(5,'DAL','NYG',{kickoff:'2026-09-29T00:15:00Z',date:'2026-09-28',status:'Mon 8:15 PM',detail:'Mon 8:15 PM',tiebreak:true}),
  game(6,'CIN','PIT',{kickoff:'2026-09-27T17:00:00Z',date:'2026-09-27',kind:'void',status:'VOID · Commissioner ruling',note:'Commissioner ruling',detail:'Canceled',void:true,picks:pk(['CIN','PIT','CIN',null],['void','void','void','void'])}),
  game(7,'LV','LAC',{kickoff:'2026-09-27T20:05:00Z',date:'2026-09-27',kind:'hold',status:'HOLD · Ruling information unusable',note:'Ruling information unusable',detail:'Sun 4:05 PM',hold:'the ruling cites policy revision 2, which does not exist',picks:pk(['LV','LAC','LV',null],['hold','hold','hold','hold'])}),
  game(8,'GB','MIN',{kickoff:null,date:'2026-09-27',status:'Scheduled',detail:'Scheduled'}),
  game(9,'SEA','SF',{kickoff:null,date:null,status:'Scheduled',detail:'Scheduled'}),
  game(10,'DET','CHI',{kickoff:'2026-09-27T17:00:00Z',date:'2026-09-27',kind:'live',status:'4th 2:10',detail:'4th 2:10',awayScore:21,homeScore:24,issue:'DET-CHI: final with contradictory status ignored'}),
  game(11,'HOU','IND',{kickoff:'2026-09-27T13:30:00Z',date:'2026-09-27',status:'Sun 9:30 AM',detail:'Sun 9:30 AM'})
];
// The same week with the picks varied: D.C., JC and DJS split on games 0, 1, 2 and 10 and agree (all on the away side) on every
// other game, Thaddeus has no picks anywhere; the VOID game 6 and the HOLD game 7 are unanimous.
const MIXED=()=>GAMES().map(g=>[3,4,5,6,7,8,9,11].includes(g.index)?{...g,picks:pk([g.away.code,g.away.code,g.away.code,null],g.picks.map(p=>p.result))}:g);
const snapshot=(o={})=>({ready:true,contest:'pickem',season:2026,week:3,revision:2,fieldSize:87,tiebreakIndex:5,entrants:[{name:'D.C.',noSubmission:false},{name:'JC',noSubmission:false},{name:'DJS',noSubmission:false},{name:'Thaddeus',noSubmission:true}],games:GAMES(),...o});
const SLATES=[['all','All Slates',12],['2026-09-24|3','Thursday Night',1],['2026-09-27|0','Sunday Morning',1],['2026-09-27|1','Sunday Early',4],['2026-09-27|2','Sunday Late',2],['2026-09-27|3','Sunday Night',1],['2026-09-27|4','Sunday · Kickoff TBD',1],['2026-09-28|3','Monday Night',1],['tbd','Kickoff TBD',1]];
const EARLY='2026-09-27|1',LATE='2026-09-27|2',NIGHT='2026-09-27|3';
// The Rules & rulings answers, as the apps give them (the model is contest-rulings.js's rulesModel output).
const incident=(o={})=>({key:'3|BUF|CIN|1',week:3,matchup:'BUF @ CIN',status:'APPLIED',detail:'VOID: removed from scoring, with no win, no loss and no points. Applied by commissioner ruling under policy revision 1.',review:null,evidence:'Recorded incident: STATUS_CANCELED · event 401437947',history:[{label:'Ruled VOID',date:'2026-10-08',note:'League canceled the game.'}],...o});
const readyModel=(o={})=>({state:'ready',contestType:"Pick'em contest",contestName:"Pool Center 2026 Pick'em",stale:null,policy:{revision:1,effectiveWeek:1,name:'Void',text:'A canceled, postponed or suspended game…',publicNote:null},revisions:[{revision:1,effectiveWeek:1,name:'Void',publicNote:null}],confirmation:'Commissioner confirmation is required…',incidents:[],empty:'No incident ruling has been confirmed for this contest so far.',...o});
const rulesAnswer=(model,o={})=>({ready:true,contest:'pickem',week:3,model,...o});

// ---- Constants.
await check('the constants: one versioned storage key (the V1.3 key), Eastern time, the four status filters in order, the six game kinds, the All Slates key',()=>{
  assert.equal(STORAGE_KEY,'poolcenter.picks.v1');assert.equal(PREFERENCES_VERSION,1);assert.equal(TIME_ZONE,'America/New_York');
  assert.deepEqual(STATUS_FILTERS,['all','final','live','upcoming']);assert.deepEqual(STATUS_LABELS,{all:'All',final:'Final',live:'Live',upcoming:'Upcoming'});
  assert.deepEqual(KINDS,['void','hold','final','tie','live','upcoming']);assert.equal(ALL_SLATES,'all');
  assert(Object.isFrozen(STATUS_FILTERS)&&Object.isFrozen(KINDS));
  assert.equal(LABELS_KEY,'poolcenter.picks.labels.v1');assert.deepEqual(LABEL_MODES,['compact','full']);assert(Object.isFrozen(LABEL_MODES));
  assert.equal(LABEL_MAX,6);assert.equal(NARROW_SCREEN,'(max-width:480px)');
});

// ---- Kickoffs in Eastern time.
await check('a kickoff is read in Eastern time whatever the device zone, across the daylight-saving change; anything that is not a time is null',()=>{
  const sun=kickoffParts('2026-09-27T17:00:00Z');
  assert.deepEqual([sun.dayKey,sun.weekday,sun.hour,sun.minute,sun.time,sun.date],['2026-09-27','Sunday',13,0,'1:00 PM EDT','Sun, Sep 27']);
  assert.equal(sun.ms,Date.parse('2026-09-27T17:00:00Z'));
  const thu=kickoffParts('2026-09-25T00:15:00Z');
  assert.deepEqual([thu.dayKey,thu.weekday,thu.hour,thu.minute,thu.time],['2026-09-24','Thursday',20,15,'8:15 PM EDT'],'a night game after midnight UTC is still that evening in the East');
  const est=kickoffParts('2026-11-08T18:00:00Z');
  assert.deepEqual([est.dayKey,est.hour,est.time],['2026-11-08',13,'1:00 PM EST'],'after the clocks change the same 1:00 PM slot is 18:00 UTC');
  assert.deepEqual([kickoffParts('2026-09-27T13:30:00Z').hour,kickoffParts('2026-09-27T13:30:00Z').time],[9,'9:30 AM EDT']);
  assert.equal(kickoffParts('2026-09-28T03:59:00Z').dayKey,'2026-09-27','11:59 PM Eastern is still Sunday');
  assert.equal(kickoffParts('2026-09-28T04:00:00Z').dayKey,'2026-09-28','midnight Eastern is Monday');
  for(const bad of [null,undefined,'','2026-13-45T00:00:00Z','tomorrow',42,{}])assert.equal(kickoffParts(bad),null,String(bad));
  assert.equal(kickoffParts('2026-09-27T17:00:00Z',{timeZone:'UTC'}).hour,17,'the zone is a parameter');
});
await check('a published calendar date is read as that date, never shifted by a zone',()=>{
  assert.deepEqual(dateParts('2026-09-27'),{dayKey:'2026-09-27',weekday:'Sunday',date:'Sun, Sep 27'});
  assert.deepEqual(dateParts('2026-09-28T00:15Z').dayKey,'2026-09-28');
  for(const bad of [null,'','27/09/2026','2026-9-7',20260927])assert.equal(dateParts(bad),null,String(bad));
});
await check('slots are by clock time: before noon morning, noon to 2:59 early, 3:00 to 6:59 late, 7:00 PM on night; the slate names follow from the day and slot',()=>{
  assert.deepEqual([0,9,11,12,13,14,15,16,18,19,20,23].map(slotOf),['morning','morning','morning','early','early','early','late','late','late','night','night','night']);
  assert.deepEqual([slotLabel('Thursday','night'),slotLabel('Sunday','early'),slotLabel('Sunday','late'),slotLabel('Sunday','night'),slotLabel('Monday','night'),slotLabel('Sunday','morning'),slotLabel('Saturday','tbd')],
    ['Thursday Night','Sunday Early','Sunday Late','Sunday Night','Monday Night','Sunday Morning','Saturday · Kickoff TBD']);
});
await check('games are grouped chronologically by Eastern date and slot, kickoff order inside a group, a date without a time in a TBD group on its date, no date at all last',()=>{
  const groups=groupGames(GAMES());
  assert.deepEqual(groups.map(g=>[g.key,g.label,g.date,g.games.map(x=>x.game.index)]),[
    ['2026-09-24|3','Thursday Night','Thu, Sep 24',[0]],
    ['2026-09-27|0','Sunday Morning','Sun, Sep 27',[11]],
    ['2026-09-27|1','Sunday Early','Sun, Sep 27',[1,2,6,10]],
    ['2026-09-27|2','Sunday Late','Sun, Sep 27',[7,3]],
    ['2026-09-27|3','Sunday Night','Sun, Sep 27',[4]],
    ['2026-09-27|4','Sunday · Kickoff TBD','Sun, Sep 27',[8]],
    ['2026-09-28|3','Monday Night','Mon, Sep 28',[5]],
    ['tbd','Kickoff TBD','',[9]]
  ]);
  assert.deepEqual(groups[3].games.map(x=>x.time),['4:05 PM EDT','4:25 PM EDT'],'the 4:05 game comes before the 4:25 game whatever the published order');
  assert.deepEqual(groups[5].games.map(x=>x.time),[null],'no kickoff text without a kickoff');
  assert.equal(groups.reduce((n,g)=>n+g.games.length,0),12,'every game is in exactly one group');
  assert.deepEqual(groupGames([]),[]);assert.deepEqual(groupGames(null),[]);
});
await check('unusual slates get true labels and are never invented: a Thanksgiving Thursday, a Saturday doubleheader, a Friday game and a Christmas Monday afternoon',()=>{
  const g=(i,kickoff)=>game(i,'A','B',{kickoff});
  assert.deepEqual(groupGames([g(0,'2026-11-26T17:30:00Z'),g(1,'2026-11-26T21:30:00Z'),g(2,'2026-11-27T01:20:00Z'),g(3,'2026-12-19T18:00:00Z'),g(4,'2026-12-19T21:30:00Z'),g(5,'2026-12-20T01:15:00Z'),g(6,'2026-12-25T18:00:00Z'),g(7,'2026-12-26T00:15:00Z')]).map(x=>x.label),
    ['Thursday Early','Thursday Late','Thursday Night','Saturday Early','Saturday Late','Saturday Night','Friday Early','Friday Night']);
});

// ---- Slates.
await check('the slate options are exactly the kickoff groups present, All Slates first, each with its game count; a slate that is not offered resolves to All Slates',()=>{
  assert.deepEqual(slateOptions(GAMES()).map(o=>[o.key,o.label,o.count]),SLATES);
  assert.deepEqual(slateOptions(GAMES()).map(o=>o.date),['','Thu, Sep 24','Sun, Sep 27','Sun, Sep 27','Sun, Sep 27','Sun, Sep 27','Sun, Sep 27','Mon, Sep 28','']);
  assert.deepEqual(slateOptions([]),[{key:'all',label:'All Slates',date:'',count:0}]);assert.deepEqual(slateOptions(null),[{key:'all',label:'All Slates',date:'',count:0}]);
  const options=slateOptions(GAMES());
  assert.equal(resolveSlate(EARLY,options),EARLY);assert.equal(resolveSlate('all',options),'all');
  for(const missing of ['2026-10-04|1',null,undefined,42,'',{}])assert.equal(resolveSlate(missing,options),'all',String(missing));
  assert.equal(resolveSlate(EARLY,[]),'all');
});
await check('filtering by a slate keeps the published order and only that slate’s games; All Slates keeps everything; an absent slate keeps nothing',()=>{
  assert.deepEqual(filterSlate(GAMES(),EARLY).map(g=>g.index),[1,2,6,10]);
  assert.deepEqual(filterSlate(GAMES(),LATE).map(g=>g.index),[3,7],'published order, not kickoff order');
  assert.deepEqual(filterSlate(GAMES(),'tbd').map(g=>g.index),[9]);
  assert.deepEqual(filterSlate(GAMES(),'2026-09-27|4').map(g=>g.index),[8]);
  assert.deepEqual(filterSlate(GAMES(),'all').map(g=>g.index),[0,1,2,3,4,5,6,7,8,9,10,11]);
  assert.deepEqual(filterSlate(GAMES(),null).map(g=>g.index),[0,1,2,3,4,5,6,7,8,9,10,11]);
  assert.deepEqual(filterSlate(GAMES(),'2026-10-04|1'),[]);assert.deepEqual(filterSlate(null,EARLY),[]);
});

// ---- Slate expansion (the V1.4 collapsible slate groups).
await check('a slate’s default: open while it lists a live game in All Slates, open as the chosen slate; a state wins over the default, whatever its shape; anything that is not a boolean means the default',()=>{
  const groups=groupGames(GAMES()),by=key=>groups.find(g=>g.key===key);
  assert.deepEqual(groups.map(g=>[g.key,slateHasLive(g)]),[['2026-09-24|3',false],['2026-09-27|0',false],[EARLY,true],[LATE,false],[NIGHT,false],['2026-09-27|4',false],['2026-09-28|3',false],['tbd',false]]);
  assert.equal(slateHasLive(null),false);assert.equal(slateHasLive({games:[{game:{kind:'live'}}]}),true);assert.equal(slateHasLive({games:[{game:null},null]}),false);
  assert.deepEqual(groups.map(g=>defaultSlateOpen(g)),[false,false,true,false,false,false,false,false]);
  assert.deepEqual(groups.map(g=>defaultSlateOpen(g,ALL_SLATES)),[false,false,true,false,false,false,false,false]);
  assert.equal(defaultSlateOpen(by(LATE),LATE),true,'a chosen slate is open');assert.equal(defaultSlateOpen(by(NIGHT),'2026-10-04|1'),true,'any chosen slate');
  assert.equal(slateOpen(by(EARLY)),true);assert.equal(slateOpen(by(LATE)),false);assert.equal(slateOpen(by(LATE),LATE),true);
  assert.equal(slateOpen(by(EARLY),ALL_SLATES,new Map([[EARLY,{open:false,manual:true}]])),false,'a state wins');
  assert.equal(slateOpen(by(LATE),ALL_SLATES,new Map([[LATE,{open:true,manual:false}]])),true);
  assert.equal(slateOpen(by(LATE),ALL_SLATES,{[LATE]:true}),true,'an object of booleans');assert.equal(slateOpen(by(EARLY),ALL_SLATES,{[EARLY]:false}),false);
  assert.equal(slateOpen(by(LATE),ALL_SLATES,new Map([[LATE,true]])),true,'a Map of booleans');
  [null,undefined,new Map(),{},new Map([[LATE,'yes']]),{[LATE]:{open:'yes'}},{[LATE]:1},[LATE]].forEach((states,i)=>assert.equal(slateOpen(by(LATE),ALL_SLATES,states),false,`states ${i}`));
  assert.equal(slateOpen(null,ALL_SLATES,null),false);assert.equal(slateOpen(null,LATE,null),true);
});
await check('the compact summary counts a slate’s listed games once each by the status its card shows (LIVE, FINAL, FINAL TIE, UPCOMING, VOID, HOLD), then the games under review, the unverified results and the tiebreak game; the pills name them in that order, in the page’s words, and nothing else',()=>{
  const groups=groupGames(GAMES()),by=key=>groups.find(g=>g.key===key);
  assert.deepEqual(slateSummary(by(EARLY)),{all:4,live:2,final:0,tie:1,upcoming:0,void:1,hold:0,review:0,issue:1,tiebreak:false});
  assert.deepEqual(slateSummary(by(LATE)),{all:2,live:0,final:0,tie:0,upcoming:1,void:0,hold:1,review:0,issue:0,tiebreak:false});
  assert.deepEqual(slateSummary(by('2026-09-28|3')),{all:1,live:0,final:0,tie:0,upcoming:1,void:0,hold:0,review:0,issue:0,tiebreak:true});
  assert.deepEqual(slateSummary(by('2026-09-24|3')),{all:1,live:0,final:1,tie:0,upcoming:0,void:0,hold:0,review:0,issue:0,tiebreak:false});
  assert.deepEqual(slateSummary(null),{all:0,live:0,final:0,tie:0,upcoming:0,void:0,hold:0,review:0,issue:0,tiebreak:false});
  assert.deepEqual(slateSummary({games:[{game:{kind:'bogus'}},{game:null}]}),{all:2,live:0,final:0,tie:0,upcoming:2,void:0,hold:0,review:0,issue:0,tiebreak:false},'an unknown kind counts as upcoming, as the card shows it');
  for(const group of groupGames(GAMES())){const s=slateSummary(group);assert.equal(s.live+s.final+s.tie+s.upcoming+s.void+s.hold,s.all,`${group.label}: every game counted once by its status`);assert.equal(s.all,group.games.length)}
  assert.equal(slateSummaryHtml(by(EARLY)),'<span class="pm-slate-pill pm-slate-pill-live">2 LIVE</span><span class="pm-slate-pill pm-slate-pill-tie">1 FINAL TIE</span><span class="pm-slate-pill pm-slate-pill-void">1 VOID</span><span class="pm-slate-pill pm-slate-pill-issue">1 NOT VERIFIED</span>');
  assert.equal(slateSummaryHtml(by(LATE)),'<span class="pm-slate-pill pm-slate-pill-upcoming">1 UPCOMING</span><span class="pm-slate-pill pm-slate-pill-hold">1 HOLD</span>');
  assert.equal(slateSummaryHtml(by('2026-09-28|3')),'<span class="pm-slate-pill pm-slate-pill-upcoming">1 UPCOMING</span><span class="pm-slate-pill pm-slate-pill-tiebreak">TIEBREAK</span>');
  assert.equal(slateSummaryHtml(by('2026-09-24|3')),'<span class="pm-slate-pill pm-slate-pill-final">1 FINAL</span>');
  assert.equal(slateSummaryHtml(null),'');assert.equal(slateSummaryHtml({games:[]}),'');
  const reviewed={...by(EARLY),games:by(EARLY).games.map(x=>x.game.index===6?{...x,game:{...x.game,underReview:'the feed now reports a completed final'}}:x)};
  assert.equal(slateSummaryHtml(reviewed),'<span class="pm-slate-pill pm-slate-pill-live">2 LIVE</span><span class="pm-slate-pill pm-slate-pill-tie">1 FINAL TIE</span><span class="pm-slate-pill pm-slate-pill-void">1 VOID</span><span class="pm-slate-pill pm-slate-pill-review">1 UNDER REVIEW</span><span class="pm-slate-pill pm-slate-pill-issue">1 NOT VERIFIED</span>');
  assert.equal(slateSummaryHtml({games:[{game:GAMES()[1]},{game:GAMES()[1]}]}),'<span class="pm-slate-pill pm-slate-pill-tie">2 FINAL TIES</span>');
  assert.equal(slateSummaryHtml({games:[{game:GAMES()[0]},{game:GAMES()[1]}]}),'<span class="pm-slate-pill pm-slate-pill-final">1 FINAL</span><span class="pm-slate-pill pm-slate-pill-tie">1 FINAL TIE</span>');
});
await check('the All Slates states after a render: a new slate starts at its default (open while live), a manual choice stays (closed never reopens by itself, open never closes by itself), an untouched slate opens once it goes live and stays open, a slate off the schedule is dropped, malformed states are dropped; Expand all and Collapse all set every slate; nothing is changed in place',()=>{
  const groups=groupGames(GAMES()),keys=groups.map(g=>g.key);
  const first=nextSlateStates(null,groups);
  assert.deepEqual([...first],keys.map(k=>[k,{open:k===EARLY,manual:false}]));
  assert.deepEqual([...nextSlateStates(undefined,groups,{})],[...first]);
  assert.deepEqual([...nextSlateStates(first,groups)],[...first],'a refresh with nothing new changes nothing');
  assert.deepEqual([...nextSlateStates(null,groupGames(filterSlate(GAMES(),NIGHT)),{slate:NIGHT})],[[NIGHT,{open:false,manual:false}]],'the All Slates default, whatever else is passed: a chosen slate opens on the board, not in these states');
  const closed=setSlateOpen(first,EARLY,false);
  assert.deepEqual(closed.get(EARLY),{open:false,manual:true});assert.deepEqual(first.get(EARLY),{open:true,manual:false},'the previous Map is untouched');assert.notEqual(closed,first);
  assert.deepEqual(nextSlateStates(closed,groups).get(EARLY),{open:false,manual:true},'a slate closed by hand never reopens by itself');
  const lateLive=groupGames(GAMES().map(g=>g.index===3?{...g,kind:'live'}:g));
  const next=nextSlateStates(first,lateLive);
  assert.deepEqual(next.get(LATE),{open:true,manual:false},'a slate that goes live opens');assert.deepEqual(next.get(EARLY),{open:true,manual:false});
  assert.deepEqual(first.get(LATE),{open:false,manual:false},'in a new Map');
  assert.deepEqual(nextSlateStates(next,groups).get(LATE),{open:true,manual:false},'and stays open once its games end: nothing closes by itself');
  assert.deepEqual(nextSlateStates(setSlateOpen(first,LATE,false),lateLive).get(LATE),{open:false,manual:true},'unless the user closed it');
  assert.deepEqual(nextSlateStates(setSlateOpen(first,NIGHT,true),groups).get(NIGHT),{open:true,manual:true},'a slate opened by hand stays open');
  assert.deepEqual([...nextSlateStates(first,groups.slice(0,2),{keys:keys.slice(0,2)}).keys()],keys.slice(0,2),'slates off the schedule are dropped');
  assert.deepEqual([...nextSlateStates(first,groups.slice(0,2),{keys}).keys()],keys,'slates on the schedule but filtered out are kept');
  assert.deepEqual([...nextSlateStates(first,groups.slice(0,2)).keys()],keys,'without keys nothing is dropped');
  const odd=nextSlateStates(new Map([[EARLY,'x'],[LATE,{open:'y',manual:'z'}],[42,{open:true}]]),groups);
  assert.deepEqual([odd.get(EARLY),odd.get(LATE),odd.get(42),odd.size],[{open:true,manual:false},{open:false,manual:false},undefined,8],'malformed states are dropped or made whole');
  assert.equal(nextSlateStates(first,[null,{key:7,games:[]},...groups]).size,8,'a group without a string key is ignored');
  const all=setSlateOpen(first,keys,false);assert(keys.every(k=>all.get(k).open===false&&all.get(k).manual===true),'Collapse all');
  const every=setSlateOpen(all,keys,true);assert(keys.every(k=>every.get(k).open===true&&every.get(k).manual===true),'Expand all');
  assert.deepEqual([...setSlateOpen(null,[EARLY],true)],[[EARLY,{open:true,manual:true}]]);assert.deepEqual([...setSlateOpen(undefined,'tbd',false)],[['tbd',{open:false,manual:true}]]);
  assert.deepEqual([...setSlateOpen(first,[42,null,undefined],true)],[...first],'a key that is not a string is ignored');
  assert.deepEqual(setSlateOpen(first,EARLY,'yes').get(EARLY),{open:false,manual:true},'only true opens');
  assert.deepEqual(nextSlateStates(every,groups).get(EARLY),{open:true,manual:true});
});

// ---- Status filter and counts.
await check('All, Final, Live and Upcoming: a verified tie is a final; VOID and HOLD games stay in every filter; the counts say what each filter shows and how many ruled games ride along',()=>{
  const games=GAMES();
  assert.deepEqual(filterGames(games,'all').map(g=>g.index),[0,1,2,3,4,5,6,7,8,9,10,11]);
  assert.deepEqual(filterGames(games,'final').map(g=>g.index),[0,1,6,7]);
  assert.deepEqual(filterGames(games,'live').map(g=>g.index),[2,6,7,10]);
  assert.deepEqual(filterGames(games,'upcoming').map(g=>g.index),[3,4,5,6,7,8,9,11]);
  assert.deepEqual(filterGames(games,'bogus').map(g=>g.index),[0,1,2,3,4,5,6,7,8,9,10,11],'an unknown filter hides nothing');
  assert.deepEqual(statusCounts(games),{all:12,final:2,live:2,upcoming:6,exceptions:2});
  assert.deepEqual(statusCounts([]),{all:0,final:0,live:0,upcoming:0,exceptions:0});
  for(const kind of ['void','hold'])for(const status of STATUS_FILTERS)assert.equal(matchesStatus(kind,status),true,`${kind} in ${status}`);
  assert.equal(matchesStatus('tie','final'),true);assert.equal(matchesStatus('tie','live'),false);assert.equal(matchesStatus('upcoming','final'),false);
  // Slate and status combine: the status filter runs over the slate's games, VOID and HOLD included.
  assert.deepEqual(filterGames(filterSlate(games,EARLY),'live').map(g=>g.index),[2,6,10]);
  assert.deepEqual(filterGames(filterSlate(games,LATE),'final').map(g=>g.index),[7]);
  assert.deepEqual(filterGames(filterSlate(games,NIGHT),'live'),[]);
  assert.deepEqual(statusCounts(filterSlate(games,EARLY)),{all:4,final:1,live:2,upcoming:0,exceptions:1});
});

// ---- Entrant selection.
await check('the selection is any 1 to all of the published names in their published order, never empty: unknown versions, shapes and names fall back to everyone',()=>{
  assert.deepEqual(normalizeSelection({version:1,entrants:['DJS','D.C.']},NAMES),['D.C.','DJS'],'published order, not stored order');
  for(const raw of [null,undefined,'x',42,[],{},{version:2,entrants:['JC']},{version:1},{version:1,entrants:'JC'},{version:1,entrants:[]},{version:1,entrants:['Nobody',7]}])assert.deepEqual(normalizeSelection(raw,NAMES),NAMES,JSON.stringify(raw));
  assert.deepEqual(normalizeSelection({version:1,entrants:['JC','Nobody','JC']},NAMES),['JC'],'unknown and repeated names are dropped');
  assert.deepEqual(normalizeSelection({version:1,entrants:['JC']},[]),[]);
});
await check('toggling: a tap adds or removes an entry, the last selected entry stays, and All selects everyone',()=>{
  assert.deepEqual(toggleEntrant(NAMES,NAMES,'JC'),['D.C.','DJS','Thaddeus']);
  assert.deepEqual(toggleEntrant(['D.C.','DJS'],NAMES,'JC'),['D.C.','JC','DJS']);
  assert.deepEqual(toggleEntrant(['Thaddeus'],NAMES,'Thaddeus'),['Thaddeus'],'the last one cannot be deselected');
  assert.deepEqual(toggleEntrant(['D.C.','JC'],NAMES,'*'),NAMES);
  assert.deepEqual(toggleEntrant(['D.C.','JC'],NAMES,'Nobody'),['D.C.','JC'],'an unknown name changes nothing');
  assert.deepEqual(toggleEntrant([],NAMES,'JC'),['D.C.','DJS','Thaddeus'],'an empty selection means everyone');
});
await check('storage: the V1.3 key and shape, unchanged; absent, refusing, malformed or old values are everyone; writing touches only the one key and reports failure instead of throwing',()=>{
  const store=new Map(),storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,v)};
  assert.deepEqual(readSelection(NAMES,storage),NAMES);
  assert.deepEqual(readSelection(NAMES,undefined),NAMES);
  assert.deepEqual(readSelection(NAMES,{getItem(){throw new Error('denied')}}),NAMES);
  store.set(STORAGE_KEY,'{not json');assert.deepEqual(readSelection(NAMES,storage),NAMES);
  store.set(STORAGE_KEY,JSON.stringify({version:0,entrants:['JC']}));assert.deepEqual(readSelection(NAMES,storage),NAMES);
  store.set(STORAGE_KEY,JSON.stringify({version:1,entrants:['Thaddeus','JC']}));assert.deepEqual(readSelection(NAMES,storage),['JC','Thaddeus'],'a value V1.3 wrote is read as it was');
  store.set('other','keep');
  assert.equal(writeSelection(['JC','DJS'],storage),true);
  assert.deepEqual([...store.keys()].sort(),['other',STORAGE_KEY]);assert.deepEqual(JSON.parse(store.get(STORAGE_KEY)),{version:1,entrants:['JC','DJS']},'the written shape is V1.3’s, so V1.3 reads it too');assert.equal(store.get('other'),'keep');
  assert.equal(writeSelection(['JC'],undefined),false);
  assert.equal(writeSelection(['JC'],{setItem(){throw new Error('quota')}}),false);
});
await check('the one compact control says what is compared: All N entries, or the names joined with +',()=>{
  assert.equal(compareLabel(NAMES,NAMES),'All 4 entries');assert.equal(compareLabel(NAMES,null),'All 4 entries');
  assert.equal(compareLabel(NAMES,['D.C.','DJS']),'D.C. + DJS');assert.equal(compareLabel(NAMES,['DJS','D.C.','JC']),'D.C. + JC + DJS','published order');
  assert.equal(compareLabel(NAMES,['Thaddeus']),'Thaddeus');assert.equal(compareLabel(NAMES,['Nobody']),'All 4 entries');
  assert.equal(compareLabel(['Pat'],['Pat']),'All 1 entry');assert.equal(compareLabel([],[]),'');
});

// ---- Markup.
const cards=html=>html.match(/<article [\s\S]*?<\/article>/g)||[];
const tokensOf=html=>[...html.matchAll(/<span class="pm-token ([a-z-]+(?: no-pick)?)"><span class="pm-token-name">([^<]+)<\/span>(?:<span class="pm-token-pick">([^<]+)<\/span>)?(?:<span class="pm-token-mark" role="img" aria-label="([^"]+)">([^<]+)<\/span>)?<\/span>/g)].map(m=>[m[2],m[1],m[3]??null,m[4]??null,m[5]??null]);
await check('a final card: collapsed, one button with the kickoff, FINAL, both teams with logos and the verified score, the winner marked, one result token per selected entry; the hidden details hold the graded picks and never repeat the score or status',()=>{
  const html=cardHtml(GAMES()[0],NAMES,{time:'8:15 PM EDT'});
  assert.match(html,/^<article class="pm-card pm-kind-final" data-game="0" aria-label="DEN at KC, FINAL"><button type="button" class="pm-summary" data-picks-expand="0" aria-expanded="false" aria-controls="pm-details-0"><span class="pm-top"><span class="pm-moment">8:15 PM EDT<\/span><span class="pm-status pm-status-final">FINAL<\/span><span class="pm-chevron" aria-hidden="true"><\/span><\/span>/);
  assert(!html.includes('pm-detail"'),'a plain Final adds no detail');
  assert.match(html,/<span class="pm-side pm-away pm-winner"><span class="pm-badge" style="--tc:#123456" aria-hidden="true"><span class="pm-badge-code">DEN<\/span><img class="pm-logo" src="https:\/\/a\.espncdn\.com\/i\/teamlogos\/nfl\/500\/den\.png" alt="" loading="lazy" decoding="async" onerror="this\.hidden=true"><\/span><span class="pm-code">DEN<\/span><span class="pm-score">24<\/span><\/span><span class="pm-at">@<\/span><span class="pm-side pm-home"><span class="pm-score">17<\/span><span class="pm-code">KC<\/span><span class="pm-badge"/);
  assert.deepEqual(tokensOf(html),[['D.C.','ok','DEN','correct','✓'],['JC','bad','KC','incorrect','✕'],['DJS','ok','DEN','correct','✓'],['Thaddeus','bad no-pick','—','incorrect','✕']]);
  const details=html.slice(html.indexOf('<div class="pm-details"'));
  assert.match(details,/^<div class="pm-details" id="pm-details-0" hidden><ul class="pm-picks">/);
  assert.deepEqual([...details.matchAll(/<li class="pm-pick ([a-z-]+(?: no-pick-row)?)"><span class="pm-name">([^<]+)<\/span>(.*?)<\/li>/g)].map(m=>[m[2],m[1],m[3].replace(/<span class="pm-badge[^"]*"[^>]*><span class="pm-badge-code">[^<]*<\/span>(?:<img[^>]*>)?<\/span>/g,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()]),[
    ['D.C.','ok','DEN ✓ Correct'],['JC','bad','KC ✕ Incorrect'],['DJS','ok','DEN ✓ Correct'],['Thaddeus','bad no-pick-row','NO PICK ✕ No pick']]);
  assert(!/pm-score|pm-status|pm-moment|pm-flag/.test(details),'the details repeat no score, status or flag');
  assert(!details.includes('pm-ownership')&&!details.includes('pm-whys'),'no ownership or explanation without them');
  const two=cardHtml(GAMES()[0],['JC','Thaddeus']);
  assert.deepEqual(tokensOf(two).map(t=>t[0]),['JC','Thaddeus'],'only the selected entries, in published order');
  assert.deepEqual([...two.matchAll(/<span class="pm-name">([^<]+)<\/span>/g)].map(m=>m[1]),['JC','Thaddeus']);
  assert(!two.includes('pm-moment'),'a final without a kickoff text shows no moment');
  const open=cardHtml(GAMES()[0],NAMES,{time:'8:15 PM EDT',expanded:true});
  assert.match(open,/^<article class="pm-card pm-kind-final is-expanded"/);assert.match(open,/aria-expanded="true"/);assert.match(open,/<div class="pm-details" id="pm-details-0"><ul/,'an expanded card shows its details');
});
await check('a tie card: FINAL TIE, the overtime detail, no winner, every token and every pick one loss',()=>{
  const html=cardHtml(GAMES()[1],NAMES,{time:'1:00 PM EDT'});
  assert.match(html,/pm-kind-tie" data-game="1" aria-label="MIA at BUF, FINAL TIE">/);
  assert.match(html,/<span class="pm-status pm-status-tie">FINAL TIE<\/span><span class="pm-detail">Final\/OT<\/span><span class="pm-chevron"/);
  assert(!html.includes('pm-winner'),'no winner');
  assert.deepEqual(tokensOf(html).map(t=>[t[1],t[3]]),[['bad','tie, one loss'],['bad','tie, one loss'],['bad','tie, one loss'],['bad no-pick','tie, one loss']]);
  assert.equal((html.match(/✕ Tie · 1 loss/g)||[]).length,3);assert.match(html,/NO PICK<\/span><span class="pm-result">✕ No pick<\/span>/);
});
await check('a live card: the clock in the kickoff’s place, LIVE and the live score; the tokens show each pick with no mark; an unverified result is flagged on the card and explained in the details in the page’s own words',()=>{
  const html=cardHtml(GAMES()[2],NAMES,{time:'1:00 PM EDT'});
  assert.match(html,/pm-kind-live" data-game="2" aria-label="NYJ at NE, LIVE">/);
  assert.match(html,/<span class="pm-top"><span class="pm-moment">3rd 7:41<\/span><span class="pm-status pm-status-live">LIVE<\/span><span class="pm-chevron"/);
  assert(!html.includes('1:00 PM EDT'),'the kickoff gives way to the clock');
  assert.match(html,/<span class="pm-score">10<\/span>/);assert.match(html,/<span class="pm-score">7<\/span>/);
  assert.deepEqual(tokensOf(html),[['D.C.','pending','NYJ',null,null],['JC','pending','NE',null,null],['DJS','pending','NYJ',null,null],['Thaddeus','pending no-pick','—',null,null]]);
  assert.equal((html.match(/>Pending</g)||[]).length,4);
  const flagged=cardHtml(GAMES()[10],NAMES);
  assert.match(flagged,/<span class="pm-status pm-status-live">LIVE<\/span><span class="pm-flag pm-flag-issue">NOT VERIFIED<\/span>/);
  assert.match(flagged,/<div class="pm-whys"><span class="pm-why pm-why-issue"><b>Not verified<\/b>DET-CHI: final with contradictory status ignored<\/span><\/div>/);
});
await check('an upcoming card: the Eastern kickoff, UPCOMING, no scores, the picks in the tokens, the tiebreak game flagged and explained, full-field ownership in the details when the field is published',()=>{
  const html=cardHtml(GAMES()[3],NAMES,{time:'4:25 PM EDT'});
  assert.match(html,/<span class="pm-top"><span class="pm-moment">4:25 PM EDT<\/span><span class="pm-status pm-status-upcoming">UPCOMING<\/span><span class="pm-chevron" aria-hidden="true"><\/span><\/span>/);
  assert(!html.includes('pm-score'),'no score before kickoff');
  assert.deepEqual(tokensOf(html).map(t=>t[2]),['WAS','PHI','WAS','—']);
  assert.match(html,/<div class="pm-ownership" aria-label="Full-field pick ownership"><span class="contrarian">WAS 31%<\/span><small>of 87 entries<\/small><span>69% PHI<\/span><\/div>/);
  assert(html.indexOf('pm-ownership')>html.indexOf('pm-details'),'ownership is in the details, not the summary');
  const tb=cardHtml(GAMES()[5],NAMES);
  assert.match(tb,/<span class="pm-moment">Mon 8:15 PM<\/span>/,'without a kickoff text the feed detail stands in');
  assert.match(tb,/<span class="pm-status pm-status-upcoming">UPCOMING<\/span><span class="pm-flag pm-flag-tiebreak">TIEBREAK<\/span>/);
  assert.match(tb,/<span class="pm-why pm-why-tiebreak"><b>Tiebreak game<\/b>activates when this game is final<\/span>/);
  assert.match(cardHtml(game(0,'A','B',{detail:null}),NAMES),/<span class="pm-moment">Kickoff TBD<\/span>/,'with neither a kickoff nor a feed detail the card says so');
});
await check('a VOID card and a HOLD card say so once, with the Games grid’s own note, the held game’s reason flagged, every token and pick VOID or HOLD and never graded, and the details explaining why they are listed in every filter',()=>{
  const v=cardHtml(GAMES()[6],NAMES,{time:'1:00 PM EDT'});
  assert.match(v,/pm-kind-void" data-game="6" aria-label="CIN at PIT, VOID">/);
  assert.match(v,/<span class="pm-moment">1:00 PM EDT<\/span><span class="pm-status pm-status-void">VOID<\/span><span class="pm-detail">Commissioner ruling<\/span>/);
  assert.deepEqual(tokensOf(v).map(t=>[t[1],t[2],t[4]]),[['void','CIN',null],['void','PIT',null],['void','CIN',null],['void no-pick','—',null]]);
  assert.equal((v.match(/<span class="pm-result">VOID<\/span>/g)||[]).length,4);assert(!/✓|✕/.test(v),'nothing graded');
  assert.match(v,/<span class="pm-why pm-why-void"><b>Void<\/b>Commissioner ruling · removed from scoring · listed in every status filter<\/span>/);
  assert.equal((v.match(/VOID/g)||[]).length,6,'the card label, the status pill once, the four pick grades; the tokens do not repeat it');
  const review=cardHtml({...GAMES()[6],note:'Commissioner ruling · UNDER REVIEW',underReview:'the feed now reports a completed final'},NAMES);
  assert.match(review,/<span class="pm-status pm-status-void">VOID<\/span><span class="pm-flag pm-flag-review">UNDER REVIEW<\/span><span class="pm-detail">Commissioner ruling · UNDER REVIEW<\/span>/);
  assert.match(review,/<span class="pm-why pm-why-review"><b>Under review<\/b>the feed now reports a completed final<\/span>/);
  const h=cardHtml(GAMES()[7],NAMES,{time:'4:05 PM EDT'});
  assert.match(h,/pm-kind-hold" data-game="7" aria-label="LV at LAC, HOLD">/);
  assert.match(h,/<span class="pm-status pm-status-hold">HOLD<\/span><span class="pm-flag pm-flag-issue">NOT GRADED<\/span><span class="pm-detail">Ruling information unusable<\/span>/);
  assert.match(h,/<span class="pm-why pm-why-issue"><b>Not graded<\/b>the ruling cites policy revision 2, which does not exist · listed in every status filter<\/span>/);
  assert.equal((h.match(/<span class="pm-result">HOLD<\/span>/g)||[]).length,4);
});
await check('names, codes and feed text are escaped; an unknown kind renders as upcoming; the summary and details parts are the card’s own halves',()=>{
  const hostile=game(0,'<b>','KC',{detail:'<img src=x onerror=alert(1)>',issue:'<script>',picks:[{name:'<i>x</i>',team:'<b>',result:'correct'}]});
  const html=cardHtml(hostile,['<i>x</i>']);
  assert(!/<img src=x|<script>|<i>x/.test(html),'nothing hostile survives');
  assert.deepEqual([...html.matchAll(/<b>([^<]*)<\/b>/g)].map(m=>m[1]),['Not verified'],'the only <b> is the explanation label; the hostile team code is text');
  assert(html.includes('&lt;i&gt;x&lt;/i&gt;')&&html.includes('&lt;script&gt;')&&html.includes('&lt;b&gt;'));
  assert.match(cardHtml({...game(0,'A','B'),kind:'bogus'},NAMES),/pm-kind-upcoming/);
  const g=GAMES()[3];
  assert(cardHtml(g,NAMES,{time:'4:25 PM EDT'}).includes(summaryHtml(g,NAMES,{time:'4:25 PM EDT'})));
  assert(cardHtml(g,NAMES).includes(detailsHtml(g,NAMES)));
  assert.match(cardHtml(g,[]),/<span class="pm-token pending"><span class="pm-token-name">No entry selected<\/span><\/span>/);
});
await check('the board: the slates in order with their headers, filtered by slate, status and entrants together, the one expanded matchup open; a loading or failed app shows its reason; an empty combination says so truthfully',()=>{
  const html=boardHtml(snapshot(),{entrants:NAMES,status:'all'});
  assert.deepEqual([...html.matchAll(/<section class="pm-group(?: is-collapsed)?" data-slate="([^"]+)" aria-label="([^"]+)"><h3 class="pm-group-title"><button [^>]+><span class="pm-slate-chevron" aria-hidden="true"><\/span><span class="pm-slate-copy"><span class="pm-slate-name">([^<]+)<\/span><small class="pm-slate-meta">([^<]*)<\/small><\/span>/g)].map(m=>[m[1],m[3],m[4]]),[
    ['2026-09-24|3','Thursday Night','Thu, Sep 24 · 1 game'],['2026-09-27|0','Sunday Morning','Sun, Sep 27 · 1 game'],['2026-09-27|1','Sunday Early','Sun, Sep 27 · 4 games'],['2026-09-27|2','Sunday Late','Sun, Sep 27 · 2 games'],
    ['2026-09-27|3','Sunday Night','Sun, Sep 27 · 1 game'],['2026-09-27|4','Sunday · Kickoff TBD','Sun, Sep 27 · 1 game'],['2026-09-28|3','Monday Night','Mon, Sep 28 · 1 game'],['tbd','Kickoff TBD','1 game']]);
  assert.equal(cards(html).length,12);assert(cards(html).every(c=>!c.includes('aria-expanded="true"')),'every card starts collapsed');
  assert.deepEqual(cards(boardHtml(snapshot(),{entrants:['JC'],status:'live'})).map(c=>c.match(/data-game="(\d+)"/)[1]),['2','6','10','7']);
  assert.equal((boardHtml(snapshot(),{entrants:['JC'],status:'live'}).match(/<span class="pm-token-name">/g)||[]).length,4,'one token per card for one entry');
  assert.deepEqual(cards(boardHtml(snapshot(),{entrants:NAMES,status:'all',slate:EARLY})).map(c=>c.match(/data-game="(\d+)"/)[1]),['1','2','6','10']);
  assert.deepEqual(cards(boardHtml(snapshot(),{entrants:NAMES,status:'live',slate:EARLY})).map(c=>c.match(/data-game="(\d+)"/)[1]),['2','6','10'],'slate and status together, the VOID game along');
  assert.deepEqual(cards(boardHtml(snapshot(),{entrants:NAMES,status:'final',slate:LATE})).map(c=>c.match(/data-game="(\d+)"/)[1]),['7'],'the HOLD game rides with Final');
  assert.equal(boardHtml(snapshot(),{entrants:NAMES,status:'live',slate:NIGHT}),'<div class="empty">No live games in Sunday Night.</div>');
  assert.equal(boardHtml(snapshot(),{entrants:NAMES,status:'all',slate:'2026-10-04|1'}).split('<article ').length-1,12,'a slate that is not on the schedule means All Slates');
  const open=boardHtml(snapshot(),{entrants:NAMES,status:'all',expanded:6});
  assert.deepEqual(cards(open).filter(c=>c.includes('aria-expanded="true"')).map(c=>c.match(/data-game="(\d+)"/)[1]),['6'],'exactly the one expanded matchup is open');
  assert.equal(cards(open).filter(c=>c.includes('is-expanded')).length,1);
  assert.equal(boardHtml(snapshot({games:GAMES().filter(g=>g.kind==='upcoming')}),{entrants:NAMES,status:'live'}),'<div class="empty">No games are live right now.</div>');
  assert.equal(boardHtml(snapshot({games:[]}),{entrants:NAMES,status:'all'}),'<div class="empty">No games are published for this week.</div>');
  assert.equal(boardHtml(null,{}),'<div class="empty">Picks are not available yet.</div>');
  assert.equal(boardHtml({ready:false,reason:"Pick'em picks have not loaded yet."},{}),'<div class="empty">Pick&#39;em picks have not loaded yet.</div>');
  assert.equal(cards(boardHtml(snapshot(),{entrants:['Nobody'],status:'all'})).length,12,'an unknown selection means everyone');
  assert.equal((boardHtml(snapshot(),{entrants:['Nobody'],status:'all'}).match(/<span class="pm-name">/g)||[]).length,48);
});
await check('the board’s slates are disclosures: each heading holds one button naming its state and the body it controls, the slate, its date and game count and its summary pills; in All Slates the slate with live games starts open and every other starts collapsed with its body hidden, under Expand all and Collapse all; given states win; a chosen slate starts open without the controls; an empty state carries nothing',()=>{
  const html=boardHtml(snapshot(),{entrants:NAMES});
  assert.match(html,/^<div class="pm-slates-bar" role="group" aria-label="Slates"><button type="button" class="pm-slates-action" data-picks-slates="expand">Expand all<\/button><button type="button" class="pm-slates-action" data-picks-slates="collapse">Collapse all<\/button><\/div><section /);
  assert.equal(html.split('pm-slates-bar').length-1,1);
  const heads=[...html.matchAll(/<section class="pm-group( is-collapsed)?" data-slate="([^"]+)" aria-label="([^"]+)"><h3 class="pm-group-title"><button type="button" class="pm-slate-toggle" data-picks-slate-toggle="([^"]+)" aria-expanded="(true|false)" aria-controls="([^"]+)"><span class="pm-slate-chevron" aria-hidden="true"><\/span><span class="pm-slate-copy"><span class="pm-slate-name">([^<]+)<\/span><small class="pm-slate-meta">([^<]*)<\/small><\/span><span class="pm-slate-summary">((?:<span class="pm-slate-pill pm-slate-pill-[a-z]+">[^<]+<\/span>)*)<\/span><\/button><\/h3><div class="pm-slate-body" id="([^"]+)"( hidden)?><article /g)];
  assert.equal(heads.length,8,'eight slates, each in this exact shape');
  assert.deepEqual(heads.map(m=>[m[2],m[7],m[8],m[5]==='true']),[['2026-09-24|3','Thursday Night','Thu, Sep 24 · 1 game',false],['2026-09-27|0','Sunday Morning','Sun, Sep 27 · 1 game',false],[EARLY,'Sunday Early','Sun, Sep 27 · 4 games',true],[LATE,'Sunday Late','Sun, Sep 27 · 2 games',false],[NIGHT,'Sunday Night','Sun, Sep 27 · 1 game',false],['2026-09-27|4','Sunday · Kickoff TBD','Sun, Sep 27 · 1 game',false],['2026-09-28|3','Monday Night','Mon, Sep 28 · 1 game',false],['tbd','Kickoff TBD','1 game',false]]);
  for(const m of heads){
    assert.equal(m[4],m[2],'the control names its slate');assert.equal(m[6],m[10],'the control names the body it controls');assert.equal(m[3],m[7],'the section is named by the slate');
    assert.equal(!!m[1],m[5]==='false','a collapsed section says so');assert.equal(!!m[11],m[5]==='false','a collapsed body is hidden');
  }
  assert.deepEqual(heads.map(m=>m[10]),['pm-slate-2026-09-24-3','pm-slate-2026-09-27-0','pm-slate-2026-09-27-1','pm-slate-2026-09-27-2','pm-slate-2026-09-27-3','pm-slate-2026-09-27-4','pm-slate-2026-09-28-3','pm-slate-tbd'],'one id per slate, safe for aria-controls');
  assert.deepEqual(heads.map(m=>[...m[9].matchAll(/>([^<]+)</g)].map(x=>x[1])),[['1 FINAL'],['1 UPCOMING'],['2 LIVE','1 FINAL TIE','1 VOID','1 NOT VERIFIED'],['1 UPCOMING','1 HOLD'],['1 UPCOMING'],['1 UPCOMING'],['1 UPCOMING','TIEBREAK'],['1 UPCOMING']]);
  assert.equal(cards(html).length,12);assert(cards(html).every(c=>!c.includes('aria-expanded="true"')),'every card starts collapsed whatever its slate');
  assert.equal(html.split('<h3 ').length-1,8);assert.equal(html.split('</section>').length-1,8);
  const given=boardHtml(snapshot(),{entrants:NAMES,slates:new Map([[EARLY,{open:false,manual:true}],[LATE,{open:true,manual:true}]])});
  assert.deepEqual([...given.matchAll(/data-picks-slate-toggle="([^"]+)" aria-expanded="(true|false)"/g)].map(m=>[m[1],m[2]==='true']),[['2026-09-24|3',false],['2026-09-27|0',false],[EARLY,false],[LATE,true],[NIGHT,false],['2026-09-27|4',false],['2026-09-28|3',false],['tbd',false]],'given states win, the rest at their default');
  assert.match(given,/<section class="pm-group is-collapsed" data-slate="2026-09-27\|1"[\s\S]*?<div class="pm-slate-body" id="pm-slate-2026-09-27-1" hidden>/);
  assert.match(given,/<section class="pm-group" data-slate="2026-09-27\|2"[\s\S]*?<div class="pm-slate-body" id="pm-slate-2026-09-27-2">/);
  assert.deepEqual([...boardHtml(snapshot(),{entrants:NAMES,slates:{[EARLY]:false,[NIGHT]:true}}).matchAll(/data-picks-slate-toggle="([^"]+)" aria-expanded="true"/g)].map(m=>m[1]),[NIGHT],'an object of booleans works too');
  assert.deepEqual([...boardHtml(snapshot(),{entrants:NAMES,status:'live'}).matchAll(/data-picks-slate-toggle="([^"]+)" aria-expanded="(true|false)"/g)].map(m=>[m[1],m[2]]),[[EARLY,'true'],[LATE,'false']],'the status filter: the defaults follow the games listed');
  assert.equal([...boardHtml(snapshot(),{entrants:NAMES,status:'final'}).matchAll(/aria-expanded="true"/g)].length,0,'Final lists no live game, so every slate starts collapsed');
  const one=boardHtml(snapshot(),{entrants:NAMES,slate:LATE});
  assert(!one.includes('pm-slates-bar'),'no Expand all or Collapse all for one chosen slate');
  assert.match(one,/^<section class="pm-group" data-slate="2026-09-27\|2" aria-label="Sunday Late"><h3 class="pm-group-title"><button type="button" class="pm-slate-toggle" data-picks-slate-toggle="2026-09-27\|2" aria-expanded="true" aria-controls="pm-slate-2026-09-27-2">/);
  assert.match(one,/<div class="pm-slate-body" id="pm-slate-2026-09-27-2"><article /,'the body is shown');
  assert.equal(one.split('</section>').length-1,1);
  assert(boardHtml(snapshot(),{entrants:NAMES,slate:LATE,slates:new Map([[LATE,{open:false,manual:true}]])}).includes('data-picks-slate-toggle="2026-09-27|2" aria-expanded="false"'),'a chosen slate closed by hand stays closed');
  assert(boardHtml(snapshot(),{entrants:NAMES,slate:'2026-10-04|1'}).startsWith('<div class="pm-slates-bar"'),'a slate that is not on the schedule means All Slates, with the controls');
  for(const empty of [boardHtml(snapshot({games:[]}),{entrants:NAMES}),boardHtml(null,{}),boardHtml(snapshot(),{entrants:NAMES,status:'live',slate:NIGHT})])assert(empty.startsWith('<div class="empty">')&&!empty.includes('pm-slates-bar'),'an empty state carries no slate control');
  assert.equal(slatesBarHtml(),'<div class="pm-slates-bar" role="group" aria-label="Slates"><button type="button" class="pm-slates-action" data-picks-slates="expand">Expand all</button><button type="button" class="pm-slates-action" data-picks-slates="collapse">Collapse all</button></div>');
  const group=groupGames(GAMES()).find(g=>g.key===LATE);
  assert.equal(slateHtml(group,NAMES,{open:false}),`<section class="pm-group is-collapsed" data-slate="2026-09-27|2" aria-label="Sunday Late"><h3 class="pm-group-title"><button type="button" class="pm-slate-toggle" data-picks-slate-toggle="2026-09-27|2" aria-expanded="false" aria-controls="pm-slate-2026-09-27-2"><span class="pm-slate-chevron" aria-hidden="true"></span><span class="pm-slate-copy"><span class="pm-slate-name">Sunday Late</span><small class="pm-slate-meta">Sun, Sep 27 · 2 games</small></span><span class="pm-slate-summary">${slateSummaryHtml(group)}</span></button></h3><div class="pm-slate-body" id="pm-slate-2026-09-27-2" hidden>${cardHtml(GAMES()[7],NAMES,{time:'4:05 PM EDT'})}${cardHtml(GAMES()[3],NAMES,{time:'4:25 PM EDT'})}</div></section>`,'a slate is its heading and its cards in kickoff order');
  assert(slateHtml(group,NAMES,{open:true,expanded:3}).includes(cardHtml(GAMES()[3],NAMES,{time:'4:25 PM EDT',expanded:true})),'the open matchup inside');
  assert(slateHtml(group,NAMES,{open:true,labels:labelMap(NAMES,'compact')}).includes('>Thad.<'),'compact labels inside');
  assert.match(slateHtml({key:'a b"c|d',label:'<x>',date:'',games:[]},NAMES),/^<section class="pm-group" data-slate="a b&quot;c\|d" aria-label="&lt;x&gt;"><h3 class="pm-group-title"><button type="button" class="pm-slate-toggle" data-picks-slate-toggle="a b&quot;c\|d" aria-expanded="true" aria-controls="pm-slate-a-b-c-d">/,'a key and a label are escaped, the id made safe');
});
await check('the controls: one Comparing control that opens the selection panel, the slate selector with every present slate and its count, the four status segments with their counts, a live note; the panel rows name each entry and its submission state',()=>{
  const counts=statusCounts(GAMES()),html=filterBarHtml(NAMES,{selected:['D.C.','JC'],status:'live',counts,slates:slateOptions(GAMES()),slate:EARLY});
  assert.match(html,/^<div class="pm-filters"><div class="pm-row"><button type="button" class="pm-compare" data-picks-compare aria-haspopup="dialog" aria-expanded="false" aria-controls="picksEntrants"><span class="pm-compare-copy"><span class="pm-compare-kicker">Comparing<\/span><b data-picks-compare-label>D\.C\. \+ JC<\/b><\/span><span class="pm-caret" aria-hidden="true"><\/span><\/button><label class="pm-sr" for="picksSlate">Slate<\/label><select id="picksSlate" class="pm-select" data-picks-slate>/);
  assert.deepEqual([...html.matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)].map(m=>[m[1],m[3],!!m[2]]),SLATES.map(([key,label,count])=>[key,`${label} (${count})`,key===EARLY]));
  assert.match(html,/<\/select><\/div><div class="pm-segments" role="group" aria-label="Game status"><button type="button" class="pm-segment" data-picks-status="all" aria-pressed="false">All<b data-picks-count="all">12<\/b><\/button><button type="button" class="pm-segment" data-picks-status="final" aria-pressed="false">Final<b data-picks-count="final">2<\/b><\/button><button type="button" class="pm-segment" data-picks-status="live" aria-pressed="true">Live<b data-picks-count="live">2<\/b><\/button><button type="button" class="pm-segment" data-picks-status="upcoming" aria-pressed="false">Upcoming<b data-picks-count="upcoming">6<\/b><\/button><\/div><div class="pm-options"><button type="button" class="pm-toggle" data-picks-disagree aria-pressed="false"><span class="pm-toggle-track" aria-hidden="true"><\/span><span class="pm-toggle-copy">Disagreements only<\/span><\/button><\/div><p class="pm-note" data-picks-note aria-live="polite"><\/p><\/div>$/);
  assert(!html.includes('pm-chip'),'no chip strip');
  assert.match(filterBarHtml(NAMES,{selected:['JC']}),/<button type="button" class="pm-toggle" data-picks-disagree aria-pressed="false" disabled>/,'one entry: Disagreements only is off and disabled');
  assert.match(filterBarHtml(NAMES,{selected:['JC','DJS'],disagree:true}),/data-picks-disagree aria-pressed="true"><span/,'two entries: it can be on');
  assert.match(filterBarHtml(NAMES,{selected:['JC'],disagree:true}),/data-picks-disagree aria-pressed="false" disabled>/,'asked on with one entry, it is off');
  assert.match(filterBarHtml(NAMES,{}),/data-picks-disagree aria-pressed="false"><span/,'off by default');
  assert.equal(filterBarHtml(NAMES,{}).split('data-picks-disagree').length-1,1,'one switch');
  assert.match(filterBarHtml(NAMES,{}),/<b data-picks-compare-label>All 4 entries<\/b>/,'everyone compared by default');
  assert.match(filterBarHtml(NAMES,{}),/<option value="all" selected>All Slates \(0\)<\/option><\/select>/,'All Slates alone without slates');
  assert.equal(slateOptionsHtml(slateOptions(GAMES()),'2026-10-04|1').split(' selected').length-1,1);assert.match(slateOptionsHtml(slateOptions(GAMES()),'2026-10-04|1'),/<option value="all" selected>/,'an absent slate selects All Slates');
  assert.equal(entrantPanelHtml(snapshot().entrants,['D.C.','DJS']),'<label class="pm-entry"><input type="checkbox" data-picks-entrant="D.C." checked><span class="pm-entry-copy"><span class="pm-entry-name">D.C.</span></span></label><label class="pm-entry"><input type="checkbox" data-picks-entrant="JC"><span class="pm-entry-copy"><span class="pm-entry-name">JC</span></span></label><label class="pm-entry"><input type="checkbox" data-picks-entrant="DJS" checked><span class="pm-entry-copy"><span class="pm-entry-name">DJS</span></span></label><label class="pm-entry pm-entry-none"><input type="checkbox" data-picks-entrant="Thaddeus"><span class="pm-entry-copy"><span class="pm-entry-name">Thaddeus</span><span class="pm-entry-meta">No picks submitted this week</span></span></label>');
  assert.equal((entrantPanelHtml(NAMES,null).match(/ checked/g)||[]).length,4,'plain names: everyone checked, no submission state');
  assert.equal(filterNote(NAMES,NAMES,'all',counts,12),'All 4 entries · 12 of 12 games · 2 VOID/HOLD shown in every status filter');
  assert.equal(filterNote(NAMES,['D.C.','JC'],'live',counts,4,'At least one entry stays selected'),'At least one entry stays selected · D.C. + JC · 4 of 12 games · Live · 2 VOID/HOLD shown in every status filter');
  assert.equal(filterNote(NAMES,NAMES,'final',{all:1,final:1,live:0,upcoming:0,exceptions:0},1,'','Sunday Late'),'All 4 entries · Sunday Late · 1 of 1 game · Final');
  assert.equal(filterNote(NAMES,['D.C.','JC'],'live',counts,2,'','Sunday Early',true),'D.C. + JC · Sunday Early · 2 of 12 games · Live · Disagreements only · 2 VOID/HOLD shown in every filter');
  assert.equal(filterNote(NAMES,NAMES,'all',{all:3,final:0,live:0,upcoming:3,exceptions:0},3,'','',true),'All 4 entries · 3 of 3 games · Disagreements only');
});

// ---- Card name labels and Disagreements only (the V1.4 final polish).
await check('compact labels: a name of six characters or fewer stays whole, a longer one is its first four letters and a full stop; two names that would shorten alike are lengthened until they differ; a shortening that would read like another name is lengthened; a name that cannot be shortened unambiguously stays whole; nothing is changed in place',()=>{
  assert.deepEqual(shortLabels(NAMES),['D.C.','JC','DJS','Thad.']);
  assert.deepEqual(shortLabels(['Marcus','Michael','Thaddeus','Jo','Jordan','Jeremiah']),['Marcus','Mich.','Thad.','Jo','Jordan','Jere.']);
  assert.deepEqual(shortLabels(['Thaddeus','Thadeus']),['Thadd.','Thade.'],'alike shortenings are lengthened for both');
  assert.deepEqual(shortLabels(['Thad','Thaddeus']),['Thad','Thadd.'],'a shortening that reads like another name is lengthened');
  assert.deepEqual(shortLabels(['Thad.','Thaddeus','thad']),['Thad.','Thadd.','thad'],'case and a full stop do not make two labels differ');
  assert.deepEqual(shortLabels(['Thaddeus','Thaddeus Jr']),['Thaddeus','Thaddeus Jr'],'no unambiguous shortening: whole');
  assert.deepEqual(shortLabels(['A.B.C.D.E','Big Mike','Christopher']),['A.B.','Big.','Chri.'],'no doubled full stop, no trailing space');
  assert.deepEqual(shortLabels([]),[]);assert.deepEqual(shortLabels(null),[]);
  assert.deepEqual(shortLabels(['',null,undefined,7,'Thaddeus']),['','','','7','Thad.']);
  const names=NAMES.slice();shortLabels(names);assert.deepEqual(names,NAMES,'the names are untouched');
  assert.deepEqual([...labelMap(NAMES,'compact')],[['D.C.','D.C.'],['JC','JC'],['DJS','DJS'],['Thaddeus','Thad.']]);
  assert.deepEqual([...labelMap(NAMES,'full')],NAMES.map(n=>[n,n]));assert.deepEqual([...labelMap(NAMES,'bogus')],NAMES.map(n=>[n,n]));
});
await check('the default label mode is compact on a narrow screen and full otherwise or without a screen to ask; the setting is read and written under its own key, never the selection key; a value that is not a mode, or storage trouble, means the default',()=>{
  assert.equal(defaultLabels({matchMedia:q=>({matches:q===NARROW_SCREEN})}),'compact');
  assert.equal(defaultLabels({matchMedia:()=>({matches:false})}),'full');
  assert.equal(defaultLabels(null),'full');assert.equal(defaultLabels({}),'full');assert.equal(defaultLabels({matchMedia:()=>null}),'full');
  assert.equal(defaultLabels({matchMedia(){throw new Error('no')}}),'full');
  const store=new Map(),storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v))};
  assert.equal(readLabels(storage),null);
  assert.equal(writeLabels('compact',storage),true);assert.equal(store.get(LABELS_KEY),'compact');assert.equal(readLabels(storage),'compact');
  assert.equal(writeLabels('full',storage),true);assert.equal(readLabels(storage),'full');
  assert.equal(writeLabels('tiny',storage),false,'only a mode is written');assert.equal(readLabels(storage),'full');
  assert.deepEqual([...store.keys()],[LABELS_KEY],'the selection key is never touched');
  assert.deepEqual(readSelection(NAMES,storage),NAMES,'the selection reads as before');
  assert.equal(writeSelection(['JC'],storage),true);assert.equal(readLabels(storage),'full','a selection write leaves the setting alone');
  assert.deepEqual([...store.keys()].sort(),[STORAGE_KEY,LABELS_KEY].sort());
  for(const bad of ['COMPACT','tiny','',' compact','{"compact":true}']){store.set(LABELS_KEY,bad);assert.equal(readLabels(storage),null,JSON.stringify(bad))}
  assert.equal(readLabels({getItem(){throw new Error('denied')}}),null);
  assert.equal(writeLabels('full',{setItem(){throw new Error('quota')}}),false);assert.equal(writeLabels('full',{}),false);
});
await check('a disagreement is two or more compared entries on different teams: submitted picks only, grades aside; one entry never disagrees; a missing pick never disagrees with anyone',()=>{
  const g=GAMES()[0];
  assert.equal(disagreement(g,NAMES),true);
  assert.equal(disagreement(g,['D.C.','JC']),true);assert.equal(disagreement(g,['D.C.','DJS']),false,'the same team twice is agreement');
  assert.equal(disagreement(g,['D.C.','Thaddeus']),false,'a missing pick is left out');assert.equal(disagreement(g,['JC','Thaddeus']),false);
  assert.equal(disagreement(g,['D.C.','DJS','Thaddeus']),false,'three entries, two picks, one team');assert.equal(disagreement(g,['D.C.','JC','DJS']),true);
  assert.equal(disagreement(g,['D.C.']),false);assert.equal(disagreement(g,[]),false);assert.equal(disagreement(g,null),false);assert.equal(disagreement(g,['Nobody','Thaddeus']),false);
  assert.equal(disagreement(game(0,'A','B',{picks:pk(['A','A','A','A'],['correct','incorrect','pending','void'])}),NAMES),false,'different grades on one team are no disagreement');
  assert.equal(disagreement(GAMES()[1],NAMES),true,'a tie with split picks is a disagreement: picks, not grades');
  assert.equal(disagreement(GAMES()[6],NAMES),true,'a VOID game with split picks is one too');
  assert.equal(disagreement({...g,picks:[{name:'D.C.',team:'den'},{name:'JC',team:' DEN '}]},['D.C.','JC']),false,'codes compare as codes');
  assert.equal(disagreement(null,NAMES),false);assert.equal(disagreement({},NAMES),false);assert.equal(disagreement({picks:null},NAMES),false);
});
await check('Disagreements only keeps the games where the compared entries split and the VOID and HOLD games whatever their picks, in published order, with the slate and the status; off, it keeps everything; one entry cannot disagree',()=>{
  const mixed=MIXED();
  assert.deepEqual(filterDisagreements(mixed,NAMES,true).map(g=>g.index),[0,1,2,6,7,10],'splits plus the VOID and HOLD exceptions');
  assert.deepEqual(filterDisagreements(mixed,['D.C.','JC'],true).map(g=>g.index),[0,1,2,6,7,10]);
  assert.deepEqual(filterDisagreements(mixed,['D.C.','DJS'],true).map(g=>g.index),[6,7],'two entries that agree everywhere: the exceptions alone');
  assert.deepEqual(filterDisagreements(mixed,['JC','Thaddeus'],true).map(g=>g.index),[6,7],'a missing submission never makes a disagreement');
  assert.deepEqual(filterDisagreements(mixed,['D.C.','JC','DJS'],true).map(g=>g.index),[0,1,2,6,7,10]);
  assert.deepEqual(filterDisagreements(mixed,['D.C.'],true).map(g=>g.index),[6,7],'one entry cannot disagree');
  assert.deepEqual(filterDisagreements(mixed,NAMES,false).map(g=>g.index),[0,1,2,3,4,5,6,7,8,9,10,11]);
  assert.deepEqual(filterDisagreements(mixed,NAMES,'yes').map(g=>g.index),[0,1,2,3,4,5,6,7,8,9,10,11],'only true switches it on');
  assert.deepEqual(filterDisagreements(null,NAMES,true),[]);
  assert.deepEqual(filterDisagreements(filterGames(filterSlate(mixed,EARLY),'live'),NAMES,true).map(g=>g.index),[2,6,10]);
  assert.deepEqual(filterDisagreements(filterGames(filterSlate(mixed,EARLY),'final'),NAMES,true).map(g=>g.index),[1,6]);
  assert.deepEqual(filterDisagreements(filterGames(filterSlate(mixed,LATE),'upcoming'),NAMES,true).map(g=>g.index),[7]);
  assert.deepEqual(filterDisagreements(filterGames(filterSlate(mixed,NIGHT),'all'),NAMES,true),[]);
  assert.deepEqual(statusCounts(filterDisagreements(mixed,NAMES,true)),{all:6,final:2,live:2,upcoming:0,exceptions:2});
});
await check('the board with Disagreements only: the split games and the exceptions, with the slate and the status; the empty state names who was compared and what narrowed it, or stays the plain one when nothing was listed to begin with; fewer than two entries means the filter does not apply',()=>{
  const snap=snapshot({games:MIXED()}),ids=html=>cards(html).map(c=>c.match(/data-game="(\d+)"/)[1]);
  assert.deepEqual(ids(boardHtml(snap,{entrants:NAMES,disagree:true})),['0','1','2','6','10','7']);
  assert.deepEqual(ids(boardHtml(snap,{entrants:['D.C.','JC'],status:'live',slate:EARLY,disagree:true})),['2','6','10']);
  assert.deepEqual(ids(boardHtml(snap,{entrants:['D.C.','DJS'],disagree:true})),['6','7'],'the exceptions alone');
  assert.equal(boardHtml(snap,{entrants:['D.C.','DJS'],status:'upcoming',slate:NIGHT,disagree:true}),'<div class="empty">No upcoming disagreements between D.C. and DJS in Sunday Night.</div>');
  assert.equal(boardHtml(snap,{entrants:NAMES,slate:NIGHT,disagree:true}),'<div class="empty">No disagreements among all 4 entries in Sunday Night.</div>');
  assert.equal(boardHtml(snap,{entrants:['D.C.','JC','DJS'],slate:'2026-09-28|3',disagree:true}),'<div class="empty">No disagreements among D.C., JC and DJS in Monday Night.</div>');
  assert.equal(boardHtml(snapshot({games:MIXED().filter(g=>[3,4].includes(g.index))}),{entrants:NAMES,disagree:true}),'<div class="empty">No disagreements among all 4 entries.</div>');
  assert.equal(boardHtml(snapshot({games:MIXED().filter(g=>[3,4].includes(g.index))}),{entrants:NAMES,status:'upcoming',disagree:true}),'<div class="empty">No upcoming disagreements among all 4 entries.</div>');
  assert.equal(boardHtml(snap,{entrants:NAMES,status:'live',slate:NIGHT,disagree:true}),'<div class="empty">No live games in Sunday Night.</div>','nothing listed to begin with: the plain empty state');
  assert.equal(boardHtml(snapshot({games:[]}),{entrants:NAMES,disagree:true}),'<div class="empty">No games are published for this week.</div>');
  assert.equal(ids(boardHtml(snap,{entrants:['D.C.'],disagree:true})).length,12,'one entry: the filter does not apply');
  assert.equal(ids(boardHtml(snap,{entrants:NAMES,disagree:false})).length,12);assert.equal(ids(boardHtml(snap,{entrants:NAMES})).length,12,'off by default');
  assert.equal(emptyDisagreements(NAMES,['JC','Thaddeus'],'final','Sunday Early'),'No final disagreements between JC and Thaddeus in Sunday Early.');
  assert.equal(emptyDisagreements(NAMES,NAMES),'No disagreements among all 4 entries.');assert.equal(emptyDisagreements(NAMES,NAMES,'bogus'),'No disagreements among all 4 entries.');
});
await check('compact labels on the card: a shortened name shows its label and keeps its full name for assistive technology, a short name is plain; four compared entries make the chips dense; compact labels put the chips on a grid with one column per entry; the open matchup keeps every full name; hostile names stay text',()=>{
  const map=labelMap(NAMES,'compact');
  const html=cardHtml(GAMES()[0],NAMES,{time:'8:15 PM EDT',labels:map});
  assert.match(html,/<span class="pm-results is-dense is-grid" style="--pm-cols:4"><span class="pm-token ok"><span class="pm-token-name">D\.C\.<\/span><span class="pm-token-pick">DEN<\/span><span class="pm-token-mark" role="img" aria-label="correct">✓<\/span><\/span>/,'a short name is plain text');
  assert.match(html,/<span class="pm-token bad no-pick"><span class="pm-token-name"><span class="pm-token-short" aria-hidden="true">Thad\.<\/span><span class="pm-sr">Thaddeus<\/span><\/span><span class="pm-token-pick">—<\/span><span class="pm-token-mark" role="img" aria-label="incorrect">✕<\/span><\/span><\/span><\/button>/);
  assert.equal((html.match(/pm-token-short/g)||[]).length,1,'only the long name is shortened');
  const details=html.slice(html.indexOf('<div class="pm-details"'));
  assert.deepEqual([...details.matchAll(/<span class="pm-name">([^<]+)<\/span>/g)].map(m=>m[1]),NAMES,'the open matchup keeps full names');
  assert(!details.includes('Thad.')&&!details.includes('pm-sr'));
  const full=cardHtml(GAMES()[0],NAMES,{time:'8:15 PM EDT'});
  assert.match(full,/<span class="pm-results is-dense" style="--pm-cols:4">/,'full labels: dense, no grid');
  assert(!full.includes('pm-token-short')&&!full.includes('pm-sr')&&!full.includes('Thad.'));
  assert.deepEqual(tokensOf(full).map(t=>t[0]),NAMES);
  assert.match(cardHtml(GAMES()[0],['D.C.','JC','Thaddeus'],{labels:map}),/<span class="pm-results is-grid" style="--pm-cols:3">/,'three entries are not dense');
  assert.match(cardHtml(GAMES()[0],['JC'],{}),/<span class="pm-results" style="--pm-cols:1">/);
  assert.match(cardHtml(GAMES()[0],[],{labels:map}),/<span class="pm-results is-grid" style="--pm-cols:1"><span class="pm-token pending"><span class="pm-token-name">No entry selected<\/span><\/span><\/span>/);
  assert.match(summaryHtml(GAMES()[2],NAMES,{labels:map}),/<span class="pm-token-short" aria-hidden="true">Thad\.<\/span><span class="pm-sr">Thaddeus<\/span><\/span><span class="pm-token-pick">—<\/span><\/span>/,'a live game: the label, the pick, no mark');
  assert(boardHtml(snapshot(),{entrants:NAMES,labels:'compact'}).includes('>Thad.<'));
  assert(!boardHtml(snapshot(),{entrants:NAMES,labels:'full'}).includes('Thad.'));assert(!boardHtml(snapshot(),{entrants:NAMES}).includes('Thad.'),'full unless asked');
  assert.equal((boardHtml(snapshot(),{entrants:NAMES,labels:'compact'}).match(/<span class="pm-sr">Thaddeus<\/span>/g)||[]).length,12,'every card speaks the full name');
  assert(!boardHtml(snapshot(),{entrants:NAMES,labels:'compact'}).includes('pm-name">Thad.'),'no open matchup is shortened');
  const hostile=cardHtml(game(0,'A','B',{picks:[{name:'<Thaddeus>',team:'A',result:'correct'}]}),['<Thaddeus>'],{labels:labelMap(['<Thaddeus>'],'compact')});
  assert(hostile.includes('<span class="pm-token-short" aria-hidden="true">&lt;Tha.</span><span class="pm-sr">&lt;Thaddeus&gt;</span>'),'the label and the name are escaped');
  assert(!/<Tha|<Thaddeus>/.test(hostile));
});

// ---- Rules & rulings summary and alerts.
await check('the collapsed summary and the alerts come from the app’s own model: loading, unavailable, ON HOLD, inactive, ready with no rulings, and ready with stale, held, reviewed and applied rulings',()=>{
  assert.deepEqual(rulesSummary(null),{summary:'Loading contest rules and rulings…',alerts:[]});
  assert.deepEqual(rulesSummary({ready:false,reason:'Survivor is not published yet: No published Survivor weeks found'}),{summary:'Survivor is not published yet: No published Survivor weeks found',alerts:[]});
  assert.deepEqual(rulesSummary({ready:false}),{summary:'Loading contest rules and rulings…',alerts:[]});
  assert.deepEqual(rulesSummary(rulesAnswer(null)),{summary:'Loading contest rules and rulings…',alerts:[]},'ready before the first ruling load');
  assert.deepEqual(rulesSummary(rulesAnswer({state:'hold',contestType:"Pick'em contest",heading:'ON HOLD · Ruling data unavailable',text:'The contest rules and rulings could not be loaded or verified (ruling data unavailable). Results that depend on them are on hold until they load; nothing is graded from the NFL feed alone.',confirmation:'…'})),
    {summary:'ON HOLD · Ruling data unavailable',alerts:[{tone:'bad',label:'ON HOLD',text:'The contest rules and rulings could not be loaded or verified (ruling data unavailable). Results that depend on them are on hold until they load; nothing is graded from the NFL feed alone.'}]});
  assert.deepEqual(rulesSummary(rulesAnswer({state:'inactive',contestType:'Pool contest',heading:'No contest-scoped rulings',text:'…',confirmation:'…'})),{summary:'No contest-scoped rulings',alerts:[]});
  assert.deepEqual(rulesSummary(rulesAnswer(readyModel())),{summary:'Void policy · revision 1 · no incident rulings',alerts:[]});
  const busy=readyModel({stale:'The rules and rulings could not be refreshed just now; these are the ones last verified on this page.',incidents:[
    incident(),
    incident({key:'3|DEN|KC|1',matchup:'DEN @ KC',status:'UNDER REVIEW',review:'UNDER REVIEW: the feed now reports a completed final. The ruling stays applied until the commissioner changes it.'}),
    incident({key:'3|LV|LAC|1',matchup:'LV @ LAC',status:'HOLD',detail:'On hold: the ruling cites policy revision 2, which does not exist. No consequence is applied.'}),
    incident({key:'2|GB|MIN|1',week:2,matchup:'GB @ MIN',status:'WITHDRAWN',detail:'The ruling was withdrawn: there is no active ruling, so the NFL result or the awaiting-ruling state applies.'})]});
  assert.deepEqual(rulesSummary(rulesAnswer(busy)),{summary:'Void policy · revision 1 · 1 applied · 1 under review · 1 on hold · 1 withdrawn · RULINGS STALE',alerts:[
    {tone:'warn',label:'RULINGS STALE',text:'The rules and rulings could not be refreshed just now; these are the ones last verified on this page.'},
    {tone:'warn',label:'HOLD',text:'Week 3 · LV @ LAC · On hold: the ruling cites policy revision 2, which does not exist. No consequence is applied.'},
    {tone:'warn',label:'UNDER REVIEW',text:'Week 3 · DEN @ KC · UNDER REVIEW: the feed now reports a completed final. The ruling stays applied until the commissioner changes it.'},
    {tone:'info',label:'APPLIED',text:'Week 3 · BUF @ CIN · VOID: removed from scoring, with no win, no loss and no points. Applied by commissioner ruling under policy revision 1.'}]});
  assert.deepEqual(rulesSummary(rulesAnswer(readyModel({policy:null,incidents:[incident()]}))).summary,'No policy in force · 1 applied');
  assert.equal(alertsHtml(rulesSummary(rulesAnswer(busy)).alerts).split('<div class="rules-alert-line').length-1,4);
  assert.equal(alertsHtml([{tone:'warn',label:'HOLD',text:'<b>x</b> & y'}]),'<div class="rules-alert-line tone-warn"><b>HOLD</b><span>&lt;b&gt;x&lt;/b&gt; &amp; y</span></div>');
  assert.equal(alertsHtml([]),'');assert.equal(alertsHtml(null),'');
});

// ---- A small DOM: elements with attributes, classList, dataset, hidden, open, checked, disabled, value, textContent and
// innerHTML (parsed), simple selectors (tag, #id, .class, [attr], [attr="value"], compounds and descendants), events that
// bubble to the document, and focus. Only what picks-mobile.js uses.
const VOID=new Set(['img','input','br','hr','meta','link','path','source','wbr']);
const decode=s=>s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g,m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[m]));
const encode=s=>String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
const kebab=k=>k.replace(/[A-Z]/g,m=>'-'+m.toLowerCase());
class TextNode{constructor(text){this.nodeType=3;this.text=text;this.parent=null}get textContent(){return this.text}}
class ClassList{
  constructor(node){this.node=node}
  get list(){return (this.node.getAttribute('class')||'').split(/\s+/).filter(Boolean)}
  set(list){this.node.setAttribute('class',list.join(' '))}
  contains(c){return this.list.includes(c)}
  add(...cs){const l=this.list;for(const c of cs)if(!l.includes(c))l.push(c);this.set(l)}
  remove(...cs){this.set(this.list.filter(c=>!cs.includes(c)))}
  toggle(c,force){const has=this.contains(c),want=force===undefined?!has:!!force;if(want&&!has)this.add(c);if(!want&&has)this.remove(c);return want}
}
function callListeners(node,event){for(const l of (node.listeners.get(event.type)||[]).slice()){if(l.once)node.listeners.set(event.type,node.listeners.get(event.type).filter(x=>x!==l));l.fn.call(node,event)}}
const flag=name=>({get(){return this.hasAttribute(name)},set(v){if(v)this.setAttribute(name,'');else this.removeAttribute(name)}});
class Element{
  constructor(tag,doc){
    this.nodeType=1;this.localName=tag.toLowerCase();this.tagName=this.localName.toUpperCase();this.doc=doc;this.children=[];this.parent=null;this.attrs=new Map();this.listeners=new Map();this.classList=new ClassList(this);
    this.dataset=new Proxy({},{get:(_,k)=>typeof k==='string'?(this.getAttribute('data-'+kebab(k))??undefined):undefined,set:(_,k,v)=>{this.setAttribute('data-'+kebab(k),String(v));return true},has:(_,k)=>this.hasAttribute('data-'+kebab(k))});
  }
  setAttribute(k,v){this.attrs.set(k,String(v))}getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null}hasAttribute(k){return this.attrs.has(k)}removeAttribute(k){this.attrs.delete(k)}
  get id(){return this.getAttribute('id')||''}set id(v){this.setAttribute('id',v)}
  get className(){return this.getAttribute('class')||''}set className(v){this.setAttribute('class',v)}
  // A select's value is its selected option's (the first option without one); setting it selects that option, as in the DOM.
  get value(){if(this.localName!=='select')return this.attrs.get('value')??'';const options=this.querySelectorAll('option');return(options.find(o=>o.hasAttribute('selected'))||options[0])?.getAttribute('value')??''}
  set value(v){if(this.localName!=='select'){this.setAttribute('value',v);return}const options=this.querySelectorAll('option'),hit=options.find(o=>o.getAttribute('value')===String(v));if(!hit)return;for(const o of options)o.removeAttribute('selected');hit.setAttribute('selected','')}
  appendChild(c){if(c.parent)c.parent.children=c.parent.children.filter(x=>x!==c);c.parent=this;this.children.push(c);return c}
  append(...cs){for(const c of cs)this.appendChild(typeof c==='string'?new TextNode(c):c)}
  remove(){if(this.parent){this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null}}
  replaceChildren(...cs){for(const c of this.children)c.parent=null;this.children=[];this.append(...cs)}
  get textContent(){return this.children.map(c=>c.textContent).join('')}
  set textContent(v){this.replaceChildren();if(v!==''&&v!=null)this.appendChild(new TextNode(String(v)))}
  get innerHTML(){return this.children.map(serialize).join('')}
  set innerHTML(html){this.replaceChildren();for(const c of parse(String(html),this.doc))this.appendChild(c)}
  get elements(){const out=[];(function walk(n){for(const c of n.children)if(c.nodeType===1){out.push(c);walk(c)}})(this);return out}
  querySelectorAll(sel){return this.elements.filter(e=>matchesSelector(e,sel))}
  querySelector(sel){return this.querySelectorAll(sel)[0]||null}
  matches(sel){return matchesSelector(this,sel)}
  closest(sel){let n=this;while(n&&n.nodeType===1){if(n.matches(sel))return n;n=n.parent}return null}
  addEventListener(type,fn,options){const list=this.listeners.get(type)||[];list.push({fn,once:!!(options&&options.once)});this.listeners.set(type,list)}
  removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)||[]).filter(l=>l.fn!==fn))}
  dispatchEvent(event){
    try{if(event.target==null)event.target=this}catch{}
    for(let node=this;node;node=node.parent){callListeners(node,event);if(event.bubbles===false||event.cancelBubble)return !event.defaultPrevented}
    callListeners(this.doc,event);
    return !event.defaultPrevented;
  }
  click(){this.dispatchEvent({type:'click',bubbles:true,target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true},stopPropagation(){this.cancelBubble=true}})}
  change(){this.dispatchEvent({type:'change',bubbles:true,target:this,defaultPrevented:false,preventDefault(){},stopPropagation(){this.cancelBubble=true}})}
  focus(){this.doc.activeElement=this}
  blur(){if(this.doc.activeElement===this)this.doc.activeElement=null}
}
Object.defineProperties(Element.prototype,{hidden:flag('hidden'),open:flag('open'),checked:flag('checked'),disabled:flag('disabled')});
function matchesCompound(el,compound){
  const re=/([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;let m,any=false;
  while((m=re.exec(compound))){
    any=true;
    if(m[1]){if(el.localName!==m[1].toLowerCase())return false}
    else if(m[2]){if(el.id!==m[2])return false}
    else if(m[3]){if(!el.classList.contains(m[3]))return false}
    else if(m[4]){if(!el.hasAttribute(m[4]))return false;if(m[5]!==undefined&&el.getAttribute(m[4])!==m[5])return false}
  }
  return any;
}
function matchesSelector(el,selector){
  return String(selector).split(',').some(s=>{
    const parts=s.trim().split(/\s+/);let node=el;
    if(!matchesCompound(node,parts[parts.length-1]))return false;
    for(let k=parts.length-2;k>=0;k--){node=node.parent;while(node&&node.nodeType===1&&!matchesCompound(node,parts[k]))node=node.parent;if(!node||node.nodeType!==1)return false}
    return true;
  });
}
const serialize=n=>n.nodeType===3?encode(n.text):`<${n.localName}${[...n.attrs].map(([k,v])=>v===''?` ${k}`:` ${k}="${v.replace(/"/g,'&quot;')}"`).join('')}>${VOID.has(n.localName)?'':n.children.map(serialize).join('')+`</${n.localName}>`}`;
function parse(html,doc){
  const root=[],stack=[];let i=0;
  const push=n=>{if(stack.length){stack[stack.length-1].children.push(n);n.parent=stack[stack.length-1]}else root.push(n)};
  while(i<html.length){
    if(html.startsWith('<!--',i)){const end=html.indexOf('-->',i);i=end<0?html.length:end+3;continue}
    if(html[i]==='<'){
      const end=html.indexOf('>',i);let tag=html.slice(i+1,end);i=end+1;
      if(tag.startsWith('/')){const name=tag.slice(1).trim().toLowerCase();for(let k=stack.length-1;k>=0;k--)if(stack[k].localName===name){stack.length=k;break}continue}
      const selfClosing=tag.trim().endsWith('/');if(selfClosing)tag=tag.trim().slice(0,-1);
      const m=/^([a-zA-Z][\w-]*)\s*([\s\S]*)$/.exec(tag.trim()),el=new Element(m[1],doc),attrs=/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g;let a;
      while((a=attrs.exec(m[2])))el.setAttribute(a[1],decode(a[2]??a[3]??a[4]??''));
      push(el);if(!selfClosing&&!VOID.has(el.localName))stack.push(el);
    }else{const next=html.indexOf('<',i),text=html.slice(i,next<0?html.length:next);i=next<0?html.length:next;if(text)push(new TextNode(decode(text)))}
  }
  return root;
}
function makeDocument(html){
  const doc={listeners:new Map(),activeElement:null,
    createElement:tag=>new Element(tag,doc),
    getElementById:id=>doc.body.elements.find(e=>e.id===id)||null,
    querySelectorAll:sel=>doc.body.querySelectorAll(sel),querySelector:sel=>doc.body.querySelector(sel),
    addEventListener(type,fn,options){const list=doc.listeners.get(type)||[];list.push({fn,once:!!(options&&options.once)});doc.listeners.set(type,list)},
    removeEventListener(type,fn){doc.listeners.set(type,(doc.listeners.get(type)||[]).filter(l=>l.fn!==fn))},
    dispatchEvent(event){try{if(event.target==null)event.target=doc}catch{}callListeners(doc,event);return !event.defaultPrevented}};
  doc.body=new Element('body',doc);doc.body.innerHTML=html;doc.body.dataset.view='picks';
  return doc;
}
let instance=0;
// A page: the real Games, Survivor and Picks panels, the two apps as listeners (answering a picks or rules request with their
// fixture, or null for an app that is not there), storage as configured, and the module booted on it.
async function page({picksAnswer=()=>snapshot(),pickemRules=()=>rulesAnswer(readyModel({incidents:[incident()]})),survivorRules=()=>({ready:true,contest:'survivor',week:3,model:readyModel({contestType:'Survivor contest',contestName:'Pool Center 2026 Survivor',policy:{revision:1,effectiveWeek:1,name:'Advance, team used',text:'…',publicNote:null},revisions:[{revision:1,effectiveWeek:1,name:'Advance, team used',publicNote:null}]})}),storage='ok',stored=null,storedLabels=null,narrow=false}={}){
  const doc=makeDocument(PAGE);
  globalThis.document=doc;
  globalThis.location={href:'https://example.test/nfl-pool/?view=picks',search:'?view=picks'};
  // The screen: narrow (a phone) or not, as the module asks matchMedia; no scrolling.
  globalThis.window={matchMedia:query=>({matches:narrow===true&&query===NARROW_SCREEN,media:query})};
  const store=new Map(),writes=[];
  if(stored!==null)store.set(STORAGE_KEY,typeof stored==='string'?stored:JSON.stringify(stored));
  if(storedLabels!==null)store.set(LABELS_KEY,String(storedLabels));
  const localStorage=storage==='absent'?undefined:storage==='throws'?{getItem(){throw new Error('denied')},setItem(){throw new Error('denied')}}
    :{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{writes.push([k,String(v)]);store.set(k,String(v))},removeItem:k=>store.delete(k)};
  if(localStorage)globalThis.localStorage=localStorage;else delete globalThis.localStorage;
  const answers={picks:picksAnswer,pickem:pickemRules,survivor:survivorRules},asked=[];
  doc.addEventListener('poolcenter:picks',e=>{asked.push(['picks',e.detail.contest]);if(e.detail.contest==='pickem'&&answers.picks)e.detail.snapshot=answers.picks()});
  doc.addEventListener('poolcenter:rules',e=>{asked.push(['rules',e.detail.contest]);const answer=answers[e.detail.contest];if(answer)e.detail.snapshot=answer()});
  const timers=[],realSetInterval=globalThis.setInterval,realSetTimeout=globalThis.setTimeout;
  globalThis.setInterval=(fn,ms)=>{timers.push(['setInterval',ms]);return 0};
  globalThis.setTimeout=(fn,ms,...a)=>{if(ms>0)timers.push(['setTimeout',ms]);return realSetTimeout(fn,ms,...a)};
  try{await import(`./picks-mobile.js?instance=${++instance}`)}finally{globalThis.setInterval=realSetInterval;globalThis.setTimeout=realSetTimeout}
  await flush();
  const card=contest=>doc.querySelector(`[data-rules-card="${contest}"]`),board=()=>doc.getElementById('picksBoard'),dialog=()=>doc.getElementById('picksEntrants');
  return{doc,store,writes,answers,asked,timers,
    card,toggle:contest=>doc.querySelector(`[data-rules-toggle="${contest}"]`),body:contest=>doc.getElementById(`${contest}-rules-body`),
    summary:contest=>doc.querySelector(`[data-rules-summary="${contest}"]`).textContent,alerts:contest=>doc.querySelector(`[data-rules-alerts="${contest}"]`),
    label:contest=>doc.querySelector(`[data-rules-card="${contest}"] [data-rules-toggle-label]`).textContent,
    update:contest=>doc.dispatchEvent(new CustomEvent('poolcenter:update',{detail:{contest}})),
    board,filters:()=>doc.getElementById('picksFilters'),dialog,
    compare:()=>doc.querySelector('[data-picks-compare]'),comparing:()=>doc.querySelector('[data-picks-compare-label]')?.textContent??null,
    select:()=>doc.querySelector('[data-picks-slate]'),slates:()=>doc.querySelectorAll('[data-picks-slate] option').map(o=>[o.getAttribute('value'),o.textContent,o.hasAttribute('selected')]),
    chooseSlate:key=>{const s=doc.querySelector('[data-picks-slate]');s.value=key;s.change()},
    segment:status=>doc.querySelector(`[data-picks-status="${status}"]`),
    note:()=>doc.querySelector('[data-picks-note]')?.textContent??null,
    boxes:()=>doc.querySelectorAll('[data-picks-entrants] [data-picks-entrant]'),box:name=>doc.querySelector(`[data-picks-entrants] [data-picks-entrant="${name}"]`),
    checked:()=>Object.fromEntries(doc.querySelectorAll('[data-picks-entrants] [data-picks-entrant]').map(b=>[b.dataset.picksEntrant,b.checked])),
    toggleBox:name=>{const b=doc.querySelector(`[data-picks-entrants] [data-picks-entrant="${name}"]`);b.checked=!b.checked;b.change()},
    selectAll:()=>doc.querySelector('[data-picks-entrant="*"]'),dialogNote:()=>doc.querySelector('[data-picks-dialog-note]')?.textContent??null,
    done:()=>doc.querySelector('.pm-sheet-actions [data-picks-close]'),
    labelsButton:mode=>doc.querySelector(`[data-picks-labels="${mode}"]`),
    labelsMode:()=>doc.querySelectorAll('[data-picks-labels]').find(b=>b.getAttribute('aria-pressed')==='true')?.dataset.picksLabels??null,
    labelsStored:()=>store.has(LABELS_KEY)?store.get(LABELS_KEY):null,
    disagree:()=>doc.querySelector('[data-picks-disagree]'),
    chipNames:article=>article.querySelectorAll('.pm-token-name').map(n=>n.querySelector('.pm-token-short')?.textContent??n.textContent),
    cards:()=>board().querySelectorAll('article'),cardOf:i=>board().querySelectorAll('article').find(a=>Number(a.dataset.game)===i),
    shown:()=>board().querySelectorAll('article').map(a=>Number(a.dataset.game)),
    groups:()=>board().querySelectorAll('.pm-slate-name').map(s=>s.textContent),
    sections:()=>board().querySelectorAll('.pm-group'),slateToggle:key=>doc.querySelector(`[data-picks-slate-toggle="${key}"]`),
    slateBody:key=>{const t=doc.querySelector(`[data-picks-slate-toggle="${key}"]`);return t?doc.getElementById(t.getAttribute('aria-controls')||''):null},
    slatesOpen:()=>Object.fromEntries(board().querySelectorAll('[data-picks-slate-toggle]').map(b=>[b.dataset.picksSlateToggle,b.getAttribute('aria-expanded')==='true'])),
    pills:key=>doc.querySelector(`[data-picks-slate-toggle="${key}"] .pm-slate-summary`)?.querySelectorAll('.pm-slate-pill').map(x=>x.textContent)??null,
    bar:()=>board().querySelector('.pm-slates-bar'),slatesAction:kind=>doc.querySelector(`[data-picks-slates="${kind}"]`),
    expandOf:i=>doc.querySelector(`[data-picks-expand="${i}"]`),details:i=>doc.getElementById(`pm-details-${i}`),
    expanded:()=>board().querySelectorAll('[data-picks-expand]').filter(b=>b.getAttribute('aria-expanded')==='true').map(b=>Number(b.dataset.picksExpand)),
    status:()=>doc.querySelectorAll('[data-picks-status]').find(s=>s.getAttribute('aria-pressed')==='true')?.dataset.picksStatus??null,
    counts:()=>Object.fromEntries(doc.querySelectorAll('[data-picks-count]').map(c=>[c.dataset.picksCount,c.textContent])),
    table:()=>[doc.getElementById('pickHead').innerHTML,doc.getElementById('pickBody').innerHTML],
    prefs:()=>JSON.parse(store.get(STORAGE_KEY)||'null')};
}
// What a reader gets: the text of the elements, aria-hidden decoration (the team badges, a compact label) left out, one space
// between parts.
const visible=node=>node.nodeType===3?node.text:node.getAttribute('aria-hidden')==='true'?'':node.children.map(visible).filter(Boolean).join(' ');
const spoken=node=>visible(node).replace(/\s+/g,' ').trim();
// The names the chips speak: the full names, whatever label is shown.
const namesOn=article=>article.querySelectorAll('.pm-token-name').map(spoken);
const tokens=article=>article.querySelectorAll('.pm-token').map(spoken);

// ---- The page part: collapsible Rules & rulings (unchanged from V1.3).
await check('boot: both Rules & rulings cards are collapsed as the page ships (body hidden, the control says Expand), with the summary and the alerts from the apps’ own models visible, nothing written, no timer started',async()=>{
  const p=await page();
  for(const contest of ['pickem','survivor']){
    assert.equal(p.body(contest).hidden,true,`${contest} body hidden`);
    assert.equal(p.toggle(contest).getAttribute('aria-expanded'),'false',`${contest} collapsed`);
    assert.equal(p.toggle(contest).getAttribute('aria-controls'),`${contest}-rules-body`);
    assert.equal(p.toggle(contest).getAttribute('aria-label'),'Expand Rules & rulings');
    assert.equal(p.label(contest),'Expand');
    assert.equal(p.card(contest).classList.contains('is-collapsed'),true);
    assert(p.doc.getElementById(contest==='pickem'?'pickemRules':'svRules').closest('.rules-panel')===p.body(contest),`the app's container is inside the ${contest} body`);
  }
  assert.equal(p.summary('pickem'),'Void policy · revision 1 · 1 applied');
  assert.equal(p.alerts('pickem').innerHTML,'<div class="rules-alert-line tone-info"><b>APPLIED</b><span>Week 3 · BUF @ CIN · VOID: removed from scoring, with no win, no loss and no points. Applied by commissioner ruling under policy revision 1.</span></div>');
  assert.equal(p.summary('survivor'),'Advance, team used policy · revision 1 · no incident rulings');
  assert.equal(p.alerts('survivor').innerHTML,'');
  assert.deepEqual(p.asked.filter(([kind])=>kind==='rules'),[['rules','pickem'],['rules','survivor']],'each card asks its own app once at boot');
  assert.deepEqual(p.writes,[],'nothing is written until a choice is made');
  assert.deepEqual(p.timers,[],'no timer: the apps say when something changed');
});
await check('the control expands and collapses with a click (so with Enter or Space on the button), keeps focus, and names its state for assistive technology',async()=>{
  const p=await page();
  for(const contest of ['pickem','survivor']){
    const toggle=p.toggle(contest);
    toggle.focus();toggle.click();
    assert.equal(p.body(contest).hidden,false,`${contest} expanded`);
    assert.equal(toggle.getAttribute('aria-expanded'),'true');assert.equal(toggle.getAttribute('aria-label'),'Collapse Rules & rulings');assert.equal(p.label(contest),'Collapse');
    assert.equal(p.card(contest).classList.contains('is-collapsed'),false);
    assert.equal(p.doc.activeElement,toggle,'focus stays on the control');
    toggle.click();
    assert.equal(p.body(contest).hidden,true,`${contest} collapsed again`);
    assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(p.label(contest),'Expand');assert.equal(p.card(contest).classList.contains('is-collapsed'),true);
  }
  assert.equal(p.body('pickem').hidden,true);assert.equal(p.body('survivor').hidden,true);
  p.toggle('pickem').click();assert.equal(p.body('pickem').hidden,false);assert.equal(p.body('survivor').hidden,true,'each card has its own state');
});
await check('the expanded or collapsed state survives every refresh: an app’s update re-reads its model for the summary and the alerts and never touches the body',async()=>{
  const p=await page();
  p.toggle('pickem').click();
  const inner=p.doc.getElementById('pickemRules');inner.innerHTML='<div class="rules-grid">rendered by weekly-app.js</div>';
  p.answers.pickem=()=>rulesAnswer(readyModel({stale:'The rules and rulings could not be refreshed just now; these are the ones last verified on this page.',incidents:[incident({status:'UNDER REVIEW',review:'UNDER REVIEW: the feed now reports a completed final. The ruling stays applied until the commissioner changes it.'})]}));
  for(let i=0;i<3;i++)p.update('pickem');
  assert.equal(p.body('pickem').hidden,false,'still expanded');assert.equal(p.toggle('pickem').getAttribute('aria-expanded'),'true');
  assert.equal(inner.innerHTML,'<div class="rules-grid">rendered by weekly-app.js</div>','the app’s rendering is untouched');
  assert.equal(p.summary('pickem'),'Void policy · revision 1 · 1 under review · RULINGS STALE');
  assert.deepEqual(p.alerts('pickem').querySelectorAll('.rules-alert-line').map(a=>a.textContent),[
    'RULINGS STALEThe rules and rulings could not be refreshed just now; these are the ones last verified on this page.',
    'UNDER REVIEWWeek 3 · BUF @ CIN · UNDER REVIEW: the feed now reports a completed final. The ruling stays applied until the commissioner changes it.']);
  p.update('survivor');
  assert.equal(p.body('pickem').hidden,false,'Survivor’s update leaves Pick’em’s card alone');assert.equal(p.body('survivor').hidden,true);
  p.toggle('pickem').click();p.update('pickem');
  assert.equal(p.body('pickem').hidden,true,'collapsed stays collapsed through a refresh');
});
await check('ON HOLD, HOLD, UNDER REVIEW and stale warnings stay visible while the card is collapsed, in a live status region; a loading or unavailable app shows its reason',async()=>{
  const hold=await page({pickemRules:()=>rulesAnswer({state:'hold',contestType:"Pick'em contest",heading:'ON HOLD · Ruling data unavailable',text:'The contest rules and rulings could not be loaded or verified (ruling data unavailable). Results that depend on them are on hold until they load; nothing is graded from the NFL feed alone.',confirmation:'…'}),
    survivorRules:()=>({ready:true,contest:'survivor',week:3,model:readyModel({incidents:[incident({status:'HOLD',detail:'On hold: the ruling cites policy revision 2, which does not exist. No consequence is applied.'})]})})});
  assert.equal(hold.body('pickem').hidden,true);
  assert.equal(hold.summary('pickem'),'ON HOLD · Ruling data unavailable');
  assert.match(hold.alerts('pickem').innerHTML,/^<div class="rules-alert-line tone-bad"><b>ON HOLD<\/b><span>The contest rules and rulings could not be loaded/);
  assert.equal(hold.alerts('pickem').getAttribute('aria-live'),'polite');assert.equal(hold.alerts('pickem').getAttribute('role'),'status');
  assert.match(hold.alerts('survivor').innerHTML,/^<div class="rules-alert-line tone-warn"><b>HOLD<\/b><span>Week 3 · BUF @ CIN · On hold: the ruling cites policy revision 2/);
  const loading=await page({pickemRules:()=>({ready:false,reason:'Loading contest rules and rulings…'}),survivorRules:()=>({ready:false,reason:'Survivor is not published yet: No published Survivor weeks found'})});
  assert.equal(loading.summary('pickem'),'Loading contest rules and rulings…');assert.equal(loading.alerts('pickem').innerHTML,'');
  assert.equal(loading.summary('survivor'),'Survivor is not published yet: No published Survivor weeks found');
  const silent=await page({pickemRules:null,survivorRules:null});
  assert.equal(silent.summary('pickem'),'Loading contest rules and rulings…','an app that does not answer');
});

// ---- The page part: the compact Picks board.
await check('boot: the compact list; every matchup is one collapsed card in kickoff order with all four entries’ tokens, the one Comparing control, the slate selector with every present slate and its count, All / Final / Live / Upcoming with counts, the note; the table is untouched',async()=>{
  const p=await page();
  assert.equal(p.board().hidden,false);assert.equal(p.filters().hidden,false);
  assert.equal(p.board().closest('.picks').classList.contains('is-mobile-ready'),true);
  assert.equal(p.board().closest('[data-view-panel]').classList.contains('is-mobile-ready'),true,'the panel is marked too, for the page copy');
  assert.deepEqual(p.shown(),[0,11,1,2,6,10,7,3,4,8,5,9]);
  assert.deepEqual(p.groups(),['Thursday Night','Sunday Morning','Sunday Early','Sunday Late','Sunday Night','Sunday · Kickoff TBD','Monday Night','Kickoff TBD']);
  assert.deepEqual(p.expanded(),[],'every card starts collapsed');
  for(const article of p.cards()){
    assert.deepEqual(namesOn(article),NAMES,`card ${article.dataset.game}`);
    const toggle=article.querySelector('[data-picks-expand]');
    assert.equal(toggle.localName,'button');assert.equal(toggle.getAttribute('aria-controls'),`pm-details-${article.dataset.game}`);
    assert.equal(p.details(Number(article.dataset.game)).hidden,true,`card ${article.dataset.game} details hidden`);
    assert.equal(article.querySelectorAll('.pm-status').length,1,'one status pill per card');
  }
  assert.equal(p.comparing(),'All 4 entries');assert.equal(p.compare().getAttribute('aria-haspopup'),'dialog');assert.equal(p.compare().getAttribute('aria-expanded'),'false');
  assert.deepEqual(p.slates(),SLATES.map(([key,label,count])=>[key,`${label} (${count})`,key==='all']));
  assert.equal(p.select().value,'all');
  assert.equal(p.status(),'all');assert.deepEqual(p.counts(),{all:'12',final:'2',live:'2',upcoming:'6'});
  assert.equal(p.note(),'All 4 entries · 12 of 12 games · 2 VOID/HOLD shown in every status filter');
  assert.equal(p.dialog().open,false);
  assert.deepEqual(p.table(),['',''],'the comparison table is weekly-app.js’s alone');
  assert(p.doc.querySelector('.picks .scroll table thead#pickHead'),'the table markup stays');
  assert.deepEqual(p.asked.filter(([kind])=>kind==='picks'),[['picks','pickem']]);
  assert.deepEqual(p.writes,[]);assert.deepEqual(p.timers,[]);
});
await check('expansion: a tap opens one matchup (its grading, ownership and explanations), a tap on another moves the one open matchup there, a tap on the open one restores the compact view; focus stays on the control',async()=>{
  const p=await page();
  const t2=p.expandOf(2);t2.focus();t2.click();
  assert.deepEqual(p.expanded(),[2]);assert.equal(p.details(2).hidden,false);assert.equal(p.cardOf(2).classList.contains('is-expanded'),true);
  assert.equal(p.doc.activeElement,t2);
  assert.deepEqual(p.details(2).querySelectorAll('.pm-pick').map(spoken),['D.C. NYJ Pending','JC NE Pending','DJS NYJ Pending','Thaddeus NO PICK Pending']);
  p.expandOf(3).click();
  assert.deepEqual(p.expanded(),[3],'only one matchup is open at a time');assert.equal(p.details(2).hidden,true);assert.equal(p.cardOf(2).classList.contains('is-expanded'),false);
  assert.equal(spoken(p.details(3).querySelector('.pm-ownership')),'WAS 31% of 87 entries 69% PHI');
  p.expandOf(3).click();
  assert.deepEqual(p.expanded(),[],'collapsing restores the compact view');assert.equal(p.details(3).hidden,true);
  p.expandOf(0).click();
  assert.deepEqual(p.details(0).querySelectorAll('.pm-pick').map(spoken),['D.C. DEN ✓ Correct','JC KC ✕ Incorrect','DJS DEN ✓ Correct','Thaddeus NO PICK ✕ No pick']);
  assert(!p.details(0).querySelector('.pm-score')&&!p.details(0).querySelector('.pm-status'),'the details repeat no score or status');
  assert.deepEqual(tokens(p.cardOf(0)),['D.C. DEN ✓','JC KC ✕','DJS DEN ✓','Thaddeus — ✕'],'the summary keeps its tokens while open');
});
await check('slate filtering: the selector shows only that slate, the status counts and the note follow the slate, All Slates restores everything',async()=>{
  const p=await page();
  p.chooseSlate(EARLY);
  assert.equal(p.select().value,EARLY);assert.deepEqual(p.shown(),[1,2,6,10]);assert.deepEqual(p.groups(),['Sunday Early']);
  assert.deepEqual(p.counts(),{all:'4',final:'1',live:'2',upcoming:'0'});
  assert.equal(p.note(),'All 4 entries · Sunday Early · 4 of 4 games · 1 VOID/HOLD shown in every status filter');
  assert.deepEqual(p.slates().filter(s=>s[2]).map(s=>s[0]),[EARLY],'the selector keeps the choice');
  p.chooseSlate('tbd');assert.deepEqual(p.shown(),[9]);assert.equal(p.note(),'All 4 entries · Kickoff TBD · 1 of 1 game');
  p.chooseSlate('2026-09-27|4');assert.deepEqual(p.shown(),[8]);assert.deepEqual(p.groups(),['Sunday · Kickoff TBD']);
  p.chooseSlate('all');
  assert.deepEqual(p.shown(),[0,11,1,2,6,10,7,3,4,8,5,9]);assert.equal(p.note(),'All 4 entries · 12 of 12 games · 2 VOID/HOLD shown in every status filter');
});
await check('combined filters: slate, status and entries apply together; VOID and HOLD games stay in every status filter of their slate and the note says so; an empty combination is truthful',async()=>{
  const p=await page();
  p.chooseSlate(EARLY);p.segment('live').click();
  assert.deepEqual(p.shown(),[2,6,10]);assert.equal(p.status(),'live');
  assert.equal(p.note(),'All 4 entries · Sunday Early · 3 of 4 games · Live · 1 VOID/HOLD shown in every status filter');
  p.compare().click();p.toggleBox('JC');p.toggleBox('Thaddeus');p.done().click();
  assert.deepEqual(p.shown(),[2,6,10]);for(const article of p.cards())assert.deepEqual(namesOn(article),['D.C.','DJS']);
  assert.equal(p.comparing(),'D.C. + DJS');assert.equal(p.note(),'D.C. + DJS · Sunday Early · 3 of 4 games · Live · 1 VOID/HOLD shown in every status filter');
  p.chooseSlate(LATE);p.segment('final').click();
  assert.deepEqual(p.shown(),[7],'the HOLD game rides with Final');assert.equal(p.note(),'D.C. + DJS · Sunday Late · 1 of 2 games · Final · 1 VOID/HOLD shown in every status filter');
  p.segment('upcoming').click();assert.deepEqual(p.shown(),[7,3]);
  p.chooseSlate(NIGHT);p.segment('live').click();
  assert.equal(p.board().innerHTML,'<div class="empty">No live games in Sunday Night.</div>');assert.equal(p.note(),'D.C. + DJS · Sunday Night · 0 of 1 game · Live');
  assert.deepEqual(p.counts(),{all:'1',final:'0',live:'0',upcoming:'1'});
  p.segment('all').click();assert.deepEqual(p.shown(),[4]);
  p.chooseSlate('all');assert.deepEqual(p.shown(),[0,11,1,2,6,10,7,3,4,8,5,9]);
  for(const status of ['final','live','upcoming']){p.segment(status).click();assert(p.shown().includes(6)&&p.shown().includes(7),`VOID and HOLD under ${status}`)}
});
await check('the entry selection panel: the Comparing control opens an accessible dialog of labelled checkboxes (with each entry’s submission state), every change applies at once and is remembered, the last entry stays selected, Select all selects everyone, closing returns focus to the control',async()=>{
  const p=await page();
  const compare=p.compare();compare.click();
  assert.equal(p.dialog().open,true);assert.equal(compare.getAttribute('aria-expanded'),'true');
  assert.equal(p.dialog().getAttribute('aria-labelledby'),'picksEntrantsTitle');assert.equal(p.doc.getElementById('picksEntrantsTitle').textContent,'Entries to compare');
  assert.deepEqual(p.checked(),{'D.C.':true,JC:true,DJS:true,Thaddeus:true});
  assert.equal(p.doc.activeElement,p.box('D.C.'),'focus moves into the panel');
  assert.equal(p.box('Thaddeus').closest('.pm-entry').querySelector('.pm-entry-meta').textContent,'No picks submitted this week');
  assert.equal(p.selectAll().disabled,true,'Select all has nothing to do while everyone is compared');
  p.toggleBox('JC');
  assert.deepEqual(p.checked(),{'D.C.':true,JC:false,DJS:true,Thaddeus:true});assert.equal(p.comparing(),'D.C. + DJS + Thaddeus');
  for(const article of p.cards())assert.deepEqual(namesOn(article),['D.C.','DJS','Thaddeus']);
  assert.deepEqual(p.prefs(),{version:1,entrants:['D.C.','DJS','Thaddeus']});assert.equal(p.selectAll().disabled,false);
  p.toggleBox('D.C.');p.toggleBox('DJS');
  assert.equal(p.comparing(),'Thaddeus');for(const article of p.cards())assert.deepEqual(namesOn(article),['Thaddeus']);
  p.toggleBox('Thaddeus');
  assert.deepEqual(p.checked(),{'D.C.':false,JC:false,DJS:false,Thaddeus:true},'the last entry cannot be deselected');
  assert.equal(p.dialogNote(),'At least one entry stays selected');assert.equal(p.comparing(),'Thaddeus');
  assert.deepEqual(p.prefs(),{version:1,entrants:['Thaddeus']});
  p.toggleBox('JC');
  assert.equal(p.comparing(),'JC + Thaddeus');for(const article of p.cards())assert.deepEqual(namesOn(article),['JC','Thaddeus'],'two entries, published order');
  p.selectAll().click();
  assert.deepEqual(p.checked(),{'D.C.':true,JC:true,DJS:true,Thaddeus:true});assert.equal(p.comparing(),'All 4 entries');assert.deepEqual(p.prefs(),{version:1,entrants:NAMES});
  p.done().click();
  assert.equal(p.dialog().open,false);assert.equal(compare.getAttribute('aria-expanded'),'false');assert.equal(p.doc.activeElement,compare,'focus returns to the control');
  compare.click();p.doc.querySelector('.pm-sheet-head [data-picks-close]').click();assert.equal(p.dialog().open,false,'the close button closes too');
  const three=await page({stored:{version:1,entrants:['DJS','JC','D.C.']}});
  assert.equal(three.comparing(),'D.C. + JC + DJS','a remembered choice (V1.3’s or this version’s) is restored');
  for(const article of three.cards())assert.deepEqual(namesOn(article),['D.C.','JC','DJS']);
  three.compare().click();assert.deepEqual(three.checked(),{'D.C.':true,JC:true,DJS:true,Thaddeus:false});
  for(const stored of ['{bad',{version:1,entrants:['Nobody']},{version:9,entrants:['JC']}]){const q=await page({stored});assert.equal(q.comparing(),'All 4 entries',JSON.stringify(stored))}
  const noStore=await page({storage:'throws'});
  noStore.compare().click();noStore.toggleBox('JC');
  assert.equal(noStore.comparing(),'D.C. + DJS + Thaddeus');assert.equal(noStore.dialogNote(),'Selection not saved in this browser');
  assert.match(noStore.note(),/^Selection not saved in this browser · D\.C\. \+ DJS \+ Thaddeus/,'the page says the choice applies here only');
  const absent=await page({storage:'absent'});absent.compare().click();absent.toggleBox('JC');assert.equal(absent.comparing(),'D.C. + DJS + Thaddeus');
});
await check('refresh stability: an update of the same week keeps the slate, status and entries, keeps the one open matchup open with the same elements and focus, and redraws only what changed; a filter that hides the open matchup closes it',async()=>{
  const p=await page();
  p.compare().click();p.toggleBox('JC');p.toggleBox('Thaddeus');p.done().click();
  p.chooseSlate(EARLY);
  const t2=p.expandOf(2);t2.focus();t2.click();
  const cardBefore=p.cardOf(2),selectBefore=p.select(),compareBefore=p.compare(),segmentBefore=p.segment('live'),detailsBefore=p.details(2);
  assert.deepEqual(p.shown(),[1,2,6,10]);assert.deepEqual(p.expanded(),[2]);
  p.answers.picks=()=>snapshot({games:GAMES().map(g=>g.index===2?{...g,kind:'final',status:'FINAL',detail:'Final',awayScore:27,homeScore:24,winner:'NYJ',picks:pk(['NYJ','NE','NYJ',null],['correct','incorrect','correct','incorrect'])}:g.index===3?{...g,kind:'live',status:'1st 12:00',detail:'1st 12:00',awayScore:0,homeScore:3}:g)});
  for(let i=0;i<5;i++)p.update('pickem');
  assert.equal(p.select().value,EARLY,'the slate stays');assert.equal(p.status(),'all','the status stays');assert.equal(p.comparing(),'D.C. + DJS','the entries stay');
  assert.deepEqual(p.shown(),[1,2,6,10]);assert.deepEqual(p.expanded(),[2],'the open matchup stays open');
  assert.equal(p.cardOf(2),cardBefore,'the same card element');assert.equal(p.expandOf(2),t2,'the same control');assert.equal(p.details(2),detailsBefore);
  assert.equal(p.doc.activeElement,t2,'focus is not lost');assert.equal(p.details(2).hidden,false);
  assert.equal(p.select(),selectBefore);assert.equal(p.compare(),compareBefore);assert.equal(p.segment('live'),segmentBefore,'the controls are the same elements');
  assert.equal(p.cardOf(2).getAttribute('class'),'pm-card pm-kind-final is-expanded','the card follows the new state');
  assert.equal(p.cardOf(2).querySelector('.pm-status').textContent,'FINAL');assert.deepEqual(p.cardOf(2).querySelectorAll('.pm-score').map(s=>s.textContent),['27','24']);
  assert.deepEqual(tokens(p.cardOf(2)),['D.C. NYJ ✓','DJS NYJ ✓']);assert.deepEqual(p.details(2).querySelectorAll('.pm-pick').map(spoken),['D.C. NYJ ✓ Correct','DJS NYJ ✓ Correct']);
  assert.deepEqual(p.counts(),{all:'4',final:'2',live:'1',upcoming:'0'});assert.equal(p.note(),'D.C. + DJS · Sunday Early · 4 of 4 games · 1 VOID/HOLD shown in every status filter');
  assert.deepEqual(p.prefs(),{version:1,entrants:['D.C.','DJS']});
  p.update('survivor');
  assert.deepEqual(p.shown(),[1,2,6,10]);assert.deepEqual(p.expanded(),[2],'a Survivor update changes nothing here');
  p.segment('live').click();
  assert.deepEqual(p.shown(),[6,10]);assert.deepEqual(p.expanded(),[],'the open matchup left the list, so nothing is open');
  p.segment('all').click();
  assert.deepEqual(p.shown(),[1,2,6,10]);assert.deepEqual(p.expanded(),[],'it comes back compact');
  p.expandOf(6).click();p.chooseSlate('all');
  assert.deepEqual(p.expanded(),[6],'a slate change that keeps the open matchup keeps it open');
  p.compare().click();p.selectAll().click();p.done().click();
  assert.deepEqual(p.expanded(),[6],'an entry change keeps it open');assert.deepEqual(namesOn(p.cardOf(6)),NAMES);
});
await check('a week change: the slates are rebuilt from the new schedule, a slate that is not on it falls back to All Slates with a note, every card is compact again, the status filter and the entries stay; while another week loads nothing moves',async()=>{
  const p=await page();
  p.chooseSlate(LATE);p.segment('upcoming').click();p.expandOf(7).click();
  assert.deepEqual(p.shown(),[7,3]);assert.deepEqual(p.expanded(),[7]);
  p.answers.picks=()=>({ready:false,reason:'Another week is loading. The picks follow once it is on screen.'});
  p.update('pickem');
  assert.equal(p.board().innerHTML,'<div class="empty">Another week is loading. The picks follow once it is on screen.</div>');
  assert.equal(p.filters().innerHTML,'','no controls while nothing is answered, as in V1.3');
  p.answers.picks=()=>snapshot();p.update('pickem');
  assert.deepEqual(p.shown(),[7,3],'the same week back: the same slate and status');assert.equal(p.select().value,LATE);assert.equal(p.status(),'upcoming');
  assert.deepEqual(p.expanded(),[7],'the same week back: the open matchup is open again');
  const g=(index,away,home,kickoff,o={})=>game(index,away,home,{kickoff,date:kickoff.slice(0,10),...o});
  p.answers.picks=()=>snapshot({week:4,games:[g(0,'BUF','NYJ','2026-10-03T17:00:00Z'),g(1,'DAL','PHI','2026-10-03T20:25:00Z',{kind:'final',status:'FINAL',detail:'Final',awayScore:13,homeScore:30,winner:'PHI',picks:pk(['DAL','PHI','DAL',null],['incorrect','correct','incorrect','incorrect'])}),g(2,'KC','LV','2026-10-05T00:15:00Z')]});
  p.update('pickem');
  assert.deepEqual(p.slates(),[['all','All Slates (3)',true],['2026-10-03|1','Saturday Early (1)',false],['2026-10-03|2','Saturday Late (1)',false],['2026-10-04|3','Sunday Night (1)',false]]);
  assert.equal(p.select().value,'all');assert.equal(p.status(),'upcoming','the status filter stays');assert.deepEqual(p.shown(),[0,2]);
  assert.equal(p.note(),'Sunday Late is not on this week\'s schedule · showing All Slates · All 4 entries · 2 of 3 games · Upcoming');
  assert.deepEqual(p.expanded(),[],'a new week is compact');
  p.update('pickem');
  assert.equal(p.note(),'All 4 entries · 2 of 3 games · Upcoming','the note is said once');
  p.chooseSlate('2026-10-03|2');p.segment('final').click();assert.deepEqual(p.shown(),[1]);
  p.answers.picks=()=>snapshot();p.update('pickem');
  assert.equal(p.select().value,'all');assert.equal(p.status(),'final');assert.deepEqual(p.shown(),[0,1,6,7]);
  assert.equal(p.note(),'Saturday Late is not on this week\'s schedule · showing All Slates · All 4 entries · 4 of 12 games · Final · 2 VOID/HOLD shown in every status filter');
});
await check('a week with other tracked names rebuilds the controls and the panel and keeps the remembered choice where it still applies; an app that does not answer leaves the loading text and no controls',async()=>{
  const p=await page({stored:{version:1,entrants:['JC','DJS']}});
  assert.equal(p.comparing(),'JC + DJS');
  p.answers.picks=()=>snapshot({entrants:[{name:'JC',noSubmission:false},{name:'Alex',noSubmission:false}],games:GAMES().slice(0,2).map(g=>({...g,picks:[{name:'JC',team:g.home.code,result:g.picks[1].result},{name:'Alex',team:g.away.code,result:g.picks[0].result}]}))});
  p.update('pickem');
  assert.equal(p.comparing(),'JC','the names JC still applies to');
  p.compare().click();assert.deepEqual(p.checked(),{JC:true,Alex:false});p.done().click();
  for(const article of p.cards())assert.deepEqual(namesOn(article),['JC']);
  p.answers.picks=()=>snapshot({entrants:[{name:'Pat',noSubmission:false}],games:[]});
  p.update('pickem');
  assert.equal(p.comparing(),'All 1 entry','no remembered name applies: everyone');
  const silent=await page({picksAnswer:null});
  assert.equal(silent.board().innerHTML,'<div class="empty">Picks are not available yet.</div>');
  assert.equal(silent.filters().innerHTML,'');
  silent.answers.picks=()=>({ready:false,reason:'Another week is loading. The picks follow once it is on screen.'});silent.update('pickem');
  assert.equal(silent.board().innerHTML,'<div class="empty">Another week is loading. The picks follow once it is on screen.</div>');
  silent.answers.picks=()=>snapshot();silent.update('pickem');
  assert.equal(silent.cards().length,12);assert.equal(silent.comparing(),'All 4 entries');
});
await check('a week change with the same tracked names: each entry’s submission note follows the week on screen (no picks last week, picks this week: the note goes; the other way round: it comes), on the same row elements, with the selection, Select all and focus as before',async()=>{
  // Week A (the fixture week 3): Thaddeus has no submission; the remembered choice compares D.C. and Thaddeus.
  const p=await page({stored:{version:1,entrants:['D.C.','Thaddeus']}});
  const row=name=>p.box(name).closest('.pm-entry'),meta=name=>row(name).querySelector('.pm-entry-meta')?.textContent??null,none=name=>row(name).classList.contains('pm-entry-none');
  const compare=p.compare();compare.click();
  assert.equal(p.dialog().open,true);assert.deepEqual(p.checked(),{'D.C.':true,JC:false,DJS:false,Thaddeus:true});
  assert.equal(meta('Thaddeus'),'No picks submitted this week');assert.equal(none('Thaddeus'),true);
  assert.deepEqual(['D.C.','JC','DJS'].map(meta),[null,null,null]);assert.deepEqual(['D.C.','JC','DJS'].map(none),[false,false,false]);
  const boxesA=p.boxes();
  p.done().click();assert.equal(p.dialog().open,false);assert.equal(p.doc.activeElement,compare);
  // Week B arrives as one update with the same four names in the same order (as weekly-app.js announces a chosen week once it
  // is on screen): Thaddeus submitted, JC did not.
  const g=(index,away,home,kickoff,teams)=>game(index,away,home,{kickoff,date:kickoff.slice(0,10),picks:pk(teams,['pending','pending','pending','pending'])});
  const weekB=(jc,thaddeus)=>snapshot({week:4,entrants:[{name:'D.C.',noSubmission:false},{name:'JC',noSubmission:jc},{name:'DJS',noSubmission:false},{name:'Thaddeus',noSubmission:thaddeus}],
    games:[g(0,'BUF','NYJ','2026-10-04T17:00:00Z',['BUF',jc?null:'NYJ','NYJ',thaddeus?null:'BUF']),g(1,'DAL','PHI','2026-10-04T20:25:00Z',['PHI',jc?null:'DAL','PHI',thaddeus?null:'PHI']),g(2,'KC','LV','2026-10-06T00:15:00Z',['KC',jc?null:'KC','LV',thaddeus?null:'KC'])]});
  p.answers.picks=()=>weekB(true,false);
  p.update('pickem');
  assert.equal(p.comparing(),'D.C. + Thaddeus','the entries stay');assert.deepEqual(p.shown(),[0,1,2]);
  compare.click();
  assert.equal(p.dialog().open,true);
  assert.equal(meta('Thaddeus'),null,'the Week A note is gone: Thaddeus submitted this week');assert.equal(none('Thaddeus'),false);
  assert.equal(meta('JC'),'No picks submitted this week','JC did not submit this week');assert.equal(none('JC'),true);
  assert.deepEqual(['D.C.','DJS'].map(meta),[null,null]);
  assert(p.boxes().length===4&&p.boxes().every((b,i)=>b===boxesA[i]),'the same checkbox elements');
  assert.deepEqual(p.boxes().map(b=>b.dataset.picksEntrant),NAMES,'in published order');
  assert.deepEqual(p.checked(),{'D.C.':true,JC:false,DJS:false,Thaddeus:true},'the selection stays');
  assert.equal(p.doc.activeElement,p.box('D.C.'),'focus moves into the panel');assert.equal(p.selectAll().disabled,false);
  // A refresh while the panel is open with a focused checkbox that changes a submission state: the row follows, the focus and
  // the selection stay, and a change still applies at once.
  p.box('Thaddeus').focus();
  p.answers.picks=()=>weekB(false,false);
  p.update('pickem');
  assert.equal(meta('JC'),null,'JC’s picks came in');assert.equal(none('JC'),false);assert.equal(meta('Thaddeus'),null);
  assert.equal(p.doc.activeElement,p.box('Thaddeus'),'focus is not lost');assert.deepEqual(p.checked(),{'D.C.':true,JC:false,DJS:false,Thaddeus:true});
  p.toggleBox('JC');
  assert.deepEqual(p.checked(),{'D.C.':true,JC:true,DJS:false,Thaddeus:true});assert.equal(p.comparing(),'D.C. + JC + Thaddeus');
  for(const article of p.cards())assert.deepEqual(namesOn(article),['D.C.','JC','Thaddeus']);
  assert.deepEqual(p.prefs(),{version:1,entrants:['D.C.','JC','Thaddeus']});
  p.selectAll().click();assert.deepEqual(p.checked(),{'D.C.':true,JC:true,DJS:true,Thaddeus:true});assert.equal(p.selectAll().disabled,true);
  p.toggleBox('DJS');assert.deepEqual(p.checked(),{'D.C.':true,JC:true,DJS:false,Thaddeus:true});
  p.done().click();
  assert.equal(p.dialog().open,false);assert.equal(p.doc.activeElement,compare,'focus returns to the control');
  // Back to Week A: Thaddeus’s note is back and JC’s is not; the choice made in Week B stays.
  p.answers.picks=()=>snapshot();p.update('pickem');
  compare.click();
  assert.equal(meta('Thaddeus'),'No picks submitted this week');assert.equal(none('Thaddeus'),true);assert.equal(meta('JC'),null);assert.equal(none('JC'),false);
  assert(p.boxes().every((b,i)=>b===boxesA[i]),'still the same checkbox elements');
  assert.deepEqual(p.checked(),{'D.C.':true,JC:true,DJS:false,Thaddeus:true});assert.equal(p.comparing(),'D.C. + JC + Thaddeus');
  p.done().click();assert.equal(p.doc.activeElement,compare);
});
await check('Disagreements only: off on load; on, the list keeps the games where the compared entries split and the VOID and HOLD exceptions, the counts and the note follow, an open matchup that left the list closes; it combines with the slate and the status, keeps the entries, survives refreshes and a week change, and writes nothing; fewer than two entries turn it off and disable it, with a note said once',async()=>{
  const p=await page({picksAnswer:()=>snapshot({games:MIXED()})});
  const sw=()=>p.disagree(),on=()=>sw().getAttribute('aria-pressed');
  assert.equal(on(),'false');assert.equal(sw().disabled,false);assert.equal(sw().localName,'button');assert.equal(spoken(sw()),'Disagreements only');
  assert(sw().closest('#picksFilters'),'the switch is part of the existing filters, not another toolbar');
  assert.deepEqual(p.shown(),[0,11,1,2,6,10,7,3,4,8,5,9]);
  p.expandOf(3).click();assert.deepEqual(p.expanded(),[3]);
  const before=p.writes.length;
  sw().click();
  assert.equal(on(),'true');assert.deepEqual(p.shown(),[0,1,2,6,10,7]);assert.deepEqual(p.expanded(),[],'the open matchup left the list');
  assert.deepEqual(p.counts(),{all:'6',final:'2',live:'2',upcoming:'0'});
  assert.equal(p.note(),'All 4 entries · 6 of 6 games · Disagreements only · 2 VOID/HOLD shown in every filter');
  assert.equal(p.comparing(),'All 4 entries');assert.equal(p.writes.length,before,'page state: nothing is written');
  p.expandOf(2).click();assert.deepEqual(p.expanded(),[2]);
  p.segment('live').click();assert.deepEqual(p.shown(),[2,6,10,7]);assert.deepEqual(p.expanded(),[2],'the open matchup stays while it is listed');
  assert.equal(p.note(),'All 4 entries · 4 of 6 games · Live · Disagreements only · 2 VOID/HOLD shown in every filter');
  p.chooseSlate(EARLY);assert.deepEqual(p.shown(),[2,6,10]);assert.deepEqual(p.counts(),{all:'4',final:'1',live:'2',upcoming:'0'});
  assert.equal(p.note(),'All 4 entries · Sunday Early · 3 of 4 games · Live · Disagreements only · 1 VOID/HOLD shown in every filter');
  p.segment('upcoming').click();assert.deepEqual(p.shown(),[6],'the exception alone');
  assert.equal(p.note(),'All 4 entries · Sunday Early · 1 of 4 games · Upcoming · Disagreements only · 1 VOID/HOLD shown in every filter');
  p.chooseSlate(NIGHT);
  assert.equal(p.board().innerHTML,'<div class="empty">No upcoming disagreements among all 4 entries in Sunday Night.</div>');
  assert.equal(p.note(),'All 4 entries · Sunday Night · 0 of 0 games · Upcoming · Disagreements only');
  p.segment('live').click();assert.equal(p.board().innerHTML,'<div class="empty">No live games in Sunday Night.</div>','no game at all to disagree on: the plain empty state');
  p.chooseSlate('all');p.segment('all').click();assert.deepEqual(p.shown(),[0,1,2,6,10,7]);
  p.compare().click();p.toggleBox('JC');p.toggleBox('Thaddeus');p.done().click();
  assert.equal(p.comparing(),'D.C. + DJS');assert.deepEqual(p.shown(),[6,7],'two entries that agree everywhere: the exceptions alone');
  assert.equal(on(),'true','the choice stays through an entry change');
  assert.equal(p.note(),'D.C. + DJS · 2 of 2 games · Disagreements only · 2 VOID/HOLD shown in every filter');
  for(let i=0;i<3;i++)p.update('pickem');
  assert.equal(on(),'true');assert.deepEqual(p.shown(),[6,7],'a refresh keeps it');
  p.answers.picks=()=>snapshot({week:4,games:MIXED()});p.update('pickem');
  assert.equal(on(),'true','a week change keeps it, like the status');assert.deepEqual(p.shown(),[6,7]);
  p.compare().click();p.toggleBox('DJS');
  assert.equal(p.dialogNote(),'Disagreements only is off: it needs two or more entries');
  p.done().click();
  assert.equal(on(),'false');assert.equal(sw().disabled,true);assert.deepEqual(p.shown(),[0,11,1,2,6,10,7,3,4,8,5,9]);
  assert.equal(p.note(),'Disagreements only is off: it needs two or more entries · D.C. · 12 of 12 games · 2 VOID/HOLD shown in every status filter');
  sw().click();assert.equal(on(),'false','disabled: a tap changes nothing');assert.deepEqual(p.shown(),[0,11,1,2,6,10,7,3,4,8,5,9]);
  p.update('pickem');assert.equal(p.note(),'D.C. · 12 of 12 games · 2 VOID/HOLD shown in every status filter','the note is said once');
  p.compare().click();p.toggleBox('JC');p.done().click();
  assert.equal(sw().disabled,false);assert.equal(on(),'false','it stays off until tapped again');
  sw().click();assert.deepEqual(p.shown(),[0,1,2,6,10,7]);
  assert(p.writes.every(([k])=>k===STORAGE_KEY),'only the selection is written');
});
await check('card name labels: compact by default on a narrow screen (Thaddeus reads Thad., spoken in full), full elsewhere; the setting in the panel switches the cards in place, is remembered under its own key with the selection key untouched, and a reload restores it; storage trouble is said in the panel; the open matchup and the panel always show full names',async()=>{
  const p=await page({narrow:true});
  assert.equal(p.labelsMode(),'compact');
  for(const article of p.cards()){assert.deepEqual(p.chipNames(article),['D.C.','JC','DJS','Thad.'],`card ${article.dataset.game} labels`);assert.deepEqual(namesOn(article),NAMES,`card ${article.dataset.game} speaks full names`)}
  assert.equal(p.cardOf(0).querySelector('.pm-results').getAttribute('class'),'pm-results is-dense is-grid');
  assert.deepEqual(tokens(p.cardOf(0)),['D.C. DEN ✓','JC KC ✕','DJS DEN ✓','Thaddeus — ✕']);
  assert.equal(p.cardOf(0).querySelector('.pm-token-short').getAttribute('aria-hidden'),'true');
  p.expandOf(0).click();assert.deepEqual(p.details(0).querySelectorAll('.pm-name').map(n=>n.textContent),NAMES,'the open matchup names everyone in full');p.expandOf(0).click();
  const card=p.cardOf(0),t0=p.expandOf(0),compare=p.compare();
  compare.click();
  assert.deepEqual(p.boxes().map(b=>b.closest('.pm-entry').querySelector('.pm-entry-name').textContent),NAMES,'the panel lists full names');
  assert.equal(p.labelsButton('compact').getAttribute('aria-pressed'),'true');assert.equal(p.labelsButton('full').getAttribute('aria-pressed'),'false');
  assert.equal(p.doc.activeElement,p.box('D.C.'),'focus still moves to the first entry');
  p.labelsButton('full').click();
  assert.equal(p.labelsMode(),'full');assert.equal(p.dialog().open,true,'the panel stays open');
  assert.equal(p.cardOf(0),card,'the same card element');assert.equal(p.expandOf(0),t0,'the same control');
  for(const article of p.cards())assert.deepEqual(p.chipNames(article),NAMES);
  assert.equal(p.cardOf(0).querySelector('.pm-results').getAttribute('class'),'pm-results is-dense');assert(!p.cardOf(0).querySelector('.pm-sr'));
  assert.equal(p.labelsStored(),'full');assert.deepEqual(p.writes,[[LABELS_KEY,'full']]);assert.equal(p.prefs(),null,'the selection key is untouched');
  p.labelsButton('compact').click();
  assert.equal(p.labelsStored(),'compact');for(const article of p.cards())assert.deepEqual(p.chipNames(article),['D.C.','JC','DJS','Thad.']);
  p.toggleBox('JC');
  assert.deepEqual(p.prefs(),{version:1,entrants:['D.C.','DJS','Thaddeus']});assert.equal(p.labelsStored(),'compact','a selection write leaves the setting alone');
  for(const article of p.cards())assert.deepEqual(p.chipNames(article),['D.C.','DJS','Thad.']);
  assert.equal(p.cardOf(0).querySelector('.pm-results').getAttribute('class'),'pm-results is-grid','three entries: not dense');
  p.done().click();assert.equal(p.doc.activeElement,compare);
  const wide=await page();assert.equal(wide.labelsMode(),'full');for(const article of wide.cards())assert.deepEqual(wide.chipNames(article),NAMES);
  const again=await page({storedLabels:'compact'});assert.equal(again.labelsMode(),'compact');for(const article of again.cards())assert.deepEqual(again.chipNames(article),['D.C.','JC','DJS','Thad.']);
  const forced=await page({narrow:true,storedLabels:'full'});assert.equal(forced.labelsMode(),'full');for(const article of forced.cards())assert.deepEqual(forced.chipNames(article),NAMES);
  const bad=await page({narrow:true,storedLabels:'tiny'});assert.equal(bad.labelsMode(),'compact','a value that is not a mode means the default');
  const both=await page({narrow:true,stored:{version:1,entrants:['JC','Thaddeus']},storedLabels:'full'});
  assert.equal(both.comparing(),'JC + Thaddeus');assert.equal(both.labelsMode(),'full');for(const article of both.cards())assert.deepEqual(both.chipNames(article),['JC','Thaddeus']);
  const noStore=await page({storage:'throws',narrow:true});
  noStore.compare().click();noStore.labelsButton('full').click();
  assert.equal(noStore.labelsMode(),'full');assert.equal(noStore.dialogNote(),'Label setting not saved in this browser');
  for(const article of noStore.cards())assert.deepEqual(noStore.chipNames(article),NAMES);
  noStore.toggleBox('JC');assert.equal(noStore.dialogNote(),'Selection not saved in this browser · Label setting not saved in this browser');
  assert.match(noStore.note(),/^Selection not saved in this browser · Label setting not saved in this browser · D\.C\. \+ DJS \+ Thaddeus/);
  const absent=await page({storage:'absent',narrow:true});absent.compare().click();absent.labelsButton('full').click();assert.equal(absent.labelsMode(),'full');
});
await check('exceptional games on the page: VOID, HOLD, FINAL TIE, UNDER REVIEW, an unverified result and the tiebreak game read on the compact cards as the snapshot states them, say so once, and explain themselves when opened',async()=>{
  const p=await page({picksAnswer:()=>snapshot({games:GAMES().map(g=>g.index===6?{...g,note:'Commissioner ruling · UNDER REVIEW',underReview:'the feed now reports a completed final'}:g)})});
  const top=i=>spoken(p.cardOf(i).querySelector('.pm-top'));
  assert.equal(top(6),'1:00 PM EDT VOID UNDER REVIEW Commissioner ruling · UNDER REVIEW');
  assert.deepEqual(tokens(p.cardOf(6)),['D.C. CIN','JC PIT','DJS CIN','Thaddeus —'],'nothing graded, no mark');
  p.expandOf(6).click();
  assert.deepEqual(p.details(6).querySelectorAll('.pm-why').map(spoken),['Void Commissioner ruling · UNDER REVIEW · removed from scoring · listed in every status filter','Under review the feed now reports a completed final']);
  assert.deepEqual(p.details(6).querySelectorAll('.pm-pick').map(spoken),['D.C. CIN VOID','JC PIT VOID','DJS CIN VOID','Thaddeus NO PICK VOID']);
  assert.equal(top(7),'4:05 PM EDT HOLD NOT GRADED Ruling information unusable');
  p.expandOf(7).click();
  assert.deepEqual(p.details(7).querySelectorAll('.pm-why').map(spoken),['Not graded the ruling cites policy revision 2, which does not exist · listed in every status filter']);
  assert.equal(spoken(p.details(7).querySelectorAll('.pm-pick')[2]),'DJS LV HOLD');
  assert.equal(top(1),'1:00 PM EDT FINAL TIE Final/OT');assert.deepEqual(tokens(p.cardOf(1)),['D.C. MIA ✕','JC BUF ✕','DJS MIA ✕','Thaddeus — ✕']);
  p.expandOf(1).click();assert.equal(spoken(p.details(1).querySelectorAll('.pm-pick')[0]),'D.C. MIA ✕ Tie · 1 loss');assert.equal(p.details(1).querySelectorAll('.pm-why').length,0,'a tie needs no further explanation');
  assert.equal(top(10),'4th 2:10 LIVE NOT VERIFIED');
  p.expandOf(10).click();assert.deepEqual(p.details(10).querySelectorAll('.pm-why').map(spoken),['Not verified DET-CHI: final with contradictory status ignored']);
  assert.equal(top(5),'8:15 PM EDT UPCOMING TIEBREAK');
  p.expandOf(5).click();assert.deepEqual(p.details(5).querySelectorAll('.pm-why').map(spoken),['Tiebreak game activates when this game is final']);
  assert.equal(top(2),'3rd 7:41 LIVE');assert.equal(top(0),'8:15 PM EDT FINAL');assert.equal(top(3),'4:25 PM EDT UPCOMING');assert.equal(top(8),'Scheduled UPCOMING');assert.equal(top(9),'Scheduled UPCOMING');
  for(const article of p.cards()){
    const g=new Map(GAMES().map(x=>[x.index,x])).get(Number(article.dataset.game));
    assert.equal(article.getAttribute('aria-label'),`${g.away.code} at ${g.home.code}, ${{void:'VOID',hold:'HOLD',final:'FINAL',tie:'FINAL TIE',live:'LIVE',upcoming:'UPCOMING'}[g.kind]}`);
    assert.deepEqual(article.querySelectorAll('.pm-code').map(c=>c.textContent),[g.away.code,g.home.code]);
    for(const token of article.querySelectorAll('.pm-token'))assert([g.away.code,g.home.code,'—'].includes(token.querySelector('.pm-token-pick').textContent),`game ${g.index}: ${spoken(token)}`);
  }
});
// ---- The page part: the collapsible slate groups.
// Identity checks on elements go through same() and none(): a failing assert.equal formats both operands, and on this DOM
// every element reaches the whole document through its getters, so the message would never finish.
const same=(a,b,message)=>assert(a===b,message);
const none=(a,message)=>assert(a===null,message);
await check('boot in All Slates: the slate with live games starts open and every other slate starts collapsed behind its summary; each heading is one button naming its state and the hidden body that holds its cards; Expand all and Collapse all sit above the slates; nothing is written and no timer starts',async()=>{
  const p=await page();
  assert.deepEqual(p.slatesOpen(),{'2026-09-24|3':false,'2026-09-27|0':false,[EARLY]:true,[LATE]:false,[NIGHT]:false,'2026-09-27|4':false,'2026-09-28|3':false,tbd:false});
  assert.deepEqual(p.groups(),['Thursday Night','Sunday Morning','Sunday Early','Sunday Late','Sunday Night','Sunday · Kickoff TBD','Monday Night','Kickoff TBD'],'every slate is on the board, open or not');
  assert.deepEqual(p.shown(),[0,11,1,2,6,10,7,3,4,8,5,9],'every card is on the board, inside its slate');
  for(const section of p.sections()){
    const key=section.dataset.slate,toggle=section.querySelector('[data-picks-slate-toggle]'),open=toggle.getAttribute('aria-expanded')==='true';
    assert.equal(toggle.localName,'button');assert.equal(toggle.getAttribute('type'),'button');assert.equal(toggle.dataset.picksSlateToggle,key);
    same(toggle.closest('h3'),section.querySelector('.pm-group-title'),`${key}: the control is the heading's`);
    assert.equal(section.querySelectorAll('h3').length,1);assert.equal(section.querySelectorAll('[data-picks-slate-toggle]').length,1,`${key}: one control`);
    const body=p.doc.getElementById(toggle.getAttribute('aria-controls'));
    assert(body&&body.classList.contains('pm-slate-body')&&body.closest('.pm-group')===section,`${key}: the control names the body it controls`);
    assert.equal(body.hidden,!open,`${key}: the body follows the state`);assert.equal(section.classList.contains('is-collapsed'),!open);
    const articles=section.querySelectorAll('article');
    assert(articles.length>0&&articles.every(a=>a.closest('.pm-slate-body')===body),`${key}: every card is inside the body`);
    assert.equal(section.getAttribute('aria-label'),section.querySelector('.pm-slate-name').textContent);
  }
  assert.deepEqual(p.pills(EARLY),['2 LIVE','1 FINAL TIE','1 VOID','1 NOT VERIFIED']);
  assert.deepEqual(p.pills(LATE),['1 UPCOMING','1 HOLD']);assert.deepEqual(p.pills('2026-09-28|3'),['1 UPCOMING','TIEBREAK']);assert.deepEqual(p.pills('2026-09-24|3'),['1 FINAL']);
  assert.equal(p.slateToggle(LATE).querySelector('.pm-slate-meta').textContent,'Sun, Sep 27 · 2 games');
  const bar=p.bar();
  assert(bar&&bar.getAttribute('role')==='group'&&bar.getAttribute('aria-label')==='Slates','one labelled group of slate actions');
  assert.equal(p.board().querySelectorAll('.pm-slates-bar').length,1);assert(p.board().innerHTML.indexOf('pm-slates-bar')<p.board().innerHTML.indexOf('pm-group'),'above the slates');
  assert.deepEqual([p.slatesAction('expand'),p.slatesAction('collapse')].map(b=>[b.localName,b.getAttribute('type'),b.textContent,b.closest('.pm-slates-bar')===bar]),[['button','button','Expand all',true],['button','button','Collapse all',true]]);
  assert.deepEqual(p.expanded(),[],'every card starts collapsed');
  assert.deepEqual(p.writes,[]);assert.deepEqual(p.timers,[]);
});
await check('each slate opens and closes on its own with a tap on its heading (so with Enter or Space on the button), the other slates untouched, focus kept on the heading and nothing re-rendered; a matchup opened inside a slate keeps its state while the slate is closed; the filters are untouched',async()=>{
  const p=await page();
  const late=p.slateToggle(LATE),bodyLate=p.slateBody(LATE),card7=p.cardOf(7);
  late.focus();late.click();
  assert.equal(late.getAttribute('aria-expanded'),'true');assert.equal(bodyLate.hidden,false);assert.equal(late.closest('.pm-group').classList.contains('is-collapsed'),false);
  assert.equal(p.slatesOpen()[EARLY],true);assert.equal(p.slatesOpen()[NIGHT],false,'the other slates are untouched');
  same(p.doc.activeElement,late,'focus stays on the heading');same(p.slateToggle(LATE),late,'the same heading element');same(p.cardOf(7),card7,'the same card element');
  p.slateToggle(EARLY).click();
  assert.equal(p.slatesOpen()[EARLY],false);assert.equal(p.slateBody(EARLY).hidden,true);assert.equal(p.slateBody(EARLY).closest('.pm-group').classList.contains('is-collapsed'),true);assert.equal(p.slatesOpen()[LATE],true,'independent');
  p.slateToggle(EARLY).click();assert.equal(p.slatesOpen()[EARLY],true,'and back');
  p.expandOf(7).click();assert.deepEqual(p.expanded(),[7]);
  late.click();assert.equal(p.slatesOpen()[LATE],false);assert.deepEqual(p.expanded(),[7],'the open matchup keeps its state inside the closed slate');assert.equal(p.details(7).hidden,false);
  late.click();assert.equal(p.slatesOpen()[LATE],true);assert.deepEqual(p.expanded(),[7]);
  p.expandOf(3).click();assert.deepEqual(p.expanded(),[3],'one open matchup at a time, as before');
  assert.deepEqual(p.writes,[],'page state: nothing is written');
  assert.equal(p.select().value,'all');assert.equal(p.status(),'all');assert.equal(p.comparing(),'All 4 entries');assert.equal(p.disagree().getAttribute('aria-pressed'),'false');
  assert.equal(p.note(),'All 4 entries · 12 of 12 games · 2 VOID/HOLD shown in every status filter','the note describes the games listed, open or not');
});
await check('Expand all opens every slate of the week and Collapse all closes every one, the live one too, each a manual choice; the headings still work afterwards; focus stays on the control, and returns to it after a rebuild; the controls are absent for a chosen slate',async()=>{
  const p=await page();
  const expand=p.slatesAction('expand');
  expand.focus();expand.click();
  assert(Object.values(p.slatesOpen()).every(Boolean),'every slate open');assert(p.sections().every(s=>!s.classList.contains('is-collapsed')));
  same(p.doc.activeElement,expand,'focus stays on Expand all');same(p.slatesAction('expand'),expand,'the same control');
  p.slatesAction('collapse').click();
  assert(Object.values(p.slatesOpen()).every(v=>v===false),'every slate closed, the live one too');assert.equal(p.slateBody(EARLY).hidden,true);
  p.slateToggle(EARLY).click();assert.equal(p.slatesOpen()[EARLY],true);assert.equal(Object.values(p.slatesOpen()).filter(Boolean).length,1,'one slate reopened by hand');
  p.slatesAction('expand').click();assert(Object.values(p.slatesOpen()).every(Boolean));
  p.slateToggle(NIGHT).click();assert.equal(p.slatesOpen()[NIGHT],false);assert.equal(Object.values(p.slatesOpen()).filter(v=>!v).length,1);
  p.slatesAction('expand').focus();p.segment('final').click();
  assert.deepEqual(p.groups(),['Thursday Night','Sunday Early','Sunday Late']);assert.deepEqual(Object.values(p.slatesOpen()),[true,true,true],'Expand all reaches the slates a filter shows later');
  same(p.doc.activeElement,p.slatesAction('expand'),'focus returns to the control after a rebuild');
  p.segment('all').click();p.slatesAction('collapse').click();p.segment('upcoming').click();
  assert(Object.values(p.slatesOpen()).every(v=>v===false),'Collapse all reaches them too');
  p.segment('all').click();
  p.chooseSlate(LATE);none(p.bar(),'no Expand all or Collapse all for one chosen slate');none(p.slatesAction('expand'),'no Expand all');assert.deepEqual(p.slatesOpen(),{[LATE]:true},'a chosen slate opens whatever Collapse all said');
  p.chooseSlate('all');assert(p.bar(),'back with All Slates');assert(Object.values(p.slatesOpen()).every(v=>v===false),'every slate as Collapse all left it, the one looked at alone included');
  assert.deepEqual(p.writes,[]);
});
await check('refresh stability for slates: an update of the same week keeps every manual choice and the same heading elements and focus, and redraws only the summary pills that changed; a slate nobody touched opens once it goes live and never closes by itself; a slate the user closed never reopens by itself, live or not; a slate the user opened stays open; a rebuild returns focus to the same heading',async()=>{
  const p=await page();
  p.slateToggle(EARLY).click();p.slateToggle(NIGHT).click();
  const early=p.slateToggle(EARLY),night=p.slateToggle(NIGHT),bar=p.bar(),bodyEarly=p.slateBody(EARLY);early.focus();
  for(let i=0;i<5;i++)p.update('pickem');
  assert.deepEqual([p.slatesOpen()[EARLY],p.slatesOpen()[NIGHT],p.slatesOpen()[LATE]],[false,true,false]);
  same(p.slateToggle(EARLY),early,'the same Sunday Early heading');same(p.slateToggle(NIGHT),night,'the same Sunday Night heading');same(p.bar(),bar,'the same slate actions');same(p.slateBody(EARLY),bodyEarly,'the same body');same(p.doc.activeElement,early,'focus is not lost');
  assert.deepEqual(p.pills(EARLY),['2 LIVE','1 FINAL TIE','1 VOID','1 NOT VERIFIED']);
  const lateLive=()=>snapshot({games:GAMES().map(g=>g.index===3?{...g,kind:'live',status:'1st 12:00',detail:'1st 12:00',awayScore:0,homeScore:3}:g)});
  p.answers.picks=lateLive;p.update('pickem');
  assert.equal(p.slatesOpen()[LATE],true,'a slate that goes live opens');assert.equal(p.slatesOpen()[EARLY],false,'a slate closed by hand never reopens by itself');assert.equal(p.slatesOpen()[NIGHT],true);
  assert.deepEqual(p.pills(LATE),['1 LIVE','1 HOLD'],'the pills follow the scores');assert.equal(p.slateToggle(LATE).closest('.pm-group').classList.contains('is-collapsed'),false);
  assert.equal(p.slateBody(LATE).hidden,false);assert.equal(p.cardOf(3).querySelector('.pm-status').textContent,'LIVE');
  p.answers.picks=()=>snapshot({games:GAMES().map(g=>g.index===3?{...g,kind:'final',status:'FINAL',detail:'Final',awayScore:17,homeScore:31,winner:'PHI',picks:pk(['WAS','PHI','WAS',null],['incorrect','correct','incorrect','incorrect'])}:g)});
  for(let i=0;i<3;i++)p.update('pickem');
  assert.equal(p.slatesOpen()[LATE],true,'nothing closes by itself');assert.deepEqual(p.pills(LATE),['1 FINAL','1 HOLD']);
  p.slateToggle(LATE).click();assert.equal(p.slatesOpen()[LATE],false);
  p.answers.picks=lateLive;p.update('pickem');assert.equal(p.slatesOpen()[LATE],false,'live or not, a slate closed by hand stays closed');
  p.slateToggle(EARLY).click();assert.equal(p.slatesOpen()[EARLY],true);
  p.answers.picks=()=>snapshot({games:GAMES().map(g=>[2,10].includes(g.index)?{...g,kind:'final',status:'FINAL',detail:'Final',awayScore:20,homeScore:10,winner:g.away.code,issue:null}:g)});
  for(let i=0;i<3;i++)p.update('pickem');
  assert.equal(p.slatesOpen()[EARLY],true,'a slate opened by hand stays open');assert.deepEqual(p.pills(EARLY),['2 FINAL','1 FINAL TIE','1 VOID']);
  p.update('survivor');assert.deepEqual([p.slatesOpen()[EARLY],p.slatesOpen()[LATE],p.slatesOpen()[NIGHT]],[true,false,true],'a Survivor update changes nothing here');
  p.slateToggle(NIGHT).focus();
  p.answers.picks=()=>snapshot({games:GAMES().filter(g=>g.index!==9)});p.update('pickem');
  assert.equal(p.groups().length,7);assert(p.slateToggle(NIGHT)!==night,'rebuilt');same(p.doc.activeElement,p.slateToggle(NIGHT),'focus returns to the same heading');
  assert.deepEqual([p.slatesOpen()[EARLY],p.slatesOpen()[LATE],p.slatesOpen()[NIGHT]],[true,false,true],'the choices survive the rebuild');
  assert.deepEqual(p.writes,[]);
});
await check('filters and slates: a status change or Disagreements only keeps every manual choice and never closes an open slate; a slate chosen in the selector opens each time it is chosen (even one closed by hand), without Expand all or Collapse all, and can then be closed by hand, kept through refreshes and filters; All Slates comes back exactly as it was left, the slate looked at alone included; the entries, the status and the open matchup are untouched',async()=>{
  const p=await page({picksAnswer:()=>snapshot({games:MIXED()})});
  p.slateToggle(EARLY).click();p.slateToggle(NIGHT).click();
  p.segment('final').click();
  assert.deepEqual(p.groups(),['Thursday Night','Sunday Early','Sunday Late']);assert.deepEqual(p.slatesOpen(),{'2026-09-24|3':false,[EARLY]:false,[LATE]:false},'a status change keeps the choices');
  p.slateToggle('2026-09-24|3').click();assert.equal(p.slatesOpen()['2026-09-24|3'],true);
  p.segment('all').click();
  assert.deepEqual([p.slatesOpen()['2026-09-24|3'],p.slatesOpen()[EARLY],p.slatesOpen()[NIGHT]],[true,false,true],'back with every slate, the choices stay');
  p.disagree().click();
  assert.deepEqual(p.shown(),[0,1,2,6,10,7]);assert.deepEqual(p.groups(),['Thursday Night','Sunday Early','Sunday Late']);assert.deepEqual(Object.values(p.slatesOpen()),[true,false,false]);
  p.disagree().click();
  p.chooseSlate(EARLY);
  assert.deepEqual(p.groups(),['Sunday Early']);assert.deepEqual(p.slatesOpen(),{[EARLY]:true},'a chosen slate starts open although it was closed by hand');none(p.bar(),'no slate actions for one chosen slate');
  assert.equal(p.slateBody(EARLY).hidden,false);assert.equal(p.note(),'All 4 entries · Sunday Early · 4 of 4 games · 1 VOID/HOLD shown in every status filter');
  p.slateToggle(EARLY).click();assert.deepEqual(p.slatesOpen(),{[EARLY]:false},'and can be closed by hand');
  for(let i=0;i<3;i++)p.update('pickem');assert.deepEqual(p.slatesOpen(),{[EARLY]:false},'kept through refreshes');
  p.segment('live').click();assert.deepEqual(p.slatesOpen(),{[EARLY]:false},'and through a status change');p.segment('all').click();
  p.chooseSlate('all');
  assert.deepEqual(p.slatesOpen(),{'2026-09-24|3':true,'2026-09-27|0':false,[EARLY]:false,[LATE]:false,[NIGHT]:true,'2026-09-27|4':false,'2026-09-28|3':false,tbd:false},'All Slates comes back exactly as it was left');assert(p.bar());
  p.chooseSlate(LATE);assert.deepEqual(p.slatesOpen(),{[LATE]:true});
  p.chooseSlate(EARLY);assert.deepEqual(p.slatesOpen(),{[EARLY]:true},'chosen again: open again, whatever was chosen for it before');
  p.chooseSlate('all');assert.equal(p.slatesOpen()[LATE],false,'a slate looked at alone keeps its All Slates state');assert.equal(p.slatesOpen()[EARLY],false,'and so does one closed by hand in All Slates');
  p.slateToggle(EARLY).click();p.expandOf(2).click();p.compare().click();p.toggleBox('JC');p.done().click();
  assert.deepEqual(p.expanded(),[2]);assert.equal(p.comparing(),'D.C. + DJS + Thaddeus');assert.deepEqual([p.slatesOpen()[EARLY],p.slatesOpen()[NIGHT]],[true,true],'an entry change keeps the slates');
  p.segment('live').click();assert.deepEqual(p.expanded(),[2]);assert.equal(p.status(),'live');assert.deepEqual(p.slatesOpen(),{[EARLY]:true,[LATE]:false});
  assert.deepEqual(p.prefs(),{version:1,entrants:['D.C.','DJS','Thaddeus']});assert(p.writes.every(([k])=>k===STORAGE_KEY),'only the selection is written');
});
await check('a week change returns every slate to its default (the live slates open, the rest collapsed) and a chosen slate to open, the choices made for the week before dropped even when the slates match; the status, the entries and Disagreements only stay; while another week loads nothing moves and the same week back restores the choices; a slate that leaves the schedule is forgotten',async()=>{
  const p=await page();
  p.slateToggle(EARLY).click();p.slateToggle(NIGHT).click();p.segment('upcoming').click();
  assert.deepEqual(p.groups(),['Sunday Morning','Sunday Early','Sunday Late','Sunday Night','Sunday · Kickoff TBD','Monday Night','Kickoff TBD']);
  assert.deepEqual([p.slatesOpen()[EARLY],p.slatesOpen()[NIGHT]],[false,true]);
  p.answers.picks=()=>({ready:false,reason:'Another week is loading. The picks follow once it is on screen.'});p.update('pickem');
  assert.equal(p.board().innerHTML,'<div class="empty">Another week is loading. The picks follow once it is on screen.</div>');
  p.answers.picks=()=>snapshot();p.update('pickem');
  assert.deepEqual([p.slatesOpen()[EARLY],p.slatesOpen()[NIGHT]],[false,true],'the same week back: the choices are back');assert.equal(p.status(),'upcoming');
  const g=(index,away,home,kickoff,o={})=>game(index,away,home,{kickoff,date:kickoff.slice(0,10),...o});
  p.answers.picks=()=>snapshot({week:4,games:[g(0,'BUF','NYJ','2026-10-04T17:00:00Z'),g(1,'DAL','PHI','2026-10-04T17:00:00Z',{kind:'live',status:'2nd 3:00',detail:'2nd 3:00',awayScore:7,homeScore:10}),g(2,'KC','LV','2026-10-04T20:25:00Z'),g(3,'GB','MIN','2026-10-06T00:15:00Z',{tiebreak:true})]});
  p.update('pickem');
  assert.equal(p.status(),'upcoming','the status stays');assert.equal(p.comparing(),'All 4 entries');
  assert.deepEqual(p.slatesOpen(),{'2026-10-04|1':false,'2026-10-04|2':false,'2026-10-05|3':false},'Upcoming lists no live game: every slate of the new week collapsed');
  p.segment('all').click();
  assert.deepEqual(p.slatesOpen(),{'2026-10-04|1':true,'2026-10-04|2':false,'2026-10-05|3':false},'the new week: its live slate open, the rest collapsed, by default');
  assert.deepEqual(p.pills('2026-10-04|2'),['1 UPCOMING']);assert.deepEqual(p.pills('2026-10-05|3'),['1 UPCOMING','TIEBREAK']);
  p.slateToggle('2026-10-04|2').click();assert.equal(p.slatesOpen()['2026-10-04|2'],true);
  p.answers.picks=()=>snapshot();p.update('pickem');
  assert.deepEqual([p.slatesOpen()[EARLY],p.slatesOpen()[NIGHT],p.slatesOpen()[LATE]],[true,false,false],'a different week: defaults, the earlier choices dropped');assert.equal(p.status(),'all');
  p.slateToggle(EARLY).click();assert.equal(p.slatesOpen()[EARLY],false);
  p.answers.picks=()=>snapshot({games:GAMES().map(g=>[1,2,6,10].includes(g.index)?{...g,kickoff:'2026-09-27T20:05:00Z'}:g)});p.update('pickem');
  assert(!(EARLY in p.slatesOpen()),'Sunday Early is off the schedule');assert.equal(p.slatesOpen()[LATE],true,'Sunday Late, now with the live games, opens');
  p.answers.picks=()=>snapshot();p.update('pickem');
  assert.equal(p.slatesOpen()[EARLY],true,'back on the schedule with live games: its default, the old choice forgotten');assert.equal(p.slatesOpen()[LATE],true,'Sunday Late stays open');
  // Another week on the same dates (a fixture only: real weeks never share a kickoff date), so its slates keep their keys and
  // only the week can reset them.
  p.slateToggle(EARLY).click();p.slateToggle(NIGHT).click();
  assert.deepEqual([p.slatesOpen()[EARLY],p.slatesOpen()[NIGHT],p.slatesOpen()[LATE]],[false,true,true]);
  p.answers.picks=()=>snapshot({week:4});p.update('pickem');
  assert.deepEqual([p.slatesOpen()[EARLY],p.slatesOpen()[NIGHT],p.slatesOpen()[LATE]],[true,false,false],'a different week starts afresh even when its slates match the week before');
  p.chooseSlate(LATE);p.slateToggle(LATE).click();assert.deepEqual(p.slatesOpen(),{[LATE]:false});
  p.answers.picks=()=>snapshot({week:5});p.update('pickem');
  assert.equal(p.select().value,LATE,'the chosen slate is on the new schedule, so it stays chosen');assert.deepEqual(p.slatesOpen(),{[LATE]:true},'and opens again: closed by hand in the week before');
  assert.deepEqual(p.writes,[]);
});
await check('VOID and HOLD games are discoverable from a collapsed slate: its summary pills name them (with ties, reviews, unverified results and the tiebreak game) in every status filter; opening the slate shows the same cards, graded exactly as before',async()=>{
  const p=await page({picksAnswer:()=>snapshot({games:GAMES().map(g=>g.index===6?{...g,note:'Commissioner ruling · UNDER REVIEW',underReview:'the feed now reports a completed final'}:g)})});
  p.slatesAction('collapse').click();
  assert.deepEqual(p.pills(EARLY),['2 LIVE','1 FINAL TIE','1 VOID','1 UNDER REVIEW','1 NOT VERIFIED']);
  assert.deepEqual(p.pills(LATE),['1 UPCOMING','1 HOLD']);assert.deepEqual(p.pills('2026-09-28|3'),['1 UPCOMING','TIEBREAK']);
  for(const [status,early,late] of [['final',['1 FINAL TIE','1 VOID','1 UNDER REVIEW'],['1 HOLD']],['live',['2 LIVE','1 VOID','1 UNDER REVIEW','1 NOT VERIFIED'],['1 HOLD']],['upcoming',['1 VOID','1 UNDER REVIEW'],['1 UPCOMING','1 HOLD']]]){
    p.segment(status).click();assert.deepEqual(p.pills(EARLY),early,`${status}: Sunday Early`);assert.deepEqual(p.pills(LATE),late,`${status}: Sunday Late`);
    assert(p.shown().includes(6)&&p.shown().includes(7),`${status}: VOID and HOLD stay listed`);assert(Object.values(p.slatesOpen()).every(v=>v===false),`${status}: still collapsed`);
  }
  p.segment('all').click();
  assert.equal(p.note(),'All 4 entries · 12 of 12 games · 2 VOID/HOLD shown in every status filter');
  for(const article of p.cards())assert.equal(article.querySelectorAll('.pm-status').length,1,'the pills add no status pill to the cards');
  p.slateToggle(EARLY).click();
  assert.deepEqual(tokens(p.cardOf(6)),['D.C. CIN','JC PIT','DJS CIN','Thaddeus —'],'nothing graded');assert.equal(spoken(p.cardOf(6).querySelector('.pm-top')),'1:00 PM EDT VOID UNDER REVIEW Commissioner ruling · UNDER REVIEW');
  p.expandOf(6).click();assert.deepEqual(p.details(6).querySelectorAll('.pm-pick').map(spoken),['D.C. CIN VOID','JC PIT VOID','DJS CIN VOID','Thaddeus NO PICK VOID']);
  p.slateToggle(LATE).click();p.expandOf(7).click();assert.equal(spoken(p.details(7).querySelectorAll('.pm-pick')[0]),'D.C. LV HOLD');
  assert.deepEqual(p.writes,[]);
});
await check('accessibility and the stylesheet: a semantic heading with one button per slate (aria-expanded, aria-controls naming an existing body), the Expand all and Collapse all buttons in a labelled group, visible focus styling, 44px slate headings and 42px actions, the chevron following aria-expanded, the summary pills shown only while collapsed, the body hidden with the hidden attribute the base stylesheet honours',async()=>{
  const p=await page();
  const ids=new Set();
  for(const section of p.sections()){
    const h3=section.querySelector('.pm-group-title');assert.equal(h3.localName,'h3');
    const buttons=h3.querySelectorAll('button');assert.equal(buttons.length,1,'one control per heading');
    const [b]=buttons;assert(['true','false'].includes(b.getAttribute('aria-expanded')));
    const id=b.getAttribute('aria-controls');assert(id&&!ids.has(id),'a unique id');ids.add(id);assert.match(id,/^pm-slate-[A-Za-z0-9_-]+$/,'an id safe for aria-controls');
    assert.equal(p.doc.getElementById(id).getAttribute('class'),'pm-slate-body');
    assert.equal(b.querySelector('.pm-slate-chevron').getAttribute('aria-hidden'),'true','the chevron is decoration');
    assert(spoken(b).startsWith(section.querySelector('.pm-slate-name').textContent),'the control is named by the slate first');
  }
  const bar=p.bar();assert.equal(bar.getAttribute('role'),'group');assert.equal(bar.getAttribute('aria-label'),'Slates');
  assert.deepEqual(bar.querySelectorAll('button').map(b=>[b.textContent,b.getAttribute('type')]),[['Expand all','button'],['Collapse all','button']]);
  assert.match(css,/\.pm-slate-toggle\{[^}]*width:100%/);assert.match(css,/\.pm-slate-toggle\{[^}]*min-height:44px/);assert.match(css,/\.pm-slates-action\{[^}]*min-height:42px/);
  const focus=css.match(/^([^{\n]*:focus-visible[^{\n]*)\{outline:2px solid #ef5a61;outline-offset:2px\}$/m)?.[1]||'';
  assert(focus.includes('.pm-slate-toggle:focus-visible')&&focus.includes('.pm-slates-action:focus-visible'),'visible focus on the new controls, as on the existing ones');
  assert(css.includes('.pm-slate-toggle[aria-expanded="true"] .pm-slate-chevron{transform:rotate(-135deg)'),'the chevron follows the state');
  assert(css.includes('.pm-slate-summary:empty,.pm-group:not(.is-collapsed) .pm-slate-summary{display:none}'),'the summary shows only while collapsed');
  assert(!/\.pm-slate-body\[hidden\]|\.pm-slate-body\{[^}]*display:none/.test(css)&&baseCss.includes('[hidden]{display:none!important}'),'the body hides with the hidden attribute, which style.css honours over any display rule');
  assert.match(css,/prefers-reduced-motion:reduce\)\{[^}]*\.pm-slate-chevron/);
  assert(!/https?:\/\//.test(css));
});
await check('desktop table regression: through boot, every filter, the panel, every expansion and every update the module never writes the comparison table or the containers weekly-app.js owns',async()=>{
  const p=await page();
  p.doc.getElementById('pickHead').innerHTML='<tr><th class="name">Entry</th></tr>';p.doc.getElementById('pickBody').innerHTML='<tr><td class="name">D.C.</td></tr>';
  p.compare().click();p.toggleBox('JC');p.done().click();p.chooseSlate(EARLY);p.segment('final').click();p.expandOf(1).click();p.update('pickem');p.update('survivor');p.toggle('pickem').click();
  assert.deepEqual(p.table(),['<tr><th class="name">Entry</th></tr>','<tr><td class="name">D.C.</td></tr>']);
  assert(p.doc.querySelector('.picks .scroll'),'the scrolling table wrapper stays for wide screens');
});
await check('small-screen layout and desktop fallback, as the stylesheet and the page declare them: the cards and controls only below 761px and only once the module is ready, the table everywhere else, the page copy per layout, touch targets of 42px or more, nothing remote',()=>{
  assert.match(css,/^\.picks\.is-mobile-ready \.picks-filters,\.picks\.is-mobile-ready \.picks-board,\.pm-copy-cards\{display:none\}$/m,'without the module, or on a wide screen, the containers and the card copy are hidden');
  const mobile=css.slice(css.indexOf('@media(max-width:760px){'),css.indexOf('\n}\n',css.indexOf('@media(max-width:760px){'))+3);
  for(const rule of ['.picks.is-mobile-ready .scroll{display:none}','.picks.is-mobile-ready .picks-filters{display:block}','.picks.is-mobile-ready .picks-board{display:grid','.view-panel.is-mobile-ready .pm-copy-table{display:none}','.view-panel.is-mobile-ready .pm-copy-cards{display:inline}'])assert(mobile.includes(rule),`below 761px: ${rule}`);
  assert(!css.slice(0,css.indexOf('@media(max-width:760px){')).includes('.scroll{display:none}'),'the table is never hidden outside the narrow layout');
  assert.match(css,/\.pm-compare,\.pm-select\{[^}]*min-height:44px/);assert.match(css,/\.pm-segment\{[^}]*min-height:42px/);assert.match(css,/\.pm-summary\{[^}]*min-height:56px/);assert.match(css,/\.pm-entry\{[^}]*min-height:48px/);assert.match(css,/\.rules-toggle\{[^}]*min-height:44px/);
  assert.match(css,/\.pm-toggle\{[^}]*min-height:42px/,'the Disagreements only switch is a 42px target');
  assert(css.includes('.pm-results.is-grid{display:grid;grid-template-columns:repeat(var(--pm-cols,1),minmax(0,1fr))}'),'compact labels: one column per compared entry');
  assert(css.includes('.pm-results.is-grid .pm-token{justify-self:start;max-width:100%;min-width:0}')&&css.includes('.pm-results.is-grid .pm-token-name{min-width:0;overflow:hidden;text-overflow:ellipsis}'),'a chip never overflows its column');
  assert(css.includes('.pm-results.is-dense .pm-token{gap:3px;min-height:20px;padding:0 5px;font-size:9.5px}')&&css.includes('.pm-results.is-dense .pm-token{font-size:9px;padding:0 4px}'),'four compared entries: denser chips, denser still below 401px');
  assert(css.includes('.pm-sheet-setting{')&&css.includes('.pm-segments-2{grid-template-columns:repeat(2,1fr)'),'the labels setting is styled for the panel');
  assert.match(css,/\.pm-toggle\[aria-pressed="true"\]\{color:#fff;border-color:#d52d3466;background:#d52d3414\}/,'the switch takes the existing accent');
  assert(!/https?:\/\//.test(css),'the stylesheet names no remote resource');
  assert(!/pm-chip/.test(css),'no chip strip');
  assert.match(css,/\.pm-card\.is-expanded \.pm-results\{display:none\}/,'an open card shows its graded rows instead of its tokens');
  assert(mobile.includes('.picks.is-mobile-ready>.head{flex-direction:column'),'the card head stacks its title over the legend on phones');
  const picks=panelOf('picks');
  assert.match(picks,/<p><span class="pm-copy-table">Side-by-side picks for D\.C\., JC, DJS and Thaddeus\. Matchup headers show full-field ownership when available\.<\/span><span class="pm-copy-cards">[^<]*Tap a matchup[^<]*<\/span><\/p>/,'the table copy and the card copy are both in the page, one shown per layout');
  assert(!/scroll(?:ing)? (?:sideways|horizontally)|swipe/i.test(picks),'no instruction describes a sideways-scrolling table');
  assert.equal(picks.split('<dialog class="pm-dialog" id="picksEntrants" aria-labelledby="picksEntrantsTitle">').length-1,1,'one entry selection dialog');
  assert.equal(picks.split('data-picks-close').length-1,2,'a close control in the head and Done');
  assert(picks.includes('<button type="button" class="share-action" data-picks-entrant="*">Select all</button>'));
  assert(picks.includes('<p class="pm-sheet-status" data-picks-dialog-note role="status" aria-live="polite"></p>'),'the panel’s note is a live status region');
  assert(picks.includes('<div class="pm-sheet-list" data-picks-entrants></div>'));
  assert.equal(picks.split('data-picks-labels=').length-1,2,'the panel holds the Compact / Full labels setting');
  assert(picks.indexOf('data-picks-entrants')<picks.indexOf('pm-sheet-setting')&&picks.indexOf('pm-sheet-setting')<picks.indexOf('data-picks-dialog-note'),'the setting sits between the list and the status');
  assert(!/data-picks-labels|data-picks-disagree/.test(picks.slice(0,picks.indexOf('<dialog'))),'no permanently visible toolbar: the setting lives in the panel and the switch is rendered into the filters');
  assert(picks.indexOf('id="picksBoard"')<picks.indexOf('id="pickHead"')&&picks.indexOf('id="pickHead"')<picks.indexOf('id="picksEntrants"'),'cards, then the table, then the dialog');
});
await check('a page without the mobile markup is left alone',async()=>{
  const doc=makeDocument('<div class="other"><div id="gamegrid"></div></div>');
  globalThis.document=doc;
  const mod=await import(`./picks-mobile.js?instance=${++instance}`);
  assert.equal(mod.boot(),null);
  assert.equal(doc.body.innerHTML,'<div class="other"><div id="gamegrid"></div></div>');
});

assert.equal(failures.length,0,`V1.4 compact Picks UX regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
console.log('picks-mobile regressions passed: Eastern kickoff slates, slate, status, entry and Disagreements only filters together, compact pick chips and card name labels, the compact card, slate, board and control markup, the collapsible slate groups (defaults, independent and all-at-once expansion, refresh stability, filters, week changes, VOID/HOLD summaries and accessibility), the entry selection panel and its labels setting, one open matchup at a time, refresh stability, week changes, exceptional game states, the untouched comparison table, the declared small-screen layout and desktop fallback, and the collapsible Rules & rulings');
