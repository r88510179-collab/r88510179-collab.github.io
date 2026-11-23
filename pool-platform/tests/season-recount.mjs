// The naive recount of a pool season: a second, deliberately plain count of the database's season snapshot, written
// without any of the code the pages run. Two users:
//   - season-standings-recount.test.mjs compares it with the pages' code on thousands of random seasons;
//   - the signed-in acceptance routine compares it with what a real backend's page shows.
// It must stay free of imports from pool-platform/: sharing code with what it checks would make it prove nothing.
export function recount(snapshot){
  const kind=snapshot.pool_type;
  const tally=new Map(snapshot.entries.map(e=>[e.entry_id,kind==='pickem'
    ?{correct:0,incorrect:0,ties:0,submitted:0,missing:0}
    :{alive:true,used:[],advanced:0,outWeek:null,why:null,ignored:0}]));
  const states=snapshot.weeks.map(()=>'not_counted');
  let stopped=null,counted=0,through=null,interrupted=false;
  for(let i=0;i<snapshot.weeks.length&&!interrupted;i++){
    const w=snapshot.weeks[i];
    if(w.visibility==='sealed'){states[i]='sealed';break}
    if(w.result===null){states[i]='awaiting_finals';stopped={week:w.week,reason:'awaiting_finals'};break}
    const chosen=new Map(w.submissions.map(s=>[s.entry_id,s.payload]));
    if(kind==='pickem'){
      for(const [entryId,t] of tally){
        const payload=chosen.get(entryId);
        if(!payload){t.missing++;continue}
        t.submitted++;
        for(const game of w.games){
          const score=w.result.results[game.id];
          if(score.away_score===score.home_score){t.ties++;t.incorrect++}
          else if(payload.picks[game.id]===(score.away_score>score.home_score?'away':'home'))t.correct++;
          else t.incorrect++;
        }
      }
    }else{
      const fate=new Map();
      for(const game of w.games){
        const score=w.result.results[game.id],tie=score.away_score===score.home_score;
        fate.set(game.away.key,tie?'tie':score.away_score>score.home_score?'won':'loss');
        fate.set(game.home.key,tie?'tie':score.home_score>score.away_score?'won':'loss');
      }
      for(const [entryId,t] of tally){
        const payload=chosen.get(entryId);
        if(!t.alive){if(payload)t.ignored++;continue}
        if(!payload){t.alive=false;t.outWeek=w.week;t.why='no_pick';continue}
        t.used.push(payload.team);
        const outcome=fate.get(payload.team);
        if(outcome==='won')t.advanced++;
        else{t.alive=false;t.outWeek=w.week;t.why=outcome}
      }
    }
    states[i]='counted';counted++;through=w.week;
  }
  snapshot.weeks.forEach((w,i)=>{if(states[i]==='not_counted'&&w.visibility==='sealed')states[i]='sealed'});
  const byCode=(x,y)=>x.code<y.code?-1:x.code>y.code?1:0;
  const rows=snapshot.entries.map(e=>{
    const t=tally.get(e.entry_id),who={entry_id:e.entry_id,name:e.display_name,code:e.entry_code};
    return kind==='pickem'
      ?{...who,correct:t.correct,incorrect:t.incorrect,ties_both_lose:t.ties,submitted_weeks:t.submitted,missing_weeks:t.missing,
        rank:counted?1+[...tally.values()].filter(other=>other.correct>t.correct).length:null}
      :{...who,status:t.alive?'active':'eliminated',used_teams:t.used,advanced_weeks:t.advanced,eliminated_week:t.outWeek,
        elimination_reason:t.why,ignored_later_submissions:t.ignored};
  });
  if(kind==='pickem')rows.sort((x,y)=>y.correct-x.correct||byCode(x,y));
  else rows.sort((x,y)=>(x.status==='active'?0:1)-(y.status==='active'?0:1)||y.advanced_weeks-x.advanced_weeks||byCode(x,y));
  return {ok:true,reason:null,kind,rows,
    weeks:snapshot.weeks.map((w,i)=>({week:w.week,state:states[i],revision:w.result?.revision??null})),
    throughWeek:through,countedWeeks:counted,stopped,
    // A week without a pick is a loss, whether the pool says so or says nothing (the ruling of 2026-11-13).
    noPickRule:kind==='survivor'?{outcome:'eliminated',statedBy:'missingSurvivorPick' in snapshot.rules?'pool':'default'}:null,
    unofficial:true};
}
