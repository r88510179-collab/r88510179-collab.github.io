// V1.3 mobile UX regressions. picks-mobile.js's pure parts directly (kickoff grouping in Eastern time, the status filter, the
// entrant selection and its storage, the card, board and filter markup, the Rules & rulings summary and alerts), and its page
// part on a small DOM built from the real Games, Survivor and Picks panels of index.html (so the markup the module needs is the
// markup the page ships), with the two apps stood in for by poolcenter:picks and poolcenter:rules listeners that answer with
// fixtures and poolcenter:update announcements, exactly as weekly-app.js and survivor-app.js do.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {STORAGE_KEY,PREFERENCES_VERSION,TIME_ZONE,STATUS_FILTERS,STATUS_LABELS,KINDS,kickoffParts,dateParts,slotOf,slotLabel,groupGames,
  matchesStatus,filterGames,statusCounts,normalizeSelection,readSelection,writeSelection,toggleEntrant,cardHtml,boardHtml,filterBarHtml,filterNote,
  rulesSummary,alertsHtml} from './picks-mobile.js';

const failures=[];
const check=async(name,fn)=>{try{await fn()}catch(error){failures.push(`${name}: [${error?.code||error?.name}] ${error?.message||error}`)}};
const flush=async(n=10)=>{for(let i=0;i<n;i++)await new Promise(r=>setTimeout(r,0))};
const index=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const panelOf=name=>{
  const start=index.indexOf(`<section class="view-panel" data-view-panel="${name}"`),tags=/<section\b[^>]*>|<\/section>/g;
  assert(start>=0,`index.html has the ${name} panel`);
  tags.lastIndex=start;let depth=0,m;
  while((m=tags.exec(index))){depth+=m[0][1]==='/'?-1:1;if(!depth)return index.slice(start,m.index+m[0].length)}
  throw new Error(`the ${name} panel does not close`);
};
const PAGE=[panelOf('games'),panelOf('survivor'),panelOf('picks')].join('\n');
assert(PAGE.includes('data-rules-card="pickem"')&&PAGE.includes('data-rules-card="survivor"')&&PAGE.includes('id="picksBoard"'),'the panels of index.html hold the mobile UX markup');

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
const snapshot=(o={})=>({ready:true,contest:'pickem',season:2026,week:3,revision:2,fieldSize:87,tiebreakIndex:5,entrants:[{name:'D.C.',noSubmission:false},{name:'JC',noSubmission:false},{name:'DJS',noSubmission:false},{name:'Thaddeus',noSubmission:true}],games:GAMES(),...o});
// The Rules & rulings answers, as the apps give them (the model is contest-rulings.js's rulesModel output).
const incident=(o={})=>({key:'3|BUF|CIN|1',week:3,matchup:'BUF @ CIN',status:'APPLIED',detail:'VOID: removed from scoring, with no win, no loss and no points. Applied by commissioner ruling under policy revision 1.',review:null,evidence:'Recorded incident: STATUS_CANCELED · event 401437947',history:[{label:'Ruled VOID',date:'2026-10-08',note:'League canceled the game.'}],...o});
const readyModel=(o={})=>({state:'ready',contestType:"Pick'em contest",contestName:"Pool Center 2026 Pick'em",stale:null,policy:{revision:1,effectiveWeek:1,name:'Void',text:'A canceled, postponed or suspended game…',publicNote:null},revisions:[{revision:1,effectiveWeek:1,name:'Void',publicNote:null}],confirmation:'Commissioner confirmation is required…',incidents:[],empty:'No incident ruling has been confirmed for this contest so far.',...o});
const rulesAnswer=(model,o={})=>({ready:true,contest:'pickem',week:3,model,...o});

// ---- Constants.
await check('the constants: one versioned storage key, Eastern time, the four status filters in order, the six game kinds',()=>{
  assert.equal(STORAGE_KEY,'poolcenter.picks.v1');assert.equal(PREFERENCES_VERSION,1);assert.equal(TIME_ZONE,'America/New_York');
  assert.deepEqual(STATUS_FILTERS,['all','final','live','upcoming']);assert.deepEqual(STATUS_LABELS,{all:'All',final:'Final',live:'Live',upcoming:'Upcoming'});
  assert.deepEqual(KINDS,['void','hold','final','tie','live','upcoming']);
  assert(Object.isFrozen(STATUS_FILTERS)&&Object.isFrozen(KINDS));
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
await check('slots are by clock time: before noon morning, noon to 2:59 early, 3:00 to 6:59 late, 7:00 PM on night; the familiar labels follow from the day and slot',()=>{
  assert.deepEqual([0,9,11,12,13,14,15,16,18,19,20,23].map(slotOf),['morning','morning','morning','early','early','early','late','late','late','night','night','night']);
  assert.deepEqual([slotLabel('Thursday','night'),slotLabel('Sunday','early'),slotLabel('Sunday','late'),slotLabel('Sunday','night'),slotLabel('Monday','night'),slotLabel('Sunday','morning'),slotLabel('Saturday','tbd')],
    ['Thursday Night','Sunday — Early Games','Sunday — Late Games','Sunday Night','Monday Night','Sunday Morning','Saturday · kickoff time TBD']);
});
await check('games are grouped chronologically by Eastern date and slot, kickoff order inside a group, a date without a time in a TBD group on its date, no date at all last',()=>{
  const groups=groupGames(GAMES());
  assert.deepEqual(groups.map(g=>[g.label,g.date,g.games.map(x=>x.game.index)]),[
    ['Thursday Night','Thu, Sep 24',[0]],
    ['Sunday Morning','Sun, Sep 27',[11]],
    ['Sunday — Early Games','Sun, Sep 27',[1,2,6,10]],
    ['Sunday — Late Games','Sun, Sep 27',[7,3]],
    ['Sunday Night','Sun, Sep 27',[4]],
    ['Sunday · kickoff time TBD','Sun, Sep 27',[8]],
    ['Monday Night','Mon, Sep 28',[5]],
    ['Unscheduled · kickoff TBD','',[9]]
  ]);
  assert.deepEqual(groups[3].games.map(x=>x.time),['4:05 PM EDT','4:25 PM EDT'],'the 4:05 game comes before the 4:25 game whatever the published order');
  assert.deepEqual(groups[5].games.map(x=>x.time),[null],'no kickoff text without a kickoff');
  assert.equal(groups.reduce((n,g)=>n+g.games.length,0),12,'every game is in exactly one group');
  assert.deepEqual(groupGames([]),[]);assert.deepEqual(groupGames(null),[]);
});
await check('unusual slates get true labels: a Thanksgiving Thursday, a Saturday doubleheader, a Friday game and a Christmas Monday afternoon',()=>{
  const g=(i,kickoff)=>game(i,'A','B',{kickoff});
  assert.deepEqual(groupGames([g(0,'2026-11-26T17:30:00Z'),g(1,'2026-11-26T21:30:00Z'),g(2,'2026-11-27T01:20:00Z'),g(3,'2026-12-19T18:00:00Z'),g(4,'2026-12-19T21:30:00Z'),g(5,'2026-12-20T01:15:00Z'),g(6,'2026-12-25T18:00:00Z'),g(7,'2026-12-26T00:15:00Z')]).map(x=>x.label),
    ['Thursday — Early Games','Thursday — Late Games','Thursday Night','Saturday — Early Games','Saturday — Late Games','Saturday Night','Friday — Early Games','Friday Night']);
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
await check('storage: absent, refusing, malformed or old values are everyone; writing touches only the one key and reports failure instead of throwing',()=>{
  const store=new Map(),storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,v)};
  assert.deepEqual(readSelection(NAMES,storage),NAMES);
  assert.deepEqual(readSelection(NAMES,undefined),NAMES);
  assert.deepEqual(readSelection(NAMES,{getItem(){throw new Error('denied')}}),NAMES);
  store.set(STORAGE_KEY,'{not json');assert.deepEqual(readSelection(NAMES,storage),NAMES);
  store.set(STORAGE_KEY,JSON.stringify({version:0,entrants:['JC']}));assert.deepEqual(readSelection(NAMES,storage),NAMES);
  store.set(STORAGE_KEY,JSON.stringify({version:1,entrants:['Thaddeus','JC']}));assert.deepEqual(readSelection(NAMES,storage),['JC','Thaddeus']);
  store.set('other','keep');
  assert.equal(writeSelection(['JC','DJS'],storage),true);
  assert.deepEqual([...store.keys()].sort(),['other',STORAGE_KEY]);assert.deepEqual(JSON.parse(store.get(STORAGE_KEY)),{version:1,entrants:['JC','DJS']});assert.equal(store.get('other'),'keep');
  assert.equal(writeSelection(['JC'],undefined),false);
  assert.equal(writeSelection(['JC'],{setItem(){throw new Error('quota')}}),false);
});

// ---- Markup.
const cards=html=>html.split('<article ').slice(1).map(s=>'<article '+s);
await check('a final card: both teams with their logos and verified score, the winner marked, FINAL, the picks of the selected entries only, graded as the table grades them, NO PICK where there was no submission',()=>{
  const html=cardHtml(GAMES()[0],NAMES,{time:'8:15 PM EDT'});
  assert.match(html,/^<article class="pm-card pm-kind-final" data-game="0" aria-label="DEN at KC, FINAL">/);
  assert.match(html,/<span class="pm-time">8:15 PM EDT<\/span><span class="pm-status pm-status-final">FINAL<\/span>/);
  assert(!html.includes('pm-detail'),'a plain Final adds no detail');
  assert.match(html,/<div class="pm-side pm-away pm-winner"><span class="pm-badge" style="--tc:#123456" aria-hidden="true"><span class="pm-badge-code">DEN<\/span><img class="pm-logo" src="https:\/\/a\.espncdn\.com\/i\/teamlogos\/nfl\/500\/den\.png" alt="" loading="lazy" decoding="async" onerror="this\.hidden=true"><\/span><span class="pm-code">DEN<\/span><span class="pm-score">24<\/span><\/div>/);
  assert.match(html,/<div class="pm-side pm-home"><span class="pm-score">17<\/span><span class="pm-code">KC<\/span><span class="pm-badge"/);
  assert.deepEqual([...html.matchAll(/<li class="pm-pick ([a-z-]+(?: no-pick-row)?)"><span class="pm-name">([^<]+)<\/span>(.*?)<\/li>/g)].map(m=>[m[2],m[1],m[3].replace(/<span class="pm-badge[^"]*"[^>]*><span class="pm-badge-code">[^<]*<\/span>(?:<img[^>]*>)?<\/span>/g,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()]),[
    ['D.C.','ok','DEN ✓ Correct'],['JC','bad','KC ✕ Incorrect'],['DJS','ok','DEN ✓ Correct'],['Thaddeus','bad no-pick-row','NO PICK ✕ No pick']]);
  const two=cardHtml(GAMES()[0],['JC','Thaddeus']);
  assert.deepEqual([...two.matchAll(/<span class="pm-name">([^<]+)<\/span>/g)].map(m=>m[1]),['JC','Thaddeus'],'only the selected entries, in published order');
  assert.match(two,/<span class="pm-time">Kickoff TBD<\/span>/,'without a kickoff text the card says so');
  assert(!html.includes('pm-ownership')&&!html.includes('pm-flags'),'no ownership or flags without them');
});
await check('a tie card: FINAL TIE, the overtime detail, no winner, every pick one loss',()=>{
  const html=cardHtml(GAMES()[1],NAMES,{time:'1:00 PM EDT'});
  assert.match(html,/pm-kind-tie" data-game="1" aria-label="MIA at BUF, FINAL TIE">/);
  assert.match(html,/<span class="pm-status pm-status-tie">FINAL TIE<\/span><span class="pm-detail">Final\/OT<\/span>/);
  assert(!html.includes('pm-winner'),'no winner');
  assert.equal((html.match(/✕ Tie · 1 loss/g)||[]).length,3);assert.match(html,/NO PICK<\/span><span class="pm-result">✕ No pick<\/span>/);
  assert.equal((html.match(/pm-pick bad/g)||[]).length,4,'a tie is a loss for every pick');
});
await check('a live card: LIVE with the clock and the live score; an unverified result is flagged on the card in the page’s own words',()=>{
  const html=cardHtml(GAMES()[2],NAMES,{time:'1:00 PM EDT'});
  assert.match(html,/pm-kind-live" data-game="2" aria-label="NYJ at NE, LIVE">/);
  assert.match(html,/<span class="pm-status pm-status-live">LIVE<\/span><span class="pm-detail">3rd 7:41<\/span>/);
  assert.match(html,/<span class="pm-score">10<\/span>/);assert.match(html,/<span class="pm-score">7<\/span>/);
  assert.equal((html.match(/>Pending</g)||[]).length,4);
  const flagged=cardHtml(GAMES()[10],NAMES);
  assert.match(flagged,/<div class="pm-flags"><span class="pm-flag pm-flag-issue">Not verified · DET-CHI: final with contradictory status ignored<\/span><\/div>/);
});
await check('an upcoming card: the Eastern kickoff, UPCOMING, no scores, the tiebreak game marked, full-field ownership when the field is published',()=>{
  const html=cardHtml(GAMES()[3],NAMES,{time:'4:25 PM EDT'});
  assert.match(html,/<span class="pm-time">4:25 PM EDT<\/span><span class="pm-status pm-status-upcoming">UPCOMING<\/span><\/div>/);
  assert(!html.includes('pm-score'),'no score before kickoff');
  assert.match(html,/<div class="pm-ownership" aria-label="Full-field pick ownership"><span class="contrarian">WAS 31%<\/span><small>of 87 entries<\/small><span>69% PHI<\/span><\/div>/);
  assert.match(cardHtml(GAMES()[5],NAMES),/<span class="pm-time">Mon 8:15 PM<\/span>/,'without a kickoff text the feed detail stands in');
  assert.match(cardHtml(GAMES()[5],NAMES),/<span class="pm-flag pm-flag-tiebreak">TIEBREAK GAME<\/span>/);
});
await check('a VOID card and a HOLD card say so, with the Games grid’s own note, the held game’s reason, and every pick VOID or HOLD, never graded',()=>{
  const v=cardHtml(GAMES()[6],NAMES,{time:'1:00 PM EDT'});
  assert.match(v,/pm-kind-void" data-game="6" aria-label="CIN at PIT, VOID">/);
  assert.match(v,/<span class="pm-status pm-status-void">VOID<\/span><span class="pm-detail">Commissioner ruling<\/span>/);
  assert.equal((v.match(/<span class="pm-result">VOID<\/span>/g)||[]).length,4);assert(!/✓|✕/.test(v),'nothing graded');
  const review=cardHtml({...GAMES()[6],note:'Commissioner ruling · UNDER REVIEW',underReview:'the feed now reports a completed final'},NAMES);
  assert.match(review,/<span class="pm-detail">Commissioner ruling · UNDER REVIEW<\/span>/);assert.match(review,/<span class="pm-flag pm-flag-review">UNDER REVIEW<\/span>/);
  const h=cardHtml(GAMES()[7],NAMES,{time:'4:05 PM EDT'});
  assert.match(h,/pm-kind-hold" data-game="7" aria-label="LV at LAC, HOLD">/);
  assert.match(h,/<span class="pm-status pm-status-hold">HOLD<\/span><span class="pm-detail">Ruling information unusable<\/span>/);
  assert.match(h,/<span class="pm-flag pm-flag-issue">Not graded · the ruling cites policy revision 2, which does not exist<\/span>/);
  assert.equal((h.match(/<span class="pm-result">HOLD<\/span>/g)||[]).length,4);
});
await check('names, codes and feed text are escaped; an unknown kind renders as upcoming',()=>{
  const hostile=game(0,'<b>','KC',{detail:'<img src=x onerror=alert(1)>',issue:'<script>',picks:[{name:'<i>x</i>',team:'<b>',result:'correct'}]});
  const html=cardHtml(hostile,['<i>x</i>']);
  assert(!/<b>|<img src=x|<script>|<i>x/.test(html.replace(/<b>|<\/b>/g,m=>m)),'nothing hostile survives');
  assert(html.includes('&lt;i&gt;x&lt;/i&gt;')&&html.includes('&lt;script&gt;')&&html.includes('&lt;b&gt;'));
  assert.match(cardHtml({...game(0,'A','B'),kind:'bogus'},NAMES),/pm-kind-upcoming/);
});
await check('the board: the groups in order with their headers, filtered by status and entrants; a loading or failed app shows its reason; an empty filter says so',()=>{
  const html=boardHtml(snapshot(),{entrants:NAMES,status:'all'});
  assert.deepEqual([...html.matchAll(/<h3 class="pm-group-title"><span>([^<]+)<\/span><small>([^<]*)<\/small><\/h3>/g)].map(m=>[m[1],m[2]]),[
    ['Thursday Night','Thu, Sep 24 · 1 game'],['Sunday Morning','Sun, Sep 27 · 1 game'],['Sunday — Early Games','Sun, Sep 27 · 4 games'],['Sunday — Late Games','Sun, Sep 27 · 2 games'],
    ['Sunday Night','Sun, Sep 27 · 1 game'],['Sunday · kickoff time TBD','Sun, Sep 27 · 1 game'],['Monday Night','Mon, Sep 28 · 1 game'],['Unscheduled · kickoff TBD','1 game']]);
  assert.equal(cards(html).length,12);
  assert.deepEqual(cards(boardHtml(snapshot(),{entrants:['JC'],status:'live'})).map(c=>c.match(/data-game="(\d+)"/)[1]),['2','6','10','7']);
  assert.equal((boardHtml(snapshot(),{entrants:['JC'],status:'live'}).match(/<span class="pm-name">/g)||[]).length,4,'one pick row per card for one entry');
  assert.equal(boardHtml(snapshot({games:GAMES().filter(g=>g.kind==='upcoming')}),{entrants:NAMES,status:'live'}),'<div class="empty">No games are live right now.</div>');
  assert.equal(boardHtml(snapshot({games:[]}),{entrants:NAMES,status:'all'}),'<div class="empty">No games are published for this week.</div>');
  assert.equal(boardHtml(null,{}),'<div class="empty">Picks are not available yet.</div>');
  assert.equal(boardHtml({ready:false,reason:"Pick'em picks have not loaded yet."},{}),'<div class="empty">Pick&#39;em picks have not loaded yet.</div>');
  assert.equal(cards(boardHtml(snapshot(),{entrants:['Nobody'],status:'all'})).length,12,'an unknown selection means everyone');
  assert.equal((boardHtml(snapshot(),{entrants:['Nobody'],status:'all'}).match(/<span class="pm-name">/g)||[]).length,48);
});
await check('the filter bar: All N and one chip per entry (pressed as selected), the four status segments with their counts, a live note',()=>{
  const html=filterBarHtml(NAMES,{selected:['D.C.','JC'],status:'live',counts:statusCounts(GAMES())});
  assert.match(html,/^<div class="pm-filters"><div class="pm-chips" role="group" aria-label="Entries shown"><button type="button" class="pm-chip pm-chip-all" data-picks-entrant="\*" aria-pressed="false">All 4<\/button><button type="button" class="pm-chip" data-picks-entrant="D\.C\." aria-pressed="true">D\.C\.<\/button><button type="button" class="pm-chip" data-picks-entrant="JC" aria-pressed="true">JC<\/button><button type="button" class="pm-chip" data-picks-entrant="DJS" aria-pressed="false">DJS<\/button><button type="button" class="pm-chip" data-picks-entrant="Thaddeus" aria-pressed="false">Thaddeus<\/button><\/div>/);
  assert.match(html,/<div class="pm-segments" role="group" aria-label="Game status"><button type="button" class="pm-segment" data-picks-status="all" aria-pressed="false">All<b data-picks-count="all">12<\/b><\/button><button type="button" class="pm-segment" data-picks-status="final" aria-pressed="false">Final<b data-picks-count="final">2<\/b><\/button><button type="button" class="pm-segment" data-picks-status="live" aria-pressed="true">Live<b data-picks-count="live">2<\/b><\/button><button type="button" class="pm-segment" data-picks-status="upcoming" aria-pressed="false">Upcoming<b data-picks-count="upcoming">6<\/b><\/button><\/div><p class="pm-note" data-picks-note aria-live="polite"><\/p><\/div>$/);
  assert.match(filterBarHtml(NAMES,{}),/data-picks-entrant="\*" aria-pressed="true"/,'everyone selected by default');
  assert.equal(filterNote(NAMES,NAMES,'all',statusCounts(GAMES()),12),'All 4 entries · 12 of 12 games · 2 VOID/HOLD shown in every filter');
  assert.equal(filterNote(NAMES,['D.C.','JC'],'live',statusCounts(GAMES()),4,'At least one entry stays selected'),'At least one entry stays selected · D.C. · JC · 4 of 12 games · Live · 2 VOID/HOLD shown in every filter');
  assert.equal(filterNote(NAMES,NAMES,'final',{all:1,final:1,live:0,upcoming:0,exceptions:0},1),'All 4 entries · 1 of 1 game · Final');
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

// ---- A small DOM: elements with attributes, classList, dataset, hidden, textContent and innerHTML (parsed), simple selectors
// (tag, #id, .class, [attr], [attr="value"], compounds and descendants), events that bubble to the document, and focus. Only
// what picks-mobile.js uses.
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
class Element{
  constructor(tag,doc){
    this.nodeType=1;this.localName=tag.toLowerCase();this.tagName=this.localName.toUpperCase();this.doc=doc;this.children=[];this.parent=null;this.attrs=new Map();this.listeners=new Map();this.classList=new ClassList(this);
    this.dataset=new Proxy({},{get:(_,k)=>typeof k==='string'?(this.getAttribute('data-'+kebab(k))??undefined):undefined,set:(_,k,v)=>{this.setAttribute('data-'+kebab(k),String(v));return true},has:(_,k)=>this.hasAttribute('data-'+kebab(k))});
  }
  setAttribute(k,v){this.attrs.set(k,String(v))}getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null}hasAttribute(k){return this.attrs.has(k)}removeAttribute(k){this.attrs.delete(k)}
  get id(){return this.getAttribute('id')||''}set id(v){this.setAttribute('id',v)}
  get className(){return this.getAttribute('class')||''}set className(v){this.setAttribute('class',v)}
  get hidden(){return this.hasAttribute('hidden')}set hidden(v){if(v)this.setAttribute('hidden','');else this.removeAttribute('hidden')}
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
  focus(){this.doc.activeElement=this}
  blur(){if(this.doc.activeElement===this)this.doc.activeElement=null}
}
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
async function page({picksAnswer=()=>snapshot(),pickemRules=()=>rulesAnswer(readyModel({incidents:[incident()]})),survivorRules=()=>({ready:true,contest:'survivor',week:3,model:readyModel({contestType:'Survivor contest',contestName:'Pool Center 2026 Survivor',policy:{revision:1,effectiveWeek:1,name:'Advance, team used',text:'…',publicNote:null},revisions:[{revision:1,effectiveWeek:1,name:'Advance, team used',publicNote:null}]})}),storage='ok',stored=null}={}){
  const doc=makeDocument(PAGE);
  globalThis.document=doc;
  globalThis.location={href:'https://example.test/nfl-pool/?view=picks',search:'?view=picks'};
  const store=new Map(),writes=[];
  if(stored!==null)store.set(STORAGE_KEY,typeof stored==='string'?stored:JSON.stringify(stored));
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
  const card=contest=>doc.querySelector(`[data-rules-card="${contest}"]`);
  return{doc,store,writes,answers,asked,timers,
    card,toggle:contest=>doc.querySelector(`[data-rules-toggle="${contest}"]`),body:contest=>doc.getElementById(`${contest}-rules-body`),
    summary:contest=>doc.querySelector(`[data-rules-summary="${contest}"]`).textContent,alerts:contest=>doc.querySelector(`[data-rules-alerts="${contest}"]`),
    label:contest=>doc.querySelector(`[data-rules-card="${contest}"] [data-rules-toggle-label]`).textContent,
    update:contest=>doc.dispatchEvent(new CustomEvent('poolcenter:update',{detail:{contest}})),
    board:()=>doc.getElementById('picksBoard'),filters:()=>doc.getElementById('picksFilters'),
    chip:name=>doc.querySelector(`[data-picks-entrant="${name}"]`),segment:status=>doc.querySelector(`[data-picks-status="${status}"]`),
    note:()=>doc.querySelector('[data-picks-note]')?.textContent??null,
    cards:()=>doc.getElementById('picksBoard').querySelectorAll('article'),
    shown:()=>doc.getElementById('picksBoard').querySelectorAll('article').map(a=>Number(a.dataset.game)),
    pressed:()=>Object.fromEntries(doc.querySelectorAll('[data-picks-entrant]').map(c=>[c.dataset.picksEntrant,c.getAttribute('aria-pressed')])),
    status:()=>doc.querySelectorAll('[data-picks-status]').find(s=>s.getAttribute('aria-pressed')==='true')?.dataset.picksStatus??null,
    counts:()=>Object.fromEntries(doc.querySelectorAll('[data-picks-count]').map(c=>[c.dataset.picksCount,c.textContent])),
    table:()=>[doc.getElementById('pickHead').innerHTML,doc.getElementById('pickBody').innerHTML],
    prefs:()=>JSON.parse(store.get(STORAGE_KEY)||'null')};
}
const namesOn=article=>article.querySelectorAll('.pm-name').map(n=>n.textContent);
// What a reader gets: the text of the elements, aria-hidden decoration (the team badges) left out, one space between parts.
const visible=node=>node.nodeType===3?node.text:node.getAttribute('aria-hidden')==='true'?'':node.children.map(visible).filter(Boolean).join(' ');
const spoken=node=>visible(node).replace(/\s+/g,' ').trim();

// ---- The page part: collapsible Rules & rulings.
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

// ---- The page part: the Picks board.
await check('boot: the card and filter containers are shown and the card marked ready (the stylesheet decides which of table and cards is on screen), every game is a card in kickoff order with all four entries, the table is untouched',async()=>{
  const p=await page();
  assert.equal(p.board().hidden,false);assert.equal(p.filters().hidden,false);
  assert.equal(p.board().closest('.picks').classList.contains('is-mobile-ready'),true);
  assert.deepEqual(p.shown(),[0,11,1,2,6,10,7,3,4,8,5,9]);
  assert.deepEqual(p.pressed(),{'*':'true','D.C.':'true',JC:'true',DJS:'true',Thaddeus:'true'});
  assert.equal(p.status(),'all');assert.deepEqual(p.counts(),{all:'12',final:'2',live:'2',upcoming:'6'});
  assert.equal(p.note(),'All 4 entries · 12 of 12 games · 2 VOID/HOLD shown in every filter');
  for(const article of p.cards())assert.deepEqual(namesOn(article),NAMES,`card ${article.dataset.game}`);
  assert.deepEqual(p.table(),['',''],'the comparison table is weekly-app.js’s alone');
  assert(p.doc.querySelector('.picks .scroll table thead#pickHead'),'the table markup stays');
  assert.deepEqual(p.asked.filter(([kind])=>kind==='picks'),[['picks','pickem']]);
});
await check('entrant filtering: any combination of 1 to 4, All 4 selects everyone, the last selected entry stays, the choice is remembered in this browser',async()=>{
  const p=await page();
  p.chip('JC').click();
  assert.deepEqual(p.pressed(),{'*':'false','D.C.':'true',JC:'false',DJS:'true',Thaddeus:'true'});
  for(const article of p.cards())assert.deepEqual(namesOn(article),['D.C.','DJS','Thaddeus']);
  assert.equal(p.note(),'D.C. · DJS · Thaddeus · 12 of 12 games · 2 VOID/HOLD shown in every filter');
  assert.deepEqual(p.prefs(),{version:1,entrants:['D.C.','DJS','Thaddeus']});
  p.chip('D.C.').click();p.chip('DJS').click();
  assert.deepEqual(p.pressed(),{'*':'false','D.C.':'false',JC:'false',DJS:'false',Thaddeus:'true'});
  for(const article of p.cards())assert.deepEqual(namesOn(article),['Thaddeus']);
  p.chip('Thaddeus').click();
  assert.deepEqual(p.pressed(),{'*':'false','D.C.':'false',JC:'false',DJS:'false',Thaddeus:'true'},'the last entry cannot be deselected');
  assert.equal(p.note(),'At least one entry stays selected · Thaddeus · 12 of 12 games · 2 VOID/HOLD shown in every filter');
  assert.deepEqual(p.prefs(),{version:1,entrants:['Thaddeus']});
  p.chip('JC').click();
  assert.deepEqual(p.pressed(),{'*':'false','D.C.':'false',JC:'true',DJS:'false',Thaddeus:'true'});
  for(const article of p.cards())assert.deepEqual(namesOn(article),['JC','Thaddeus'],'two entries, published order');
  p.chip('*').click();
  assert.deepEqual(p.pressed(),{'*':'true','D.C.':'true',JC:'true',DJS:'true',Thaddeus:'true'});
  assert.deepEqual(p.prefs(),{version:1,entrants:NAMES});
  p.chip('D.C.').click();p.chip('JC').click();p.chip('DJS').click();
  for(const article of p.cards())assert.deepEqual(namesOn(article),['Thaddeus']);
  const three=await page({stored:{version:1,entrants:['DJS','JC','D.C.']}});
  assert.deepEqual(three.pressed(),{'*':'false','D.C.':'true',JC:'true',DJS:'true',Thaddeus:'false'},'a remembered choice is restored');
  for(const article of three.cards())assert.deepEqual(namesOn(article),['D.C.','JC','DJS']);
  for(const stored of ['{bad',{version:1,entrants:['Nobody']},{version:9,entrants:['JC']}]){const q=await page({stored});assert.deepEqual(q.pressed()['*'],'true',JSON.stringify(stored))}
  const noStore=await page({storage:'throws'});
  noStore.chip('JC').click();
  assert.deepEqual(noStore.pressed().JC,'false');assert.match(noStore.note(),/^Selection not saved in this browser · D\.C\. · DJS · Thaddeus/,'the page says the choice applies here only');
  const absent=await page({storage:'absent'});absent.chip('JC').click();assert.deepEqual(absent.pressed().JC,'false');
});
await check('game-status filtering: one segmented control; Final keeps the verified tie, VOID and HOLD games appear in every filter, and the empty states are truthful',async()=>{
  const p=await page();
  p.segment('final').click();
  assert.equal(p.status(),'final');assert.deepEqual(p.shown(),[0,1,6,7]);
  assert.equal(p.note(),'All 4 entries · 4 of 12 games · Final · 2 VOID/HOLD shown in every filter');
  p.segment('live').click();
  assert.deepEqual(p.shown(),[2,6,10,7]);assert.equal(p.note(),'All 4 entries · 4 of 12 games · Live · 2 VOID/HOLD shown in every filter');
  p.segment('upcoming').click();
  assert.deepEqual(p.shown(),[11,6,7,3,4,8,5,9]);
  p.segment('all').click();
  assert.deepEqual(p.shown(),[0,11,1,2,6,10,7,3,4,8,5,9]);
  const quiet=await page({picksAnswer:()=>snapshot({games:GAMES().filter(g=>g.kind==='final'||g.kind==='tie')})});
  quiet.segment('live').click();
  assert.equal(quiet.board().innerHTML,'<div class="empty">No games are live right now.</div>');
  assert.equal(quiet.note(),'All 4 entries · 0 of 2 games · Live');
  assert.deepEqual(quiet.counts(),{all:'2',final:'2',live:'0',upcoming:'0'});
});
await check('the filters survive ordinary score refreshes: an update re-reads the snapshot and redraws the cards with the same entries and status, without rebuilding the controls',async()=>{
  const p=await page();
  p.chip('DJS').click();p.chip('Thaddeus').click();p.segment('live').click();
  const chipBefore=p.chip('JC'),segmentBefore=p.segment('live');
  assert.deepEqual(p.shown(),[2,6,10,7]);
  p.answers.picks=()=>snapshot({games:GAMES().map(g=>g.index===2?{...g,kind:'final',status:'FINAL',detail:'Final',awayScore:27,homeScore:24,winner:'NYJ',picks:pk(['NYJ','NE','NYJ',null],['correct','incorrect','correct','incorrect'])}:g.index===3?{...g,kind:'live',status:'1st 12:00',detail:'1st 12:00',awayScore:0,homeScore:3}:g)});
  for(let i=0;i<5;i++)p.update('pickem');
  assert.deepEqual(p.pressed(),{'*':'false','D.C.':'true',JC:'true',DJS:'false',Thaddeus:'false'},'the entries chosen stay chosen');
  assert.equal(p.status(),'live','the status stays');
  assert.deepEqual(p.shown(),[6,10,7,3],'the cards follow the new scores: NYJ went final, WAS kicked off');
  for(const article of p.cards())assert.deepEqual(namesOn(article),['D.C.','JC']);
  assert.equal(p.chip('JC'),chipBefore,'the chips are the same elements (a focused chip is not lost)');assert.equal(p.segment('live'),segmentBefore);
  assert.deepEqual(p.counts(),{all:'12',final:'3',live:'2',upcoming:'5'});
  assert.deepEqual(p.prefs(),{version:1,entrants:['D.C.','JC']});
  p.update('survivor');
  assert.deepEqual(p.shown(),[6,10,7,3],'a Survivor update changes nothing here');
});
await check('missing submissions, final ties, VOID, HOLD and live or unverified states read on the cards exactly as the snapshot grades them',async()=>{
  const p=await page();
  const card=i=>p.cards().find(a=>Number(a.dataset.game)===i);
  const rowOf=(i,name)=>card(i).querySelectorAll('.pm-pick').find(r=>r.querySelector('.pm-name').textContent===name);
  const text=spoken;
  assert.equal(text(rowOf(0,'Thaddeus')),'Thaddeus NO PICK ✕ No pick','no submission, decided game');
  assert.equal(text(rowOf(3,'Thaddeus')),'Thaddeus NO PICK Pending','no submission, upcoming game');
  assert.equal(text(rowOf(1,'Thaddeus')),'Thaddeus NO PICK ✕ No pick','no submission, tie');
  assert.equal(text(rowOf(6,'Thaddeus')),'Thaddeus NO PICK VOID');
  assert.equal(text(rowOf(0,'D.C.')),'D.C. DEN ✓ Correct');assert.equal(text(rowOf(0,'JC')),'JC KC ✕ Incorrect');
  assert.equal(card(1).querySelector('.pm-status').textContent,'FINAL TIE');assert.equal(text(rowOf(1,'D.C.')),'D.C. MIA ✕ Tie · 1 loss');
  assert.equal(card(6).querySelector('.pm-status').textContent,'VOID');assert.equal(text(rowOf(6,'JC')),'JC PIT VOID');
  assert.equal(card(7).querySelector('.pm-status').textContent,'HOLD');assert.equal(text(rowOf(7,'DJS')),'DJS LV HOLD');
  assert.equal(card(7).querySelector('.pm-flag-issue').textContent,'Not graded · the ruling cites policy revision 2, which does not exist');
  assert.equal(card(2).querySelector('.pm-status').textContent,'LIVE');assert.equal(card(2).querySelector('.pm-detail').textContent,'3rd 7:41');assert.equal(text(rowOf(2,'D.C.')),'D.C. NYJ Pending');
  assert.equal(card(10).querySelector('.pm-flag-issue').textContent,'Not verified · DET-CHI: final with contradictory status ignored');
  assert.equal(card(3).querySelector('.pm-ownership').textContent,'WAS 31%of 87 entries69% PHI');
  assert.equal(card(5).querySelector('.pm-flag-tiebreak').textContent,'TIEBREAK GAME');
});
await check('each card’s picks line up with its own matchup: every pick row names one of the card’s two teams or NO PICK, and the card is labelled with its teams and state',async()=>{
  const p=await page();
  const games=new Map(GAMES().map(g=>[g.index,g]));
  for(const article of p.cards()){
    const g=games.get(Number(article.dataset.game));
    assert.equal(article.getAttribute('aria-label'),`${g.away.code} at ${g.home.code}, ${{void:'VOID',hold:'HOLD',final:'FINAL',tie:'FINAL TIE',live:'LIVE',upcoming:'UPCOMING'}[g.kind]}`);
    assert.deepEqual(article.querySelectorAll('.pm-code').map(c=>c.textContent),[g.away.code,g.home.code]);
    for(const row of article.querySelectorAll('.pm-pick')){
      const team=spoken(row.querySelector('.pm-pick-team'));
      assert([g.away.code,g.home.code,'NO PICK'].includes(team),`game ${g.index}: ${row.querySelector('.pm-name').textContent} shows ${team}`);
    }
  }
});
await check('a week with other tracked names rebuilds the chips and keeps the remembered choice where it still applies; an app that does not answer leaves the loading text and no controls',async()=>{
  const p=await page({stored:{version:1,entrants:['JC','DJS']}});
  assert.deepEqual(p.pressed(),{'*':'false','D.C.':'false',JC:'true',DJS:'true',Thaddeus:'false'});
  p.answers.picks=()=>snapshot({entrants:[{name:'JC',noSubmission:false},{name:'Alex',noSubmission:false}],games:GAMES().slice(0,2).map(g=>({...g,picks:[{name:'JC',team:g.home.code,result:g.picks[1].result},{name:'Alex',team:g.away.code,result:g.picks[0].result}]}))});
  p.update('pickem');
  assert.deepEqual(p.pressed(),{'*':'false',JC:'true',Alex:'false'},'the names JC still applies to; All 2 is unpressed');
  assert.equal(p.chip('*').textContent,'All 2');
  for(const article of p.cards())assert.deepEqual(namesOn(article),['JC']);
  p.answers.picks=()=>snapshot({entrants:[{name:'Pat',noSubmission:false}],games:[]});
  p.update('pickem');
  assert.deepEqual(p.pressed(),{'*':'true',Pat:'true'},'no remembered name applies: everyone');
  const silent=await page({picksAnswer:null});
  assert.equal(silent.board().innerHTML,'<div class="empty">Picks are not available yet.</div>');
  assert.equal(silent.filters().innerHTML,'');
  silent.answers.picks=()=>({ready:false,reason:'Another week is loading. The picks follow once it is on screen.'});silent.update('pickem');
  assert.equal(silent.board().innerHTML,'<div class="empty">Another week is loading. The picks follow once it is on screen.</div>');
  silent.answers.picks=()=>snapshot();silent.update('pickem');
  assert.equal(silent.cards().length,12);assert.deepEqual(silent.pressed()['*'],'true');
});
await check('desktop table regression: through boot, every filter and every update the module never writes the comparison table or the containers weekly-app.js owns',async()=>{
  const p=await page();
  p.doc.getElementById('pickHead').innerHTML='<tr><th class="name">Entry</th></tr>';p.doc.getElementById('pickBody').innerHTML='<tr><td class="name">D.C.</td></tr>';
  p.chip('JC').click();p.segment('final').click();p.update('pickem');p.update('survivor');p.toggle('pickem').click();
  assert.deepEqual(p.table(),['<tr><th class="name">Entry</th></tr>','<tr><td class="name">D.C.</td></tr>']);
  assert(p.doc.querySelector('.picks .scroll'),'the scrolling table wrapper stays for wide screens');
});
await check('a page without the mobile markup is left alone',async()=>{
  const doc=makeDocument('<div class="other"><div id="gamegrid"></div></div>');
  globalThis.document=doc;
  const mod=await import(`./picks-mobile.js?instance=${++instance}`);
  assert.equal(mod.boot(),null);
  assert.equal(doc.body.innerHTML,'<div class="other"><div id="gamegrid"></div></div>');
});

assert.equal(failures.length,0,`V1.3 mobile UX regressions failed (${failures.length}):\n  ${failures.join('\n  ')}`);
console.log('picks-mobile regressions passed: Eastern kickoff groups, status and entrant filters with storage, card, board and filter markup, rules summary and alerts, collapsible Rules & rulings on both pages, the Picks board on the real page markup, filter persistence through refreshes and the untouched comparison table');
